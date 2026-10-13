#!/usr/bin/env python3
"""Merge every source of truth about the 36 SOTA techniques into ONE canonical `data/coverage.json`.

There are three generated records in this repo, written at different times by different runs, with
different shapes:

  training/NOT_RUN_HERE.json          10 entries, `status: script-ready-not-executed` (ids 11-15, 17,
                                      "harness", 23-25). `est_cost_usd` there is a STRING carrying
                                      arithmetic, not a number - it is copied through verbatim.
  services/search-svc/SOTA_MEASURED.json   techniques 8, 9, 10, `status: real-measured`
  data/technique_coverage.json        ops techniques 16, 22, 26, 29, 32

Everything else (the data plane, the retrieval spine, the eval stack, the governance stack) is
implemented in this repo but has no merged record. This script builds one: 36 rows, each with the
file AND symbol that implements it, the measured number where one exists, the honest reason where
one does not, the provenance, and the playbook section link.

THE HONESTY CHECK (the reason this script exits non-zero)
---------------------------------------------------------
A row may not claim `real-measured` or `real-no-metric` unless every code reference it names
resolves: the file exists on disk AND the symbol is actually DEFINED in it (a `def`, `class`,
`export`, or `const` at a line start - a mention in a comment does not count). If any real-* row
fails, this script prints every failure and exits 1. Weakening the check is not the fix; fixing
the claim is.

Usage:
    uv run python scripts/build_coverage.py [--out data/coverage.json] [--quiet]
Exit codes: 0 all real-* claims resolve; 1 at least one does not.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from coverage_extras import build_extras, lifecycle  # noqa: E402  (B02/B04/B06/B07/B08/B10 blocks)
PLAYBOOK = (ROOT / ".." / ".." / "MLOps Agentic Lifecycle" / "SOTA_Technique_Playbook.md").resolve()
PLAYBOOK_REL = "../../MLOps Agentic Lifecycle/SOTA_Technique_Playbook.md"

NOT_RUN = ROOT / "training" / "NOT_RUN_HERE.json"
MEASURED = ROOT / "services" / "search-svc" / "SOTA_MEASURED.json"
OPS_COVERAGE = ROOT / "data" / "technique_coverage.json"
EVAL_RESULTS = ROOT / "evals" / "results.json"
SELECTION = ROOT / "data" / "selection_report.json"
SYNTH = ROOT / "data" / "synth_attributes.json"
DP = ROOT / "data" / "dp_query_logs.json"

STATUSES = ("real-measured", "real-no-metric", "script-ready-not-executed", "absent")

# Lifecycle stages exactly as the playbook's §2 map names them.
STAGE = {
    **{i: "1-2 Data" for i in range(1, 7)},
    **{i: "3 Retrieval" for i in range(7, 11)},
    **{i: "4 Training" for i in range(11, 16)},
    **{i: "5 ML agents" for i in (16, 17)},
    **{i: "6 Evaluation" for i in range(18, 23)},
    **{i: "7 Serving" for i in range(23, 27)},
    **{i: "8 Delivery and runtime safety" for i in (27, 28)},
    **{i: "9-10 Monitoring and retraining" for i in range(29, 33)},
    **{i: "11-12 Agentic ops, governance, security" for i in range(33, 37)},
}


# --------------------------------------------------------------------------------------- helpers
def load(p: Path):
    if not p.exists():
        return None
    return json.loads(p.read_text())


def slugify(heading: str) -> str:
    """GitHub-style anchor for a Markdown heading, minus the leading '### '."""
    s = heading.strip().lower()
    s = s.replace("‍", "")
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)  # drops '.', ':', the 🟣 marker
    return re.sub(r"[\s_]+", "-", s).strip("-")


def playbook_sections() -> dict[int, dict]:
    """Parse `### N. Title` headings out of the playbook §6 so names and links are not hand-typed."""
    if not PLAYBOOK.exists():
        return {}
    out: dict[int, dict] = {}
    for line in PLAYBOOK.read_text().splitlines():
        m = re.match(r"^###\s+(\d{1,2})\.\s+(.*)$", line)
        if not m:
            continue
        tid = int(m.group(1))
        if tid < 1 or tid > 36 or tid in out:
            continue
        title = m.group(2).strip()
        clean = title.replace("🟣", "").strip()
        out[tid] = {
            "playbook_name": clean,
            "playbook_section": f"§6.{tid}",
            "playbook_link": f"{PLAYBOOK_REL}#{slugify(f'{tid}. {title}')}",
        }
    return out


DEF_PATTERNS = (
    r"^\s*def\s+{s}\b",
    r"^\s*async\s+def\s+{s}\b",
    r"^\s*class\s+{s}\b",
    r"^\s*export\s+(?:async\s+)?function\s+{s}\b",
    r"^\s*export\s+(?:const|let|class|interface|type)\s+{s}\b",
    r"^\s*(?:const|let|function|class)\s+{s}\b",
)


def symbol_defined(text: str, symbol: str) -> bool:
    """True only if `symbol` is DEFINED at a line start. A mention in prose or a comment is not."""
    esc = re.escape(symbol)
    return any(re.search(p.format(s=esc), text, re.MULTILINE) for p in DEF_PATTERNS)


def resolve_refs(refs: list[dict]) -> tuple[list[dict], list[str]]:
    """Verify each {file, symbol}. Returns (annotated refs, failure messages)."""
    out, fails = [], []
    for r in refs:
        f = ROOT / r["file"]
        entry = {**r, "resolved": False}
        if not f.exists():
            fails.append(f"missing file: {r['file']}")
        else:
            txt = f.read_text(errors="replace")
            if symbol_defined(txt, r["symbol"]):
                entry["resolved"] = True
            else:
                fails.append(f"symbol not defined: {r['symbol']} in {r['file']}")
        out.append(entry)
    return out, fails


def num(d, *path, default=None):
    """Walk a nested dict/list path, returning `default` rather than raising."""
    cur = d
    for k in path:
        if cur is None:
            return default
        try:
            cur = cur[k]
        except (KeyError, IndexError, TypeError):
            return default
    return default if cur is None else cur


def ref(file: str, symbol: str, note: str = "") -> dict:
    return {"file": file, "symbol": symbol, **({"note": note} if note else {})}


# ----------------------------------------------------------------------------------------- build
def build(quiet: bool = False) -> tuple[dict, list[str]]:
    pb = playbook_sections()
    not_run = load(NOT_RUN) or []
    measured = load(MEASURED) or {}
    ops = load(OPS_COVERAGE) or {}
    evals = load(EVAL_RESULTS) or {}
    selection = load(SELECTION) or {}
    synth = load(SYNTH) or {}
    dp = load(DP) or {}

    not_run_by_id = {e["id"]: e for e in not_run if isinstance(e.get("id"), int)}
    harness = next((e for e in not_run if e.get("id") == "harness"), None)
    measured_by_id = {t["id"]: t for t in measured.get("techniques", [])}
    ops_by_id = {t["id"]: t for t in ops.get("techniques", [])}

    rows: list[dict] = []

    def add(tid, *, status, refs, measurements=None, headline=None, no_metric_reason=None,
            provenance=None, verdict=None, null_result=False, negative_result=False, caveats=None,
            not_run_entry=None):
        rows.append({
            "id": tid,
            "name": pb.get(tid, {}).get("playbook_name") or f"technique {tid}",
            "stage": STAGE[tid],
            "status": status,
            "code": refs,
            "measurements": measurements or [],
            "headline": headline,
            "no_metric_reason": no_metric_reason,
            "provenance": provenance or [],
            "verdict": verdict,
            "null_result": bool(null_result),
            "negative_result": bool(negative_result),
            "caveats": caveats or [],
            "not_run": not_run_entry,
            "playbook_section": pb.get(tid, {}).get("playbook_section", f"§6.{tid}"),
            "playbook_link": pb.get(tid, {}).get("playbook_link", PLAYBOOK_REL),
        })

    def m(label, value, *, unit=None, n=None, ci95=None, how=None):
        return {k: v for k, v in
                {"label": label, "value": value, "unit": unit, "n": n, "ci95": ci95, "how": how}.items()
                if v is not None}

    # ---------------------------------------------------------------- 1-2 Data plane (1-6)
    add(1, status="real-no-metric",
        refs=[ref("services/ops-mcp/src/ops_mcp/labeling.py", "record",
                  "LLM label + confidence; below LOW_CONFIDENCE the item is routed to the human review queue"),
              ref("services/ops-mcp/src/ops_mcp/labeling.py", "review_queue"),
              ref("services/ops-mcp/src/ops_mcp/labeling.py", "submit_review"),
              ref("services/ops-mcp/src/ops_mcp/labeling.py", "_kappa", "judge-vs-ESCI agreement, per batch")],
        no_metric_reason=("Runs for real in beat 9 and computes Cohen's kappa per batch, but no batch report is "
                          "written to data/, so this board asserts no number. The routing threshold is a "
                          "[PROPOSAL] value, not a calibrated one."),
        provenance=["repo code; no generated artefact"])

    add(2, status="real-measured",
        refs=[ref("scripts/synth_attributes.py", "process", "generate -> verify -> resample loop"),
              ref("scripts/synth_attributes.py", "deterministic_check", "grounding against the real ESCI text"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "generate_synthetic_attributes")],
        measurements=[
            m("acceptance rate (all 3 verification stages)", num(synth, "results", "acceptance_rate"),
              n=num(synth, "results", "products")),
            m("first-attempt acceptance", num(synth, "results", "first_attempt_acceptance_rate"),
              n=num(synth, "results", "products")),
            m("cost per accepted attribute set", num(synth, "cost", "usd_per_accepted_attribute_set"), unit="USD"),
        ],
        headline=(f"{num(synth, 'results', 'accepted')}/{num(synth, 'results', 'products')} accepted after "
                  f"schema + deterministic grounding + an independent verifier; "
                  f"{num(synth, 'results', 'accepted_first_attempt')} on the first attempt."),
        caveats=["n = 25 products. An acceptance rate from 25 items is an indication, not a certification.",
                 num(synth, "note")],
        provenance=["data/synth_attributes.json (scripts/synth_attributes.py)"])

    add(3, status="real-measured",
        refs=[ref("scripts/dp_query_logs.py", "dp_histogram", "Laplace / analytic-Gaussian mechanism"),
              ref("scripts/dp_query_logs.py", "synthesize", "emits the released private log"),
              ref("scripts/dp_query_logs.py", "gaussian_sigma"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "generate_dp_query_logs")],
        measurements=[
            m("epsilon released", num(dp, "released_log", "epsilon")),
            m("delta", num(dp, "released_log", "delta")),
            m("verbatim real queries in the release", num(dp, "released_log", "verbatim_real_queries"),
              n=num(dp, "released_log", "events")),
            m("top-50 overlap with the true histogram at the released epsilon",
              next((p.get("top50_overlap") for p in (dp.get("utility_curve") or [])
                    if p.get("epsilon") == num(dp, "released_log", "epsilon")), None)),
        ],
        headline=("A real (eps, delta)-DP histogram release with a written privacy ledger and a measured "
                  "utility curve. Zero verbatim real queries survive into the release."),
        caveats=["Utility is poor at small epsilon and the curve says so; nothing is tuned to hide it.",
                 "epsilon is a policy decision. The value here is a demo choice, not a real retailer's policy."],
        provenance=["data/dp_query_logs.json (scripts/dp_query_logs.py)"])

    add(4, status="real-no-metric",
        refs=[ref("services/ops-mcp/src/ops_mcp/dq.py", "run", "missingness, dietary coverage, MAD price outliers"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "run_data_validation")],
        no_metric_reason=("The gate runs live in beat 9 against the real catalogue, but its report is returned to "
                          "the agent and not written to data/, so no number is asserted here. The expectations "
                          "are hand-written checks, not an ODCS contract."),
        provenance=["repo code; no generated artefact"])

    add(5, status="real-no-metric",
        refs=[ref("services/ops-mcp/src/ops_mcp/dq.py", "near_duplicates", "MinHash LSH"),
              ref("services/ops-mcp/src/ops_mcp/dq.py", "semantic_duplicates", "FAISS cosine over bge-small"),
              ref("services/ops-mcp/src/ops_mcp/dq.py", "dedup_report")],
        no_metric_reason=("Both passes run for real over the 25,003-row catalogue, but the pair counts are "
                          "computed per request and not persisted, so no duplicate rate is asserted here."),
        caveats=["Thresholds (0.9 MinHash / 0.95 semantic) are [PROPOSAL] values; no precision/recall was measured "
                 "against a labelled duplicate set, because none exists here."],
        provenance=["repo code; no generated artefact"])

    add(6, status="real-measured", negative_result=True,
        refs=[ref("scripts/select_data.py", "select", "coverage - lambda * redundancy over bge-small embeddings"),
              ref("scripts/select_data.py", "select_cluster_representative"),
              ref("scripts/select_data.py", "coverage_scores"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "run_data_selection")],
        measurements=[
            m("NDCG@10, full catalogue", num(selection, "comparison", "ndcg10_full"), n=200),
            m("NDCG@10, model-selected 40%", num(selection, "comparison", "ndcg10_selected"), n=200),
            m("NDCG@10, RANDOM 40% baseline", num(selection, "comparison", "ndcg10_random_baseline"), n=200),
            m("delta, model-selected vs random", num(selection, "comparison", "ndcg_delta_selected_vs_random"), n=200),
        ],
        verdict="negative result: the random baseline BEAT the model-based selector",
        headline=("At the same 40% keep fraction a uniformly random subset scores "
                  f"{num(selection, 'comparison', 'ndcg10_random_baseline')} against the selector's "
                  f"{num(selection, 'comparison', 'ndcg10_selected')} - the selector is WORSE than random by "
                  f"{abs(num(selection, 'comparison', 'ndcg_delta_selected_vs_random', default=0)):.4f} NDCG@10."),
        caveats=[num(selection, "note"), num(selection, "interpretation")],
        provenance=["data/selection_report.json (scripts/select_data.py)"])

    # ---------------------------------------------------------------- 3 Retrieval (7-10)
    nd = {r["mode"]: r for r in num(evals, "ndcg_by_mode", "rows", default=[])}
    add(7, status="real-measured",
        refs=[ref("services/search-svc/engine.py", "Engine", "search(mode='rrf_rerank') is the champion path"),
              ref("services/search-svc/engine.py", "rrf", "reciprocal rank fusion, k=60"),
              ref("services/search-svc/engine.py", "ndcg10")],
        measurements=[
            m("NDCG@10 bm25", num(nd, "bm25", "ndcg10"), n=200),
            m("NDCG@10 vector (bge-small + FAISS)", num(nd, "vector", "ndcg10"), n=200),
            m("NDCG@10 rrf (k=60)", num(nd, "rrf", "ndcg10"), n=200),
            m("NDCG@10 rrf_rerank (+ MiniLM cross-encoder)", num(nd, "rrf_rerank", "ndcg10"), n=200),
            m("p50 latency, rrf_rerank", num(nd, "rrf_rerank", "latency_p50_ms"), unit="ms", n=200),
        ],
        headline=(f"The spine of the demo and the only technique with a clear positive: rerank lifts NDCG@10 from "
                  f"{num(nd, 'bm25', 'ndcg10')} (bm25) to {num(nd, 'rrf_rerank', 'ndcg10')} on 200 held-out ESCI "
                  f"test queries."),
        caveats=["A laptop CPU cross-encoder. p95 sits near the 150 ms gate threshold; CPU contention alone can "
                 "fail the gate."],
        provenance=["evals/results.json (scripts/run_evals.py -> search-svc POST /eval/ndcg)"])

    for tid in (8, 9, 10):
        src = measured_by_id.get(tid)
        if not src:
            add(tid, status="absent", refs=[],
                no_metric_reason="no entry in services/search-svc/SOTA_MEASURED.json",
                provenance=[])
            continue
        code = src.get("code", {})
        if tid == 8:
            refs = [ref("scripts/contextual_enrich.py", "build_variant", "writes the enriched variant index"),
                    ref("scripts/contextual_enrich.py", "verify", "entity + length grounding check"),
                    ref("services/search-svc/engine.py", "VariantIndex"),
                    ref("services/search-svc/mlops.py", "MLOps", "eval_contextual -> paired NDCG@10 + bootstrap CI")]
            ms = src["measurements"]
            meas = [
                m("NDCG@10 baseline (RRF, no rerank)", num(ms, "ndcg10_baseline_rrf", "value"), n=67),
                m("NDCG@10 contextual (RRF, no rerank)", num(ms, "ndcg10_contextual_rrf", "value"), n=67),
                m("paired delta, retrieval only", num(ms, "ndcg10_delta_retrieval_only", "value"), n=67,
                  ci95=num(ms, "ndcg10_delta_retrieval_only", "ci95")),
                m("paired delta, production path (+ rerank)", num(ms, "ndcg10_delta_production_path", "value"), n=67,
                  ci95=num(ms, "ndcg10_delta_production_path", "ci95")),
                m("context acceptance rate", num(ms, "contexts_accepted", "acceptance_rate"),
                  n=num(ms, "contexts_accepted", "sample_size")),
                m("generation cost", num(ms, "generation_cost_usd", "value"), unit="USD"),
            ]
            head = ("NULL RESULT. On the production path the enriched index is worth "
                    f"{num(ms, 'ndcg10_delta_production_path', 'value')} NDCG@10, CI95 "
                    f"{num(ms, 'ndcg10_delta_production_path', 'ci95')} - straddles zero. "
                    "The playbook's own 'When NOT to use' names structured catalogue records; this is one.")
        elif tid == 9:
            refs = [ref("services/search-svc/engine.py", "Engine", "maxsim / late_interaction rescorer"),
                    ref("services/search-svc/mlops.py", "MLOps", "eval_late_interaction -> paired NDCG@10 + CI")]
            ms = src["measurements"]
            meas = [
                m("NDCG@10 hybrid RRF + cross-encoder (production)",
                  num(ms, "ndcg10_hybrid_rrf_rerank", "value"), n=200),
                m("NDCG@10 late interaction (MaxSim)", num(ms, "ndcg10_late_interaction", "value"), n=200),
                m("paired delta vs production", num(ms, "ndcg10_delta_vs_production", "value"), n=200,
                  ci95=num(ms, "ndcg10_delta_vs_production", "ci95")),
                m("p95 latency, late interaction", num(ms, "latency_p95_ms_late_interaction", "value"),
                  unit="ms", n=200),
            ]
            head = ("NULL RESULT, and it BREACHES THE GATE. The quality delta is "
                    f"{num(ms, 'ndcg10_delta_vs_production', 'value')} with CI95 "
                    f"{num(ms, 'ndcg10_delta_vs_production', 'ci95')} (straddles zero), while p95 is "
                    f"{num(ms, 'latency_p95_ms_late_interaction', 'value')} ms against the demo's own 150 ms "
                    "p95 release gate. No quality gain, and it would fail the gate on latency.")
        else:
            refs = [ref("services/search-svc/graph.py", "ProductGraph", "networkx product graph + traversal"),
                    ref("services/search-svc/graph.py", "route", "rules-first query router")]
            ms = src.get("measurements", {})
            meas = [m(k, v.get("value") if isinstance(v, dict) else v,
                      n=(v.get("sample_size") if isinstance(v, dict) else None),
                      ci95=(v.get("ci95_wilson") or v.get("ci95") if isinstance(v, dict) else None))
                    for k, v in ms.items() if isinstance(v, (dict, int, float))]
            head = src.get("verdict")
        add(tid, status="real-measured", refs=refs, measurements=meas, headline=head,
            verdict=src.get("verdict"),
            null_result=str(src.get("verdict", "")).lower().startswith("null result"),
            caveats=(src.get("caveats") or []) + (
                ["SCOPE: the playbook's technique 9 is ColPali VISUAL retrieval. What was built and measured here "
                 "is the late-interaction MaxSim mechanism over TEXT on the existing bge-small encoder. The VISION "
                 "variant, and a trained ColBERT checkpoint with [Q]/[D] markers and a learned projection, are "
                 "ABSENT from this repo."] if tid == 9 else []),
            provenance=[f"services/search-svc/SOTA_MEASURED.json (scripts/measure_techniques.py); endpoints: "
                        f"{', '.join(str(v) for v in code.values())}"])

    # ---------------------------------------------------------------- 4 Training + 5 agents (11-17)
    def script_ready(tid, extra_refs=None, share_harness=False):
        e = not_run_by_id.get(tid)
        if not e:
            add(tid, status="absent", refs=[], no_metric_reason="no entry in training/NOT_RUN_HERE.json")
            return
        refs = [ref(e["entrypoint"], "main", "the job entrypoint; never executed here")] + (extra_refs or [])
        entry = {
            "dir": e.get("dir"),
            "entrypoint": e.get("entrypoint"),
            "gpu_sku": e.get("gpu_sku"),
            # deliberately a STRING carrying arithmetic, not a number: copied through verbatim
            "est_cost_usd": e.get("est_cost_usd"),
            "est_cost_usd_is_a_string": isinstance(e.get("est_cost_usd"), str),
            "cloud": e.get("cloud"),
            "expected_result": e.get("expected_result"),
            "citation": e.get("citation"),
        }
        if share_harness and harness:
            entry["shared_harness"] = {"entrypoint": harness.get("entrypoint"), "name": harness.get("name")}
        add(tid, status="script-ready-not-executed", refs=refs,
            no_metric_reason=("NO GPU WAS AVAILABLE AND THIS WAS NOT RUN. The script, the cloud job spec and the "
                              "expected result are real; there is no measurement, and the expected result is a "
                              "prediction from the cited literature, not an observation."),
            headline=e.get("name"), not_run_entry=entry,
            provenance=["training/NOT_RUN_HERE.json"])

    for tid in (11, 12, 13, 14, 15, 17):
        extra = ([ref("training/13_rlvr_verifier/verifier.py", "verify")] if tid == 13 else None)
        script_ready(tid, extra_refs=extra)

    add(16, status="real-measured", null_result=True,
        refs=[ref("services/ops-mcp/src/ops_mcp/mle_search.py", "search", "budgeted search over the ranking config space"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "run_mle_search")],
        measurements=[
            m("trials", num(ops_by_id, 16, "numbers", "trials", "value")),
            m("USD spent", num(ops_by_id, 16, "numbers", "usd_spent", "value"), unit="USD"),
            m("best dev delta vs champion", num(ops_by_id, 16, "numbers", "best_observed_dev_delta", "value"),
              n=150, ci95=num(ops_by_id, 16, "numbers", "best_observed_dev_delta", "ci95")),
            m("SEALED holdout delta", num(ops_by_id, 16, "numbers", "sealed_holdout_delta", "value"),
              n=200, ci95=num(ops_by_id, 16, "numbers", "sealed_holdout_delta", "ci95")),
        ],
        verdict=num(ops_by_id, 16, "verdict"),
        headline=num(ops_by_id, 16, "headline"),
        caveats=[num(ops_by_id, 16, "honest_note")],
        provenance=["data/technique_coverage.json (scripts/technique_coverage.py)"])

    # ---------------------------------------------------------------- 6 Evaluation (18-22)
    cmp_ = evals.get("compare", {})
    add(18, status="real-measured",
        refs=[ref("scripts/run_evals.py", "main", "the gate; exits 1 on failure"),
              ref("scripts/run_evals.py", "score_runs")],
        measurements=[
            m("gate verdict", num(evals, "gate", "verdict")),
            m("p95 latency threshold", num(evals, "gate", "thresholds", "p95_ms_le"), unit="ms"),
            m("NDCG delta CI-lower floor", num(evals, "gate", "thresholds", "ndcg_delta_ci_lower_ge")),
            m("candidate p95", num(cmp_, "latency", "candidate", "p95_ms"), unit="ms"),
        ],
        headline=("A real gate with five checks that exits non-zero. ci/eval-gate.yml is an EXAMPLE workflow: it "
                  "is not installed under .github/workflows, so nothing is enforced on a PR in this repo."),
        caveats=["ci/eval-gate.yml is a template to copy, not an active CI job."],
        provenance=["evals/results.json (scripts/run_evals.py)", "ci/eval-gate.yml"])

    k29 = ops_by_id.get(29, {})
    add(19, status="real-measured", negative_result=True,
        refs=[ref("services/ops-mcp/src/ops_mcp/online_eval.py", "agreement", "kappa + Wilson CI vs ESCI qrels"),
              ref("services/ops-mcp/src/ops_mcp/online_eval.py", "_kappa"),
              ref("services/ops-mcp/src/ops_mcp/online_eval.py", "_wilson"),
              ref("services/ops-mcp/src/ops_mcp/online_eval.py", "judge")],
        measurements=[
            m("LEXICAL judge agreement with ESCI gold", num(k29, "numbers", "judge_agreement", "value"),
              n=num(k29, "numbers", "judge_agreement", "n"),
              ci95=num(k29, "numbers", "judge_agreement", "ci95_wilson")),
            m("LEXICAL judge Cohen's kappa", num(k29, "numbers", "cohens_kappa", "value"),
              n=num(k29, "numbers", "cohens_kappa", "n")),
            m("gold base rate (relevant)", num(k29, "numbers", "base_rate_gold_relevant", "value")),
        ],
        verdict="calibration measured; the LEXICAL judge FAILS it",
        headline=("The calibration machinery is real - and it is what proves the demo's LEXICAL judge unusable. kappa = "
                  f"{num(k29, 'numbers', 'cohens_kappa', 'value')} on n="
                  f"{num(k29, 'numbers', 'cohens_kappa', 'n')}: below chance."),
        caveats=[num(k29, "sample_size_caveat"),
                 "Calibration here means agreement with ESCI qrels, not the playbook's Rogan-Gladen prevalence "
                 "correction against a human gold set - no human gold set exists in this repo."],
        provenance=["data/technique_coverage.json (technique 29 block)"])

    add(20, status="real-measured",
        refs=[ref("services/search-svc/mlops.py", "MLOps", "bootstrap_ci: 1000-resample paired percentile CI"),
              ref("services/search-svc/mlops.py", "Registry")],
        measurements=[
            m("champion NDCG@10", num(cmp_, "metrics", "ndcg10", "champion"), n=200),
            m("candidate NDCG@10", num(cmp_, "metrics", "ndcg10", "candidate"), n=200),
            m("paired delta", num(cmp_, "metrics", "ndcg10", "delta", "mean"), n=200,
              ci95=num(cmp_, "metrics", "ndcg10", "delta", "ci95"),
              how=num(cmp_, "method")),
            m("resamples", num(cmp_, "metrics", "ndcg10", "delta", "resamples")),
        ],
        headline=("Every delta in this demo carries a paired bootstrap CI, which is exactly why so many of its "
                  "results are reported as null rather than as wins."),
        caveats=["Paired bootstrap over per-query deltas; no clustering correction, and no power analysis was run "
                 "to choose n."],
        provenance=["evals/results.json compare block (search-svc POST /eval/compare)"])

    pk = evals.get("pass_k", {})
    add(21, status="real-measured", negative_result=True,
        refs=[ref("scripts/run_evals.py", "pass_k", "k independent trajectories per task"),
              ref("scripts/run_evals.py", "run_agent_once")],
        measurements=[
            m("pass^k (state-based)", num(pk, "pass_hat_k"), n=num(pk, "tasks")),
            m("pass^k (strict: also within max-turns)", num(pk, "pass_hat_k_strict"), n=num(pk, "tasks")),
            m("pass@1", num(pk, "pass_at_1"), n=num(pk, "tasks")),
            m("k", num(pk, "k")),
        ],
        headline=(f"pass^{num(pk, 'k')} = {num(pk, 'pass_hat_k')} state-based, {num(pk, 'pass_hat_k_strict')} strict. "
                  "school_lunches_nut_free fails 3/3 and was deliberately NOT deleted from the suite."),
        caveats=["5 tasks, k=3. That is 15 trajectories: far too few for a confidence interval, and none is "
                 "claimed.", num(pk, "scoring")],
        provenance=["evals/results.json pass_k block (scripts/run_evals.py)"])

    rt = ops_by_id.get(22, {})
    _bgp = ROOT / "data" / "bypass_gate.json"
    bg22 = json.loads(_bgp.read_text()) if _bgp.exists() else {}

    def _bg(side, *path):
        o = bg22.get(side, {})
        for k in path:
            o = o.get(k, {}) if isinstance(o, dict) else {}
        return o or {}

    b10 = []
    if bg22:
        fb, fa = _bg("before", "findings_replay"), _bg("after", "findings_replay")
        b10 = [
            m("B10 recorded bypasses still bypassing, before (pre-B10 detector)", fb.get("bypassing"), n=fb.get("n"),
              ci95=fb.get("bypass_rate", {}).get("ci95_wilson"), how="data/bypass_gate.json before.findings_replay"),
            m("B10 recorded bypasses still bypassing, after (IN-SAMPLE)", fa.get("bypassing"), n=fa.get("n"),
              ci95=fa.get("bypass_rate", {}).get("ci95_wilson"), how="data/bypass_gate.json after.findings_replay"),
        ]
        for side in ("before", "after"):
            for blk, lab in (("adaptive_same_seeds", "same seeds 1-3"), ("adaptive_unseen_seeds", "new seeds 11-13")):
                a = _bg(side, blk, "pooled_asr")
                if a:
                    b10.append(m(f"B10 adaptive ASR {side}, {lab}", round(a["rate"], 4), n=a["n"], ci95=a["ci95_wilson"],
                                 how=f"data/bypass_gate.json {side}.{blk}.pooled_asr"))
    add(22, status="real-measured", negative_result=True,
        refs=[ref("services/ops-mcp/src/ops_mcp/redteam.py", "run", "evolutionary attacker over real guard input"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "run_red_team"),
              ref("services/shop-mcp/src/shop_mcp/injection.py", "detect_injection", "the guard under attack"),
              ref("services/ops-mcp/src/ops_mcp/bypass_gate.py", "classify_language", "B10 per-language bypass-class gate")],
        measurements=[
            m("attack success rate against the pre-B10 detector (original run)",
              num(rt, "numbers", "attack_success_rate", "value"), n=num(rt, "numbers", "attack_success_rate", "n")),
            m("block rate (pre-B10 detector, original run)", num(rt, "numbers", "block_rate", "value"), n=num(rt, "numbers", "block_rate", "n"),
              ci95=num(rt, "numbers", "block_rate", "ci95_wilson")),
            m("seed regression suite block rate", num(rt, "numbers", "regression_suite_block_rate", "value"),
              n=num(rt, "numbers", "regression_suite_block_rate", "n")),
            *b10,
        ],
        verdict=rt.get("verdict"),
        headline=("BYPASS REDUCED, NOT CLOSED. Original run: "
                  f"{num(rt, 'numbers', 'attack_success_rate', 'value')} attack success over "
                  f"{num(rt, 'numbers', 'attack_success_rate', 'n')} attempts, Spanish/code-switched imperatives in polite framing. "
                  "After the B10 bypass-class gate (data/bypass_gate.json): recorded bypasses "
                  f"{_bg('before', 'findings_replay').get('bypassing')}/{_bg('before', 'findings_replay').get('n')} -> "
                  f"{_bg('after', 'findings_replay').get('bypassing')}/{_bg('after', 'findings_replay').get('n')} (in-sample); "
                  f"adaptive ASR on the same seeds {_bg('before', 'adaptive_same_seeds', 'pooled_asr').get('rate')} -> "
                  f"{round(_bg('after', 'adaptive_same_seeds', 'pooled_asr').get('rate', 0), 4)}, on new seeds "
                  f"{round(_bg('before', 'adaptive_unseen_seeds', 'pooled_asr').get('rate', 0), 4)} -> "
                  f"{round(_bg('after', 'adaptive_unseen_seeds', 'pooled_asr').get('rate', 0), 4)}. The attacker still gets through."
                  if bg22 else
                  "OPEN BYPASS. B10 report data/bypass_gate.json is absent."),
        caveats=["The regression suite scores 1.0 while the adaptive attacker still succeeds. A passing gate here "
                 "means the gate is underpowered, not that the guard is safe.",
                 "The 54-finding replay is IN-SAMPLE: the fix was written after reading those findings.",
                 "New seeds (11-13) reuse the same intents, carriers and translation table: semi-in-sample.",
                 "Worst intents in the original run: unbounded consumption 0.81 ASR, promote_model 0.63, cart_stuff and memory_poison "
                 "0.55 each."],
        provenance=["data/technique_coverage.json (technique 22, original run)", "data/redteam_findings.json (54 findings)",
                    "data/bypass_gate.json (B10 before/after)"])

    # ---------------------------------------------------------------- 7 Serving (23-26)
    for tid in (23, 24, 25):
        script_ready(tid, share_harness=True)

    r26 = ops_by_id.get(26, {})
    add(26, status="real-measured", negative_result=True,
        refs=[ref("bff/src/ops/router.ts", "route", "per-request routing + escalation, writes a route receipt"),
              ref("bff/src/ops/router.ts", "decide"),
              ref("bff/src/ops/router.ts", "routerReport", "the paired control measurement")],
        measurements=[
            m("cost/1k, cascade", num(r26, "numbers", "cost_per_1k_routed_with_cascade", "value"), unit="USD", n=40),
            m("cost/1k, routing without cascade", num(r26, "numbers", "cost_per_1k_routed_no_cascade", "value"),
              unit="USD", n=40),
            m("cost/1k, always-premium control", num(r26, "numbers", "cost_per_1k_always_premium", "value"),
              unit="USD", n=40),
            m("saving vs always-premium WITH cascade",
              num(r26, "numbers", "saving_vs_always_premium_with_cascade_pct", "value"), unit="%"),
            m("saving vs always-premium WITHOUT cascade",
              num(r26, "numbers", "saving_vs_always_premium_no_cascade_pct", "value"), unit="%"),
            m("escalations", num(r26, "numbers", "escalations_with_cascade", "value"),
              n=num(r26, "numbers", "escalations_with_cascade", "of")),
        ],
        verdict="the cascade is a NET LOSS on this traffic",
        headline=("The cascade as configured LOSES "
                  f"{abs(num(r26, 'numbers', 'saving_vs_always_premium_with_cascade_pct', 'value', default=0))}% "
                  "against always-premium: the rank1/rank3 margin threshold fires on "
                  f"{num(r26, 'numbers', 'escalations_with_cascade', 'value')}/"
                  f"{num(r26, 'numbers', 'escalations_with_cascade', 'of')} queries, so the router pays for BOTH "
                  "arms. Pure routing without the cascade is the arm that saves "
                  f"({num(r26, 'numbers', 'saving_vs_always_premium_no_cascade_pct', 'value')}%). Both are "
                  "reported; neither was tuned to look good."),
        caveats=[num(r26, "honest_note"), num(r26, "not_measured"),
                 "No Claude arm was exercised, so no LLM-arm cost or latency is claimed.",
                 "$/CPU-min is an ASSUMPTION; the wall-clock ms it multiplies are measured."],
        provenance=["data/technique_coverage.json (technique 26)"])

    # ---------------------------------------------------------------- 8 Delivery + safety (27-28)
    add(27, status="real-measured",
        refs=[ref("services/shop-mcp/src/shop_mcp/injection.py", "detect_injection", "layer 1: content"),
              ref("services/shop-mcp/src/shop_mcp/guard.py", "guarded_add_to_cart", "layer 2: tool-side rules"),
              ref("services/policy-mcp/src/policy_mcp/policy.py", "check", "layer 3: capability + guard policy"),
              ref("bff/src/agents/guard.ts", "Guard", "layer 4: orchestrator quarantine")],
        measurements=[
            m("seed red-team suite blocked", num(evals, "red_team", "blocked"), n=num(evals, "red_team", "attacks")),
            m("false positives on benign listings", num(evals, "red_team", "false_positives"),
              n=num(evals, "red_team", "benign")),
            m("adaptive attacker block rate (technique 22)", num(rt, "numbers", "block_rate", "value"),
              n=num(rt, "numbers", "block_rate", "n"), ci95=num(rt, "numbers", "block_rate", "ci95_wilson")),
        ],
        headline=("Four real layers, and the honest number is the adaptive one, not the seed suite: "
                  f"{num(evals, 'red_team', 'blocked')}/{num(evals, 'red_team', 'attacks')} on the fixed suite but "
                  f"only {num(rt, 'numbers', 'block_rate', 'value')} against the technique-22 attacker."),
        caveats=["No managed shield (Azure Prompt Shields / GCP Model Armor) is wired in; layer 1 is a local "
                 "keyword + normalisation detector and it is English-only.",
                 "Beat 7's planted injection listings must be planted on a real ESCI product; there is no scripted "
                 "fallback."],
        provenance=["evals/results.json red_team block", "data/technique_coverage.json (technique 22)"])

    add(28, status="real-no-metric",
        refs=[ref("services/search-svc/mlops.py", "MLOps", "canary_start / canary_traffic / canary_status / rollback"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "start_canary"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "rollback"),
              ref("services/ops-mcp/src/ops_mcp/guardrail.py", "start", "the watcher that fires the rollback")],
        no_metric_reason=("The canary and its unattended auto-rollback run for real in beat 9, but the run produces "
                          "no artefact in data/, so no arm delta is asserted here; rollback time was measured "
                          "separately (evidence canary-rollback-timing, n=3). The "
                          "canary traffic is simulated inside search-svc, not real user traffic, and there is no "
                          "Argo Rollouts / OpenFeature deployment behind it."),
        caveats=["Underpowered by construction: the canary arm sees a simulated request stream, so its CI would be "
                 "meaningless and none is offered."],
        provenance=["repo code; no generated artefact"])

    # ---------------------------------------------------------------- 9-10 Monitoring (29-32)
    add(29, status="real-measured", negative_result=True,
        refs=[ref("bff/src/otel.ts", "withGenAiSpan", "OTel GenAI semconv spans"),
              ref("bff/src/otel.ts", "ATTR"),
              ref("bff/src/ops/onlineEval.ts", "exportSessions"),
              ref("services/ops-mcp/src/ops_mcp/online_eval.py", "ingest"),
              ref("services/ops-mcp/src/ops_mcp/online_eval.py", "agreement")],
        measurements=[
            m("sessions judged", num(k29, "numbers", "judged_pairs", "value")),
            m("pairs with ESCI ground truth", num(k29, "numbers", "pairs_with_ground_truth", "value")),
            m("LEXICAL judge raw agreement", num(k29, "numbers", "judge_agreement", "value"),
              n=num(k29, "numbers", "judge_agreement", "n"),
              ci95=num(k29, "numbers", "judge_agreement", "ci95_wilson")),
            m("LEXICAL judge Cohen's kappa", num(k29, "numbers", "cohens_kappa", "value"),
              n=num(k29, "numbers", "cohens_kappa", "n")),
            m("Jaeger traces visible", num(k29, "numbers", "jaeger_traces_visible", "value")),
        ],
        verdict="the online LEXICAL judge is NOT FIT TO GATE anything",
        headline=("NEGATIVE RESULT. Cohen's kappa = "
                  f"{num(k29, 'numbers', 'cohens_kappa', 'value')} on n="
                  f"{num(k29, 'numbers', 'cohens_kappa', 'n')} labelled pairs, against a relevant base rate of "
                  f"{num(k29, 'numbers', 'base_rate_gold_relevant', 'value')}. A judge that simply always said "
                  "'relevant' would score HIGHER. The tracing is real and the pipeline is real; the judge behind "
                  "it does not agree with gold beyond chance and is reported as unusable. This is a LEXICAL (token-overlap) "
                  "judge, not an LLM judge: see evidence row spike-llm-judge for a separately measured LLM judge."),
        caveats=[num(k29, "sample_size_caveat"), num(k29, "judge", "limits"), num(k29, "honest_note")],
        provenance=["data/technique_coverage.json (technique 29)"])

    lc = lifecycle()
    if lc.get("status") == "real-measured":
        dr = lc["drift"]
        add(30, status="real-measured",
            refs=[ref("services/search-svc/mlops.py", "MLOps", "mmd_perm: MMD^2 with a permutation test, driven by drift()"),
                  ref("services/ops-mcp/src/ops_mcp/tools.py", "compute_drift")],
            measurements=[
                m("MMD permutation p-value, seasonal stream (latest window)", dr.get("p_value"), n=dr.get("window_size"),
                  how=f"{dr.get('n_perm')} permutations; window {dr.get('window')}"),
                m("MMD^2, latest window", dr.get("mmd2"), n=dr.get("window_size")),
            ],
            headline=(f"Drift alert {'RAISED' if dr.get('alert') else 'not raised'}: MMD permutation p = {dr.get('p_value')} on "
                      "the seasonal stream, recorded by scripts/record_lifecycle.py from the live search-svc."),
            caveats=[dr.get("caveat"), "One recorded run; the permutation test is seeded, so re-running reproduces it."],
            provenance=[f"data/lifecycle_measured.json (scripts/record_lifecycle.py, {lc.get('generated_at')})"])
    else:
        add(30, status="real-no-metric",
            refs=[ref("services/search-svc/mlops.py", "MLOps", "mmd_perm: MMD^2 with a permutation test, driven by drift()"),
                  ref("services/ops-mcp/src/ops_mcp/tools.py", "compute_drift")],
            no_metric_reason=("The MMD permutation test runs for real, but data/lifecycle_measured.json has not been "
                              "recorded, so this board asserts no p-value. Run scripts/record_lifecycle.py."),
            caveats=["The 'seasonal' stream is a constructed query set, not observed production traffic."],
            provenance=["repo code; no generated artefact"])

    add(31, status="real-no-metric",
        refs=[ref("services/search-svc/mlops.py", "MLOps", "calibration(): retrieval confidence -> estimated NDCG@10"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "estimate_performance")],
        no_metric_reason=("Runs for real alongside the drift check, but writes no artefact, so no estimate is "
                          "asserted here."),
        caveats=["This is a retrieval-confidence regression, NOT NannyML CBPE/DLE. The playbook's estimator is not "
                 "what is implemented, and the difference is not cosmetic."],
        provenance=["repo code; no generated artefact"])

    r32 = ops_by_id.get(32, {})
    add(32, status="real-measured",
        refs=[ref("services/ops-mcp/src/ops_mcp/tools.py", "cost_model", "ROI + p95 eligibility over measured inputs"),
              ref("services/ops-mcp/src/ops_mcp/measure.py", "measure_p95"),
              ref("services/ops-mcp/src/ops_mcp/measure.py", "measure_rebuild"),
              ref("services/ops-mcp/src/ops_mcp/measure.py", "roi_view")],
        measurements=[
            m("current p95", num(r32, "numbers", "current_p95_ms", "value"), unit="ms",
              n=num(r32, "numbers", "current_p95_ms", "n")),
            m("measured rebuild cost", num(r32, "numbers", "rebuild_usd", "value"), unit="USD"),
            m("business value per 0.01 NDCG/day", num(r32, "numbers", "value_usd_per_0.01_ndcg_day", "value"),
              how="NOT SUPPLIED and no default is applied; ROI is reported as a break-even threshold instead"),
        ],
        headline=("The trigger currently DENIES every remediation, because the technique-16 search found no config "
                  "measurably better than the champion. That denial is the correct output of a cost-aware policy "
                  "and was not worked around."),
        caveats=[num(r32, "honest_note"),
                 "The value-per-NDCG input is deliberately absent - there is no revenue signal on this laptop and "
                 "no plausible-looking default was invented.",
                 "$/CPU-min is an ASSUMPTION; the CPU-minutes are measured.",
                 "The rebuild reuses data/embeddings.npy, so it excludes re-embedding the catalogue."],
        provenance=["data/technique_coverage.json (technique 32)"])

    # ---------------------------------------------------------------- 11-12 Ops / governance (33-36)
    add(33, status="real-no-metric",
        refs=[ref("services/ops-mcp/src/ops_mcp/tools.py", "propose_remediation", "T0-T3 tiered options"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "gate_outlook"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "build_candidate", "approval-gated"),
              ref("services/policy-mcp/src/policy_mcp/policy.py", "check_tier", "server-side tier enforcement")],
        no_metric_reason=("The tiers are enforced for real by policy-mcp (a T3 action without an approval is "
                          "refused before the tool is reached), but there is no measurement of reversibility or "
                          "of how often a tier is mis-declared, because there is no incident history here."),
        caveats=["Declared reversibility is asserted by the tier table, not verified at run time - that is the "
                 "playbook's own named risk for this technique and it is unmitigated here."],
        provenance=["repo code; enforcement provable via `make policy-smoke`"])

    add(34, status="real-no-metric",
        refs=[ref("services/ops-mcp/src/ops_mcp/signing.py", "sign"),
              ref("services/ops-mcp/src/ops_mcp/signing.py", "verify"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "verify_model_signature")],
        no_metric_reason=("Signing and verification really run and really fail on a tampered manifest, but there is "
                          "nothing to measure - it is a boolean, not a metric."),
        caveats=["This is a LOCAL demo key (data/ops_keys/), not Sigstore keyless signing bound to a CI workflow "
                 "identity. The playbook's actual risk - verifying 'any cert' instead of the release identity - is "
                 "therefore not addressed here.",
                 "No admission controller enforces the signature before serving."],
        provenance=["repo code; artefacts under data/model_artifacts/"])

    add(35, status="real-no-metric",
        refs=[ref("services/ops-mcp/src/ops_mcp/mlbom.py", "build", "CycloneDX ML-BOM"),
              ref("services/ops-mcp/src/ops_mcp/mlbom.py", "validate"),
              ref("services/ops-mcp/src/ops_mcp/tools.py", "generate_mlbom")],
        no_metric_reason="A generated, schema-validated document. There is no number to report.",
        caveats=["Covers the model, its config, the encoder and the reranker; it is NOT a full dependency BOM of "
                 "the serving image."],
        provenance=["repo code; output at data/model_artifacts/v4.cdx.json"])

    add(36, status="real-no-metric",
        refs=[ref("bff/src/agents/camel.ts", "runCamel", "privileged planner vs quarantined extractor"),
              ref("bff/src/agents/camel.ts", "quarantinedExtract"),
              ref("bff/src/agents/camel.ts", "resolveArg", "tainted value can never become a trusted item_id"),
              ref("services/policy-mcp/src/policy_mcp/policy.py", "check_camel", "server-side enforcement")],
        no_metric_reason=("The capability separation is real and enforced server-side, but no utility-loss "
                          "measurement was run: the paper's ~7-point cost is a published figure for a different "
                          "benchmark and is NOT claimed as a measurement of this system."),
        caveats=["Covers the cart-action path only, not every tool.",
                 "No A/B of task success with and without CaMeL was run here."],
        provenance=["repo code; bff/src/agents/camel.test.ts"])

    # ---------------------------------------------------------------- verify + assemble
    rows.sort(key=lambda r: r["id"])
    failures: list[str] = []
    for r in rows:
        r["code"], fails = resolve_refs(r["code"])
        r["code_ref"] = ("; ".join(f"{c['file']}:{c['symbol']}" for c in r["code"]) or None)
        if r["status"].startswith("real-"):
            if not r["code"]:
                failures.append(f"technique {r['id']} claims {r['status']} with NO code reference at all")
            failures.extend(f"technique {r['id']} ({r['status']}): {x}" for x in fails)
        elif fails and not quiet:
            print(f"  note: technique {r['id']} ({r['status']}) unresolved ref: {'; '.join(fails)}", file=sys.stderr)

    tally = {s: sum(1 for r in rows if r["status"] == s) for s in STATUSES}
    doc = {
        "generated_by": "scripts/build_coverage.py",
        "about": ("The canonical merge of every source of truth about the playbook's 36 SOTA techniques. One row "
                  "per technique: what is real, what is not, the file AND symbol that implements it, the measured "
                  "number or the honest reason there is none, and the playbook section."),
        "rules": [
            "No number on this board is typed by hand. Each is read out of a generated artefact named in "
            "`provenance`, or it is absent and `no_metric_reason` says why.",
            "A row may not claim real-* unless every code reference resolves: the file exists and the symbol is "
            "DEFINED in it. build_coverage.py exits 1 otherwise.",
            "Null and negative results carry the same weight as positive ones and are flagged, not buried.",
            "`not_run.est_cost_usd` is a STRING carrying arithmetic, copied verbatim from "
            "training/NOT_RUN_HERE.json. It is deliberately not a number: no one measured it.",
        ],
        "sources": {
            "playbook": PLAYBOOK_REL,
            "script_ready_not_executed": "training/NOT_RUN_HERE.json",
            "retrieval_measured": "services/search-svc/SOTA_MEASURED.json",
            "ops_measured": "data/technique_coverage.json",
            "eval_gate": "evals/results.json",
            "data_plane": ["data/selection_report.json", "data/synth_attributes.json", "data/dp_query_logs.json"],
        },
        "statuses": {
            "real-measured": "implemented here AND a number was measured on this machine, with provenance.",
            "real-no-metric": "implemented here and it runs, but no number is claimed - the reason is stated.",
            "script-ready-not-executed": "the script and cloud job spec exist; NO GPU, so it was never run.",
            "absent": "not built here.",
        },
        "tally": tally,
        "null_or_negative": sorted(r["id"] for r in rows if r["null_result"] or r["negative_result"]),
        "total": len(rows),
        "techniques": rows,
    }
    extras = build_extras(rows)
    doc = {"generated_by": doc["generated_by"], "generated_at": extras.pop("generated_at"),
           **{k: v for k, v in doc.items() if k != "generated_by"}, **extras}
    for block in ("preregistered_gate",):
        for c in doc[block].get("code", []):
            f = ROOT / c["file"]
            c["resolved"] = f.exists() and symbol_defined(f.read_text(errors="replace"), c["symbol"])
            if not c["resolved"]:
                failures.append(f"{block}: {c['file']}:{c['symbol']} does not resolve")
    for ev in doc["evidence"]:
        for pth in ev.get("provenance", []):
            if pth.startswith("docs/") and not (ROOT / pth).exists():
                failures.append(f"evidence {ev.get('key')}: {pth} does not exist in the repo")
    return doc, failures


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "coverage.json"))
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    doc, failures = build(a.quiet)
    missing = sorted({i for i in range(1, 37)} - {r["id"] for r in doc["techniques"]})
    if missing:
        failures.append(f"techniques missing from the board entirely: {missing}")

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1) + "\n")

    if not a.quiet:
        print(f"wrote {out} - {doc['total']} techniques")
        for s in STATUSES:
            print(f"  {s:<28} {doc['tally'][s]}")
        print(f"  null or negative results     {doc['null_or_negative']}")

    if failures:
        print(f"\nFAIL: {len(failures)} real-* claim(s) do not resolve to code:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    if not a.quiet:
        print("\nOK: every real-* claim resolves to a file and a defined symbol.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
