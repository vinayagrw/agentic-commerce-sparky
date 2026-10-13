"""ops-mcp tool implementations (plain functions returning compact dicts; wrapped by server.py).

Every result carries: provenance, ui {surface}, agent, tier. Human approvals are recorded ONLY through ops-http.
Tiers: T0 observe, T1 recommend, T2 act with human approval, T3 act within guardrails.
"""
from __future__ import annotations

import functools
import json
import time

from . import datagen, db, dq, labeling, measure, mlbom, mle_search, redteam, search_client, signing
from .db import DATA, EVALS
from .search_client import SearchUnavailable

NDCG_CI_FLOOR, P95_MAX_MS, CANARY_MAX_PCT = -0.005, 150.0, 25.0
OPS_HTTP = "http://127.0.0.1:8803"

# ---------------- cost model (technique 32 cost-aware retrain, 33 remediation tiers) ----------------
# Two of these three used to be hand-written constants. They are now measured at call time
# (ops_mcp.measure), and the one that genuinely cannot be measured on a laptop - the business
# value of an NDCG point - is an explicit user-supplied assumption whose effect on the verdict
# is published as a break-even threshold and a sensitivity table.
USD_PER_CPU_MIN = measure.USD_PER_CPU_MIN
HORIZON_DAYS = 30
MIN_ROI = 10.0

# The remediation options are no longer a hand-written MENU. They are the trajectory of a real
# config-space search (technique 16, ops_mcp.mle_search), so every option's expected gain is a
# measurement with a bootstrap CI rather than a prior somebody typed.
SEARCH_REPORT = DATA / "mle_search_report.json"


def _meta(agent: str, tier: str, ui: str, source: str = "ops-mcp", **extra) -> dict:
    return {"agent": agent, "tier": tier, "ui": {"surface": ui},
            "provenance": {"service": "ops-mcp", "source": source, "ts": round(time.time(), 3), **extra}}


def _guard(agent: str, tier: str, ui: str):
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            try:
                return fn(*a, **kw)
            except SearchUnavailable as e:
                db.audit(agent, tier, fn.__name__, outcome="error", detail={"error": str(e)})
                return {"error": "search_svc_unavailable", "detail": str(e), **_meta(agent, tier, ui, "search-svc")}
        return wrapper
    return deco


def _registry() -> dict:
    return search_client.call("GET", "/models")


def _record(version: str) -> dict:
    reg = _registry()
    vid = reg.get(version) if version in ("champion", "candidate") else version
    for v in reg["versions"]:
        if v["version"] == vid:
            return v
    raise KeyError(f"unknown model version {version}")


# ================= Data Quality agent =================
def run_data_validation(category: str | None = None, semantic_dedup: bool = True, dedup_sample: int = 6000) -> dict:
    r = dq.run(category, semantic_dedup=semantic_dedup, dedup_sample=dedup_sample or None)
    sem = r.get("semantic_dedup") or {}
    db.audit("data-quality-agent", "T1", "run_data_validation", category or "all",
             detail={"verdict": r.get("verdict"), "combined_dup_rate": (sem.get("combined") or {}).get("duplicate_rate")})
    return {**r, **_meta("data-quality-agent", "T1", "dq_report", "data/products.parquet + data/embeddings.npy",
                         techniques=[4, 5])}


# ================= Data generation / selection agent (techniques 2, 3, 6) =================
def generate_synthetic_attributes(sample: int = 25, max_attempts: int = 3, refresh: bool = False) -> dict:
    r = datagen.synth_attributes(sample, max_attempts, refresh)
    res = r.get("results") or {}
    db.audit("data-generation-agent", "T1", "generate_synthetic_attributes", f"sample={sample}",
             outcome=r.get("status"), detail={"acceptance_rate": res.get("acceptance_rate"), "refresh": refresh})
    return {**r, **_meta("data-generation-agent", "T1", "dq_report", "scripts/synth_attributes.py -> data/synth_attributes.json",
                         techniques=[2])}


def generate_dp_query_logs(epsilon: float = 1.0, delta: float = 1e-6, sample: int = 0, refresh: bool = False) -> dict:
    r = datagen.dp_query_logs(epsilon, delta, sample, refresh)
    db.audit("data-generation-agent", "T1", "generate_dp_query_logs", f"eps={epsilon}", outcome=r.get("status"),
             detail={"total_epsilon": (r.get("privacy_ledger") or {}).get("total_epsilon"), "refresh": refresh})
    return {**r, **_meta("data-generation-agent", "T1", "dq_report", "scripts/dp_query_logs.py -> data/dp_query_logs.json",
                         techniques=[3])}


def run_data_selection(keep_frac: float = 0.4, n_queries: int = 200, sample: int = 0, refresh: bool = False) -> dict:
    r = datagen.select_data(keep_frac, n_queries, sample, refresh)
    cmp = r.get("comparison") or {}
    db.audit("data-generation-agent", "T1", "run_data_selection", f"keep_frac={keep_frac}", outcome=r.get("status"),
             detail={k: cmp.get(k) for k in ("ndcg10_full", "ndcg10_selected", "ndcg10_random_baseline")} | {"refresh": refresh})
    return {**r, **_meta("data-generation-agent", "T1", "eval_gate", "scripts/select_data.py -> data/selection_report.json",
                         techniques=[6])}


# ================= Labeling agent =================
def label_queries(n: int = 20) -> dict:
    r = labeling.sample(n)
    db.audit("labeling-agent", "T2", "label_queries", r["batch_id"], detail={"n": r["n"]})
    return {**r, **_meta("labeling-agent", "T2", "label_queue", "data/qrels_dev.parquet", techniques=[1, 19])}


def record_labels(batch_id: str, labels: list[dict]) -> dict:
    r = labeling.record(batch_id, labels)
    db.audit("labeling-agent", "T2", "record_labels", batch_id,
             detail={k: r.get(k) for k in ("labeled", "agreement", "cohens_kappa")} | {"review_queue": len(r.get("human_review_queue", []))})
    r["next"] = f"low-confidence items await human review via ops-http POST {OPS_HTTP}/labels/review (not an MCP tool)"
    return {**r, **_meta("labeling-agent", "T2", "label_queue", "ESCI gold (held out)", techniques=[1, 19])}


# ================= Eval agent =================
def _passk_results() -> dict | None:
    f = EVALS / "results.json"
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text()).get("pass_k")
    except Exception:
        return None


@_guard("eval-agent", "T3", "eval_gate")
def run_eval_suite(candidate_version: str, n_queries: int = 200) -> dict:
    cmp = search_client.call("POST", "/eval/compare", {"champion": "champion", "candidate": candidate_version,
                                                        "split": "test", "n_queries": n_queries})
    rt = redteam.run()
    pk = _passk_results()
    nd = cmp["metrics"]["ndcg10"]
    checks = {
        "ndcg_delta_ci_lower_ge_-0.005": {"value": nd["delta"]["ci95"][0], "passed": nd["delta"]["ci95"][0] >= NDCG_CI_FLOOR},
        "p95_latency_le_150ms": {"value": cmp["latency"]["candidate"]["p95_ms"], "passed": cmp["latency"]["candidate"]["p95_ms"] <= P95_MAX_MS},
        "injection_suite_100pct_blocked": {"value": rt["blocked_rate"], "passed": rt["blocked_rate"] == 1.0},
    }
    # B10: per-language bypass-class gate over data/redteam_findings.json (+ data/bypass_overrides.json).
    from .bypass_gate import gate_from_findings
    _bg = gate_from_findings()
    checks["bypass_classes_closed_or_overridden"] = {
        "value": {"open": [c["class"] for c in _bg["classes"] if c["status"] == "open"],
                  "overridden": _bg["overrides_applied"], "reasons": _bg["reasons"]},
        "passed": not _bg["release_blocked"]}
    passed = all(c["passed"] for c in checks.values())
    version = cmp["candidate"]
    summary = {"champion": cmp["champion"], "candidate": version, "n_queries": cmp["n_queries"],
               "ndcg10": {"champion": nd["champion"], "candidate": nd["candidate"], "delta": nd["delta"]["mean"], "ci95": nd["delta"]["ci95"],
                          "wins_losses_ties": [nd["wins"], nd["losses"], nd["ties"]]},
               "mrr": {"champion": cmp["metrics"]["mrr"]["champion"], "candidate": cmp["metrics"]["mrr"]["candidate"],
                       "delta": cmp["metrics"]["mrr"]["delta"]["mean"], "ci95": cmp["metrics"]["mrr"]["delta"]["ci95"]},
               "latency": cmp["latency"]}
    db.record_gate(version, passed, {"checks": checks, **summary})
    db.audit("eval-agent", "T3", "run_eval_suite", version, outcome="gate_passed" if passed else "gate_failed",
             detail={k: v["value"] for k, v in checks.items()})
    return {"verdict": "PASS" if passed else "FAIL", "gate_passed": passed, "checks": checks, **summary,
            "red_team": {**{k: rt[k] for k in ("attacks", "blocked", "blocked_rate", "false_positives")},
                         "open_findings": rt.get("open_findings")},
            "agent_pass_k": pk or {"status": "not_run", "hint": "run scripts/run_evals.py to produce evals/results.json"},
            "method": cmp["method"],
            **_meta("eval-agent", "T3", "eval_gate", "search-svc /eval/compare + evals/tasks.yaml", techniques=[18, 20, 21, 22])}


# ================= Gate goes red: a real preregistered null goes through the gate (B08) =================
# The candidate is NOT a presenter toggle. It is a change we built and measured earlier (technique 9, late
# interaction; routing record M22) whose result went against us. The gate re-measures it LIVE on the same
# held-out queries with the same thresholds run_eval_suite uses, so whatever it shows was computed now.
PREREGISTERED_CANDIDATES = {
    "late_interaction": {
        "label": "Late interaction (MaxSim over bge-small tokens) replacing the cross-encoder rerank",
        "record": "M22 (routing record D13); prior measurement services/search-svc/SOTA_MEASURED.json technique 9",
        "endpoint": "/eval/late_interaction",
        "comparison": "vs_production_hybrid_rerank",
        "candidate_arm": "late_interaction_maxsim",
        "champion_arm": "hybrid_rrf_rerank",
    },
}


def gate_check_rows(checks: dict, thresholds: dict) -> list[dict]:
    """Flatten gate checks into display rows: name, measured value, threshold, passed. Failing rows first."""
    rows = [{"check": k, "value": v.get("value"), "threshold": thresholds.get(k), "passed": bool(v.get("passed"))}
            for k, v in checks.items()]
    return sorted(rows, key=lambda r: r["passed"])


@_guard("eval-agent", "T3", "eval_gate")
def gate_preregistered_candidate(candidate: str = "late_interaction", n_queries: int = 200) -> dict:
    spec = PREREGISTERED_CANDIDATES.get(candidate)
    if not spec:
        return {"error": f"unknown preregistered candidate {candidate!r}", "known": sorted(PREREGISTERED_CANDIDATES),
                **_meta("eval-agent", "T3", "eval_gate")}
    t0 = time.time()
    r = search_client.call("POST", spec["endpoint"], {"split": "test", "n_queries": n_queries})
    cmp = r["comparisons"][spec["comparison"]]
    champ, cand = r["arms"][spec["champion_arm"]], r["arms"][spec["candidate_arm"]]
    rt = redteam.run()
    ci = cmp["delta"]["ci95"]
    thresholds = {"ndcg_delta_ci_lower_ge_-0.005": f">= {NDCG_CI_FLOOR}", "p95_latency_le_150ms": f"<= {P95_MAX_MS} ms",
                  "injection_suite_100pct_blocked": "== 1.0"}
    checks = {
        "ndcg_delta_ci_lower_ge_-0.005": {"value": ci[0], "passed": ci[0] is not None and ci[0] >= NDCG_CI_FLOOR},
        "p95_latency_le_150ms": {"value": cand["latency_p95_ms"], "passed": cand["latency_p95_ms"] <= P95_MAX_MS},
        "injection_suite_100pct_blocked": {"value": rt["blocked_rate"], "passed": rt["blocked_rate"] == 1.0},
    }
    passed = all(c["passed"] for c in checks.values())
    version = f"prereg:{candidate}"
    summary = {"champion": f"production ({spec['champion_arm']})", "candidate": version, "n_queries": r["n_queries"],
               "ndcg10": {"champion": champ["ndcg10"], "candidate": cand["ndcg10"], "delta": cmp["delta"]["mean"],
                          "ci95": ci, "wins_losses_ties": [cmp["wins"], cmp["losses"], cmp["ties"]]},
               "latency": {"champion": {"p50_ms": champ["latency_p50_ms"], "p95_ms": champ["latency_p95_ms"]},
                           "candidate": {"p50_ms": cand["latency_p50_ms"], "p95_ms": cand["latency_p95_ms"]}}}
    db.record_gate(version, passed, {"checks": checks, **summary})
    db.audit("eval-agent", "T3", "gate_preregistered_candidate", version, outcome="gate_passed" if passed else "gate_failed",
             detail={k: v["value"] for k, v in checks.items()})
    return {"verdict": "PASS" if passed else "FAIL", "gate_passed": passed, "checks": checks,
            "check_rows": gate_check_rows(checks, thresholds), "thresholds": thresholds,
            "failing_checks": [k for k, v in checks.items() if not v["passed"]], **summary,
            "preregistered": {"candidate": candidate, "label": spec["label"], "record": spec["record"],
                              "paired_verdict": cmp["verdict"]},
            "red_team": {k: rt[k] for k in ("attacks", "blocked", "blocked_rate", "false_positives")},
            "method": cmp["method"], "live": True, "seconds": round(time.time() - t0, 1),
            **_meta("eval-agent", "T3", "eval_gate", f"search-svc POST {spec['endpoint']} (live) + redteam seed suite",
                    techniques=[9, 18, 20])}


# ================= Red team agent (technique 22) =================
def run_red_team(generations: int = 8, per_generation: int = 16, usd_cap: float = 1.0, seed: int | None = None) -> dict:
    """Adaptive attacker agent against the live guard. Reports successes verbatim."""
    r = redteam.adaptive_run(generations=generations, per_generation=per_generation, usd_cap=usd_cap, seed=seed)
    db.audit("red-team-agent", "T1", "run_red_team", outcome=r["verdict"],
             detail={"attempts": r["attempts"], "blocked": r["blocked"], "asr": r["attack_success_rate"],
                     "usd": r["spent"]["usd"], "new_regression_cases": len(r["regression_cases_added"])})
    return {**r, **_meta("red-team-agent", "T1", "eval_gate", "shop_mcp.injection + policy_mcp.policy", techniques=[22, 27])}


# ================= Drift monitor agent =================
def _compact_drift(d: dict) -> dict:
    tl = [{k: w[k] for k in ("window", "seasonal_fraction", "mmd2", "p_value", "alert", "zero_result_rate", "est_ndcg10")} for w in d["timeline"]]
    return {"stream": d["stream"], "window": d["window"], "current": d["current"], "reference": d["reference"],
            "performance_estimator": d["performance_estimator"], "timeline": tl,
            "example_queries_latest_window": d["timeline"][-1]["sample_queries"], "stream_source": d["stream_source"]}


@_guard("drift-monitor-agent", "T0", "drift_chart")
def compute_drift(stream: str = "seasonal", window: int = 150) -> dict:
    d = _compact_drift(search_client.call("POST", "/drift", {"stream": stream, "window": window, "n_windows": 6}))
    alert_id = None
    if d["current"]["alert"]:
        alert_id = db.new_id("alr")
        db.execute("INSERT INTO alerts(alert_id,ts,kind,detail) VALUES(?,?,?,?)", (alert_id, time.time(), "embedding_drift", json.dumps(d)))
    tier = "T1" if alert_id else "T0"
    db.audit("drift-monitor-agent", tier, "compute_drift", stream, outcome="alert" if alert_id else "no_alert",
             detail={"mmd2": d["current"]["mmd2"], "p_value": d["current"]["p_value"], "alert_id": alert_id})
    d["alert_id"] = alert_id
    d["recommendation"] = (f"Drift alert {alert_id}: call propose_remediation('{alert_id}')" if alert_id else "No action: stream matches reference")
    return {**d, **_meta("drift-monitor-agent", tier, "alert" if alert_id else "drift_chart", "search-svc /drift", techniques=[30, 31])}


@_guard("drift-monitor-agent", "T0", "drift_chart")
def estimate_performance(stream: str = "seasonal") -> dict:
    d = search_client.call("POST", "/drift", {"stream": stream, "window": 150, "n_windows": 6})
    db.audit("drift-monitor-agent", "T0", "estimate_performance", stream, detail={"est_ndcg10": d["current"]["est_ndcg10"]})
    return {"stream": stream, "estimated_ndcg10_now": d["current"]["est_ndcg10"], "estimated_delta_vs_reference": d["current"]["est_ndcg10_delta"],
            "reference_est_ndcg10": d["reference"]["est_ndcg10"], "reference_measured_ndcg10": d["reference"]["measured_ndcg10_dev200"],
            "zero_result_rate": d["current"]["zero_result_rate"], "estimator": d["performance_estimator"],
            "trend": [{"window": w["window"], "est_ndcg10": w["est_ndcg10"]} for w in d["timeline"]],
            "caveat": "label-free estimate from retrieval confidence; confirm with labels (label_queries) before large decisions",
            **_meta("drift-monitor-agent", "T0", "drift_chart", "search-svc /drift", techniques=[31])}


# ================= Retrain / remediation agent =================
def _alert(alert_id: str) -> dict | None:
    q = "SELECT * FROM alerts ORDER BY ts DESC LIMIT 1" if alert_id in ("latest", "") else "SELECT * FROM alerts WHERE alert_id=?"
    r = db.rows(q, () if alert_id in ("latest", "") else (alert_id,))
    if not r:
        return None
    return {**r[0], "detail": json.loads(r[0]["detail"])}


def cost_model(opt: dict, rebuild: dict, p95: dict, value: dict) -> dict:
    """Cost, benefit and eligibility, with every input carrying its own provenance.

    `rebuild` and `p95` are MEASURED (ops_mcp.measure). `value` is a user-supplied assumption
    and may be absent - in which case no ROI is claimed and eligibility falls back to the
    break-even threshold, which needs no assumption at all.
    """
    # One rebuild for the option plus one for the eval-gate run that follows it.
    cpu_min = round(rebuild["cpu_min"] * 2, 4)
    cost = round(cpu_min * USD_PER_CPU_MIN, 6)
    risk_adj_gain = opt["expected_ndcg_gain"] * opt["confidence"]
    roi = measure.roi_view(value.get("value"), risk_adj_gain, cost, HORIZON_DAYS)
    projected_p95 = round(opt["measured_p95_ms"] if opt.get("measured_p95_ms") else p95["p95_ms"] + opt.get("latency_risk_ms", 0), 1)
    reasons = []
    if risk_adj_gain < 0.001:
        reasons.append(f"risk-adjusted gain {risk_adj_gain:+.5f} < 0.001 NDCG (measured, not assumed)")
    if roi.get("roi") is not None and roi["roi"] < MIN_ROI:
        reasons.append(f"ROI {roi['roi']} < {MIN_ROI} under the supplied value assumption")
    if projected_p95 > P95_MAX_MS:
        reasons.append(f"projected p95 {projected_p95:.0f}ms > {P95_MAX_MS:.0f}ms latency budget")
    return {"cpu_min": cpu_min, "cost_usd": cost, "risk_adjusted_gain": round(risk_adj_gain, 5),
            "cost_inputs": {
                "rebuild": {"cpu_min": rebuild["cpu_min"], "status": rebuild["status"], "how": rebuild["how"]},
                "current_p95_ms": {"value": p95["p95_ms"], "samples": p95["samples"], "status": p95["status"], "how": p95["how"]},
                "usd_per_cpu_min": {"value": USD_PER_CPU_MIN, "provenance": "assumption"},
                "value_of_ndcg": value,
            },
            "roi": roi, "projected_p95_ms": projected_p95,
            "eligible": not reasons, "blocked_by": reasons}


# ================= MLE search agent (technique 16) =================
def run_mle_search(max_trials: int = 10, usd_cap: float = 0.05, n_queries: int = 120, baseline: str = "champion") -> dict:
    """Run the real config-space search and persist its report as the remediation option source."""
    try:
        r = mle_search.search(baseline=baseline, max_trials=max_trials, usd_cap=usd_cap, n_queries=n_queries)
    except SearchUnavailable as e:
        db.audit("mle-search-agent", "T1", "run_mle_search", outcome="error", detail={"error": str(e)})
        return {"error": "search_svc_unavailable", "detail": str(e), **_meta("mle-search-agent", "T1", "eval_gate", "search-svc")}
    try:
        SEARCH_REPORT.parent.mkdir(parents=True, exist_ok=True)
        SEARCH_REPORT.write_text(json.dumps(r, indent=2))
    except OSError:
        pass
    db.audit("mle-search-agent", "T1", "run_mle_search", r["baseline"]["version"], outcome=r["verdict"],
             detail={"trials": r["spent"]["trials"], "usd": r["spent"]["usd"], "stop_reason": r["spent"]["stop_reason"]})
    return {**r, "report_path": str(SEARCH_REPORT),
            **_meta("mle-search-agent", "T1", "eval_gate", "search-svc /models/candidate + /eval/compare", techniques=[16, 20])}


def search_report() -> dict | None:
    if not SEARCH_REPORT.exists():
        return None
    try:
        return json.loads(SEARCH_REPORT.read_text())
    except (OSError, ValueError):
        return None


def options_from_search(report: dict) -> list[dict]:
    """Every remediation option is one trial of the real search, carrying its own measurement.

    `expected_ndcg_gain` is the MEASURED mean paired delta from that trial, `confidence` is
    1 - P(delta <= 0) is not available per trial, so confidence is fixed at 1.0 and the CI
    does the work instead: nothing here is a subjective prior.
    """
    base = report["baseline"]["version"]
    out = []
    for t in report["trajectory"]:
        cfg = t["config"]
        moved = [k for k, v in cfg.items() if report["baseline"]["config"].get(k) != v]
        slug = "_".join(f"{k}{cfg[k]}" for k in moved) or "baseline"
        out.append({
            "option_id": f"cfg_{slug}",
            "title": f"Rebuild with {t['move']}",
            "config": {k: cfg[k] for k in moved} or dict(cfg),
            "expected_ndcg_gain": t["ndcg10_delta"],
            "confidence": 1.0,
            "latency_risk_ms": 0,
            "measured_p95_ms": t["p95_ms"],
            "evidence": f"measured: MLE search trial {t['trial']} vs {base}, {t['n_queries']} ESCI "
                        f"{report['objective']['search_split']} queries, paired bootstrap 1000 resamples: "
                        f"{t['ndcg10_delta']:+.5f} NDCG@10, CI95 {t['ci95']}, p95 {t['p95_ms']}ms",
            "measured": {"vs_champion": base, "ndcg10_delta": t["ndcg10_delta"], "ci95": t["ci95"],
                         "p95_ms": t["p95_ms"], "split": report["objective"]["search_split"],
                         "n_queries": t["n_queries"], "version": t["version"],
                         "note": "measured by the technique-16 search, not a prior"},
        })
    return out


def gate_outlook(opt: dict, champion: str | None, projected_p95: float, applied_in_champion: bool = False) -> dict:
    """Honest forecast of what the eval gate will say about this option, and why.

    `likely_pass` only when a real measurement against the CURRENT champion clears both gate checks
    (NDCG@10 CI lower bound >= NDCG_CI_FLOOR and p95 <= P95_MAX_MS). Anything unmeasured stays `unproven`:
    the gate, not this forecast, decides — a presenter can still approve an option flagged `likely_fail`.
    """
    m = opt.get("measured")
    if m and champion and m["vs_champion"] == champion:
        ci_lo, p95 = m["ci95"][0], m["p95_ms"]
        checks = {"ndcg_ci_lower_ge_floor": ci_lo >= NDCG_CI_FLOOR, "p95_latency_le_max": p95 <= P95_MAX_MS}
        expectation = "likely_pass" if all(checks.values()) else "likely_fail"
        failing = [k.replace("_", " ") for k, v in checks.items() if not v]
        risk = ("measured on this champion; the gate re-runs it live, so a re-measure can still move the CI"
                if expectation == "likely_pass"
                else f"expected to FAIL the gate on: {', '.join(failing)} — approving it is a legitimate 'the gate stops a bad model' demo")
        return {"expectation": expectation,
                "basis": f"measured vs champion {champion} ({m.get('n_queries', '?')} ESCI {m.get('split', 'test')} "
                         f"queries, paired bootstrap 1000 resamples)",
                "ndcg10_delta": m["ndcg10_delta"], "ci95": m["ci95"], "gate_checks": checks,
                "projected_p95_ms": p95, "risk": risk, "note": m.get("note"),
                "applied_in_champion": applied_in_champion}
    reason = "no measurement against the live champion" if not m else f"measurement is against champion {m['vs_champion']}, not {champion}"
    return {"expectation": "unproven", "basis": f"prior only ({reason})", "ndcg10_delta": opt["expected_ndcg_gain"],
            "ci95": None, "gate_checks": None, "projected_p95_ms": projected_p95,
            "risk": f"expected +{opt['expected_ndcg_gain']:.4f} NDCG@10 at confidence {opt['confidence']:.0%}; it may not clear the "
                    f"{NDCG_CI_FLOOR:+.3f} CI floor — the eval gate is the decision point",
            "note": opt.get("evidence"), "applied_in_champion": applied_in_champion}


def propose_remediation(alert_id: str = "latest", include_ineligible: bool = False) -> dict:
    alert = _alert(alert_id)
    if not alert:
        return {"error": f"unknown alert {alert_id}; run compute_drift first", **_meta("retrain-agent", "T1", "alert")}
    cur = alert["detail"]["current"]
    trigger = bool(cur["alert"] and (cur["est_ndcg10_delta"] <= -0.02 or cur["zero_result_rate"] > 0.05))

    report = search_report()
    if not report:
        # No invented menu to fall back on. The options ARE the search.
        return {"error": "no_mle_search_report",
                "detail": f"remediation options come from a real config-space search (technique 16) and there is no "
                          f"report at {SEARCH_REPORT}. Run run_mle_search() first; nothing will be proposed from a "
                          f"hand-written menu.",
                "fix": "run_mle_search(max_trials=10, usd_cap=0.05)",
                **_meta("retrain-agent", "T1", "alert")}
    try:
        rebuild = measure.measure_rebuild()
        p95 = measure.measure_p95()
        reg = _registry()
        champ = reg["champion"]
        champ_cfg = next((v["config"] for v in reg["versions"] if v["version"] == champ), {})
    except SearchUnavailable as e:
        return {"error": "search_svc_unavailable",
                "detail": f"the cost model needs a measured rebuild cost and a measured p95, both of which come from "
                          f"search-svc: {e}. No constant is substituted.",
                **_meta("retrain-agent", "T1", "alert", "search-svc")}
    value = measure.value_assumption()

    scored = []
    for o in options_from_search(report):
        applied = bool(champ_cfg) and all(champ_cfg.get(k) == v for k, v in o["config"].items())
        c = cost_model(o, rebuild, p95, value)
        outlook = gate_outlook(o, champ, c["projected_p95_ms"], applied)
        if applied:
            # Not a blocker: rebuilding a config the champion already carries is the zero-risk option (it reproduces
            # the champion), so it stays on the menu — but say so plainly instead of advertising a gain it will not deliver.
            c = {**c, "already_in_champion": champ, "expected_gain_note": f"config already live in champion {champ}: expect no NDCG gain"}
        scored.append({**o, "cost": c, "gate_outlook": outlook})
    # Recommended first: an option the gate is expected to clear outranks a better-ROI gamble.
    # With no value assumption supplied there is no ROI to sort on, so the tie-break is the
    # LOWEST break-even threshold, which is the assumption-free version of "best value".
    def _rank(o):
        roi = o["cost"]["roi"]
        be = roi.get("break_even_usd_per_001_ndcg_day")
        return (0 if o["gate_outlook"]["expectation"] == "likely_pass" else 1,
                -(roi.get("roi") or 0.0),
                be if be is not None else float("inf"))

    eligible = sorted([o for o in scored if o["cost"]["eligible"]], key=_rank)
    override = False
    if not eligible and include_ineligible and scored:
        # A HUMAN asked to see the best measured option even though the cost policy rejects
        # every one of them. It goes on the table labelled for exactly what it is: the gate is
        # expected to stop it, and that outcome is the point of the exercise.
        override = True
        eligible = sorted(scored, key=lambda o: -o["expected_ndcg_gain"])[:1]
        for o in eligible:
            o["cost"] = {**o["cost"], "policy_override": "human asked for an ineligible option (include_ineligible=True)",
                         "still_blocked_by": o["cost"]["blocked_by"]}
    proposals = []
    if trigger:
        for i, o in enumerate(eligible[:2]):
            rid = db.new_id("rem")
            appr = db.request_approval("remediation", rid, "retrain-agent", f"{o['title']} (alert {alert['alert_id']})")
            db.execute("INSERT INTO remediations(remediation_id,alert_id,option_id,body,status,created_at) VALUES(?,?,?,?,?,?)",
                       (rid, alert["alert_id"], o["option_id"], json.dumps(o), "pending_approval", time.time()))
            proposals.append({"remediation_id": rid, "approval_id": appr["approval_id"], "approval_status": appr["status"],
                              "rank": i + 1, "recommended": i == 0,
                              "recommendation_reason": ("recommended: expected to clear the eval gate"
                                                        if o["gate_outlook"]["expectation"] == "likely_pass"
                                                        else f"highest ROI of the remaining options ({o['gate_outlook']['expectation']} at the gate)")
                              if i == 0 else o["gate_outlook"]["risk"],
                              **o})
    diagnosis = (f"Query mix shifted (MMD²={cur['mmd2']}, p={cur['p_value']}); estimated NDCG@10 {cur['est_ndcg10']} "
                 f"({cur['est_ndcg10_delta']:+.3f} vs reference); top-1 retrieval confidence {cur['top1_cosine_delta']:+.3f}. "
                 f"New seasonal intents, e.g. {alert['detail'].get('example_queries_latest_window', [])[:3]}, are under-covered.")
    db.audit("retrain-agent", "T2", "propose_remediation", alert["alert_id"], outcome="proposed" if proposals else "no_trigger",
             detail={"proposals": [p["remediation_id"] for p in proposals]})
    return {"alert_id": alert["alert_id"], "diagnosis": diagnosis,
            "recommended_option_id": proposals[0]["option_id"] if (proposals and not override) else None,
            "no_eligible_option": (not proposals) or override,
            "no_eligible_option_reason": (
                None if (proposals and not override) else
                f"The technique-16 search found nothing better than champion {champ}: every option's MEASURED "
                f"risk-adjusted gain is <= 0 and/or its measured p95 breaks the {P95_MAX_MS:.0f}ms budget. The cost-aware "
                f"trigger therefore denies the retrain, which is the correct answer and is logged as such. "
                + ("A human overrode that with include_ineligible=True: the option below is expected to FAIL the eval gate."
                   if override else
                   "Call propose_remediation(include_ineligible=True) to put the best measured option on the table anyway, "
                   "labelled as expected to fail the gate.")),
            "ordering": "proposals are ordered recommended-first: options the eval gate is expected to clear rank above "
                        "higher-ROI but unproven ones. Each carries its measured or expected ΔNDCG@10 and its gate risk; "
                        "the eval gate still decides and may FAIL any of them.",
            "trigger_rule": {"fired": trigger, "rule": "drift alert AND (est NDCG delta <= -0.02 OR zero-result rate > 5%); "
                             f"option eligible if the MEASURED risk-adjusted gain >= 0.001 NDCG and projected p95 <= "
                             f"{P95_MAX_MS:.0f}ms, and - only when a value assumption is supplied - ROI >= {MIN_ROI}"},
            "proposals": proposals, "not_eligible": [{"option_id": o["option_id"], "blocked_by": o["cost"]["blocked_by"]} for o in scored if not o["cost"]["eligible"]],
            "option_source": {"technique": 16, "report": str(SEARCH_REPORT), "verdict": report["verdict"],
                              "headline": report["headline"], "trials": report["spent"]["trials"],
                              "note": "options are the trajectory of a real config-space search; each one's expected gain "
                                      "is that trial's measured paired delta with a bootstrap CI, not a prior"},
            "measured_inputs": {"rebuild_cost": rebuild, "current_p95": p95},
            "assumptions": {"usd_per_cpu_min": {"value": USD_PER_CPU_MIN, "provenance": "assumption",
                                                "note": "laptop CPU rate; the CPU-minutes it multiplies are measured"},
                            "value_of_ndcg": value,
                            "horizon_days": HORIZON_DAYS,
                            "note": "exactly one number here is an assumption, and it is the one that cannot be measured "
                                    "on a laptop. Every option carries a break-even threshold and a sensitivity table so "
                                    "the reader can see how much of the verdict rests on it."},
            "next": f"A HUMAN must approve one proposal in the UI (ops-http POST {OPS_HTTP}/approvals/<approval_id>/approve). The agent cannot approve.",
            **_meta("retrain-agent", "T2", "approval", "ops.db alerts + technique-16 search report", techniques=[16, 32, 33])}


@_guard("retrain-agent", "T2", "registry")
def _approved_unbuilt_remediation() -> dict | None:
    """The one remediation a human has approved and that has not been built yet (deterministic target for build_candidate)."""
    for r in db.rows("SELECT * FROM remediations WHERE candidate_version IS NULL ORDER BY created_at DESC"):
        a = db.approval_for("remediation", r["remediation_id"])
        if a and a["status"] == "approved":
            return r
    return None


def build_candidate(remediation_id: str, presenter_worse: bool = False) -> dict:
    rem = db.rows("SELECT * FROM remediations WHERE remediation_id=?", (remediation_id,))
    appr = db.approval_for("remediation", remediation_id) if rem else None
    if not rem or not appr or appr["status"] != "approved":
        # Deterministic: never build anything but the id the human actually approved.
        target = _approved_unbuilt_remediation()
        db.audit("retrain-agent", "T2", "build_candidate", remediation_id, appr and appr["approval_id"],
                 outcome="blocked_wrong_remediation" if target else "blocked_awaiting_approval")
        if target:
            return {"error": "not_the_approved_remediation", "remediation_id": remediation_id,
                    "approved_remediation_id": target["remediation_id"],
                    "detail": f"{remediation_id} is not approved. The human approved {target['remediation_id']}; "
                              f"call build_candidate('{target['remediation_id']}') instead. Do NOT propose again.",
                    **_meta("retrain-agent", "T2", "approval")}
        return {"error": "awaiting_human_approval", "remediation_id": remediation_id,
                "approval_id": appr and appr["approval_id"], "approval_status": appr and appr["status"],
                "detail": "T2 action: a human must approve this remediation via ops-http; agents cannot approve.",
                **_meta("retrain-agent", "T2", "approval")}
    if rem[0]["candidate_version"]:
        return {"status": "already_built", "candidate_version": rem[0]["candidate_version"], **_meta("retrain-agent", "T2", "registry")}
    body = json.loads(rem[0]["body"])
    cfg = {**body["config"], "reranker": False} if presenter_worse else body["config"]
    note = f"{body['option_id']} for {rem[0]['alert_id']} ({remediation_id}, {appr['approval_id']})"
    if presenter_worse:
        note += " [presenter toggle: reranker OFF, expected to fail the gate]"
    r = search_client.call("POST", "/models/candidate", {"config": cfg, "actor": "retrain-agent", "note": note})
    db.execute("UPDATE remediations SET status='built', candidate_version=? WHERE remediation_id=?", (r["version"], remediation_id))
    db.audit("retrain-agent", "T2", "build_candidate", r["version"], appr["approval_id"],
             detail={"option": body["option_id"], "build": r.get("build"), "presenter_worse": presenter_worse})
    return {"status": "built", "candidate_version": r["version"], "config": r["config"], "build": r.get("build"), "mlflow": r.get("mlflow"),
            "approval_id": appr["approval_id"], "approved_by": appr["decided_by"], "presenter_worse": presenter_worse,
            "remediation_id": remediation_id,
            "next": f"run_eval_suite('{r['version']}')", **_meta("retrain-agent", "T2", "registry", "search-svc /models/candidate", techniques=[32, 33])}


# ================= Release agent =================
@_guard("release-agent", "T3", "canary")
def start_canary(version: str, pct: float = 10.0) -> dict:
    gate = db.latest_gate(version)
    if not gate or not gate["passed"]:
        db.audit("release-agent", "T3", "start_canary", version, outcome="blocked_gate")
        return {"error": "eval_gate_not_passed", "version": version, "gate": gate and gate["detail"].get("checks"),
                **_meta("release-agent", "T3", "eval_gate")}
    pct = min(float(pct), CANARY_MAX_PCT)
    st = search_client.call("POST", "/canary", {"version": version, "traffic_pct": pct, "actor": "release-agent"})
    db.audit("release-agent", "T3", "start_canary", version, detail={"traffic_pct": pct})
    return {**st, "note": f"T3 within guardrails: traffic capped at {CANARY_MAX_PCT:.0f}%; guardrail watcher in ops-http auto-rolls back on breach",
            **_meta("release-agent", "T3", "canary", "search-svc /canary", techniques=[28])}


@_guard("release-agent", "T0", "canary")
def get_canary_status() -> dict:
    return {**search_client.call("GET", "/canary/status"), **_meta("release-agent", "T0", "canary", "search-svc /canary/status", techniques=[28])}


@_guard("release-agent", "T2", "registry")
def promote(version: str) -> dict:
    gate = db.latest_gate(version)
    if not gate or not gate["passed"]:
        db.audit("release-agent", "T2", "promote", version, outcome="blocked_gate")
        return {"error": "eval_gate_not_passed", "version": version, **_meta("release-agent", "T2", "eval_gate")}
    from .mlops_top10 import skew_blocks  # MLO3: unresolved training-serving skew blocks promotion

    skew = skew_blocks(version)
    if skew:
        db.audit("release-agent", "T2", "promote", version, skew["approval_id"], outcome="blocked_skew")
        return {"error": "training_serving_skew_unreviewed", "version": version, "approval_id": skew["approval_id"], "approval_status": skew["status"],
                "detail": f"skew_check flagged {version}; a human must approve skew review {skew['approval_id']} before promotion",
                **_meta("release-agent", "T2", "approval")}
    from .mlops_top10 import freeze_blocks  # MLO8: an exhausted error budget freezes releases until a human override

    freeze = freeze_blocks()
    if freeze:
        db.audit("release-agent", "T2", "promote", version, freeze["approval_id"], outcome="blocked_release_freeze")
        return {"error": "release_freeze", "version": version, "approval_id": freeze["approval_id"], "approval_status": freeze["status"],
                "detail": f"error budget exhausted ({freeze['summary']}); a human must approve freeze override {freeze['approval_id']} before promotion",
                **_meta("release-agent", "T2", "approval")}
    appr = db.approval_for("promote", version)
    if not appr or appr["status"] != "approved":
        if not appr or appr["status"] == "rejected":
            appr = db.request_approval("promote", version, "release-agent", f"Promote {version} to champion (gate passed)")
        db.audit("release-agent", "T2", "promote", version, appr["approval_id"], outcome="blocked_awaiting_approval")
        return {"error": "awaiting_human_approval", "version": version, "approval_id": appr["approval_id"], "approval_status": appr["status"],
                "detail": f"a human must approve via ops-http POST {OPS_HTTP}/approvals/{appr['approval_id']}/approve",
                **_meta("release-agent", "T2", "approval")}
    r = search_client.call("POST", "/models/promote", {"version": version, "actor": "release-agent", "reason": f"approved {appr['approval_id']}"})
    db.audit("release-agent", "T2", "promote", version, appr["approval_id"], detail=r)
    return {**r, "approval_id": appr["approval_id"], "approved_by": appr["decided_by"],
            "next": f"sign_model('{version}') and generate_mlbom('{version}')", **_meta("release-agent", "T2", "registry", "search-svc /models/promote", techniques=[28])}


@_guard("release-agent", "T3", "canary")
def rollback(version: str, reason: str) -> dict:
    st = search_client.call("GET", "/canary/status")
    breached = st.get("status") == "running" and st.get("version") == version and st["guardrail"]["breached"]
    if breached:
        r = search_client.call("POST", "/models/rollback", {"version": version, "reason": reason, "actor": "release-agent"})
        db.audit("release-agent", "T3", "rollback", version, outcome=r["status"], detail={"reason": reason, "guardrail": st["guardrail"]})
        return {**r, "tier_basis": "T3: guardrail breached, rollback allowed without approval", "guardrail": st["guardrail"],
                **_meta("release-agent", "T3", "canary", "search-svc /models/rollback", techniques=[28, 33])}
    appr = db.approval_for("rollback", version)
    if not appr or appr["status"] != "approved":
        if not appr or appr["status"] == "rejected":
            appr = db.request_approval("rollback", version, "release-agent", f"Roll back {version}: {reason}")
        db.audit("release-agent", "T2", "rollback", version, appr["approval_id"], outcome="blocked_awaiting_approval")
        return {"error": "awaiting_human_approval", "version": version, "approval_id": appr["approval_id"],
                "detail": "no guardrail breach, so rollback is T2 and needs human approval", **_meta("release-agent", "T2", "approval")}
    r = search_client.call("POST", "/models/rollback", {"version": version, "reason": reason, "actor": "release-agent"})
    db.audit("release-agent", "T2", "rollback", version, appr["approval_id"], outcome=r["status"], detail={"reason": reason})
    return {**r, "approval_id": appr["approval_id"], **_meta("release-agent", "T2", "canary", "search-svc /models/rollback", techniques=[28, 33])}


@_guard("release-agent", "T3", "mlbom")
def sign_model(version: str) -> dict:
    rec = _record(version)
    r = signing.sign(rec["version"], rec)
    db.audit("release-agent", "T3", "sign_model", rec["version"], detail={"method": r["method"], "verified": r["verification"]["verified"]})
    return {**r, **_meta("release-agent", "T3", "mlbom", "model_signing", techniques=[34])}


@_guard("release-agent", "T0", "mlbom")
def verify_model_signature(version: str) -> dict:
    rec = _record(version)
    return {"version": rec["version"], **signing.verify(rec["version"]), **_meta("release-agent", "T0", "mlbom", "model_signing", techniques=[34])}


@_guard("release-agent", "T3", "mlbom")
def generate_mlbom(version: str) -> dict:
    rec = _record(version)
    sig = None
    sig_verify = signing.verify(rec["version"])
    if sig_verify.get("verified"):
        sig = {"method": sig_verify["method"], "verification": sig_verify, "files": signing._manifest(signing.art_root() / rec["version"])}
        import hashlib
        for f in (signing.art_root() / f"{rec['version']}.sig", signing.art_root() / f"{rec['version']}.hmac.json"):
            if f.exists():
                sig["signature_sha256"] = hashlib.sha256(f.read_bytes()).hexdigest()
    bom = mlbom.build(rec["version"], rec, sig)
    val = mlbom.validate(bom)
    path = mlbom.write(rec["version"], bom)
    db.audit("release-agent", "T3", "generate_mlbom", rec["version"], detail={"valid": val.get("valid"), "path": str(path)})
    comp = bom["metadata"]["component"]
    return {"version": rec["version"], "path": str(path), "validation": val, "spec_version": bom["specVersion"],
            "serial_number": bom["serialNumber"], "model_component": {k: comp[k] for k in ("type", "name", "version", "bom-ref")},
            "components": [{"type": c["type"], "name": c["name"]} for c in bom["components"]],
            "performance_metrics": comp["modelCard"]["quantitativeAnalysis"]["performanceMetrics"][:8], "signed": bool(sig),
            **_meta("release-agent", "T3", "mlbom", "CycloneDX", techniques=[35])}


@_guard("release-agent", "T0", "registry")
def get_registry() -> dict:
    reg = _registry()
    slim = [{k: v.get(k) for k in ("version", "status", "note", "config", "metrics", "created_at")} | {"mlflow_version": v.get("mlflow", {}).get("model_version")}
            for v in reg["versions"]]
    return {"champion": reg["champion"], "candidate": reg["candidate"], "versions": slim, "history": reg["history"][-10:],
            "backend": reg["backend"], **_meta("release-agent", "T0", "registry", "search-svc /models (MLflow)")}


def get_audit_log(limit: int = 50) -> dict:
    entries = db.audit_log(limit)
    return {"count": len(entries), "entries": entries,
            "pending_approvals": db.rows("SELECT approval_id,kind,subject,summary,requested_by,requested_at FROM approvals WHERE status='pending'"),
            **_meta("audit", "T0", "audit", "ops.db")}
