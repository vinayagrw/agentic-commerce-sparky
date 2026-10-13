#!/usr/bin/env python3
"""B07 per-query-type slice report on the held-out ESCI test split.

Classifies every scored test query with services/search-svc/query_types.classify (rules, no LLM),
computes per-query NDCG@10 (engine.ndcg10) for bm25 / vector / rrf / rrf_rerank with the real
engine, and reports per slice x mode {n, mean, percentile-bootstrap 95% CI}, plus paired deltas
(rrf - bm25, rrf_rerank - bm25). Then applies ONE targeted fix (see slice_fixes.py) to the worst
slice and re-measures on that slice and on all queries.

Usage (from services/search-svc):
    uv run python ../../scripts/slice_report.py [--n-queries 100000] [--cache PATH]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SVC = ROOT / "services" / "search-svc"
sys.path.insert(0, str(SVC))

SEED = 20260916
B = 2000
MODES = ["bm25", "vector", "rrf", "rrf_rerank"]
MIN_N = 30  # a slice needs at least this many queries to be eligible as "worst slice"


def boot_mean_ci(x, seed=SEED, b=B):
    x = np.asarray(x, dtype=float)
    if len(x) == 0:
        return None
    rng = np.random.default_rng(seed)
    means = x[rng.integers(0, len(x), size=(b, len(x)))].mean(axis=1)
    return [round(float(np.percentile(means, 2.5)), 4), round(float(np.percentile(means, 97.5)), 4)]


def stat(x):
    return {"n": len(x), "mean": round(float(np.mean(x)), 4) if len(x) else None, "ci95": boot_mean_ci(x)}


def paired(a, b_):
    d = np.asarray(a) - np.asarray(b_)
    ci = boot_mean_ci(d)
    return {"n": len(d), "mean_delta": round(float(d.mean()), 4), "ci95": ci,
            "wins": int((d > 1e-9).sum()), "losses": int((d < -1e-9).sum()), "ties": int((np.abs(d) <= 1e-9).sum()),
            "significant": bool(ci and (ci[0] > 0 or ci[1] < 0))}


def score_modes(e, qids, grades, qtext, rank_fn_by_mode):
    from engine import ndcg10

    out = {m: {} for m in rank_fn_by_mode}
    for j, q in enumerate(qids):
        for m, fn in rank_fn_by_mode.items():
            ranked = fn(qtext[q])
            v = ndcg10(grades[q], ranked)
            if v is not None:
                out[m][int(q)] = v
        if (j + 1) % 100 == 0:
            print(f"  {j + 1}/{len(qids)}", flush=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="test")
    ap.add_argument("--n-queries", type=int, default=100000)
    ap.add_argument("--cache", default="", help="optional per-query baseline cache (json) to skip recompute")
    ap.add_argument("--out", default=str(ROOT / "data" / "slice_report.json"))
    ap.add_argument("--fix-all", action="store_true",
                    help="re-run every query through the fix function (verifies non-target queries are unchanged)")
    a = ap.parse_args()

    import torch  # noqa: F401
    from engine import Engine
    import query_types
    import slice_fixes

    t0 = time.time()
    e = Engine()
    qids, grades = e.eval_qids(a.split, a.n_queries)
    qtext = dict(zip(e.queries.query_id, e.queries["query"]))
    cls = {int(q): query_types.classify(qtext[q]) for q in qids}

    def mode_fn(mode):
        return lambda s: [r["product_id"] for r in e.search(s, k=10, mode=mode)["results"]]

    cache = Path(a.cache) if a.cache else None
    if cache and cache.exists():
        base = {m: {int(k): v for k, v in d.items()} for m, d in json.loads(cache.read_text()).items()}
        print(f"[slice] loaded baseline cache {cache}", flush=True)
    else:
        print(f"[slice] scoring {len(qids)} {a.split} queries x {MODES}", flush=True)
        base = score_modes(e, qids, grades, qtext, {m: mode_fn(m) for m in MODES})
        if cache:
            cache.write_text(json.dumps(base))
    t_base = time.time() - t0
    common = sorted(set.intersection(*[set(base[m]) for m in MODES]))

    classes = query_types.CLASSES + ["ALL"]
    per_slice, deltas, dist = {}, {}, {}
    for c in classes:
        ids = common if c == "ALL" else [q for q in common if cls[q] == c]
        dist[c] = len(ids)
        if not ids:
            continue
        per_slice[c] = {m: stat([base[m][q] for q in ids]) for m in MODES}
        deltas[c] = {
            "rrf_minus_bm25": paired([base["rrf"][q] for q in ids], [base["bm25"][q] for q in ids]),
            "rrf_rerank_minus_bm25": paired([base["rrf_rerank"][q] for q in ids], [base["bm25"][q] for q in ids]),
        }

    eligible = [c for c in query_types.CLASSES if dist.get(c, 0) >= MIN_N]
    worst = min(eligible, key=lambda c: per_slice[c]["rrf_rerank"]["mean"])
    print(f"[slice] worst slice (production rrf_rerank, n>={MIN_N}): {worst}", flush=True)

    # ------------------------------------------------------------------ fix
    fix_spec = slice_fixes.FIXES.get(worst)
    fix = {"slice": worst, "applied": False}
    regression = None
    if fix_spec is None:
        fix["description"] = f"no fix implemented for slice {worst}"
    else:
        from engine import ndcg10
        base_fn = fix_spec["fn"]
        # ---- choose the variant on the DEV split (no test labels touched) ----
        dqids, dgrades = e.eval_qids("dev", 100000)
        dids = [q for q in dqids if query_types.classify(qtext[q]) == worst]
        tuning = {"split": "dev", "n": len(dids), "selection": "highest mean NDCG@10 on dev slice", "arms": {}}
        dev_scores = {}
        for name in ["baseline"] + fix_spec["candidates"]:
            vals = []
            for q in dids:
                order = (slice_fixes.production_rank(e, qtext[q]) if name == "baseline"
                         else base_fn(e, qtext[q], worst, variant=name))
                v = ndcg10(dgrades[q], [e.ids[i] for i in order])
                if v is not None:
                    vals.append(v)
            dev_scores[name] = vals
            tuning["arms"][name] = stat(vals)
        chosen = max(fix_spec["candidates"], key=lambda n: np.mean(dev_scores[n]))
        for name in fix_spec["candidates"]:
            tuning["arms"][name]["paired_vs_baseline"] = paired(dev_scores[name], dev_scores["baseline"])
        tuning["chosen_variant"] = chosen
        fix_spec["tuning"] = tuning
        print(f"[slice] dev tuning: {json.dumps(tuning)}", flush=True)
        fn = lambda e_, s, c: base_fn(e_, s, c, variant=chosen)  # noqa: E731
        print(f"[slice] applying fix {fix_spec['symbol']} to {worst} (production path rrf_rerank)", flush=True)
        after = {}
        for j, q in enumerate(common):
            if cls[q] != worst and not a.fix_all:
                after[q] = base["rrf_rerank"][q]  # fix is class-gated: non-target path is production_rank == search(rrf_rerank)
                continue
            ranked = [e.ids[i] for i in fn(e, qtext[q], query_types.classify(qtext[q]))]
            after[q] = ndcg10(grades[q], ranked)
            if (j + 1) % 200 == 0:
                print(f"  fix {j + 1}/{len(common)}", flush=True)
        ids = [q for q in common if cls[q] == worst]
        bef = [base["rrf_rerank"][q] for q in ids]
        aft = [after[q] for q in ids]
        d = paired(aft, bef)
        verdict = ("improved (CI excludes 0)" if d["significant"] and d["mean_delta"] > 0 else
                   "regressed (CI excludes 0)" if d["significant"] else "no significant change (CI includes 0)")
        fix.update(applied=True, description=fix_spec["description"],
                   code_ref={"file": "services/search-svc/slice_fixes.py", "symbol": fix_spec["symbol"],
                                 "variant": chosen},
                   tuning=fix_spec.get("tuning"), mode="rrf_rerank (production path)",
                   before=stat(bef), after=stat(aft), delta=d["mean_delta"], ci95=d["ci95"], n=d["n"],
                   paired=d, verdict=verdict)
        allb = [base["rrf_rerank"][q] for q in common]
        alla = [after[q] for q in common]
        ra = paired(alla, allb)
        others = [q for q in common if cls[q] != worst]
        ro = paired([after[q] for q in others], [base["rrf_rerank"][q] for q in others])
        regression = {"all_queries": {"before": stat(allb), "after": stat(alla), "paired": ra},
                      "non_target_queries": {"paired": ro,
                                             "note": ("fix is gated on the classifier; non-target queries were " + ("re-run through the fix path" if a.fix_all
                                                      else "copied from the baseline (not re-run)"))},
                      "verdict": ("regression (CI upper < 0)" if ra["ci95"][1] < 0 else "no significant regression")}

    rep = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "script": "scripts/slice_report.py",
        "split": a.split,
        "n_total": len(common),
        "metric": "engine.ndcg10 (exponential gain, @10); query selection engine.eval_qids (test split, max gain > 0)",
        "bootstrap": {"type": "percentile", "resamples": B, "seed": SEED},
        "modes": {"bm25": "BM25 only", "vector": "dense bge-small FAISS", "rrf": "hybrid RRF k=60 (no rerank)",
                  "rrf_rerank": "hybrid RRF + cross-encoder top-50 (production path)"},
        "classifier": {"module": "services/search-svc/query_types.py", "function": "classify",
                       "rules": query_types.rules_summary()},
        "class_distribution": dist,
        "per_slice": per_slice,
        "paired_deltas": deltas,
        "worst_slice": {"slice": worst, "criterion": f"lowest rrf_rerank mean NDCG@10 among slices with n >= {MIN_N}",
                        "eligible": eligible, "rrf_rerank": per_slice[worst]["rrf_rerank"],
                        "rrf": per_slice[worst]["rrf"]},
        "fix": fix,
        "regression_check": regression,
        "runtime_seconds": {"baseline": round(t_base, 1), "total": round(time.time() - t0, 1)},
        "caveats": [
            "The query-type classifier is a hand-written rule set; it has NOT been validated against human labels "
            "and its precision/recall per class is unknown. Rules were written after eyeballing class samples of "
            "the test and dev query strings (no relevance labels were used).",
            "Slices are imbalanced; small slices (e.g. compatibility, non_product) have wide CIs or are empty.",
            "CIs are percentile bootstraps over queries only; they ignore uncertainty in the ESCI judgments.",
            "Worst slice was chosen on the test set, so the choice of slice is test-informed; the fix itself uses "
            "no test labels (see fix.tuning).",
            "Paired-delta bootstraps for different slices are computed independently; no multiple-comparison correction.",
        ],
    }
    Path(a.out).write_text(json.dumps(rep, indent=2))
    print(f"[slice] wrote {a.out} in {rep['runtime_seconds']['total']}s", flush=True)
    for c in classes:
        if c in per_slice:
            s = per_slice[c]
            print(f"  {c:14s} n={s['bm25']['n']:4d} " + "  ".join(f"{m}={s[m]['mean']:.3f}{s[m]['ci95']}" for m in MODES))
    print(json.dumps({k: v for k, v in fix.items() if k not in ("paired",)}, indent=1))
    if regression:
        print("regression:", regression["all_queries"]["paired"], regression["verdict"])


if __name__ == "__main__":
    main()
