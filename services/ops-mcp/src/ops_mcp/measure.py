"""Technique 32 - the inputs to the retrain trigger, measured instead of declared.

Three things the cost model needs, and how each one is obtained here:

  current p95 latency     MEASURED. Real search-svc /search calls against the live champion
                          config, timed in this process. Sample size is reported with it.
  rebuild cost            MEASURED. An actual candidate build is timed end to end
                          (search-svc POST /models/candidate, which loads the encoder,
                          warms the reranker and registers the version) and priced at a
                          stated $/CPU-minute rate. The minutes are real.
  value of +0.01 NDCG     NOT MEASURABLE HERE, and therefore NOT INVENTED. There is no
                          revenue signal on this laptop. It is an explicit, user-supplied
                          assumption with provenance "assumption", and every decision that
                          depends on it is published together with the break-even value and
                          a sensitivity table, so a reader can see exactly how much of the
                          verdict is carried by the number they supplied.

If search-svc is unreachable, these functions raise SearchUnavailable. Nothing falls back.
"""
from __future__ import annotations

import os
import statistics
import time

from . import search_client

# STATED RATE, not a measurement: ~$0.10 per vCPU-hour on-demand. The seconds it multiplies
# are measured; this rate is an assumption and is labelled as one everywhere it surfaces.
USD_PER_CPU_MIN = 0.0017

ENV_VALUE = "SPARKY_VALUE_USD_PER_001_NDCG_DAY"

_p95_cache: dict | None = None
_rebuild_cache: dict | None = None


def measure_p95(n: int = 30, refresh: bool = False, warmup: int = 3) -> dict:
    """p50/p95 of the live champion path, from n real /search calls timed here."""
    global _p95_cache
    if _p95_cache and not refresh and _p95_cache["samples"] >= n:
        return _p95_cache
    qs = search_client.call("GET", f"/queries/sample?n={max(n, 10)}")
    queries = [q if isinstance(q, str) else q.get("query") for q in (qs if isinstance(qs, list) else qs.get("queries", []))]
    queries = [q for q in queries if q][:n]
    if not queries:
        raise search_client.SearchUnavailable("search-svc returned no sample queries; cannot measure p95")
    for q in queries[:warmup]:  # do not let cold-start dominate the percentile
        search_client.call("POST", "/search", {"query": q, "k": 10, "mode": "rrf_rerank", "filters": {}})
    ms: list[float] = []
    t0 = time.perf_counter()
    for q in queries:
        t = time.perf_counter()
        search_client.call("POST", "/search", {"query": q, "k": 10, "mode": "rrf_rerank", "filters": {}})
        ms.append((time.perf_counter() - t) * 1000.0)
    ms.sort()
    idx95 = min(len(ms) - 1, max(0, int(round(0.95 * len(ms))) - 1))
    _p95_cache = {
        "p50_ms": round(statistics.median(ms), 1),
        "p95_ms": round(ms[idx95], 1),
        "min_ms": round(ms[0], 1),
        "max_ms": round(ms[-1], 1),
        "samples": len(ms),
        "wall_clock_s": round(time.perf_counter() - t0, 2),
        "status": "real-measured",
        "how": f"{len(ms)} real search-svc POST /search calls (mode rrf_rerank, the champion path), "
               f"round-trip timed in ops-mcp, {warmup} warm-up calls discarded; nearest-rank p95",
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "caveat": "laptop wall clock including HTTP round trip, so it is an upper bound on service-internal latency; "
                  "a small sample makes the p95 coarse - the sample size is reported for exactly that reason",
    }
    return _p95_cache


def measure_rebuild(refresh: bool = False) -> dict:
    """Time a REAL rebuild. Builds a candidate carrying the champion's own config, so the
    artifact produced is a faithful reproduction of the champion and the only thing being
    measured is the cost of doing the work."""
    global _rebuild_cache
    if _rebuild_cache and not refresh:
        return _rebuild_cache
    reg = search_client.call("GET", "/models")
    champ = reg["champion"]
    cfg = next(v["config"] for v in reg["versions"] if v["version"] == champ)
    t0 = time.perf_counter()
    r = search_client.call("POST", "/models/candidate", {
        "config": cfg, "actor": "cost-measurement",
        "note": f"technique 32: timing a real rebuild of the champion config ({champ})"})
    secs = time.perf_counter() - t0
    cpu_min = round(secs / 60.0, 4)
    _rebuild_cache = {
        "cpu_min": cpu_min,
        "usd": round(cpu_min * USD_PER_CPU_MIN, 6),
        "seconds": round(secs, 2),
        "service_reported_build_seconds": (r.get("build") or {}).get("seconds"),
        "reused_cached_embeddings": (r.get("build") or {}).get("reused_cached_embeddings"),
        "version_built": r.get("version"),
        "of_champion": champ,
        "status": "real-measured",
        "how": "wall clock around a real search-svc POST /models/candidate that rebuilds the champion's own config "
               "(encoder load, reranker warm, MLflow registration), priced at the stated $/CPU-min rate",
        "rate_usd_per_cpu_min": USD_PER_CPU_MIN,
        "rate_provenance": "assumption",
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "caveat": "this laptop reuses data/embeddings.npy, so it does NOT include re-embedding the catalogue. A rebuild "
                  "that changes the embedding model is a different, much larger number and is not claimed here.",
    }
    return _rebuild_cache


def value_assumption() -> dict:
    """The one number that cannot be measured here. Supplied, labelled, never invented."""
    raw = os.environ.get(ENV_VALUE)
    supplied = None
    if raw:
        try:
            supplied = float(raw)
        except ValueError:
            supplied = None
    return {
        "name": "value_usd_per_0.01_ndcg_per_day",
        "value": supplied,
        "provenance": "assumption",
        "status": "user-supplied-assumption" if supplied is not None else "not-supplied",
        "how": f"set {ENV_VALUE} to the business's own figure. It is revenue per NDCG point per day of traffic and "
               f"cannot be derived from anything on this laptop: there is no revenue signal here.",
        "never": "no default is applied. With nothing supplied, ROI is reported as a break-even threshold and a "
                 "sensitivity table instead of a single number.",
    }


def roi_view(benefit_per_001_ndcg_day: float | None, risk_adjusted_gain: float, cost_usd: float,
             horizon_days: int = 30, ladder: tuple[float, ...] = (50.0, 100.0, 400.0, 1000.0, 5000.0)) -> dict:
    """ROI as a function of the supplied assumption, plus the break-even value of that assumption.

    break_even = the $/0.01-NDCG/day at which benefit exactly equals cost. Below it the
    retrain does not pay; above it, it does. That single number is the honest summary when
    the value model is unknown.
    """
    if risk_adjusted_gain <= 0 or cost_usd <= 0:
        return {"roi": None, "break_even_usd_per_001_ndcg_day": None,
                "reason": "non-positive expected gain or cost; ROI is undefined"}
    units = risk_adjusted_gain / 0.01 * horizon_days           # (0.01-NDCG)-days recovered
    break_even = round(cost_usd / units, 8)
    sens = [{"value_usd_per_0.01_ndcg_day": v,
             "benefit_usd": round(units * v, 4),
             "roi": round(units * v / cost_usd, 1),
             "pays_off": units * v > cost_usd} for v in ladder]
    out = {
        "horizon_days": horizon_days,
        "risk_adjusted_gain_ndcg": round(risk_adjusted_gain, 5),
        "cost_usd": round(cost_usd, 6),
        "break_even_usd_per_001_ndcg_day": break_even,
        "break_even_meaning": f"the retrain pays for itself if +0.01 NDCG@10 is worth more than ${break_even}/day "
                              f"over {horizon_days} days. That threshold needs no assumption at all - it is arithmetic "
                              f"over the measured cost.",
        "sensitivity": sens,
        "roi": None,
        "roi_basis": "not computed: no value assumption supplied",
    }
    if cost_usd < 0.01:
        out["scale_caveat"] = (
            f"the measured rebuild cost here is ${cost_usd:.2e} - this laptop reuses cached embeddings, so the rebuild "
            f"is nearly free and any ROI computed against it is a huge number that means nothing. On this hardware the "
            f"only figure worth reading is the break-even threshold. A production rebuild that re-embeds the catalogue "
            f"on GPU is a different cost and must be measured there."
        )
    if benefit_per_001_ndcg_day is not None:
        benefit = units * benefit_per_001_ndcg_day
        out["roi"] = round(benefit / cost_usd, 1)
        out["benefit_usd"] = round(benefit, 2)
        out["roi_basis"] = (f"uses the SUPPLIED assumption ${benefit_per_001_ndcg_day}/0.01-NDCG/day "
                            f"(provenance: assumption, not a measurement)")
    return out
