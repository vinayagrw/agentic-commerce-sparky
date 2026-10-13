#!/usr/bin/env python3
"""Technique 3: differentially private synthetic query logs from the real ESCI query set.

The sensitive database is `data/queries.parquet`: 1,644 REAL Amazon ESCI search queries. The privacy unit is one
query event (one record = one user's search). We release a DP histogram over (category, token) buckets and sample
synthetic query logs from it, so no real query text is ever emitted verbatim from an un-noised count.

Sensitivity analysis
  Each record is clipped to its first L distinct content tokens (default L=3), so one record changes at most L
  bucket counts by 1 each:
      L1 sensitivity  Delta_1 = L      (Laplace)
      L2 sensitivity  Delta_2 = sqrt(L) (Gaussian)
  Laplace:  noise ~ Lap(Delta_1 / eps)                      -> (eps, 0)-DP
  Gaussian: sigma = sqrt(2 ln(1.25/delta)) * Delta_2 / eps  -> (eps, delta)-DP (classical analysis, valid eps <= 1;
            for eps > 1 we use the analytic Gaussian mechanism of Balle & Wang 2018, computed numerically).
  Clamping negatives and rounding are post-processing and cost no extra budget.

Every mechanism call is recorded in a privacy budget ledger (basic sequential composition).

Usage (from services/ops-mcp, or any venv with pandas/numpy):
    uv run python ../../scripts/dp_query_logs.py [--sample N] [--epsilon 1.0] [--delta 1e-6] [--seed 42]
Writes data/dp_query_logs.json and data/dp_utility_curve.csv. Idempotent: same seed -> same output.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
EPS_GRID = [0.1, 0.5, 1.0, 2.0, 5.0]
STOP = {"a", "an", "and", "for", "of", "the", "to", "with", "in", "on", "not", "or", "by", "s"}


# ---------------------------------------------------------------- mechanisms
def laplace_noise(rng, size, scale):
    return rng.laplace(0.0, scale, size)


def gaussian_sigma(eps: float, delta: float, l2: float) -> float:
    """Classical Gaussian mechanism for eps<=1; analytic Gaussian (Balle & Wang 2018) otherwise."""
    if eps <= 1.0:
        return math.sqrt(2.0 * math.log(1.25 / delta)) * l2 / eps
    return _analytic_gaussian_sigma(eps, delta, l2)


def _analytic_gaussian_sigma(eps: float, delta: float, l2: float, tol: float = 1e-12) -> float:
    """Smallest sigma with delta_A(eps, sigma) <= delta, by bisection on the exact Gaussian-mechanism delta."""
    from math import erf, exp, sqrt

    def phi(t):
        return 0.5 * (1.0 + erf(t / sqrt(2.0)))

    def delta_of(s):
        # exact delta of the Gaussian mechanism at sigma = s * Delta_2 (Balle & Wang 2018, Thm 8):
        #   delta = Phi(1/(2s) - eps*s) - e^eps * Phi(-1/(2s) - eps*s)     (monotonically decreasing in s)
        return phi(1.0 / (2.0 * s) - eps * s) - exp(eps) * phi(-1.0 / (2.0 * s) - eps * s)

    lo, hi = 1e-6, 1.0
    while delta_of(hi) > delta:
        hi *= 2.0
        if hi > 1e9:
            break
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if delta_of(mid) > delta:
            lo = mid
        else:
            hi = mid
        if hi - lo < tol:
            break
    return hi * l2


def dp_histogram(counts: np.ndarray, eps: float, delta: float, l1: float, l2: float, mechanism: str, rng) -> dict:
    """Release a noisy histogram. Returns the noisy counts plus the exact mechanism parameters used."""
    if mechanism == "laplace":
        scale = l1 / eps
        noisy = counts + laplace_noise(rng, counts.shape, scale)
        params = {"mechanism": "laplace", "scale_b": round(scale, 5), "sensitivity_l1": l1, "delta": 0.0}
    elif mechanism == "gaussian":
        sigma = gaussian_sigma(eps, delta, l2)
        noisy = counts + rng.normal(0.0, sigma, counts.shape)
        params = {"mechanism": "gaussian", "sigma": round(sigma, 5), "sensitivity_l2": round(l2, 5), "delta": delta,
                  "analysis": "classical" if eps <= 1.0 else "analytic (Balle & Wang 2018)"}
    else:
        raise ValueError(mechanism)
    clamped = np.maximum(np.rint(noisy), 0.0)          # post-processing: free
    params.update(epsilon=eps, buckets=int(counts.size))
    return {"noisy": clamped, "raw_noisy": noisy, "params": params}


# ---------------------------------------------------------------- data
def tokenize(q: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", str(q).lower()) if t not in STOP and len(t) > 1]


def build_true_histogram(df: pd.DataFrame, clip_l: int):
    """(category, token) buckets. Each record contributes at most clip_l buckets -> bounded sensitivity."""
    counts: dict[tuple[str, str], int] = {}
    per_record = []
    for cat, q in zip(df["category"], df["query"]):
        toks = list(dict.fromkeys(tokenize(q)))[:clip_l]
        per_record.append((str(cat), toks))
        for t in toks:
            counts[(str(cat), t)] = counts.get((str(cat), t), 0) + 1
    keys = sorted(counts)
    return keys, np.array([counts[k] for k in keys], dtype=np.float64), per_record


def tv_distance(p: np.ndarray, q: np.ndarray) -> float:
    ps = p.sum() or 1.0
    qs = q.sum() or 1.0
    return float(0.5 * np.abs(p / ps - q / qs).sum())


def topk_overlap(true_c: np.ndarray, noisy_c: np.ndarray, k: int) -> float:
    a = set(np.argsort(-true_c, kind="stable")[:k].tolist())
    b = set(np.argsort(-noisy_c, kind="stable")[:k].tolist())
    return len(a & b) / k


# ---------------------------------------------------------------- synthetic log
def synthesize(keys, noisy_counts: np.ndarray, n_events: int, rng, tokens_per_query: int) -> list[dict]:
    """Sample synthetic query events from the DP histogram: pick a category by its noisy mass, then tokens
    from that category's noisy token distribution. Only post-processed DP output is read, so this is still DP."""
    by_cat: dict[str, list[int]] = {}
    for i, (cat, _tok) in enumerate(keys):
        by_cat.setdefault(cat, []).append(i)
    cats = sorted(by_cat)
    cat_mass = np.array([noisy_counts[by_cat[c]].sum() for c in cats], dtype=np.float64)
    if cat_mass.sum() <= 0:
        return []
    cat_p = cat_mass / cat_mass.sum()
    out = []
    for _ in range(n_events):
        c = cats[int(rng.choice(len(cats), p=cat_p))]
        idx = by_cat[c]
        w = noisy_counts[idx]
        if w.sum() <= 0:
            continue
        w = w / w.sum()
        m = min(tokens_per_query, int((w > 0).sum()))
        picked = rng.choice(len(idx), size=m, replace=False, p=w)
        toks = [keys[idx[int(j)]][1] for j in picked]
        out.append({"category": c, "query": " ".join(toks)})
    return out


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=0, help="use only the first N real queries (0 = all)")
    ap.add_argument("--epsilon", type=float, default=1.0, help="epsilon for the released synthetic log")
    ap.add_argument("--delta", type=float, default=1e-6)
    ap.add_argument("--clip-l", type=int, default=3, help="max distinct tokens kept per query (sensitivity cap)")
    ap.add_argument("--mechanism", choices=["gaussian", "laplace"], default="gaussian")
    ap.add_argument("--events", type=int, default=2000, help="synthetic query events to emit")
    ap.add_argument("--tokens-per-query", type=int, default=3)
    ap.add_argument("--topk", type=int, default=50)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default=str(DATA / "dp_query_logs.json"))
    ap.add_argument("--curve-out", default=str(DATA / "dp_utility_curve.csv"))
    a = ap.parse_args()

    t0 = time.time()
    df = pd.read_parquet(DATA / "queries.parquet")
    if a.sample:
        df = df.sort_values("query_id").head(a.sample)
    keys, true_counts, _ = build_true_histogram(df, a.clip_l)
    l1, l2 = float(a.clip_l), math.sqrt(a.clip_l)
    print(f"[dp] {len(df):,} real queries -> {len(keys):,} (category, token) buckets; "
          f"Delta_1={l1} Delta_2={l2:.4f}", flush=True)

    ledger, curve = [], []
    for mech in ("gaussian", "laplace"):
        for eps in EPS_GRID:
            rng = np.random.default_rng(a.seed + int(eps * 1000) + (0 if mech == "gaussian" else 7))
            r = dp_histogram(true_counts, eps, a.delta, l1, l2, mech, rng)
            row = {"mechanism": mech, "epsilon": eps, "delta": a.delta if mech == "gaussian" else 0.0,
                   "noise_scale": r["params"].get("sigma", r["params"].get("scale_b")),
                   "tv_distance": round(tv_distance(true_counts, r["noisy"]), 4),
                   "top10_overlap": round(topk_overlap(true_counts, r["noisy"], 10), 4),
                   f"top{a.topk}_overlap": round(topk_overlap(true_counts, r["noisy"], a.topk), 4),
                   "l1_error_per_bucket": round(float(np.abs(r["noisy"] - true_counts).mean()), 4),
                   "buckets_zeroed": int((r["noisy"] == 0).sum() - (true_counts == 0).sum()),
                   "spurious_mass_frac": round(float(r["noisy"][true_counts == 0].sum() / max(r["noisy"].sum(), 1)), 4)}
            curve.append(row)
            ledger.append({"purpose": f"utility curve point ({mech}, eps={eps})", **r["params"]})
            print(f"[dp] {mech:8s} eps={eps:<4} TV={row['tv_distance']:.4f} "
                  f"top{a.topk}={row[f'top{a.topk}_overlap']:.2f} L1/bucket={row['l1_error_per_bucket']:.3f}", flush=True)

    # the released artefact: one synthetic log at the chosen epsilon
    rng = np.random.default_rng(a.seed)
    rel = dp_histogram(true_counts, a.epsilon, a.delta, l1, l2, a.mechanism, rng)
    ledger.append({"purpose": f"released synthetic query log (eps={a.epsilon})", **rel["params"]})
    log = synthesize(keys, rel["noisy"], a.events, rng, a.tokens_per_query)
    real_set = {str(q).lower() for q in df["query"]}
    verbatim = sum(1 for e in log if e["query"] in real_set)

    total_eps = sum(e["epsilon"] for e in ledger)
    total_delta = sum(e.get("delta", 0.0) for e in ledger)
    out = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "seconds": round(time.time() - t0, 2),
        "inputs": {"source": "data/queries.parquet", "real_queries": int(len(df)), "sample": a.sample or None,
                   "seed": a.seed, "clip_l": a.clip_l, "buckets": len(keys),
                   "bucket_scheme": "(category, content token), stopwords removed, first L distinct tokens per query"},
        "sensitivity": {"privacy_unit": "one query event (one real ESCI query)", "clip_l": a.clip_l,
                        "l1": l1, "l2": round(l2, 5),
                        "argument": "clipping each record to L distinct tokens means one record changes at most L "
                                    "bucket counts by 1, so Delta_1 = L and Delta_2 = sqrt(L)"},
        "released_log": {"epsilon": a.epsilon, "delta": a.delta, "mechanism": a.mechanism,
                         "noise_param": rel["params"].get("sigma", rel["params"].get("scale_b")),
                         "events": len(log), "unique_queries": len({e["query"] for e in log}),
                         "verbatim_real_queries": verbatim,
                         "verbatim_rate": round(verbatim / max(len(log), 1), 4),
                         "sample": log[:15]},
        "utility_curve": curve,
        "privacy_ledger": {"entries": ledger, "composition": "basic sequential composition over all releases",
                           "total_epsilon": round(total_eps, 4), "total_delta": total_delta,
                           "note": "the utility curve itself spends budget: every point is a separate release of the "
                                   "same histogram. In production you publish ONE epsilon; the curve is a design-time "
                                   "study and would be run on a public or held-out proxy dataset."},
    }
    Path(a.out).write_text(json.dumps(out, indent=2))
    fields = list(curve[0].keys())
    with open(a.curve_out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(curve)
    print(f"[dp] released log eps={a.epsilon} {len(log)} events, verbatim-real rate {out['released_log']['verbatim_rate']}; "
          f"ledger total eps={total_eps:.2f} -> {a.out}, {a.curve_out}", flush=True)


if __name__ == "__main__":
    main()
