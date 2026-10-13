"""policy-mcp: the ONLY MCP server the Claude CLI is given.

It proxies every shop-mcp and ops-mcp tool and applies the capability policy, the
deterministic guard rules, the CaMeL capability rule and the tier limits BEFORE
forwarding. A refused call returns a structured refusal and never reaches the
underlying tool, so the guard is enforcement rather than after-the-fact reaction.

Only the tools the current role (POLICY_ROLE=shopper|checkout|ops) may use are
registered, so `--allowedTools` is enforced server-side as well as client-side.
"""
from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from . import policy
from .forward import call_json

mcp = FastMCP("policy")

ROLE = policy.role()
ALLOWED = policy.tools_for(ROLE)


def expose(name: str):
    """Register the wrapper only when the current role is allowed to use the tool."""
    def deco(fn):
        if name in ALLOWED:
            mcp.add_tool(fn, name=name, description=(fn.__doc__ or "").strip())
        return fn
    return deco


# ------------------------------------------------------------------ shop plane
@expose("search_products")
def search_products(query: str, k: int = 8, max_price: float | None = None, dietary: list[str] | None = None,
                    store_id: str = "4108", in_stock_only: bool = True, mode: str = "rrf_rerank") -> str:
    """Search the store catalogue. dietary tags e.g. gluten_free, nut_free, vegan, lactose_free.
    mode: bm25|vector|rrf|rrf_rerank. Sponsored items are labelled and capped at 1 per 8 results."""
    return call_json("search_products", dict(query=query, k=k, max_price=max_price, dietary=dietary,
                                             store_id=store_id, in_stock_only=in_stock_only, mode=mode))


@expose("get_product")
def get_product(product_id: str) -> str:
    """Get full product details by product_id. Seller text is never included: use get_seller_listing."""
    return call_json("get_product", dict(product_id=product_id))


@expose("compare_products")
def compare_products(product_ids: list[str]) -> str:
    """Compare 2-6 products side by side as attribute rows."""
    return call_json("compare_products", dict(product_ids=product_ids))


@expose("check_store_stock")
def check_store_stock(product_id: str, store_id: str = "4108") -> str:
    """Check simulated inventory of a product at a store."""
    return call_json("check_store_stock", dict(product_id=product_id, store_id=store_id))


@expose("find_substitutes")
def find_substitutes(product_id: str, store_id: str = "4108") -> str:
    """Find scored substitutes (similarity, price delta, dietary match, in stock)."""
    return call_json("find_substitutes", dict(product_id=product_id, store_id=store_id))


@expose("plan_meal")
def plan_meal(goal: str, servings: int = 4, budget: float = 30.0, dietary: list[str] | None = None) -> str:
    """Plan a meal. Returns items, a constraint ledger (met/violated/unknown with evidence) and omissions."""
    return call_json("plan_meal", dict(goal=goal, servings=servings, budget=budget, dietary=dietary))


@expose("add_to_cart")
def add_to_cart(session_id: str, product_id: str, qty: int = 1, budget: float | None = None) -> str:
    """Add a product to the session cart. Always pass the shopper's budget. policy-mcp checks qty > 5,
    budget overruns, quarantined seller listings and untrusted-derived arguments BEFORE the tool runs:
    a refused call has blocked=true and changed nothing."""
    return call_json("add_to_cart", dict(session_id=session_id, product_id=product_id, qty=qty, budget=budget))


@expose("remove_from_cart")
def remove_from_cart(session_id: str, product_id: str, qty: int | None = None) -> str:
    """Remove a product (or qty units of it) from the cart."""
    return call_json("remove_from_cart", dict(session_id=session_id, product_id=product_id, qty=qty))


@expose("get_cart")
def get_cart(session_id: str) -> str:
    """Get the cart with totals and budget check."""
    return call_json("get_cart", dict(session_id=session_id))


@expose("create_checkout_mandate")
def create_checkout_mandate(session_id: str, spend_cap: float, merchant: str = "demo-store.example") -> str:
    """Create a signed AP2/UCP-style intent mandate for the cart. Status pending_human_approval.
    This never completes payment; a human approves in the UI."""
    return call_json("create_checkout_mandate", dict(session_id=session_id, spend_cap=spend_cap, merchant=merchant))


@expose("agent_catalog_feed")
def agent_catalog_feed(category: str, agent_id: str, signature: str | None = None) -> str:
    """Agent-as-customer catalog feed: verifies the signed agent header, applies tier and rate limit."""
    return call_json("agent_catalog_feed", dict(category=category, agent_id=agent_id, signature=signature))


@expose("agent_readiness_score")
def agent_readiness_score(category: str) -> str:
    """Score 0-100 how agent-ready a category's live catalogue data is, with per-dimension breakdown."""
    return call_json("agent_readiness_score", dict(category=category))


@expose("get_seller_listing")
def get_seller_listing(product_id: str, session_id: str | None = None) -> str:
    """Get the marketplace seller's listing text, returned as quarantined untrusted_content with injection
    signals. Reading it records a quarantine: a later add_to_cart for the same product is refused."""
    return call_json("get_seller_listing", dict(product_id=product_id, session_id=session_id))


# ------------------------------------------------------------------ ops plane
@expose("run_data_validation")
def run_data_validation(category: str | None = None) -> str:
    """Data Quality agent (T1). Validation gates on the product catalog."""
    return call_json("run_data_validation", dict(category=category))


@expose("label_queries")
def label_queries(n: int = 20) -> str:
    """Labeling agent (T2). Returns query-product items for YOU to label E/S/C/I with a confidence."""
    return call_json("label_queries", dict(n=n))


@expose("record_labels")
def record_labels(batch_id: str, labels: list[dict]) -> str:
    """Record model labels for a batch; computes agreement and kappa and routes low-confidence items to humans."""
    return call_json("record_labels", dict(batch_id=batch_id, labels=labels))


@expose("compute_drift")
def compute_drift(stream: str = "seasonal", window: int = 150) -> str:
    """Drift monitor (T0/T1). Embedding MMD vs reference queries with a permutation p-value. Raises an alert_id."""
    return call_json("compute_drift", dict(stream=stream, window=window))


@expose("estimate_performance")
def estimate_performance(stream: str = "seasonal") -> str:
    """Label-free NDCG@10 estimate for a live query stream, with trend."""
    return call_json("estimate_performance", dict(stream=stream))


@expose("propose_remediation")
def propose_remediation(alert_id: str = "latest") -> str:
    """Retrain agent (T2). Proposes remediations with cost and ROI. Each needs HUMAN approval before build_candidate."""
    return call_json("propose_remediation", dict(alert_id=alert_id))


@expose("build_candidate")
def build_candidate(remediation_id: str, presenter_worse: bool = False) -> str:
    """Build the candidate for an APPROVED remediation. policy-mcp refuses unless ops-http records a human
    approval whose subject is exactly this remediation_id."""
    return call_json("build_candidate", dict(remediation_id=remediation_id, presenter_worse=presenter_worse))


@expose("run_eval_suite")
def run_eval_suite(candidate_version: str, n_queries: int = 200) -> str:
    """Eval agent (T3 automatic gate). Paired NDCG@10/MRR vs champion with 95% bootstrap CI, p50/p95, red team."""
    return call_json("run_eval_suite", dict(candidate_version=candidate_version, n_queries=n_queries))


@expose("start_canary")
def start_canary(version: str, pct: float = 10.0) -> str:
    """Release agent (T2). Start a canary; requires a passed eval gate and a human approval; pct capped at 25."""
    return call_json("start_canary", dict(version=version, pct=pct))


@expose("get_canary_status")
def get_canary_status() -> str:
    """Canary arms (requests, p50/p95 latency, NDCG@10) and guardrail state."""
    return call_json("get_canary_status", {})


@expose("promote")
def promote(version: str) -> str:
    """Release agent (T2). Promote a version to champion. Requires a passed gate AND a human approval."""
    return call_json("promote", dict(version=version))


@expose("rollback")
def rollback(version: str, reason: str) -> str:
    """Roll back a canary or champion."""
    return call_json("rollback", dict(version=version, reason=reason))


@expose("sign_model")
def sign_model(version: str) -> str:
    """Sign the model artifact with OpenSSF model_signing (demo EC key) and verify it."""
    return call_json("sign_model", dict(version=version))


@expose("verify_model_signature")
def verify_model_signature(version: str) -> str:
    """Verify a previously signed model artifact."""
    return call_json("verify_model_signature", dict(version=version))


@expose("generate_mlbom")
def generate_mlbom(version: str) -> str:
    """Generate and validate a CycloneDX 1.6 ML-BOM."""
    return call_json("generate_mlbom", dict(version=version))


@expose("get_registry")
def get_registry() -> str:
    """Model registry: champion, candidate, versions with configs/metrics, alias history."""
    return call_json("get_registry", {})


@expose("get_audit_log")
def get_audit_log(limit: int = 50) -> str:
    """Audit log: every action with actor, tier, approval id and timestamp; plus pending approvals."""
    return call_json("get_audit_log", dict(limit=limit))


# ------------------------------------------------------------------ Ops Copilot top 10 (Phase 3)

@expose("incident_triage")
def incident_triage(hours: float = 72.0) -> str:
    """Incident triage / RCA card (T0). Correlates the latest drift alert, deploy/canary/gate audit entries and live canary status; every finding cites its record (alert id, audit#id, gate#id). Correlation in time is labelled, never called causal."""
    return call_json("incident_triage", dict(hours=hours))


@expose("metric_query")
def metric_query(metric: str, versions: list[str] | None = None, limit: int = 12) -> str:
    """Natural-language metric query (T0). metric one of: ndcg10, p95_ms, mrr (registry), gate_ndcg_delta, gate_p95_ms (eval gates), drift_p_value, drift_mmd2 (alerts), online_agreement, slice_ndcg (query types), token_cost (ledger). Returns the series for an inline chart plus a table; unknown metrics return the catalog."""
    return call_json("metric_query", dict(metric=metric, versions=versions, limit=limit))


@expose("list_runbooks")
def list_runbooks() -> str:
    """Runbook catalog (T0) with each runbook's autonomy tier T0-T3 and effect."""
    return call_json("list_runbooks", {})


@expose("run_runbook")
def run_runbook(runbook_id: str) -> str:
    """One-click runbook executor. T0/T1/T3 runbooks run now and write an audit entry. T2 runbooks return an approval card and run ONLY after a human approves in the UI (you cannot approve). ids: drift_recheck, canary_status_check, verify_champion_signature, draft_remediation, clear_injected_latency, rerun_eval_gate, rollback_candidate."""
    return call_json("run_runbook", dict(runbook_id=runbook_id))


@expose("release_notes")
def release_notes(version: str = "candidate", against: str = "champion") -> str:
    """Release notes + model card (T0) from the registry config diff, the version's latest eval gate and its ML-BOM if generated."""
    return call_json("release_notes", dict(version=version, against=against))


@expose("compare_versions")
def compare_versions(a: str = "champion", b: str = "candidate") -> str:
    """Compare two model versions (T0): registry metrics side by side, the paired NDCG@10 delta with 95% CI from the eval gate, and offline query-type slices."""
    return call_json("compare_versions", dict(a=a, b=b))


@expose("drift_explain")
def drift_explain(window: int = 150) -> str:
    """Drift explainer (T0): which query-type slices moved between the reference (ESCI dev) and the latest seasonal window, with example queries from seasonal_queries and rising terms."""
    return call_json("drift_explain", dict(window=window))


@expose("eval_failure_clusters")
def eval_failure_clusters() -> str:
    """Eval failures clustered by query type (T1) from the slice report, with a suggested fix per cluster. Suggestions are proposals only; nothing is changed."""
    return call_json("eval_failure_clusters", {})


@expose("token_cost_report")
def token_cost_report(hours: float = 168.0) -> str:
    """Cost & token dashboard (T0) from data/token_ledger.jsonl: cost and cache hit by role/model, hourly spend, and anomaly alerts (cost > 2x role median, robust z > 3.5)."""
    return call_json("token_cost_report", dict(hours=hours))


@expose("replay_summary")
def replay_summary(run_id: str = "latest") -> str:
    """Replay 'what went wrong' summary (T0) for a recorded run in data/agui_runs: refused/errored/slow tools, stalls, refusals, guard blocks, Critic rejections, each cited to the run record."""
    return call_json("replay_summary", dict(run_id=run_id))


@expose("trace_summary")
def trace_summary(trace_id: str = "latest") -> str:
    """Deep-trace summary (T0) for one turn trace in data/traces: span counts per kind, slowest spans, errors, policy refusals, zero-result searches, LLM cost and cache-read ratio, each cited to a span."""
    return call_json("trace_summary", dict(trace_id=trace_id))


@expose("watch_alerts")
def watch_alerts(p_threshold: float = 0.05, hours: float = 24.0) -> str:
    """Proactive watch alerts (T0): eval gate red, drift p-value below threshold, canary guardrail breach, each with a suggested next action."""
    return call_json("watch_alerts", dict(p_threshold=p_threshold, hours=hours))

# ------------------------------------------------------------------ MLOps top 10 (MLO1-MLO10)


@expose("interleave_rankers")
def interleave_rankers(ranker_a: str = "rrf_rerank", ranker_b: str = "rrf", n_queries: int = 200, split: str = "test") -> str:
    """MLO1 team-draft interleaving pre-screen (T1): interleaves two live rankers (modes bm25|vector|rrf|rrf_rerank) on ESCI queries, clicks SIMULATED from ESCI labels; win/loss/tie, sign-test p, bootstrap CI and sensitivity vs a split A/B. Proposal only: a human decides whether to advance to A/B."""
    return call_json("interleave_rankers", dict(ranker_a=ranker_a, ranker_b=ranker_b, n_queries=n_queries, split=split))


@expose("ab_sequential_test")
def ab_sequential_test(control: str = "rrf_rerank", treatment: str = "rrf", alpha: float = 0.05, tau: float = 0.05) -> str:
    """MLO2 CUPED + mSPRT sequential A/B (T1) over logged data/online_sessions.jsonl: sessions re-randomised by trace id, outcome NDCG@10 of each arm's live ranking, covariate the pre-period served NDCG@10. Returns variance reduction, raw vs CUPED delta with CI and the mSPRT stopping point. A human calls ship."""
    return call_json("ab_sequential_test", dict(control=control, treatment=treatment, alpha=alpha, tau=tau))


@expose("skew_check")
def skew_check(version: str = "candidate", psi_threshold: float = 0.2) -> str:
    """MLO3 training-serving skew check (T2): PSI/KS per feature between data/products.parquet (training) and commerce.db serving tables. Skew above the threshold opens a skew_review approval and BLOCKS promotion of that version until a human reviews it."""
    return call_json("skew_check", dict(version=version, psi_threshold=psi_threshold))


@expose("lineage_query")
def lineage_query(node: str = "champion", depth: int = 3) -> str:
    """MLO4 lineage graph (T0, read-only): upstream/downstream of a node (champion, candidate, v4, products.parquet, gate#12) over registry.json, mlflow.db runs/model versions, ops.db gates/remediations and commerce.db serving tables; each edge cites its record."""
    return call_json("lineage_query", dict(node=node, depth=depth))


@expose("retrain_trigger")
def retrain_trigger(label_profile: str = "auto", window: int = 150) -> str:
    """MLO5 retraining trigger + DAG (T2): live drift -> label profile (fast|delayed|auto) -> slice check -> trigger rule -> alert -> build gate. Fast-label auto-fires and hands off to propose_remediation/build_candidate; delayed-label opens a retrain_signoff approval. Never promotes: promotion is always a human approval."""
    return call_json("retrain_trigger", dict(label_profile=label_profile, window=window))


@expose("exposure_audit")
def exposure_audit(mode: str = "rrf_rerank", n_queries: int = 200, split: str = "test", k: int = 10) -> str:
    """MLO6 fairness + sponsored-vs-organic exposure audit (T1): position-weighted sponsored exposure share of live top-k on ESCI queries vs the same items re-ordered by ESCI relevance, with bootstrap CI, plus brand concentration (HHI). 1P/3P is not measurable (no seller field). A human decides remediation."""
    return call_json("exposure_audit", dict(mode=mode, n_queries=n_queries, split=split, k=k))


@expose("prompt_registry_diff")
def prompt_registry_diff(action: str = "diff", to_version: str | None = None) -> str:
    """MLO7 prompt/agent config registry with eval-on-change (T2): hashes bff prompts/models config (prompt.ts, roles.ts, config.ts) into versions in ops.db, diffs versions, and evaluates the change on data/token_ledger.jsonl turns before vs after (ok-rate, cost CI, p95). A regression opens config_regression and blocks merge. action=rollback with to_version opens a config_rollback approval; files are restored only after a human approves."""
    return call_json("prompt_registry_diff", dict(action=action, to_version=to_version))


@expose("slo_budget_status")
def slo_budget_status() -> str:
    """MLO8 model SLOs + error budgets (T2): search latency <= 150 ms, agent turn success and first-token SLOs from online_sessions.jsonl and token_ledger.jsonl; burn rate, budget left, Wilson CI. An exhausted budget FREEZES releases: promote is refused until a human approves the release_freeze_override approval."""
    return call_json("slo_budget_status", dict())


@expose("golden_set_diff")
def golden_set_diff(baseline: str = "rrf_rerank", candidate: str = "rrf", split: str = "test", n_queries: int = 200, fail_below: float = 0.5) -> str:
    """MLO9 golden-set regression + eval dataset versioning (T1): hashes the ESCI golden set, versions it in ops.db with a judgment diff vs the previous version (bump needs human approval), and diffs failing queries (NDCG@10 < fail_below) between two live rankers. make eval-ci runs it as a CI gate."""
    return call_json("golden_set_diff", dict(baseline=baseline, candidate=candidate, split=split, n_queries=n_queries, fail_below=fail_below))


@expose("shadow_deploy_diff")
def shadow_deploy_diff(candidate: str = "v2", champion: str = "champion", n_queries: int = 100) -> str:
    """MLO10 shadow deployment (T1): mirrors logged shopper queries (online_sessions.jsonl) to champion and candidate arms on the live search path, returns overlap@10 and latency diff with CIs; shadow results are never served to shoppers. A human approves entry to canary."""
    return call_json("shadow_deploy_diff", dict(candidate=candidate, champion=champion, n_queries=n_queries))


def main():
    mcp.run()  # stdio


if __name__ == "__main__":
    main()
