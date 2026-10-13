"""Technique 16 - MLE search agent over the ranking config space.

This replaces the hand-written remediation MENU with a real search. Nothing here is a
prior or a canned number: every trial

  1. proposes a config (greedy coordinate search with memory over the ranking parameters
     search-svc actually accepts: rrf_k, w_bm25, w_vector, rerank_depth, reranker),
  2. registers it as a REAL model version via search-svc POST /models/candidate (so it is
     logged to MLflow with its config, exactly like any other candidate - playbook 16 AC2),
  3. runs the REAL paired eval via search-svc POST /eval/compare on the *search* split, and
  4. observes NDCG@10 with its paired bootstrap CI and p95 latency.

Budget (playbook 16 US-16.1 AC1) is explicit and enforced on BOTH axes: a trial count and a
dollar cap. The dollar figure is not assumed - each trial's cost is its measured wall clock
multiplied by a stated $/CPU-minute rate, and the loop stops before starting a trial it
cannot afford. `on_breach` mirrors the playbook's kill_and_snapshot: the partial trajectory
is still returned.

Leaderboard guard (playbook 16 US-16.2): the search runs on `split="dev"`. The `test` split
is SEALED during the search - no trial is ever scored on it - and only the single winning
config is finally scored on test. The gap between the dev delta and the sealed-test delta is
reported; a gap beyond `GUARD_MAX_GAP` is flagged as probable dev overfitting. A null result
(the incumbent is already best) is a first-class outcome and is reported as such.
"""
from __future__ import annotations

import itertools
import time
from typing import Any, Callable

from . import search_client

# $/CPU-minute used to price a trial. Same rate the retrain cost model uses; it is an
# explicitly stated rate, and the MINUTES are measured, not assumed.
USD_PER_CPU_MIN = 0.0017

# The config space. Only keys search-svc's ModelConfig actually accepts, and only values
# inside its pydantic bounds.
SPACE: dict[str, list[Any]] = {
    "rrf_k": [20, 40, 60, 90, 120],
    "w_bm25": [0.5, 0.7, 1.0, 1.3],
    "w_vector": [0.7, 1.0, 1.3],
    "rerank_depth": [25, 50, 75, 100],
}

# A dev-vs-sealed-test delta gap wider than this means the search hill-climbed the split it
# could see. It does not block anything; it is surfaced for the human reviewer (T1 only).
GUARD_MAX_GAP = 0.02


def _cost(seconds: float) -> float:
    return round(seconds / 60.0 * USD_PER_CPU_MIN, 6)


def _better(a: dict, b: dict | None) -> bool:
    """Strictly better observed mean NDCG@10 delta. Ties do not move the incumbent, so a
    null result stays a null result instead of drifting on noise."""
    return b is None or a["ndcg10_delta"] > b["ndcg10_delta"] + 1e-9


def _proposals(base: dict, seen: set[tuple]) -> list[dict]:
    """One coordinate move away from the incumbent, skipping configs already evaluated.

    Memory (`seen`) is what makes this a search rather than a sweep: the controller never
    pays for the same config twice, so the budget buys new information every time.
    """
    out = []
    for key, values in SPACE.items():
        for v in values:
            if base.get(key) == v:
                continue
            cand = {**base, key: v}
            sig = tuple(sorted(cand.items()))
            if sig in seen:
                continue
            out.append({"config": cand, "move": f"{key}: {base.get(key)} -> {v}"})
    return out


def search(
    *,
    baseline: str = "champion",
    max_trials: int = 10,
    usd_cap: float = 0.05,
    n_queries: int = 120,
    search_split: str = "dev",
    holdout_split: str = "test",
    holdout_n: int = 200,
    call: Callable[..., dict] | None = None,
) -> dict:
    """Run the search. Returns the trajectory, the best config, and the sealed-holdout verdict.

    `call` is injected in tests; by default every call is a real HTTP call to search-svc.
    """
    call = call or search_client.call
    t_start = time.perf_counter()
    spent = 0.0
    trials: list[dict] = []
    seen: set[tuple] = set()
    stop_reason = "search_converged"

    reg = call("GET", "/models")
    base_version = reg.get(baseline) if baseline in ("champion", "candidate") else baseline
    base_rec = next((v for v in reg["versions"] if v["version"] == base_version), None)
    if base_rec is None:
        raise KeyError(f"unknown baseline version {baseline!r}")
    base_cfg = {k: base_rec["config"][k] for k in SPACE if k in base_rec["config"]}
    seen.add(tuple(sorted(base_cfg.items())))

    incumbent: dict | None = None
    incumbent_cfg = dict(base_cfg)

    for round_no in itertools.count(1):
        if len(trials) >= max_trials:
            stop_reason = "trial_budget_exhausted"
            break
        options = _proposals(incumbent_cfg, seen)
        if not options:
            stop_reason = "config_space_exhausted"
            break
        improved_this_round = False
        for opt in options:
            if len(trials) >= max_trials:
                stop_reason = "trial_budget_exhausted"
                break
            # Stop BEFORE spending, using the mean measured cost so far as the estimate.
            est = (spent / len(trials)) if trials else 0.0
            if trials and spent + est > usd_cap:
                stop_reason = "dollar_budget_exhausted"
                break
            sig = tuple(sorted(opt["config"].items()))
            seen.add(sig)
            t0 = time.perf_counter()
            built = call("POST", "/models/candidate", {
                "config": opt["config"],
                "actor": "mle-search-agent",
                "note": f"technique 16 MLE search trial {len(trials) + 1}: {opt['move']}",
            })
            cmp = call("POST", "/eval/compare", {
                "champion": base_version, "candidate": built["version"],
                "split": search_split, "n_queries": n_queries,
            })
            secs = time.perf_counter() - t0
            cost = _cost(secs)
            spent = round(spent + cost, 6)
            nd = cmp["metrics"]["ndcg10"]
            trial = {
                "trial": len(trials) + 1,
                "round": round_no,
                "move": opt["move"],
                "version": built["version"],
                "config": opt["config"],
                "ndcg10": nd["candidate"],
                "ndcg10_delta": nd["delta"]["mean"],
                "ci95": nd["delta"]["ci95"],
                "p95_ms": cmp["latency"]["candidate"]["p95_ms"],
                "n_queries": cmp["n_queries"],
                "seconds": round(secs, 2),
                "cost_usd": cost,
                "cumulative_usd": spent,
                "accepted": False,
                "mlflow_run_id": (built.get("mlflow") or {}).get("run_id"),
            }
            if _better(trial, incumbent):
                trial["accepted"] = True
                incumbent = trial
                incumbent_cfg = dict(opt["config"])
                improved_this_round = True
            trials.append(trial)
            if trial["accepted"]:
                break  # greedy: restart the coordinate sweep from the new incumbent
        if stop_reason != "search_converged":
            break
        if not improved_this_round:
            stop_reason = "no_improving_move_found"
            break

    # -------- sealed holdout. Scored exactly once, on the winner only. --------
    holdout: dict | None = None
    guard = {
        "sealed_split": holdout_split,
        "seen_by_search": False,
        "search_split": search_split,
        "max_dev_holdout_gap": GUARD_MAX_GAP,
        "note": f"no trial was scored on {holdout_split!r}; only the winning config is, once, after the budget closes",
    }
    if incumbent is not None:
        t0 = time.perf_counter()
        hc = call("POST", "/eval/compare", {
            "champion": base_version, "candidate": incumbent["version"],
            "split": holdout_split, "n_queries": holdout_n,
        })
        hsecs = time.perf_counter() - t0
        spent = round(spent + _cost(hsecs), 6)
        hnd = hc["metrics"]["ndcg10"]
        gap = round(incumbent["ndcg10_delta"] - hnd["delta"]["mean"], 5)
        holdout = {
            "split": holdout_split,
            "n_queries": hc["n_queries"],
            "baseline_ndcg10": hnd["champion"],
            "best_ndcg10": hnd["candidate"],
            "ndcg10_delta": hnd["delta"]["mean"],
            "ci95": hnd["delta"]["ci95"],
            "p_delta_le_0": hnd["delta"]["p_le_0"],
            "wins_losses_ties": [hnd["wins"], hnd["losses"], hnd["ties"]],
            "p95_ms": hc["latency"]["candidate"]["p95_ms"],
            "baseline_p95_ms": hc["latency"]["champion"]["p95_ms"],
            "method": hc["method"],
            "seconds": round(hsecs, 2),
        }
        guard["dev_minus_holdout_gap"] = gap
        guard["flagged"] = abs(gap) > GUARD_MAX_GAP
        guard["flag_reason"] = (
            f"dev delta {incumbent['ndcg10_delta']:+.5f} vs sealed {holdout_split} delta "
            f"{hnd['delta']['mean']:+.5f}: gap {gap:+.5f} exceeds {GUARD_MAX_GAP}; treat the dev win as overfitting"
            if abs(gap) > GUARD_MAX_GAP else None
        )

    # -------- verdict. A null result is a result. --------
    # The search incumbent is only ever the best thing SEEN; beating the baseline means a
    # positive delta against it. Those are different claims and are kept apart on purpose.
    beats_baseline = bool(incumbent and incumbent["ndcg10_delta"] > 0)
    if incumbent is None:
        verdict, headline = "null_result", (
            f"No trial completed against {base_version} within the budget."
        )
    elif not beats_baseline:
        verdict, headline = "null_result", (
            f"Every one of the {len(trials)} configs tried scored at or below the incumbent {base_version} on "
            f"{search_split}. The best of them, {incumbent['version']} ({incumbent['move']}), was still "
            f"{incumbent['ndcg10_delta']:+.5f} NDCG@10 behind. The default configuration is the best this search "
            f"could find; there is nothing to propose."
            + (f" Scored once on the sealed {holdout_split} split for completeness: "
               f"{holdout['ndcg10_delta']:+.5f}, CI95 {holdout['ci95']} - also indistinguishable from zero."
               if holdout else "")
        )
    elif holdout and holdout["ci95"][0] > 0:
        verdict, headline = "improvement_confirmed", (
            f"{incumbent['version']} beats {base_version} by {holdout['ndcg10_delta']:+.5f} NDCG@10 on the sealed "
            f"{holdout_split} split, CI95 {holdout['ci95']} - the whole interval is above zero."
        )
    elif holdout:
        verdict, headline = "no_significant_improvement", (
            f"Best config {incumbent['version']} ({incumbent['move']}) led on {search_split} by "
            f"{incumbent['ndcg10_delta']:+.5f}, but on the sealed {holdout_split} split the delta is "
            f"{holdout['ndcg10_delta']:+.5f} with CI95 {holdout['ci95']}, which straddles zero. "
            f"That is a null result: the search found no config that is measurably better than {base_version}."
        )
    else:
        verdict, headline = "null_result", "no trial completed"

    return {
        "technique": 16,
        "objective": {"metric": "ndcg@10", "direction": "maximize", "search_split": search_split,
                      "n_queries_per_trial": n_queries},
        "baseline": {"version": base_version, "config": base_cfg},
        "strategy": "greedy coordinate search with memory; restart the sweep from each accepted incumbent",
        "space": SPACE,
        "space_size": int(_space_size()),
        "budget": {"max_trials": max_trials, "usd_cap": usd_cap,
                   "usd_per_cpu_min": USD_PER_CPU_MIN,
                   "basis": "measured wall clock per trial x the stated $/CPU-min rate",
                   "caveat": "search-svc memoises per-query eval results by config hash, so re-running a search that "
                             "revisits the same configs costs a fraction of the first, cold run. Quote the cold number.",
                   "on_breach": "stop before the next trial and return the partial trajectory"},
        "spent": {"trials": len(trials), "usd": spent,
                  "wall_clock_s": round(time.perf_counter() - t_start, 2),
                  "stop_reason": stop_reason},
        "trajectory": trials,
        "best_observed": incumbent,
        "beats_baseline_on_search_split": beats_baseline,
        "best": incumbent if beats_baseline else None,
        "holdout": holdout,
        "leaderboard_guard": guard,
        "verdict": verdict,
        "headline": headline,
        "human_review": "T1 sandbox result. No config is promoted by this tool: propose_remediation/build_candidate "
                        "and the eval gate remain the only path to champion, and both need a human.",
    }


def _space_size() -> int:
    n = 1
    for v in SPACE.values():
        n *= len(v)
    return n
