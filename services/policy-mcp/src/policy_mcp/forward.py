"""Policy gate + forwarding to the underlying tool implementations.

shop-mcp and ops-mcp are imported IN-PROCESS rather than spawned as child MCP clients.
Both are already uv path dependencies (ops-mcp depends on shop-mcp the same way), their
tool layers are plain functions returning dicts, and importing them means one process,
no second stdio handshake to keep alive, and direct access to shop_mcp.guard for the
pre-execution check. The cost is that policy-mcp must share their dependency set, which
it already does.
"""
from __future__ import annotations

import inspect
import json
import os
import time
from typing import Any, Callable

from ops_mcp import copilot as ops_copilot
from ops_mcp import mlops_top10
from ops_mcp import tools as ops_tools
from shop_mcp import sparky_trace
from shop_mcp import tools as shop_tools

from . import events, policy

# name -> the plain function that actually does the work
IMPLS: dict[str, Callable[..., dict]] = {
    # shop plane
    "search_products": shop_tools.search_products,
    "get_product": shop_tools.get_product,
    "compare_products": shop_tools.compare_products,
    "check_store_stock": shop_tools.check_store_stock,
    "find_substitutes": shop_tools.find_substitutes,
    "plan_meal": shop_tools.plan_meal,
    "add_to_cart": shop_tools.add_to_cart,
    "remove_from_cart": shop_tools.remove_from_cart,
    "get_cart": shop_tools.get_cart,
    "create_checkout_mandate": shop_tools.create_checkout_mandate,
    "agent_catalog_feed": shop_tools.agent_catalog_feed,
    "agent_readiness_score": shop_tools.agent_readiness_score,
    "get_seller_listing": shop_tools.get_seller_listing,
    # ops plane
    "run_data_validation": ops_tools.run_data_validation,
    "label_queries": ops_tools.label_queries,
    "record_labels": ops_tools.record_labels,
    "compute_drift": ops_tools.compute_drift,
    "estimate_performance": ops_tools.estimate_performance,
    "propose_remediation": ops_tools.propose_remediation,
    "build_candidate": ops_tools.build_candidate,
    "run_eval_suite": ops_tools.run_eval_suite,
    "run_mle_search": ops_tools.run_mle_search,
    "run_red_team": ops_tools.run_red_team,
    "start_canary": ops_tools.start_canary,
    "get_canary_status": ops_tools.get_canary_status,
    "promote": ops_tools.promote,
    "rollback": ops_tools.rollback,
    "sign_model": ops_tools.sign_model,
    "verify_model_signature": ops_tools.verify_model_signature,
    "generate_mlbom": ops_tools.generate_mlbom,
    "get_registry": ops_tools.get_registry,
    "get_audit_log": ops_tools.get_audit_log,
    # Ops Copilot top 10 (Phase 3)
    "incident_triage": ops_copilot.incident_triage,
    "metric_query": ops_copilot.metric_query,
    "list_runbooks": ops_copilot.list_runbooks,
    "run_runbook": ops_copilot.run_runbook,
    "release_notes": ops_copilot.release_notes,
    "compare_versions": ops_copilot.compare_versions,
    "drift_explain": ops_copilot.drift_explain,
    "eval_failure_clusters": ops_copilot.eval_failure_clusters,
    "token_cost_report": ops_copilot.token_cost_report,
    "replay_summary": ops_copilot.replay_summary,
    "trace_summary": ops_copilot.trace_summary,
    "watch_alerts": ops_copilot.watch_alerts,
    # MLOps top 10 (MLO1-MLO10)
    **mlops_top10.TOOLS,
}


_TEXT_ARGS = ("query", "goal", "text", "category")


def _policy_attrs(name: str, args: dict, r: str) -> dict:
    """What the `policy` span records: tier, bypass class/language of the free-text argument, injection flag.
    The text itself is hashed (sparky_trace.redact), never stored."""
    from ops_mcp import bypass_gate
    from shop_mcp import injection

    text = next((str(args[k]) for k in _TEXT_ARGS if isinstance(args.get(k), str) and args.get(k)), "")
    det = injection.detect_injection(text) if text else {"flagged": False, "signals": []}
    cls = bypass_gate.class_of(text, [s.get("type") for s in det.get("signals", [])]) if text else None
    return {
        "sparky.policy.tool": name,
        "sparky.policy.role": r,
        "sparky.policy.tier": policy.TIER.get(name, "T0/T1"),
        "sparky.policy.hitl_mode": os.environ.get("POLICY_HITL") or "off",
        "sparky.policy.bypass_class": cls["class"] if cls else None,
        "sparky.policy.lang": cls["language"] if cls else None,
        "sparky.policy.injection_flag": bool(det.get("flagged")),
        "sparky.policy.injection_signals": len(det.get("signals", [])),
        **sparky_trace.redact(text or None, "sparky.policy.text"),
    }


def call(name: str, args: dict[str, Any], role: str | None = None) -> dict:
    """Enforce, then forward, inside a `policy` span (child of the BFF's llm span via TRACEPARENT)."""
    r = role or policy.role()
    with sparky_trace.span(f"policy {name}", "policy", service="policy-mcp") as sp:
        t0 = time.perf_counter()
        if not isinstance(sp, sparky_trace._NoSpan):
            try:
                sparky_trace.set_attrs(sp, _policy_attrs(name, dict(args), r))
            except Exception:  # noqa: BLE001 - telemetry never fails a tool call
                pass
        result = _call(name, args, r, sp, t0)
        if isinstance(result, dict):
            refused = bool(result.get("blocked") and result.get("refused_by") == "policy-mcp")
            sparky_trace.set_attrs(sp, {
                "sparky.policy.decision": "refuse" if refused else "allow",
                "sparky.policy.rule": result.get("rule") if refused else None,
                "sparky.policy.result_error": bool(result.get("error")) and not refused,
                "sparky.policy.result_injection_flagged": bool(result.get("injection_flagged")),
                "sparky.policy.total_ms": round((time.perf_counter() - t0) * 1000, 2),
            })
        return result


def _call(name: str, args: dict[str, Any], r: str, sp: Any, t0: float) -> dict:
    """Enforce, then forward. A refused call never reaches IMPLS[name]."""
    args = dict(args)
    refusal = policy.check(name, args, r)
    sparky_trace.set_attrs(sp, {"sparky.policy.check_ms": round((time.perf_counter() - t0) * 1000, 2)})
    if refusal is not None:
        events.log("refuse", name, r, args, refusal.rule, refusal.reason, refusal.detail)
        return refusal.as_result()

    impl = IMPLS.get(name)
    if impl is None:
        events.log("refuse", name, r, args, "capability.unknown_tool", f"no implementation for {name}")
        return policy.Refusal("capability.unknown_tool", f"no implementation for {name}", name).as_result()

    args.pop("_capabilities", None)
    # The proxy's own signature is a superset of the tool's: get_seller_listing, for one,
    # takes a session_id here (so the quarantine is recorded against the right cart) that
    # the underlying function does not accept. Pass only what the implementation declares.
    accepted = inspect.signature(impl).parameters
    forwarded = {k: v for k, v in args.items() if k in accepted}
    result = impl(**forwarded)

    # get_seller_listing hands the model untrusted text: remember the quarantine here, in
    # the proxy, so a later add_to_cart for the same product is refused before execution.
    if name == "get_seller_listing" and isinstance(result, dict) and result.get("injection_flagged"):
        from shop_mcp import guard as shop_guard

        shop_guard.record_quarantine(args.get("session_id"), args.get("product_id"), result.get("injection_signals"))
        events.log("quarantine", name, r, args, "quarantine.recorded",
                   f"{args.get('product_id')} seller listing flagged; add_to_cart for it will be refused",
                   {"signals": result.get("injection_signals")})

    events.log("allow", name, r, args)
    prov = result.setdefault("provenance", {}) if isinstance(result, dict) else {}
    if isinstance(prov, dict):
        prov.setdefault("service", "policy-mcp")
        prov["proxied_by"] = "policy-mcp"
        prov["policy_role"] = r
    return result


# Fields the model never needs (the UI builds cards from the fields that remain). POLICY_TRIM=1 enables.
_ITEM_DROP = {"commerce_services", "synthetic", "image"}
_TOP_DROP = {"catalog_services", "filters"}


def trim_result(name: str, result: Any) -> Any:
    """Prompt diet for tool results: drop per-item fields no answer uses, keep one store's stock, round scores.
    Refusals and errors pass through untouched."""
    if not isinstance(result, dict) or result.get("blocked") or result.get("error"):
        return result
    out = {k: v for k, v in result.items() if k not in _TOP_DROP}
    if isinstance(out.get("provenance"), dict):
        out["provenance"] = {k: out["provenance"][k] for k in ("service", "source", "proxied_by") if k in out["provenance"]}
    items = out.get("results") if isinstance(out.get("results"), list) else out.get("substitutes") if isinstance(out.get("substitutes"), list) else None
    if items is not None:
        store = str(out.get("store_id") or "4108")
        slim = []
        for it in items:
            if not isinstance(it, dict):
                slim.append(it)
                continue
            x = {k: v for k, v in it.items() if k not in _ITEM_DROP}
            if isinstance(x.get("stock"), dict) and "in_stock_at_store" in x:
                x.pop("stock")
            elif isinstance(x.get("stock"), dict):
                x["stock"] = {store: x["stock"].get(store)}
            if isinstance(x.get("scores"), dict):
                x["scores"] = {k: round(v, 3) if isinstance(v, float) else v for k, v in x["scores"].items()}
            if x.get("promo") is None:
                x.pop("promo", None)
            if x.get("list_price") == x.get("price"):
                x.pop("list_price", None)
            slim.append(x)
        out["results" if "results" in out else "substitutes"] = slim
    return out


def call_json(name: str, args: dict[str, Any]) -> str:
    result = call(name, args)
    if os.environ.get("POLICY_TRIM") == "1":
        result = trim_result(name, result)
    return json.dumps(result, separators=(",", ":"), default=str)
