"""FastMCP stdio server for the MLOps plane ("Ops Copilot").

Human approvals (approve/reject remediation, approve promote/rollback, label review) are intentionally NOT exposed:
they exist only on ops-http so the model can never approve its own actions.
"""
from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from . import copilot, mlops_top10, tools

mcp = FastMCP("ops")


def _j(d: dict) -> str:
    return json.dumps(d, separators=(",", ":"), default=str)


@mcp.tool()
def run_data_validation(category: str | None = None, semantic_dedup: bool = True, dedup_sample: int = 6000) -> str:
    """Data Quality agent (T1). Validation gates on the product catalog: missing attributes, dietary-tag coverage,
    price outliers, and near-duplicate detection in TWO passes - MinHash-LSH over titles and an embedding (bge-small
    cosine) pass with single-link clustering. Reports MinHash-only / semantic-only / combined duplicate rates and the
    pairs MinHash misses. category e.g. grocery, pet, baby, health_household. dedup_sample caps the O(n^2) pass."""
    return _j(tools.run_data_validation(category, semantic_dedup, dedup_sample))


@mcp.tool()
def generate_synthetic_attributes(sample: int = 25, max_attempts: int = 3, refresh: bool = False) -> str:
    """Data generation agent (T1, technique 2 verified synthetic data). Generates the attributes the catalog is missing
    (dietary flags, pack size, key features) with Claude, then keeps only generations that survive a schema check,
    deterministic grounding against the real ESCI product text, and an independent LLM verifier; rejected generations
    are resampled. Returns the measured acceptance rate, rejection reasons and examples.
    refresh=true re-runs the generator (costs real money and minutes); otherwise the last real run's report is returned
    with its own generated_at timestamp."""
    return _j(tools.generate_synthetic_attributes(sample, max_attempts, refresh))


@mcp.tool()
def generate_dp_query_logs(epsilon: float = 1.0, delta: float = 1e-6, sample: int = 0, refresh: bool = False) -> str:
    """Data generation agent (T1, technique 3 DP synthetic data). Synthetic query logs from the real ESCI query set via a
    differentially private histogram (Gaussian or Laplace) with an explicit sensitivity analysis and a privacy-budget
    ledger, plus a utility-vs-epsilon curve (TV distance and top-k overlap at eps 0.1/0.5/1/2/5).
    refresh=true re-runs the mechanism (seconds)."""
    return _j(tools.generate_dp_query_logs(epsilon, delta, sample, refresh))


@mcp.tool()
def run_data_selection(keep_frac: float = 0.4, n_queries: int = 200, sample: int = 0, refresh: bool = False) -> str:
    """Data generation agent (T1, technique 6 model-based data selection). Scores the catalog for informativeness with the
    index's own embedding model, keeps keep_frac of it, builds a real BM25+FAISS index over just that subset, and compares
    NDCG@10, build time and build cost against the full index AND a size-matched random subset on held-out ESCI test
    queries. refresh=true rebuilds every arm (minutes)."""
    return _j(tools.run_data_selection(keep_frac, n_queries, sample, refresh))


@mcp.tool()
def label_queries(n: int = 20) -> str:
    """Labeling agent (T2). Returns query-product items for YOU to label E/S/C/I with a confidence. Gold labels are hidden.
    Then call record_labels(batch_id, labels=[{item_id, label, confidence}])."""
    return _j(tools.label_queries(n))


@mcp.tool()
def record_labels(batch_id: str, labels: list[dict]) -> str:
    """Record model labels for a batch; computes agreement and Cohen's kappa vs held-out ESCI gold and routes
    low-confidence (<0.7) items to the human review queue."""
    return _j(tools.record_labels(batch_id, labels))


@mcp.tool()
def compute_drift(stream: str = "seasonal", window: int = 150) -> str:
    """Drift monitor agent (T0/T1). stream: seasonal | in_distribution. Embedding MMD (RBF, median heuristic) vs reference
    queries with permutation p-value, zero-result rate, label-free NDCG estimate and a window timeline. Raises an alert_id."""
    return _j(tools.compute_drift(stream, window))


@mcp.tool()
def estimate_performance(stream: str = "seasonal") -> str:
    """Label-free NDCG@10 estimate for a live query stream (retrieval-confidence regression), with trend."""
    return _j(tools.estimate_performance(stream))


@mcp.tool()
def run_mle_search(max_trials: int = 10, usd_cap: float = 0.05, n_queries: int = 120) -> str:
    """MLE search agent (T1, technique 16). Searches the ranking config space (RRF k, hybrid weights, rerank depth)
    with a greedy coordinate search: each trial registers a REAL model version and runs the REAL paired eval against
    search-svc on the dev split, inside a hard budget (trial count AND dollar cap, priced from measured wall clock).
    The test split is sealed during the search and the winner is scored on it exactly once, with a leakage-gap guard.
    A null result (the default config is already best) is a valid outcome and is reported plainly.
    The report becomes the source of remediation options for propose_remediation."""
    return _j(tools.run_mle_search(max_trials, usd_cap, n_queries))


@mcp.tool()
def run_red_team(generations: int = 8, per_generation: int = 16, usd_cap: float = 1.0) -> str:
    """Red-team agent (T1, technique 22). An attacker agent that COMPOSES new attacks from an intent library and a
    chain of mutation operators, fires them at the live injection guard, observes what was blocked, and reinforces
    the operators that got through. Returns attempts, block rate with a Wilson CI, per-OWASP-category ASR, and every
    successful attack verbatim. Successes are promoted to permanent regression cases."""
    return _j(tools.run_red_team(generations, per_generation, usd_cap))


@mcp.tool()
def propose_remediation(alert_id: str = "latest", include_ineligible: bool = False) -> str:
    """Retrain agent (T2, technique 32). Diagnoses a drift alert and proposes up to 2 remediations. The options are the
    trajectory of the technique-16 config search, so each carries a MEASURED delta and CI, not a prior. Cost uses a
    measured rebuild time and a measured live p95; the business value of an NDCG point is a labelled user-supplied
    assumption, so every option also reports its assumption-free break-even threshold and a sensitivity table.
    Returns error no_mle_search_report if run_mle_search has not been run. Each proposal needs HUMAN approval."""
    return _j(tools.propose_remediation(alert_id, include_ineligible))


@mcp.tool()
def build_candidate(remediation_id: str, presenter_worse: bool = False) -> str:
    """Build the candidate model version for an APPROVED remediation. Returns error awaiting_human_approval otherwise,
    and error not_the_approved_remediation (naming the approved id) if a different remediation is passed.
    presenter_worse=true is the demo toggle: build the same approved remediation with the reranker OFF so the eval gate fails."""
    return _j(tools.build_candidate(remediation_id, presenter_worse))


@mcp.tool()
def run_eval_suite(candidate_version: str) -> str:
    """Eval agent (T3 automatic gate). Paired NDCG@10/MRR vs champion with 95% bootstrap CI, p50/p95 latency, red-team
    injection suite, agent pass^k (if evals/results.json exists). PASS = CI lower >= -0.005 AND p95 <= 150ms AND 100% blocked."""
    return _j(tools.run_eval_suite(candidate_version))


@mcp.tool()
def gate_preregistered_candidate(candidate: str = "late_interaction", n_queries: int = 200) -> str:
    """Eval agent (T3). Put a real, previously measured null candidate (late interaction, M22) through the release gate,
    re-measured live on held-out ESCI queries with the same thresholds as run_eval_suite. Expected to FAIL."""
    return _j(tools.gate_preregistered_candidate(candidate, n_queries))


@mcp.tool()
def start_canary(version: str, pct: float = 10.0) -> str:
    """Release agent (T3 within guardrails). Start a canary on simulated replayed traffic; requires a passed eval gate; pct capped at 25."""
    return _j(tools.start_canary(version, pct))


@mcp.tool()
def get_canary_status() -> str:
    """Canary arms (requests, p50/p95 latency, NDCG@10) and guardrail state."""
    return _j(tools.get_canary_status())


@mcp.tool()
def promote(version: str) -> str:
    """Release agent (T2). Promote a version to champion. Requires a passed eval gate AND a human approval recorded in ops-http;
    otherwise returns awaiting_human_approval with the approval_id to show the human."""
    return _j(tools.promote(version))


@mcp.tool()
def rollback(version: str, reason: str) -> str:
    """Roll back a canary or champion. Automatic (T3) when the canary guardrail is breached; otherwise needs human approval (T2)."""
    return _j(tools.rollback(version, reason))


@mcp.tool()
def sign_model(version: str) -> str:
    """Sign the model artifact (config + model card) with OpenSSF model_signing (demo EC key) and verify it."""
    return _j(tools.sign_model(version))


@mcp.tool()
def verify_model_signature(version: str) -> str:
    """Verify a previously signed model artifact."""
    return _j(tools.verify_model_signature(version))


@mcp.tool()
def generate_mlbom(version: str) -> str:
    """Generate and validate a CycloneDX 1.6 ML-BOM (machine-learning-model component, model card, ESCI dataset, dependencies)."""
    return _j(tools.generate_mlbom(version))


@mcp.tool()
def get_registry() -> str:
    """Model registry: champion, candidate, versions with configs/metrics (MLflow-backed), alias history."""
    return _j(tools.get_registry())


@mcp.tool()
def get_audit_log(limit: int = 50) -> str:
    """Audit log: every action with actor (agent or human), tier, approval id, timestamp; plus pending approvals."""
    return _j(tools.get_audit_log(limit))

# ================= Ops Copilot top 10 (Phase 3): ops_mcp.copilot =================


@mcp.tool()
def incident_triage(hours: float = 72.0) -> str:
    """Incident triage / RCA card (T0). Correlates the latest drift alert, deploy/canary/gate audit entries and live canary status; every finding cites its record (alert id, audit#id, gate#id). Correlation in time is labelled, never called causal."""
    return _j(copilot.incident_triage(hours=hours))


@mcp.tool()
def metric_query(metric: str, versions: list[str] | None = None, limit: int = 12) -> str:
    """Natural-language metric query (T0). metric one of: ndcg10, p95_ms, mrr (registry), gate_ndcg_delta, gate_p95_ms (eval gates), drift_p_value, drift_mmd2 (alerts), online_agreement, slice_ndcg (query types), token_cost (ledger). Returns the series for an inline chart plus a table; unknown metrics return the catalog."""
    return _j(copilot.metric_query(metric=metric, versions=versions, limit=limit))


@mcp.tool()
def list_runbooks() -> str:
    """Runbook catalog (T0) with each runbook's autonomy tier T0-T3 and effect."""
    return _j(copilot.list_runbooks())


@mcp.tool()
def run_runbook(runbook_id: str) -> str:
    """One-click runbook executor. T0/T1/T3 runbooks run now and write an audit entry. T2 runbooks return an approval card and run ONLY after a human approves in the UI (you cannot approve). ids: drift_recheck, canary_status_check, verify_champion_signature, draft_remediation, clear_injected_latency, rerun_eval_gate, rollback_candidate."""
    return _j(copilot.run_runbook(runbook_id=runbook_id))


@mcp.tool()
def release_notes(version: str = "candidate", against: str = "champion") -> str:
    """Release notes + model card (T0) from the registry config diff, the version's latest eval gate and its ML-BOM if generated."""
    return _j(copilot.release_notes(version=version, against=against))


@mcp.tool()
def compare_versions(a: str = "champion", b: str = "candidate") -> str:
    """Compare two model versions (T0): registry metrics side by side, the paired NDCG@10 delta with 95% CI from the eval gate, and offline query-type slices."""
    return _j(copilot.compare_versions(a=a, b=b))


@mcp.tool()
def drift_explain(window: int = 150) -> str:
    """Drift explainer (T0): which query-type slices moved between the reference (ESCI dev) and the latest seasonal window, with example queries from seasonal_queries and rising terms."""
    return _j(copilot.drift_explain(window=window))


@mcp.tool()
def eval_failure_clusters() -> str:
    """Eval failures clustered by query type (T1) from the slice report, with a suggested fix per cluster. Suggestions are proposals only; nothing is changed."""
    return _j(copilot.eval_failure_clusters())


@mcp.tool()
def token_cost_report(hours: float = 168.0) -> str:
    """Cost & token dashboard (T0) from data/token_ledger.jsonl: cost and cache hit by role/model, hourly spend, and anomaly alerts (cost > 2x role median, robust z > 3.5)."""
    return _j(copilot.token_cost_report(hours=hours))


@mcp.tool()
def replay_summary(run_id: str = "latest") -> str:
    """Replay 'what went wrong' summary (T0) for a recorded run in data/agui_runs: refused/errored/slow tools, stalls, refusals, guard blocks, Critic rejections, each cited to the run record."""
    return _j(copilot.replay_summary(run_id=run_id))


@mcp.tool()
def trace_summary(trace_id: str = "latest") -> str:
    """Deep-trace summary (T0) for one turn trace in data/traces: span counts per kind, slowest spans, errors, policy refusals, zero-result searches, LLM cost and cache-read ratio, each cited to a span."""
    return _j(copilot.trace_summary(trace_id=trace_id))


@mcp.tool()
def watch_alerts(p_threshold: float = 0.05, hours: float = 24.0) -> str:
    """Proactive watch alerts (T0): eval gate red, drift p-value below threshold, canary guardrail breach, each with a suggested next action."""
    return _j(copilot.watch_alerts(p_threshold=p_threshold, hours=hours))

# ================= MLOps top 10 (MLO1-MLO10): ops_mcp.mlops_top10 =================


@mcp.tool()
def interleave_rankers(ranker_a: str = "rrf_rerank", ranker_b: str = "rrf", n_queries: int = 200, split: str = "test") -> str:
    """MLO1 team-draft interleaving pre-screen (T1): interleaves two live rankers (modes bm25|vector|rrf|rrf_rerank) on ESCI queries, clicks SIMULATED from ESCI labels; win/loss/tie, sign-test p, bootstrap CI and sensitivity vs a split A/B. Proposal only: a human decides whether to advance to A/B."""
    return _j(mlops_top10.interleave_rankers(ranker_a=ranker_a, ranker_b=ranker_b, n_queries=n_queries, split=split))


@mcp.tool()
def ab_sequential_test(control: str = "rrf_rerank", treatment: str = "rrf", alpha: float = 0.05, tau: float = 0.05) -> str:
    """MLO2 CUPED + mSPRT sequential A/B (T1) over logged data/online_sessions.jsonl: sessions re-randomised by trace id, outcome NDCG@10 of each arm's live ranking, covariate the pre-period served NDCG@10. Returns variance reduction, raw vs CUPED delta with CI and the mSPRT stopping point. A human calls ship."""
    return _j(mlops_top10.ab_sequential_test(control=control, treatment=treatment, alpha=alpha, tau=tau))


@mcp.tool()
def skew_check(version: str = "candidate", psi_threshold: float = 0.2) -> str:
    """MLO3 training-serving skew check (T2): PSI/KS per feature between data/products.parquet (training) and commerce.db serving tables. Skew above the threshold opens a skew_review approval and BLOCKS promotion of that version until a human reviews it."""
    return _j(mlops_top10.skew_check(version=version, psi_threshold=psi_threshold))


@mcp.tool()
def lineage_query(node: str = "champion", depth: int = 3) -> str:
    """MLO4 lineage graph (T0, read-only): upstream/downstream of a node (champion, candidate, v4, products.parquet, gate#12) over registry.json, mlflow.db runs/model versions, ops.db gates/remediations and commerce.db serving tables; each edge cites its record."""
    return _j(mlops_top10.lineage_query(node=node, depth=depth))


@mcp.tool()
def retrain_trigger(label_profile: str = "auto", window: int = 150) -> str:
    """MLO5 retraining trigger + DAG (T2): live drift -> label profile (fast|delayed|auto) -> slice check -> trigger rule -> alert -> build gate. Fast-label auto-fires and hands off to propose_remediation/build_candidate; delayed-label opens a retrain_signoff approval. Never promotes: promotion is always a human approval."""
    return _j(mlops_top10.retrain_trigger(label_profile=label_profile, window=window))


@mcp.tool()
def exposure_audit(mode: str = "rrf_rerank", n_queries: int = 200, split: str = "test", k: int = 10) -> str:
    """MLO6 fairness + sponsored-vs-organic exposure audit (T1): position-weighted sponsored exposure share of live top-k on ESCI queries vs the same items re-ordered by ESCI relevance, with bootstrap CI, plus brand concentration (HHI). 1P/3P is not measurable (no seller field). A human decides remediation."""
    return _j(mlops_top10.exposure_audit(mode=mode, n_queries=n_queries, split=split, k=k))


@mcp.tool()
def prompt_registry_diff(action: str = "diff", to_version: str | None = None) -> str:
    """MLO7 prompt/agent config registry with eval-on-change (T2): hashes bff prompts/models config (prompt.ts, roles.ts, config.ts) into versions in ops.db, diffs versions, and evaluates the change on data/token_ledger.jsonl turns before vs after (ok-rate, cost CI, p95). A regression opens config_regression and blocks merge. action=rollback with to_version opens a config_rollback approval; files are restored only after a human approves."""
    return _j(mlops_top10.prompt_registry_diff(action=action, to_version=to_version))


@mcp.tool()
def slo_budget_status() -> str:
    """MLO8 model SLOs + error budgets (T2): search latency <= 150 ms, agent turn success and first-token SLOs from online_sessions.jsonl and token_ledger.jsonl; burn rate, budget left, Wilson CI. An exhausted budget FREEZES releases: promote is refused until a human approves the release_freeze_override approval."""
    return _j(mlops_top10.slo_budget_status())


@mcp.tool()
def golden_set_diff(baseline: str = "rrf_rerank", candidate: str = "rrf", split: str = "test", n_queries: int = 200, fail_below: float = 0.5) -> str:
    """MLO9 golden-set regression + eval dataset versioning (T1): hashes the ESCI golden set, versions it in ops.db with a judgment diff vs the previous version (bump needs human approval), and diffs failing queries (NDCG@10 < fail_below) between two live rankers. make eval-ci runs it as a CI gate."""
    return _j(mlops_top10.golden_set_diff(baseline=baseline, candidate=candidate, split=split, n_queries=n_queries, fail_below=fail_below))


@mcp.tool()
def shadow_deploy_diff(candidate: str = "v2", champion: str = "champion", n_queries: int = 100) -> str:
    """MLO10 shadow deployment (T1): mirrors logged shopper queries (online_sessions.jsonl) to champion and candidate arms on the live search path, returns overlap@10 and latency diff with CIs; shadow results are never served to shoppers. A human approves entry to canary."""
    return _j(mlops_top10.shadow_deploy_diff(candidate=candidate, champion=champion, n_queries=n_queries))


def main():
    mcp.run()  # stdio


if __name__ == "__main__":
    main()
