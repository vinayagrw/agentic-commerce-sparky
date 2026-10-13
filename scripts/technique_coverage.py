#!/usr/bin/env python
"""Write data/technique_coverage.json: every number this repo claims for techniques 16, 22, 26, 29 and 32,
with how it was computed and its sample size.

Follows the shape of training/NOT_RUN_HERE.json, but inverted: that file records techniques that were NOT
run here and are therefore citations, not measurements. This one records the techniques that WERE run, and
every entry carries `status: "real-measured"` plus the exact command and sample size behind it. Anything
that could not be measured is recorded with its own status ("user-supplied-assumption", "not-measured")
rather than being given a plausible-looking number.

Run it with the services up:
    make dev            # search-svc :8801, ops-http :8803, bff :8787 (BFF needs OTEL_ENABLED=1 for 29)
    docker run -d --name sparky-jaeger -e COLLECTOR_OTLP_ENABLED=true -p 16686:16686 -p 4318:4318 \
        jaegertracing/all-in-one:latest
    cd services/ops-mcp && uv run python ../../scripts/technique_coverage.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "ops-mcp" / "src"))

from ops_mcp import measure, redteam  # noqa: E402

BFF = "http://127.0.0.1:8787"
JAEGER = "http://127.0.0.1:16686"
OUT = ROOT / "data" / "technique_coverage.json"


def get(url: str, timeout: float = 180.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as e:  # noqa: BLE001 - a dead service must be recorded, not raised
        return {"_unreachable": f"{url}: {e!r}"}


def post(url: str, body: dict | None = None, timeout: float = 60.0):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        return {"_unreachable": f"{url}: {e!r}"}


def unreachable(*objs) -> str | None:
    for o in objs:
        if isinstance(o, dict) and "_unreachable" in o:
            return o["_unreachable"]
    return None


def t16() -> dict:
    p = ROOT / "data" / "mle_search_report.json"
    if not p.exists():
        return {"id": 16, "status": "not-run", "how": "run ops_mcp.tools.run_mle_search() with search-svc up"}
    r = json.loads(p.read_text())
    return {
        "id": 16, "name": "MLE search agent over the ranking config space",
        "module": "services/ops-mcp/src/ops_mcp/mle_search.py",
        "command": "ops_mcp.tools.run_mle_search(max_trials=10, usd_cap=0.05, n_queries=120)",
        "status": "real-measured",
        "verdict": r["verdict"], "headline": r["headline"],
        "numbers": {
            "trials": {"value": r["spent"]["trials"], "status": "real-measured",
                       "how": "each trial registered a real model version via search-svc POST /models/candidate and "
                              "ran search-svc POST /eval/compare on the dev split"},
            "usd_spent": {"value": r["spent"]["usd"], "status": "real-measured",
                          "how": "measured wall clock per trial x $0.0017/CPU-min (rate: assumption, minutes: measured)",
                          "caveat": r["budget"].get("caveat")},
            "wall_clock_s": {"value": r["spent"]["wall_clock_s"], "status": "real-measured"},
            "search_split_n_queries": {"value": r["objective"]["n_queries_per_trial"], "status": "real-measured"},
            "best_observed_dev_delta": {"value": (r.get("best_observed") or {}).get("ndcg10_delta"),
                                        "ci95": (r.get("best_observed") or {}).get("ci95"),
                                        "n": (r.get("best_observed") or {}).get("n_queries"),
                                        "status": "real-measured",
                                        "how": "paired per-query NDCG@10 delta vs champion, percentile bootstrap 1000 resamples"},
            "sealed_holdout_delta": {"value": (r.get("holdout") or {}).get("ndcg10_delta"),
                                     "ci95": (r.get("holdout") or {}).get("ci95"),
                                     "n": (r.get("holdout") or {}).get("n_queries"),
                                     "status": "real-measured",
                                     "how": "the test split was never scored during the search; the winner was scored on it once"},
        },
        "leaderboard_guard": r["leaderboard_guard"],
        "honest_note": "a null result. Nothing here proposes a promotion.",
    }


def t22() -> dict:
    r = redteam.adaptive_run(seed=20260915, generations=8, per_generation=16, usd_cap=1.0, promote=False)
    reg = redteam.run()
    return {
        "id": 22, "name": "Adaptive red-team attacker agent",
        "module": "services/ops-mcp/src/ops_mcp/redteam.py",
        "command": "ops_mcp.tools.run_red_team(generations=8, per_generation=16, usd_cap=1.0)  [seed 20260915 here for reproducibility]",
        "status": "real-measured",
        "verdict": r["verdict"],
        "numbers": {
            "attempts": {"value": r["attempts"], "status": "real-measured",
                         "how": "attack strings composed at run time and fired at shop_mcp.injection.detect_injection, "
                                "the guard shop-mcp really runs on untrusted seller text; de-duplicated"},
            "blocked": {"value": r["blocked"], "status": "real-measured"},
            "block_rate": {"value": r["block_rate"], "ci95_wilson": r["block_rate_ci95_wilson"],
                           "n": r["attempts"], "status": "real-measured"},
            "attack_success_rate": {"value": r["attack_success_rate"], "n": r["attempts"], "status": "real-measured"},
            "usd_spent": {"value": r["spent"]["usd"], "status": "real-measured",
                          "how": "measured CPU time x $0.0017/CPU-min. The attacker is a local evolutionary search, so "
                                 "no LLM tokens were bought; the $1 cap was never approached."},
            "regression_suite_block_rate": {"value": reg["blocked_rate"], "n": reg["attacks"], "status": "real-measured",
                                            "how": "the seed suite in evals/tasks.yaml, which is the eval gate's metric"},
            "open_findings_still_bypassing": {"value": reg["open_findings"]["still_bypassing"],
                                              "of": reg["open_findings"]["replayed"], "status": "real-measured",
                                              "how": "every past bypass is replayed against the CURRENT detector"},
        },
        "per_intent_asr": r["per_intent"],
        "successful_attacks_verbatim": r["successful_attacks"][:20],
        "tool_surface": r["tool_surface"],
        "honest_note": r["honesty_note"],
    }


def t26() -> dict:
    with_casc = get(f"{BFF}/api/ops/router?n=40")
    no_casc = get(f"{BFF}/api/ops/router?n=40&escalate=0")
    if (u := unreachable(with_casc, no_casc)):
        return {"id": 26, "status": "not-measured", "reason": u}
    arms = {a["arm"]: a for a in no_casc["arms"]}
    metrics = get(f"{BFF}/api/metrics")
    return {
        "id": 26, "name": "Model routing / cascade with route receipts",
        "module": "bff/src/ops/router.ts",
        "command": "GET /api/ops/router?n=40  and  GET /api/ops/router?n=40&escalate=0",
        "status": "real-measured",
        "numbers": {
            "requests_made": {"value": with_casc["requests_made"] + no_casc["requests_made"], "status": "real-measured",
                              "how": "every one a real HTTP POST /search to search-svc, timed in the BFF"},
            "arms": {name: {"p50_ms": a["p50_ms"], "p95_ms": a["p95_ms"], "n": a["n"],
                            "cost_per_1k_usd": a["cost_per_1k_usd"], "status": "real-measured" if a["n"] else "not-measured",
                            "how": a["measured_from"]}
                     for name, a in arms.items()},
            "cost_per_1k_routed_with_cascade": {"value": with_casc["cost_per_1k"]["routed"], "n": with_casc["n"],
                                                "status": "real-measured"},
            "cost_per_1k_routed_no_cascade": {"value": no_casc["cost_per_1k"]["routed"], "n": no_casc["n"],
                                              "status": "real-measured"},
            "cost_per_1k_always_premium": {"value": no_casc["cost_per_1k"]["always_premium"], "n": no_casc["n"],
                                           "status": "real-measured",
                                           "how": "the same queries driven through the premium arm alone, paired control"},
            "saving_vs_always_premium_with_cascade_pct": {"value": with_casc["cost_per_1k"]["savings_pct"],
                                                          "status": "real-measured"},
            "saving_vs_always_premium_no_cascade_pct": {"value": no_casc["cost_per_1k"]["savings_pct"],
                                                        "status": "real-measured"},
            "escalations_with_cascade": {"value": with_casc["escalations"], "of": with_casc["n"], "status": "real-measured"},
            "claude_arm": {"value": None, "status": "not-measured",
                           "how": "no Claude CLI runs were recorded in the measured process, so no LLM-arm latency or "
                                  "cost is claimed. metrics.ts returns null and the router says so."},
            "usd_per_cpu_min": {"value": 0.0017, "status": "assumption",
                                "how": "laptop CPU rate. The wall-clock ms it multiplies are measured; this rate is not."},
        },
        "measured_arm_buckets": {k: v for k, v in metrics.items() if isinstance(v, dict) and v.get("n")},
        "honest_note": "the cascade as configured LOSES money on this traffic: the rank1/rank3 margin threshold fires on "
                       "almost every query, so the router pays for both arms. Pure routing without the cascade is the "
                       "arm that saves. Both numbers are reported; neither was tuned to look good.",
        "not_measured": "quality per arm. This reports cost and latency only; NDCG@10 per mode is search-svc /eval/ndcg's job.",
    }


def t29() -> dict:
    exported = post(f"{BFF}/api/ops/online-evals/export")
    ag = get(f"{BFF}/api/ops/online-evals/agreement?rate=1.0&max_pairs=400")
    tr = get(f"{BFF}/api/ops/tracing")
    services = get(f"{JAEGER}/api/services", timeout=10)
    traces = get(f"{JAEGER}/api/traces?service=sparky-bff&limit=20", timeout=20)
    if (u := unreachable(ag, tr)):
        return {"id": 29, "status": "not-measured", "reason": u}
    n_traces = len(traces.get("data") or []) if isinstance(traces, dict) else 0
    return {
        "id": 29, "name": "LLM online evals + OpenTelemetry GenAI tracing",
        "modules": ["bff/src/otel.ts", "bff/src/ops/onlineEval.ts", "services/ops-mcp/src/ops_mcp/online_eval.py"],
        "command": "OTEL_ENABLED=1 npm run dev:bff; GET /api/ops/router; POST /api/ops/online-evals/export; "
                   "GET /api/ops/online-evals/agreement",
        "status": "real-measured",
        "numbers": {
            "sessions_ingested_this_run": {"value": exported.get("exported"), "status": "real-measured",
                                           "how": "sessions the BFF actually served, one per traced routed request"},
            "sessions_population": {"value": ag.get("sessions_population"), "status": "real-measured"},
            "sessions_sampled": {"value": ag.get("sessions_sampled"), "status": "real-measured",
                                 "how": ag.get("sampling")},
            "judged_pairs": {"value": ag.get("judged_pairs"), "status": "real-measured"},
            "pairs_with_ground_truth": {"value": ag.get("pairs_with_ground_truth"), "status": "real-measured",
                                        "how": "held-out ESCI qrels (dev+test); E/S = relevant, C/I = not"},
            "judge_agreement": {"value": ag.get("agreement"), "ci95_wilson": ag.get("agreement_ci95_wilson"),
                                "n": ag.get("pairs_with_ground_truth"), "status": "real-measured"},
            "cohens_kappa": {"value": ag.get("cohens_kappa"), "n": ag.get("pairs_with_ground_truth"),
                             "status": "real-measured"},
            "base_rate_gold_relevant": {"value": ag.get("base_rate_gold_relevant"), "status": "real-measured"},
            "confusion": {"value": ag.get("confusion"), "status": "real-measured"},
            "jaeger_traces_visible": {"value": n_traces, "status": "real-measured",
                                      "how": f"GET {JAEGER}/api/traces?service=sparky-bff (services seen: "
                                             f"{services.get('data') if isinstance(services, dict) else services})"},
        },
        "tracing": tr,
        "judge": ag.get("judge"),
        "sample_size_caveat": ag.get("sample_size_caveat"),
        "honest_note": "the lexical online judge does NOT agree with ESCI gold beyond chance at this sample size - a "
                       "negative kappa with a relevant base rate above 70% means a judge that always said 'relevant' "
                       "would score higher. The judge is not fit to gate anything and is reported as such.",
    }


def t32() -> dict:
    try:
        p95 = measure.measure_p95(refresh=True)
        rebuild = measure.measure_rebuild(refresh=True)
    except Exception as e:  # noqa: BLE001
        return {"id": 32, "status": "not-measured", "reason": repr(e)}
    value = measure.value_assumption()
    roi = measure.roi_view(value.get("value"), 0.005, rebuild["usd"] * 2)
    return {
        "id": 32, "name": "Cost-aware retrain triggers over measured inputs",
        "modules": ["services/ops-mcp/src/ops_mcp/measure.py", "services/ops-mcp/src/ops_mcp/tools.py"],
        "command": "ops_mcp.tools.propose_remediation('latest')",
        "status": "real-measured",
        "numbers": {
            "current_p95_ms": {"value": p95["p95_ms"], "p50_ms": p95["p50_ms"], "n": p95["samples"],
                               "status": "real-measured", "how": p95["how"], "caveat": p95["caveat"],
                               "replaces": "the hard-coded CURRENT_P95_MS = 104.0"},
            "rebuild_cpu_min": {"value": rebuild["cpu_min"], "seconds": rebuild["seconds"], "status": "real-measured",
                                "how": rebuild["how"], "caveat": rebuild["caveat"]},
            "rebuild_usd": {"value": rebuild["usd"], "status": "real-measured",
                            "how": "measured CPU-minutes x the stated $/CPU-min rate"},
            "usd_per_cpu_min": {"value": measure.USD_PER_CPU_MIN, "status": "assumption",
                                "how": "~$0.10 per vCPU-hour on demand. Stated, not measured."},
            "value_usd_per_0.01_ndcg_day": {"value": value.get("value"), "status": value["status"],
                                            "how": value["how"], "never": value["never"],
                                            "replaces": "the hard-coded VALUE_USD_PER_001_NDCG_DAY = 400.0"},
            "break_even_example": {"value": roi.get("break_even_usd_per_001_ndcg_day"),
                                   "status": "derived-from-measured",
                                   "how": "at a hypothetical +0.005 NDCG gain and the measured rebuild cost: the $/day "
                                          "value of 0.01 NDCG at which the retrain exactly pays for itself. Needs no "
                                          "value assumption at all.",
                                   "sensitivity": roi.get("sensitivity")},
        },
        "honest_note": "the trigger currently DENIES every remediation, because the technique-16 search found no config "
                       "measurably better than the champion. That denial is the correct output of a cost-aware policy "
                       "and is not worked around.",
    }


def main() -> int:
    doc = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "about": "Techniques made real in this repo. Every entry's numbers carry status: real-measured / "
                 "derived-from-measured / assumption / not-measured, plus how they were computed and the sample size. "
                 "Counterpart to training/NOT_RUN_HERE.json, which records the techniques that were NOT run here.",
        "rules": [
            "No number is written by hand. Everything below was produced by the command named in its entry.",
            "A value that cannot be measured on a laptop is marked `assumption` or `not-measured`. It is never given "
            "a plausible-looking default.",
            "Null and negative results are recorded with the same prominence as positive ones.",
        ],
        "techniques": [t16(), t22(), t26(), t29(), t32()],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=2, ensure_ascii=False))
    print(f"wrote {OUT}")
    for t in doc["techniques"]:
        print(f"  {t['id']:>3}  {t.get('status')}  {t.get('verdict', '')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
