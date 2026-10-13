#!/usr/bin/env python3
"""Serving-side benchmark harness shared by techniques 23, 24 and 25 (SOTA playbook §23-§25).

One harness, three consumers. It:
  * builds a REAL Sparky workload from the project's ESCI data - a long shared system prefix
    (instructions + attribute schema + locale few-shots drawn from actual catalogue rows)
    followed by a short per-request query, which is exactly the prefix-cache-friendly layout
    §23 step 1 prescribes;
  * drives an OpenAI-compatible vLLM endpoint with streaming, recording TTFT, inter-token
    latency (ITL) and end-to-end latency per request;
  * scrapes the vLLM Prometheus `/metrics` endpoint before and after, so prefix-cache hit rate
    and speculative-decoding acceptance are taken from the ENGINE's own counters rather than
    inferred;
  * writes results.json with percentiles and the exact metric deltas.

It measures. It never estimates and never fills in a number it did not observe: any metric the
engine did not export comes back as null with a reason.

STATUS ON THIS MACHINE: script-ready, NOT EXECUTED end to end - there is no vLLM server here
(vLLM has no Apple-silicon GPU backend). `--smoke` builds the workload, measures the real
prefix token count with the target tokenizer, and validates the metric parser against a
recorded Prometheus sample, all on CPU.

  python bench.py --smoke
  python bench.py --base-url http://localhost:8000 --model /models/qu-rewriter-8b --n 500
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "training"))
from common import esci  # noqa: E402

HARNESS_VERSION = "1"

# Metrics we read straight out of the vLLM Prometheus exposition.
PREFIX_METRICS = ["vllm:prefix_cache_queries", "vllm:prefix_cache_hits",
                  "vllm:gpu_prefix_cache_queries_total", "vllm:gpu_prefix_cache_hits_total"]
SPEC_METRICS = ["vllm:spec_decode_num_draft_tokens_total", "vllm:spec_decode_num_accepted_tokens_total",
                "vllm:spec_decode_num_drafts_total"]
KV_METRICS = ["vllm:gpu_cache_usage_perc", "vllm:kv_cache_usage_perc",
              "vllm:num_requests_running", "vllm:num_preemptions_total"]
ALL_METRICS = PREFIX_METRICS + SPEC_METRICS + KV_METRICS

# A recorded slice of a vLLM /metrics response, used to unit-test the parser offline.
SAMPLE_EXPOSITION = """\
# HELP vllm:prefix_cache_queries Prefix cache queries.
# TYPE vllm:prefix_cache_queries counter
vllm:prefix_cache_queries{model_name="/models/qu-rewriter-8b"} 128034.0
# HELP vllm:prefix_cache_hits Prefix cache hits.
# TYPE vllm:prefix_cache_hits counter
vllm:prefix_cache_hits{model_name="/models/qu-rewriter-8b"} 119511.0
# TYPE vllm:spec_decode_num_draft_tokens_total counter
vllm:spec_decode_num_draft_tokens_total{model_name="/models/sparky-answer"} 90000.0
# TYPE vllm:spec_decode_num_accepted_tokens_total counter
vllm:spec_decode_num_accepted_tokens_total{model_name="/models/sparky-answer"} 52000.0
# TYPE vllm:gpu_cache_usage_perc gauge
vllm:gpu_cache_usage_perc{model_name="/models/qu-rewriter-8b"} 0.71
"""


# ----------------------------------------------------------------------------------------
# Workload
# ----------------------------------------------------------------------------------------

def build_prefix(corpus: esci.EsciCorpus, n_shots: int = 8, seed: int = 20260915) -> str:
    """The long, STATIC, cache-shareable prefix. Static content first, dynamic last (§23 US-2)."""
    import numpy as np

    rng = np.random.default_rng(seed)
    pairs = esci.build_rewrite_pairs(corpus, max_examples=400, tail_only=False, seed=seed)
    idx = rng.choice(len(pairs), size=min(n_shots, len(pairs)), replace=False)
    shots = "\n\n".join(
        f"query: {pairs.iloc[int(i)]['query']}\n{pairs.iloc[int(i)]['completion']}" for i in idx
    )
    schema = json.dumps(
        {
            "category": esci.CATEGORIES,
            "dietary": esci.DIETARY_TAGS,
            "fields": ["title", "brand", "price", "rating", "stock_by_store", "sponsored"],
        },
        indent=1,
    )
    return (
        esci.REWRITE_SYSTEM
        + "\n\nCatalogue attribute schema:\n" + schema
        + "\n\nLocale note: shoppers mix English and Spanish; preserve brand names verbatim and "
          "never rewrite a brand to a generic term.\n\nExamples:\n" + shots
        + "\n\nNow rewrite the next query."
    )


def build_requests(corpus: esci.EsciCorpus, n: int, seed: int = 20260915) -> list[str]:
    """The short, per-request suffix: real ESCI queries."""
    q = corpus.queries.sample(n=min(n, len(corpus.queries)), random_state=seed)
    return [f"query: {str(x).strip()}" for x in q["query"]]


# ----------------------------------------------------------------------------------------
# Prometheus
# ----------------------------------------------------------------------------------------

def parse_exposition(text: str, wanted: list[str] | None = None) -> dict[str, float]:
    """Minimal Prometheus text parser: sums all label sets per metric name."""
    wanted_set = set(wanted or ALL_METRICS)
    out: dict[str, float] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name = line.split("{", 1)[0].split(" ", 1)[0]
        if name not in wanted_set:
            continue
        try:
            out[name] = out.get(name, 0.0) + float(line.rsplit(" ", 1)[1])
        except (ValueError, IndexError):
            continue
    return out


def scrape(base_url: str, timeout: float = 5.0) -> dict[str, float]:
    import urllib.request

    with urllib.request.urlopen(f"{base_url.rstrip('/')}/metrics", timeout=timeout) as r:
        return parse_exposition(r.read().decode())


def derive(before: dict[str, float], after: dict[str, float]) -> dict[str, Any]:
    """Compute rates from counter DELTAS. Anything absent stays null with a reason."""
    d = {k: after.get(k, 0.0) - before.get(k, 0.0) for k in set(before) | set(after)}
    res: dict[str, Any] = {"counter_deltas": {k: v for k, v in sorted(d.items())}}

    q = d.get("vllm:prefix_cache_queries", d.get("vllm:gpu_prefix_cache_queries_total", 0.0))
    h = d.get("vllm:prefix_cache_hits", d.get("vllm:gpu_prefix_cache_hits_total", 0.0))
    res["prefix_cache_hit_rate"] = round(h / q, 4) if q > 0 else None
    if q <= 0:
        res["prefix_cache_hit_rate_reason"] = "engine exported no prefix-cache queries in this window"

    dt = d.get("vllm:spec_decode_num_draft_tokens_total", 0.0)
    at = d.get("vllm:spec_decode_num_accepted_tokens_total", 0.0)
    nd = d.get("vllm:spec_decode_num_drafts_total", 0.0)
    res["spec_acceptance_rate"] = round(at / dt, 4) if dt > 0 else None
    res["spec_mean_acceptance_length"] = round(at / nd + 1, 4) if nd > 0 else None
    if dt <= 0:
        res["spec_reason"] = "speculative decoding not enabled, or no draft tokens in this window"
    return res


# ----------------------------------------------------------------------------------------
# Latency measurement
# ----------------------------------------------------------------------------------------

def pct(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    k = max(0, min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1)))))
    return round(s[k], 2)


def stream_one(base_url: str, model: str, prefix: str, user: str, max_tokens: int,
               temperature: float, timeout: float) -> dict[str, Any]:
    """One streaming chat completion; returns TTFT / ITL / total in milliseconds."""
    import urllib.request

    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": prefix}, {"role": "user", "content": user}],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
    }).encode()
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/v1/chat/completions", data=body,
        headers={"Content-Type": "application/json"},
    )
    t0 = time.perf_counter()
    ttft = None
    stamps: list[float] = []
    n_tok = 0
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                delta = json.loads(payload)["choices"][0]["delta"].get("content")
            except (json.JSONDecodeError, KeyError, IndexError):
                continue
            if not delta:
                continue
            now = time.perf_counter()
            if ttft is None:
                ttft = (now - t0) * 1000
            stamps.append(now)
            n_tok += 1
    total = (time.perf_counter() - t0) * 1000
    itls = [(stamps[i] - stamps[i - 1]) * 1000 for i in range(1, len(stamps))]
    return {"ttft_ms": ttft, "total_ms": total, "tokens": n_tok,
            "mean_itl_ms": statistics.mean(itls) if itls else None, "itls": itls}


def run_bench(a: argparse.Namespace) -> dict[str, Any]:
    corpus = esci.load_corpus(a.split)
    prefix = build_prefix(corpus, a.n_shots, a.seed)
    users = build_requests(corpus, a.n, a.seed)

    before = scrape(a.base_url)
    t0 = time.perf_counter()
    rows = [stream_one(a.base_url, a.model, prefix, u, a.max_tokens, a.temperature, a.timeout)
            for u in users]
    wall = time.perf_counter() - t0
    after = scrape(a.base_url)

    ttfts = [r["ttft_ms"] for r in rows if r["ttft_ms"] is not None]
    itls = [x for r in rows for x in r["itls"]]
    toks = sum(r["tokens"] for r in rows)
    return {
        "harness_version": HARNESS_VERSION,
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "endpoint": {"base_url": a.base_url, "model": a.model},
        "workload": {"requests": len(rows), "prefix_chars": len(prefix), "few_shots": a.n_shots,
                     "max_tokens": a.max_tokens, "temperature": a.temperature,
                     "data_source": corpus.meta["source"]},
        "latency_ms": {
            "ttft_p50": pct(ttfts, 50), "ttft_p95": pct(ttfts, 95), "ttft_p99": pct(ttfts, 99),
            "itl_p50": pct(itls, 50), "itl_p95": pct(itls, 95),
            "e2e_p50": pct([r["total_ms"] for r in rows], 50),
            "e2e_p99": pct([r["total_ms"] for r in rows], 99),
        },
        "throughput": {"wall_clock_s": round(wall, 3), "output_tokens": toks,
                       "output_tokens_per_s": round(toks / wall, 2) if wall > 0 else None,
                       "requests_per_s": round(len(rows) / wall, 3) if wall > 0 else None},
        "engine_metrics": derive(before, after),
        "provenance": "every number above was measured by this harness against a live endpoint",
    }


# ----------------------------------------------------------------------------------------

def build_args() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--smoke", action="store_true")
    p.add_argument("--base-url", default="http://localhost:8000")
    p.add_argument("--model", default="/models/qu-rewriter-8b")
    p.add_argument("--tokenizer", default="Qwen/Qwen3-1.7B", help="used only to count prefix tokens")
    p.add_argument("--split", default="dev", choices=["dev", "test"])
    p.add_argument("--n", type=int, default=200)
    # 24 shots lands the shared prefix near the ~1.1k tokens the playbook's UC1 example uses
    p.add_argument("--n-shots", type=int, default=24)
    p.add_argument("--max-tokens", type=int, default=48)
    p.add_argument("--temperature", type=float, default=0.0)
    p.add_argument("--timeout", type=float, default=60.0)
    p.add_argument("--out", default=None, help="write results.json here")
    p.add_argument("--seed", type=int, default=20260915)
    return p


def smoke(a: argparse.Namespace) -> int:
    corpus = esci.load_corpus(a.split)
    prefix = build_prefix(corpus, a.n_shots, a.seed)
    users = build_requests(corpus, a.n, a.seed)

    tok_stats: dict[str, Any] = {}
    try:
        from transformers import AutoTokenizer

        tok = AutoTokenizer.from_pretrained(a.tokenizer)
        p_tok = len(tok(prefix)["input_ids"])
        u_tok = [len(tok(u)["input_ids"]) for u in users[:128]]
        mean_u = sum(u_tok) / len(u_tok)
        tok_stats = {
            "tokenizer": a.tokenizer,
            "shared_prefix_tokens": p_tok,
            "mean_per_request_suffix_tokens": round(mean_u, 1),
            "shareable_token_fraction": round(p_tok / (p_tok + mean_u), 4),
            "note": ("this is the STRUCTURAL ceiling on prefix reuse for this prompt layout, "
                     "not a measured cache hit rate"),
        }
    except Exception as e:
        tok_stats = {"tokenizer": f"not loaded ({type(e).__name__}: {str(e)[:120]})"}

    # Parser unit test against the recorded exposition.
    parsed = parse_exposition(SAMPLE_EXPOSITION)
    zero = {k: 0.0 for k in parsed}
    derived = derive(zero, parsed)
    checks = {
        "parsed_metric_names": sorted(parsed),
        "prefix_hit_rate_from_sample": derived["prefix_cache_hit_rate"],
        "prefix_hit_rate_expected": round(119511.0 / 128034.0, 4),
        "spec_acceptance_from_sample": derived["spec_acceptance_rate"],
        "spec_acceptance_expected": round(52000.0 / 90000.0, 4),
    }
    ok = (checks["prefix_hit_rate_from_sample"] == checks["prefix_hit_rate_expected"]
          and checks["spec_acceptance_from_sample"] == checks["spec_acceptance_expected"])
    checks["parser_selftest"] = "PASS" if ok else "FAIL"
    if not ok:
        raise SystemExit(f"metric parser self-test FAILED: {checks}")

    # Null-safety: with no counters at all, every derived value must be null + a reason.
    empty = derive({}, {})
    checks["empty_window_returns_null"] = (empty["prefix_cache_hit_rate"] is None
                                           and empty["spec_acceptance_rate"] is None)

    reach: dict[str, Any] = {}
    try:
        reach = {"endpoint": a.base_url, "metrics": scrape(a.base_url, timeout=1.5)}
    except Exception as e:
        reach = {"endpoint": a.base_url,
                 "status": f"unreachable ({type(e).__name__}) - expected on this machine, "
                           f"there is no vLLM server here"}

    return esci.smoke_report(
        f"serving harness v{HARNESS_VERSION} - shared by §23/§24/§25",
        {
            "data": {**corpus.n, "source": corpus.meta["source"]},
            "workload": {"requests_built": len(users), "prefix_chars": len(prefix),
                         "few_shots": a.n_shots,
                         "layout": "system(static schema+few-shots) -> user(query)  [§23 step 1]",
                         "first_request": users[0] if users else "-"},
            "prefix_tokenisation": tok_stats,
            "metric_parser": checks,
            "live_endpoint": reach,
            "heavy_deps": esci.optional_imports(["transformers", "vllm", "torch"]),
            "verdict": "workload builds from real ESCI data; Prometheus parser verified; "
                       "absent metrics yield null, never a guess",
        },
    )


def main() -> int:
    a = build_args().parse_args()
    if a.smoke:
        return smoke(a)
    res = run_bench(a)
    text = json.dumps(res, indent=2)
    print(text)
    if a.out:
        Path(a.out).write_text(text)
        print(f"written to {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
