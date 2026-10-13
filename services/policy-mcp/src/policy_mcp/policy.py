"""The policy the proxy enforces BEFORE a tool call reaches shop-mcp or ops-mcp.

Four layers, checked in order. The first that fires produces a structured refusal and
the underlying tool is never called:

1. capability policy   -- the current role may not use this tool at all. The tool is
                          also not *listed* for that role, so the CLI's allowedTools is
                          enforced server-side rather than trusted.
2. CaMeL capability    -- a value derived from untrusted content (seller text, reviews)
                          may not flow into a privileged argument (qty, budget,
                          spend_cap, ...). Callers tag arguments with `_capabilities`.
3. guard rules         -- the deterministic rules from shop_mcp.guard: qty > 5, budget
                          overrun, and a product whose seller listing was quarantined.
4. tier limits         -- T2 tools need a human approval recorded in ops-http, and
                          build_candidate must name the remediation that was approved.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

import httpx

MAX_QTY = 5

# ---------------------------------------------------------------- capability policy
SHOPPER_TOOLS = {
    "search_products", "get_product", "compare_products", "check_store_stock",
    "find_substitutes", "plan_meal", "add_to_cart", "remove_from_cart", "get_cart",
    "get_seller_listing", "agent_catalog_feed", "agent_readiness_score",
}
# Beat 4 only. Creating a mandate is a T2 capability the plain Shopper role does not have.
CHECKOUT_TOOLS = SHOPPER_TOOLS | {"create_checkout_mandate"}
OPS_TOOLS = {
    "run_data_validation", "label_queries", "record_labels", "compute_drift",
    "estimate_performance", "propose_remediation", "build_candidate", "run_eval_suite",
    "run_mle_search", "run_red_team", "gate_preregistered_candidate",
    "start_canary", "get_canary_status", "promote", "rollback", "sign_model",
    "verify_model_signature", "generate_mlbom", "get_registry", "get_audit_log",
    # Ops Copilot top 10 (Phase 3). run_runbook enforces its own per-runbook tier: T2 runbooks need a human
    # approval recorded in ops.db (decided only over ops-http) before the executor runs them.
    "incident_triage", "metric_query", "list_runbooks", "run_runbook", "release_notes", "compare_versions",
    "drift_explain", "eval_failure_clusters", "token_cost_report", "replay_summary", "trace_summary", "watch_alerts",
    # MLOps top 10 (MLO1-MLO10). skew_check/retrain_trigger are T2 but enforce their own tier: they only OPEN approvals
    # (skew_review blocks promote; retrain_signoff gates the build) and never promote.
    "interleave_rankers", "ab_sequential_test", "skew_check", "lineage_query", "retrain_trigger",
    # MLO7/MLO8 are T2 the same way: prompt_registry_diff opens config_regression/config_rollback approvals and restores
    # files only after a human approves; slo_budget_status opens a release freeze that blocks promote until a human override.
    "exposure_audit", "prompt_registry_diff", "slo_budget_status", "golden_set_diff", "shadow_deploy_diff",
}

ROLE_TOOLS: dict[str, set[str]] = {
    "shopper": SHOPPER_TOOLS,
    "checkout": CHECKOUT_TOOLS,
    "ops": OPS_TOOLS,
}

# Never exposed to any role, at any tier: a human approves these, over ops-http / shop-http.
NEVER_EXPOSED = {"approve_mandate", "decide_approval", "approve_remediation", "review_label"}

# Autonomy tier per tool. T2 tools need a recorded human approval before they act.
TIER: dict[str, str] = {
    "record_labels": "T2", "build_candidate": "T2", "start_canary": "T2",
    "promote": "T2", "rollback": "T2", "create_checkout_mandate": "T2",
    "run_eval_suite": "T3", "gate_preregistered_candidate": "T3",
    # Read-only T0 tools are listed only where the tier is worth stating explicitly.
    "trace_summary": "T0",
}

# Arguments that decide what is bought or spent. A value the quarantined LLM extracted
# from untrusted text can never land in one of these (CaMeL, technique 36).
PRIVILEGED_ARGS = {"qty", "quantity", "budget", "spend_cap", "pct", "traffic_pct", "approved"}


@dataclass
class Refusal:
    rule: str
    reason: str
    tool: str
    detail: dict = field(default_factory=dict)

    def as_result(self) -> dict:
        return {
            "blocked": True,
            "refused_by": "policy-mcp",
            "rule": self.rule,
            "reason": self.reason,
            "error": f"Blocked by policy-mcp ({self.rule}): {self.reason}",
            "tool": self.tool,
            "detail": self.detail,
            "handling": "The underlying tool was never called. Tell the human why and do not retry the same call.",
            "provenance": {"service": "policy-mcp", "endpoint": f"policy/{self.rule}", "note": "pre-execution policy check"},
        }


def role() -> str:
    return os.environ.get("POLICY_ROLE", "shopper").strip().lower()


def tools_for(r: str) -> set[str]:
    """Tools a role may use. POLICY_TOOLS_ALLOW (comma list, set by the BFF per intent) can only NARROW this set,
    never widen it: an allow-list naming a tool the role lacks is ignored for that tool."""
    base = ROLE_TOOLS.get(r, set()) - NEVER_EXPOSED
    allow = os.environ.get("POLICY_TOOLS_ALLOW")
    if allow is None:
        return base
    return base & {t.strip() for t in allow.split(",") if t.strip()}


def _ops_http() -> str:
    return os.environ.get("OPS_HTTP_URL", "http://127.0.0.1:8803").rstrip("/")


def _approvals(kind: str) -> list[dict]:
    """Approvals recorded in ops-http. Unreachable ops-http means we cannot prove an
    approval exists, so a T2 tool is refused rather than allowed."""
    try:
        r = httpx.get(_ops_http() + "/approvals", timeout=3.0)
        r.raise_for_status()
        rows = r.json()
    except (httpx.HTTPError, ValueError):
        return []
    return [a for a in rows if a.get("kind") == kind]


# ---------------------------------------------------------------- the four checks
def check_capability(r: str, tool: str) -> Refusal | None:
    if tool in NEVER_EXPOSED:
        return Refusal("capability.never_exposed", f"{tool} is never exposed to an agent; a human performs it in the UI", tool)
    if tool not in tools_for(r):
        return Refusal("capability.role", f"role {r!r} may not call {tool}", tool,
                       {"role": r, "allowed": sorted(tools_for(r))})
    return None


def check_camel(tool: str, args: dict) -> Refusal | None:
    """`_capabilities` maps an argument name to "trusted" or "untrusted". The executor in
    bff/src/agents/camel.ts sets it; anything it marks untrusted came from a quarantined
    LLM reading seller text, so it may not decide quantity, budget or spend."""
    caps = args.get("_capabilities") or {}
    if not isinstance(caps, dict):
        return Refusal("capability.malformed", "_capabilities must be an object of arg -> trusted|untrusted", tool)
    tainted = sorted(k for k, v in caps.items() if v == "untrusted" and k in PRIVILEGED_ARGS)
    if tainted:
        return Refusal(
            "capability.untrusted_arg",
            f"{', '.join(tainted)} came from untrusted content and may not be a privileged argument of {tool}",
            tool,
            {"tainted": tainted, "origins": {k: caps.get(k) for k in tainted}},
        )
    return None


def check_guard(tool: str, args: dict) -> Refusal | None:
    """The deterministic rules that used to live only inside the add_to_cart tool."""
    if tool != "add_to_cart":
        return None
    from shop_mcp import guard as shop_guard

    session_id = str(args.get("session_id") or "")
    product_id = str(args.get("product_id") or "")
    qty = int(args.get("qty") or 1)
    budget = args.get("budget")
    violations = shop_guard.check_add(session_id, product_id, qty, budget)
    if not violations:
        return None
    return Refusal(
        violations[0]["kind"],
        "; ".join(v["reason"] for v in violations),
        tool,
        {"violations": violations, "policy": {"max_qty": MAX_QTY, "budget": budget, "quarantine": "same session"}},
    )


def check_tier(tool: str, args: dict) -> Refusal | None:
    if TIER.get(tool) != "T2":
        return None
    if tool == "create_checkout_mandate":
        return None  # the mandate itself IS the approval request; it never pays.
    if tool == "record_labels":
        return None  # writes go to the human review queue, not to production.
    kind = "promote" if tool in ("promote", "start_canary") else "rollback" if tool == "rollback" else "remediation"
    approved = [a for a in _approvals(kind) if a.get("status") == "approved"]
    if not approved:
        return Refusal("tier.t2_needs_approval",
                       f"{tool} is T2: it needs a human {kind} approval recorded in ops-http, and none is approved",
                       tool, {"kind": kind, "ops_http": _ops_http()})
    # An approval is for one subject. "Some promotion was approved once" is not authority to
    # promote a different version, so the argument must match what the human actually approved.
    subject_arg = "remediation_id" if tool == "build_candidate" else "version"
    wanted = str(args.get(subject_arg) or "")
    subjects = {str(a.get("subject")) for a in approved}
    if wanted and wanted not in subjects:
        rule = "tier.not_the_approved_remediation" if tool == "build_candidate" else "tier.not_the_approved_subject"
        return Refusal(rule, f"the human approved {sorted(subjects)}, not {wanted}", tool,
                       {"approved": sorted(subjects), "requested": wanted, "kind": kind})
    return None


HITL_TOOLS = {"add_to_cart", "remove_from_cart"}


def check_hitl(tool: str, args: dict) -> Refusal | None:
    """Wave 0b human-in-the-loop: when the bff starts policy-mcp with POLICY_HITL=propose, an
    agent cart change is not executed. It is refused as a *proposal* the shopper approves (or
    rejects) in the UI; the bff executes it only after approval and records it in the audit log.
    Runs after the guard, so a call the guard would refuse is refused as a violation, not proposed."""
    if os.environ.get("POLICY_HITL", "").strip().lower() != "propose" or tool not in HITL_TOOLS:
        return None
    return Refusal(
        "hitl.needs_approval",
        f"{tool} is proposed to the shopper for approval; nothing changed until they approve",
        tool,
        {"proposal": {k: args.get(k) for k in ("session_id", "product_id", "qty") if k in args}},
    )


def check(tool: str, args: dict, r: str | None = None) -> Refusal | None:
    """Run every layer in order. Returns the first refusal, or None to forward the call."""
    r = r or role()
    for fn in (lambda: check_capability(r, tool), lambda: check_camel(tool, args),
               lambda: check_guard(tool, args), lambda: check_hitl(tool, args), lambda: check_tier(tool, args)):
        ref = fn()
        if ref is not None:
            return ref
    return None
