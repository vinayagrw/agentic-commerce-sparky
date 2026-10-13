"""The non-technique blocks of data/coverage.json (B02, B04, B06, B07, B08, B10).

build_coverage.py builds the 36 technique rows. This module adds, from generated artefacts only:

  generated_at    when the board was built (the BFF used to report "file has no generated_at")
  gate_config     every threshold the UI renders, read out of the code/config that enforces it (B02)
  demo_inputs     presenter INPUTS (not measurements), e.g. the injected canary latency (B02)
  lifecycle       drift p-value and the reranker-off gate delta, from data/lifecycle_measured.json (B02)
  evidence        measured results that were NOT produced by this repo, e.g. the independent spike's LLM
                  judge (B04). Each is parsed out of its copied source file, never typed in here.
  judges          the two relevance judges side by side, each labelled with what it is (B04)
  claims          the six demo claims, each with the evidence it rests on and a "must not pretend" caption (B06)
  slice_report    per-query-type NDCG@10 slices (B07), from data/slice_report.json
  bypass_gate     per-language bypass-class release gate (B10), from data/bypass_gate.json
  preregistered_gate  the late-interaction candidate the gate turns red on (B08)

A block whose artefact is missing is emitted with `status: "absent"` and the command that produces it.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIFECYCLE = ROOT / "data" / "lifecycle_measured.json"
SLICES = ROOT / "data" / "slice_report.json"
BYPASS = ROOT / "data" / "bypass_gate.json"
DEMO_INPUTS = ROOT / "evals" / "demo_inputs.json"
SPIKE_MD = ROOT / "docs" / "evidence" / "spike_llm_judge_result.md"
SPIKE_JSON = ROOT / "docs" / "evidence" / "spike_llm_judge_primary.json"
MLOPS = ROOT / "services" / "search-svc" / "mlops.py"
EVAL_RESULTS = ROOT / "evals" / "results.json"


def _load(p: Path):
    try:
        return json.loads(p.read_text()) if p.exists() else None
    except ValueError:
        return None


def _const(path: Path, name: str):
    """Read `NAME = <number>` from a source file, so a threshold is shown as the code enforces it."""
    if not path.exists():
        return None
    m = re.search(rf"^{re.escape(name)}\s*=\s*(-?[0-9.]+)", path.read_text(), re.M)
    return float(m.group(1)) if m else None


def _absent(what: str, fix: str) -> dict:
    return {"status": "absent", "reason": f"{what} has not been generated", "fix": fix}


def _find(techniques: list[dict], tid: int) -> dict:
    return next((t for t in techniques if t["id"] == tid), {})


def _meas(t: dict, pattern: str) -> dict | None:
    return next((m for m in t.get("measurements", []) if re.search(pattern, m.get("label", ""), re.I)), None)


# ------------------------------------------------------------------------------------------------ B02
def gate_config() -> dict:
    ev = _load(EVAL_RESULTS) or {}
    th = (ev.get("gate") or {}).get("thresholds") or {}
    return {
        "source": ["evals/results.json gate.thresholds (scripts/run_evals.py)", "services/search-svc/mlops.py constants"],
        "release_gate": {
            "ndcg_delta_ci_lower_ge": th.get("ndcg_delta_ci_lower_ge", _const(MLOPS, "NDCG_CI_FLOOR")),
            "p95_ms_le": th.get("p95_ms_le", _const(MLOPS, "P95_MAX_MS")),
            "red_team_blocked": th.get("red_team_blocked"),
            "pass_k_min": th.get("pass_k_min"),
        },
        "canary_guardrail": {
            "p95_ms_le": _const(MLOPS, "P95_MAX_MS"),
            "p95_rel_to_champion_le": _const(MLOPS, "CANARY_P95_REL"),
            "ndcg_drop_le": _const(MLOPS, "CANARY_NDCG_DROP"),
            "min_samples": _const(MLOPS, "CANARY_MIN_SAMPLES"),
            "rule": "rolls back when canary p95 > p95_ms_le AND > p95_rel_to_champion_le x champion p95, or the paired NDCG drop exceeds ndcg_drop_le",
        },
    }


def demo_inputs() -> dict:
    d = _load(DEMO_INPUTS)
    if not d:
        return _absent("evals/demo_inputs.json", "restore evals/demo_inputs.json")
    return {**d, "source": "evals/demo_inputs.json", "status": "input"}


def lifecycle() -> dict:
    d = _load(LIFECYCLE)
    if not d:
        return _absent("data/lifecycle_measured.json", "cd services/ops-mcp && uv run python ../../scripts/record_lifecycle.py")
    return {**d, "status": "real-measured", "source": "data/lifecycle_measured.json"}


# ------------------------------------------------------------------------------------------------ B04
def spike_evidence() -> dict:
    prim = _load(SPIKE_JSON)
    if not prim or not SPIKE_MD.exists():
        return {"key": "spike-llm-judge", **_absent("docs/evidence/spike_llm_judge_*", "copy the spike result into docs/evidence/")}
    md = SPIKE_MD.read_text()
    cats, conf = prim["cats"], prim["conf"]
    i = cats.index("I")
    n_i = sum(conf[i])
    recall_i = round(conf[i][i] / n_i, 3) if n_i else None
    jj = re.search(r"judge–judge κ = ([0-9.]+).*?\[measured: (\d+) pairs re-run", md)
    return {
        "key": "spike-llm-judge",
        "name": "LLM relevance judge (independent falsification spike)",
        "kind": "external-measured",
        "ran_in_this_repo": False,
        "judge": "llm",
        "model": "claude-opus-5 via Claude Code CLI, headless, no tools",
        "measurements": [
            {"label": "LLM judge vs ESCI human labels: Cohen's kappa", "value": round(prim["kappa"], 4), "n": prim["n"],
             "ci95": [round(prim["ci"][0], 4), round(prim["ci"][1], 4)],
             "how": "unweighted Cohen's kappa; 95% cluster-bootstrap CI, 10,000 replicates over 60 query clusters"},
            {"label": "LLM judge recall on human-Irrelevant pairs", "value": recall_i, "n": n_i,
             "how": "confusion matrix in the spike's primary.json (rows = human label)"},
            *([{"label": "LLM judge vs itself (re-run): Cohen's kappa", "value": float(jj.group(1)), "n": int(jj.group(2))}] if jj else []),
            {"label": "observed agreement p_o", "value": round(prim["p_o"], 4), "n": prim["n"]},
        ],
        "verdict": f"preregistered verdict {prim['verdict']}, near the floor",
        "headline": (f"kappa {round(prim['kappa'], 4)} on n={prim['n']} ESCI pairs, a pass near the preregistered floor; "
                     f"near-blind on Irrelevant (recall {recall_i}, n={n_i})."),
        "caveats": [
            "Did NOT run in this repo. It is the independent team's preregistered spike, copied here so the reference resolves.",
            "An Amazon-catalogue (ESCI) number. It predicts nothing about a real retailer's labels.",
            "The judge agrees with itself far more than with humans, so self-consistency is not evidence of validity.",
        ],
        "provenance": ["docs/evidence/spike_llm_judge_result.md", "docs/evidence/spike_llm_judge_primary.json",
                       "origin: _archive/team-b/design-b/spike/result.md"],
        "related_techniques": [19, 29],
    }


def b03_evidence() -> dict:
    d = _load(ROOT / "docs" / "evidence" / "B03_headline_beat_candidates.json")
    if not d:
        return {"key": "b03-headline-beat", **_absent("docs/evidence/B03_headline_beat_candidates.json", "run the B03 candidate goals live")}
    runs = d["runs"]
    sel = next(r for r in runs if r["key"] == d["selected"])
    return {
        "key": "b03-headline-beat",
        "name": "Headline beat 1 candidate goals (live agent runs)",
        "kind": "real-measured",
        "ran_in_this_repo": True,
        "measurements": [
            {"label": "candidate goals judged correct", "value": sum(1 for r in runs if r["correct"]), "n": len(runs),
             "how": d["judged_by"]},
            *[{"label": f"{r['key']}: Claude turn cost", "value": r["cost_usd"], "unit": "USD", "n": 1,
               "how": f"run-cost chip, session {r['session_id']}, {r['started_at']}"} for r in runs],
            *[{"label": f"{r['key']}: turn duration", "value": r["turn_seconds"], "unit": "s", "n": 1} for r in runs],
        ],
        "verdict": f"selected {sel['key']}: {sel['goal']}",
        "headline": (f"{sum(1 for r in runs if r['correct'])} of {len(runs)} candidate goals correct on one live run each; "
                     f"selected {sel['key']} (${sel['cost_usd']}, {sel['turn_seconds']} s)."),
        "caveats": ["n=1 run per goal: a rehearsal choice, not a success rate; no CI is claimed.",
                    "Correctness judged by the implementing agent from product titles.",
                    "The Critic passed an incorrect run (peanut butter multipack)."],
        "provenance": ["docs/evidence/B03_headline_beat_candidates.json", "docs/evidence/B03_headline_beat_candidates.md"],
        "related_techniques": [],
    }


def rollback_evidence() -> dict:
    d = _load(ROOT / "docs" / "evidence" / "canary_rollback_timing.json")
    if not d:
        return {"key": "canary-rollback-timing", **_absent("docs/evidence/canary_rollback_timing.json", "measure the unattended canary rollback live")}
    return {
        "key": "canary-rollback-timing",
        "name": "Canary unattended auto-rollback time (live, ops-mcp guardrail watcher)",
        "kind": "real-measured",
        "ran_in_this_repo": True,
        "measurements": [
            {"label": "injected latency to canary rolled back (median)", "value": d["median_inject_to_rolled_back_s"], "unit": "s", "n": d["n"],
             "how": d["method"], "runs": [r["inject_to_rolled_back_s"] for r in d["runs"]]},
            {"label": "breach visible to canary rolled back (median)", "value": d["median_breach_to_rolled_back_s"], "unit": "s", "n": d["n"],
             "runs": [r["breach_visible_to_rolled_back_s"] for r in d["runs"]]},
        ],
        "headline": f"Canary rolled back unattended a median {d['median_inject_to_rolled_back_s']} s after latency injection (n={d['n']}; 2 s watcher poll).",
        "caveats": d["caveats"],
        "provenance": ["docs/evidence/canary_rollback_timing.json"],
        "related_techniques": [28],
    }


def judges(techniques: list[dict], spike: dict) -> list[dict]:
    t29 = _find(techniques, 29)
    k = _meas(t29, r"kappa")
    lex = {
        "key": "demo-lexical-judge", "judge": "lexical", "label": "Lexical judge (this demo, technique 29)",
        "ran_in_this_repo": True, "technique": 29,
        "kappa": k, "fit_to_gate": False,
        "what_it_is": "token-overlap scoring over real traced sessions; no LLM is called",
        "must_not_pretend": "That it says anything about LLM judges. It is a lexical matcher and is reported as unusable.",
        "provenance": t29.get("provenance", []),
    }
    sk = next((m for m in spike.get("measurements", []) if "itself" not in m["label"] and "kappa" in m["label"]), None)
    llm = {
        "key": "spike-llm-judge", "judge": "llm", "label": "LLM judge (independent spike, not run here)",
        "ran_in_this_repo": False, "technique": None, "kappa": sk, "fit_to_gate": None,
        "what_it_is": spike.get("model"),
        "must_not_pretend": "That it validates labelling for a real retailer, or that it can measure an irrelevant rate (Irrelevant recall is low).",
        "provenance": spike.get("provenance", []),
    }
    return [lex, llm]


# ------------------------------------------------------------------------------------------------ B07 / B10 / B08
def slice_report() -> dict:
    d = _load(SLICES)
    if not d:
        return _absent("data/slice_report.json", "cd services/search-svc && uv run python ../../scripts/slice_report.py")
    return {**d, "status": "real-measured", "source": "data/slice_report.json"}


def bypass_gate() -> dict:
    d = _load(BYPASS)
    if not d:
        return _absent("data/bypass_gate.json", "cd services/ops-mcp && uv run python ../../scripts/bypass_gate_report.py")
    return {**d, "status": "real-measured", "source": "data/bypass_gate.json"}


def preregistered_gate(techniques: list[dict]) -> dict:
    t9 = _find(techniques, 9)
    return {
        "candidate": "late_interaction",
        "record": "M22 (routing record D13)",
        "prior_measurement": {k: _meas(t9, p) for k, p in (("delta_vs_production", r"paired delta vs production"),
                                                             ("p95_ms", r"p95 latency, late interaction"))},
        "how_to_run": "Ops plane: 'Gate a preregistered null' button -> POST /api/ops/gate-preregistered -> ops-http "
                      "POST /gates/preregistered/late_interaction -> search-svc POST /eval/late_interaction (live)",
        "code": [{"file": "services/ops-mcp/src/ops_mcp/tools.py", "symbol": "gate_preregistered_candidate"}],
    }


# ------------------------------------------------------------------------------------------------ B06
def claims(techniques: list[dict], lc: dict, sr: dict, bg: dict, spike: dict) -> list[dict]:
    def tm(tid: int, pattern: str):
        m = _meas(_find(techniques, tid), pattern)
        return {"technique": tid, **m} if m else None

    gate = lc.get("reranker_off_gate") if lc.get("status") != "absent" else None
    slice_built = sr.get("status") != "absent"
    bypass_built = bg.get("status") != "absent"
    sk = next((m for m in spike.get("measurements", []) if m["label"].endswith("Cohen's kappa") and "itself" not in m["label"]), None)
    out = [
        {"id": 1, "claim": "We can tell you whether the assistant told the truth, across a session.",
         "shown_by": "Grounded claims with provenance; the deterministic guard blocking in the tool (beat 7); constraint checks by the Critic.",
         "evidence": [x for x in [tm(27, r"seed red-team suite")] if x],
         "must_not_pretend": ("That ESCI has prices, stock or substitutions (they are synthetic), or that per-claim checks "
                              "already equal session safety. A runtime session-constraint verifier is not built here (B09)."),
         "built": "partial"},
        {"id": 2, "claim": "We can measure relevance labels cheaply, and we know how wrong the measurement is.",
         "shown_by": "The demo's own LEXICAL judge reported as unusable, and separately the independent spike's LLM judge.",
         "evidence": [x for x in [tm(29, r"kappa"), ({"evidence": "spike-llm-judge", **sk} if sk else None)] if x],
         "must_not_pretend": ("That either judge is right. The demo judge is lexical; the spike kappa is an Amazon-catalogue "
                              "number that predicts nothing about a real retailer's labels, and it did not run in this repo."),
         "built": "yes"},
        {"id": 3, "claim": "Hard query types are diagnosable, slice by slice.",
         "shown_by": "A per-query-type slice report: NDCG@10 by rules-based query class for BM25, dense and hybrid, "
                     "then one targeted fix re-measured with a CI.",
         "evidence": ([
             {"slice_report": "worst_slice", "label": f"worst slice ({sr['worst_slice']['slice']}) NDCG@10, rrf_rerank",
              "value": sr["worst_slice"]["rrf_rerank"]["mean"], "n": sr["worst_slice"]["rrf_rerank"]["n"],
              "ci95": sr["worst_slice"]["rrf_rerank"]["ci95"]},
             {"slice_report": "fix", "label": "targeted fix, paired delta on that slice", "value": sr["fix"]["delta"],
              "n": sr["fix"]["n"], "ci95": sr["fix"]["ci95"]},
         ] if slice_built else []),
         "must_not_pretend": ("That the query classes are validated. They come from deterministic rules, not human "
                              "annotation, and small slices carry wide CIs." if slice_built else
                              "That it exists: data/slice_report.json has not been generated."),
         "built": "yes" if slice_built else "no"},
        {"id": 4, "claim": "Agents operate the lifecycle without touching production.",
         "shown_by": "Beat 8b: propose, human approval on an HTTP-only route, gate, canary, rollback, with audit rows.",
         "evidence": [x for x in [tm(16, r"sealed holdout")] if x],
         "must_not_pretend": "That this is Element integration, or that the agents are good. The MLE search agent found nothing better (null).",
         "built": "yes"},
        {"id": 5, "claim": "The gate blocks bad releases, including ours.",
         "shown_by": "The reranker-off candidate fails the gate; a real preregistered null (late interaction, M22) is gated live "
                     "and goes red; open bypass classes block the release unless a named person overrides.",
         "evidence": [x for x in [
             ({"lifecycle": "reranker_off_gate", "label": "reranker-off paired delta NDCG@10", "value": gate["delta"],
               "ci95": gate["ci95"], "n": gate["n_queries"]} if gate else None),
             tm(9, r"paired delta vs production"),
             tm(22, r"attack success rate"),
             ({"bypass_gate": "after.adaptive_unseen_seeds", "label": "adaptive attacker ASR after B10, unseen seeds",
               "value": bg["after"]["adaptive_unseen_seeds"]["pooled_asr"]["rate"],
               "n": bg["after"]["adaptive_unseen_seeds"]["pooled_asr"]["n"],
               "ci95": bg["after"]["adaptive_unseen_seeds"]["pooled_asr"]["ci95_wilson"]} if bypass_built else None),
         ] if x],
         "must_not_pretend": ("That a passing seed suite, or a closed bypass class, means safety. The Spanish fix was written after "
                              "seeing the attacks (in-sample) and the attacker still gets through on fresh seeds."),
         "built": "yes" if bypass_built else "partial"},
        {"id": 6, "claim": "We know what we cannot run here.",
         "shown_by": "The script-ready-not-executed rows on the board (GPU jobs) with their scripts.",
         "evidence": [{"tally": "script-ready-not-executed",
                       "value": sum(1 for t in techniques if t["status"] == "script-ready-not-executed")}],
         "must_not_pretend": "To have run them, or to know what they would score.",
         "built": "yes"},
    ]
    return out


def token_optimisation() -> dict:
    """Phase 2: the token bench before/after (scripts/token_bench.ts), parsed from its JSON output, with n."""
    runs = {k: _load(ROOT / "docs" / "evidence" / f"token_bench_{k}.json") for k in ("before", "after")}
    if not all(runs.values()):
        return _absent("docs/evidence/token_bench_{before,after}.json", "make token-bench LABEL=before / LABEL=after")
    keys = ("turns", "model_calls", "input_tokens_total", "cache_read_input_tokens", "output_tokens", "cost_usd", "cache_hit_ratio",
            "first_token_p50_ms", "total_p50_ms", "checks_passed", "checks_total")
    out = {"status": "measured", "source": "docs/evidence/token_bench_{before,after}.json", "script": "scripts/token_bench.ts",
           "note": "one live run per arm (n = turns; tokens/cost from data/token_ledger.jsonl, the CLI's own result usage)"}
    for plane in ("shopper", "ops"):
        out[plane] = {arm: {k: runs[arm][plane].get(k) for k in keys} for arm in ("before", "after")}
        b, a = runs["before"][plane], runs["after"][plane]
        out[plane]["cost_change_pct"] = round(100 * (a["cost_usd"] - b["cost_usd"]) / b["cost_usd"], 1) if b.get("cost_usd") else None
        out[plane]["n"] = {"before_turns": b["turns"], "after_turns": a["turns"], "before_calls": b["model_calls"], "after_calls": a["model_calls"]}
    return out


# MLOps top 10 (docs/MLOPS_TOP10_SELECTION.md). Each capability's tool writes docs/evidence/mlops_<n>_<slug>.json on every
# live run; rows 6-10 are added by appending to MLOPS_TOP10 (n, slug, title, row-builder).
def _mlo_interleave(r):
    return {"status": "measured-simulated-clicks", "n": r["n_queries"], "value": {"wins_a": r["wins_a"], "wins_b": r["wins_b"], "ties": r["ties"], "sign_test_p": r["sign_test_p"]},
            "ci95": r["preference_ci95"], "ci_of": "preference for A (bootstrap)", "synthetic": r["click_model"]}


def _mlo_ab(r):
    return {"status": "measured", "n": r["n_sessions"], "value": {"variance_reduction": r["variance_reduction"], "delta_cuped": r["delta_cuped"], "msprt_stop_cuped": r["msprt"]["stop_at_cuped"]},
            "ci95": r["ci95_cuped"], "ci_of": "CUPED delta NDCG@10", "synthetic": f"{r['assignment']}; outcome {r['outcome']}"}


def _mlo_skew(r):
    return {"status": "measured", "n": sum(f["n"] for f in r["features"] if isinstance(f["n"], int) and f["psi"] != "n/a"), "value": {f["feature"]: f["psi"] for f in r["features"] if f["psi"] != "n/a"},
            "ci95": None, "ci_of": "PSI is a point statistic (no CI)", "synthetic": "prices/stock are synthetic commerce data on both sides"}


def _mlo_lineage(r):
    return {"status": "measured", "n": r["graph_edges"], "value": {"nodes": r["graph_nodes"], "edges": r["graph_edges"], "mlflow_runs": r["mlflow_runs"], "runs_missing": len(r["runs_missing_in_mlflow_db"])},
            "ci95": None, "ci_of": "count (no CI)", "synthetic": "dataset->index edges declared from engine code, not logged OpenLineage events"}


def _mlo_retrain(r):
    return {"status": "measured", "n": len(r["steps"]), "value": {"fired": r["fired"], "profile": r["profile"], "seconds": r["seconds"], "drift_p": (r.get("drift") or {}).get("p_value")},
            "ci95": None, "ci_of": "single DAG run (no CI)", "synthetic": "seasonal drift stream is a constructed query set"}


def _mlo_exposure(r):
    return {"status": "measured", "n": r["n_queries"], "value": {"sponsored_exposure_live": r["sponsored_exposure_live"], "relevance_matched": r["sponsored_exposure_relevance_matched"], "gap": r["exposure_gap"], "brand_hhi": r["brand_hhi"]},
            "ci95": r["exposure_gap_ci95"], "ci_of": "sponsored exposure gap vs relevance-matched baseline (bootstrap over queries)", "synthetic": "sponsored flag is synthetic ad placement on ESCI products; 1P/3P not measured (no seller field)"}


def _mlo_config(r):
    n = sum(row[1] + row[2] for row in r["eval"]["rows"])
    return {"status": "measured", "n": n, "value": {"current": r["current"], "hash": r["hash"], "versions": len(r["versions"]), "regressions": r["regressions"], "verdict": r["verdict"]},
            "ci95": None, "ci_of": "per-role cost-delta CIs are in the evidence file", "synthetic": "none: real token_ledger turns; not a replayed golden conversation suite"}


def _mlo_slo(r):
    return {"status": "measured", "n": sum(s["n"] for s in r["slos"]), "value": {s["slo"]: {"burn_rate": s["burn_rate"], "budget_remaining": s["budget_remaining"]} for s in r["slos"]} | {"freeze_active": r["freeze_active"]},
            "ci95": {s["slo"]: s["bad_ci95"] for s in r["slos"]}, "ci_of": "bad-event fraction per SLO (Wilson)", "synthetic": "SLO targets are demo targets; no conversion SLO (no order events)"}


def _mlo_golden(r):
    return {"status": "measured", "n": r["n_queries"], "value": {"golden_hash": r["golden_hash"], "newly_failing": r["newly_failing"], "fixed": r["fixed"], "delta_mean": r["delta_mean"], "regression": r["regression"]},
            "ci95": r["delta_ci95"], "ci_of": f"ΔNDCG@10 {r['candidate']} - {r['baseline']} (bootstrap)", "synthetic": "none: ESCI human judgments"}


def _mlo_shadow(r):
    return {"status": "measured", "n": r["n_queries"], "value": {"overlap_at_10": r["overlap_at_10"], "latency_diff_mean_ms": r["latency_diff_mean_ms"], "p95_ms": r["latency_p95_ms"], "params_not_applied": r["params_not_applied"]},
            "ci95": r["overlap_ci95"], "ci_of": "overlap@10 (bootstrap); latency CI in evidence", "synthetic": "arms run the live reranker on/off path; other version params not applied"}


MLOPS_TOP10 = [(1, "interleaving", "Team-draft interleaving pre-screen", _mlo_interleave), (2, "cuped_msprt", "CUPED + sequential (mSPRT) A/B", _mlo_ab),
               (3, "skew", "Training-serving skew check", _mlo_skew), (4, "lineage", "Data/model lineage graph", _mlo_lineage),
               (5, "retrain_dag", "Retraining trigger + DAG", _mlo_retrain),
               (6, "exposure", "Fairness + sponsored-vs-organic exposure audit", _mlo_exposure), (7, "config_registry", "Prompt/agent config registry with eval-on-change", _mlo_config),
               (8, "slo_budget", "Model SLOs + error budgets + release freeze", _mlo_slo), (9, "golden_set", "Golden-set regression + eval dataset versioning", _mlo_golden),
               (10, "shadow", "Shadow deployment", _mlo_shadow)]


def mlops_top10() -> dict:
    rows = []
    for n, slug, title, fn in MLOPS_TOP10:
        src = f"docs/evidence/mlops_{n}_{slug}.json"
        r = _load(ROOT / src)
        rows.append({"id": f"MLO{n}", "title": title, "source": src, "generated_at": r.get("generated_at"), **fn(r)} if r
                    else {"id": f"MLO{n}", "title": title, **_absent(src, "ask the Ops Copilot, or run the MLO e2e spec (make e2e-affected SPECS=mlops-top10)")})
    return {"status": "measured" if all(r.get("status") != "absent" for r in rows) else "partial", "rows": rows}


def build_extras(techniques: list[dict]) -> dict:
    lc, sr, bg, sp = lifecycle(), slice_report(), bypass_gate(), spike_evidence()
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "gate_config": gate_config(),
        "demo_inputs": demo_inputs(),
        "lifecycle": lc,
        "evidence": [sp, b03_evidence(), rollback_evidence()],
        "judges": judges(techniques, sp),
        "claims": claims(techniques, lc, sr, bg, sp),
        "slice_report": sr,
        "bypass_gate": bg,
        "preregistered_gate": preregistered_gate(techniques),
        "token_optimisation": token_optimisation(),
        "mlops_top10": mlops_top10(),
    }
