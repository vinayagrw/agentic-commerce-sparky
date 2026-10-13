#!/usr/bin/env python3
"""Technique 23 - PagedAttention + automatic prefix caching on vLLM (SOTA playbook §23).

Two jobs:
  1. emit / launch the exact `vllm serve` command for the Sparky tail-QU rewriter with paged
     KV, automatic prefix caching, chunked prefill, FP8 KV and multi-LoRA - the flag set the
     playbook records;
  2. lint the prompt layout. §23 US-2 asks for a CI rule that fails when dynamic content
     (query, user id, timestamp) appears before the static prefix, because that is what
     silently destroys cache hits. The linter here is that rule, and it runs in --smoke.

Measurement is delegated to ../harness/bench.py, which reads
`vllm:prefix_cache_hits / vllm:prefix_cache_queries` out of the engine's own Prometheus
counters. This script never estimates a hit rate.

STATUS ON THIS MACHINE: script-ready, NOT EXECUTED. vLLM has no Apple-silicon GPU backend, so
the server cannot start here. `--smoke` validates the flags, runs the prompt linter and reports
the real shared-prefix token count.

  python serve_prefix_cache.py --smoke
  python serve_prefix_cache.py --print-cmd
  python serve_prefix_cache.py --serve --model /models/qu-rewriter-8b-lora-fp8   # GPU target
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "training"))
sys.path.insert(0, str(HERE.parents[0] / "harness"))
from common import esci  # noqa: E402
import bench  # noqa: E402

TECHNIQUE = "23 PagedAttention + prefix cache"

# Dynamic fields that must never precede the static prefix (§23 US-2 / AC1).
DYNAMIC_PATTERNS = [
    (r"\{\{?\s*query\s*\}?\}", "query"),
    (r"\{\{?\s*user(_id)?\s*\}?\}", "user id"),
    (r"\{\{?\s*(timestamp|now|date|time)\s*\}?\}", "timestamp"),
    (r"\{\{?\s*session(_id)?\s*\}?\}", "session id"),
    (r"\{\{?\s*store(_id)?\s*\}?\}", "store id"),
    (r"\{\{?\s*cart\w*\s*\}?\}", "cart state"),
    (r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", "literal timestamp"),
]
STATIC_MARKERS = ["Catalogue attribute schema", "Examples:", "You are the Sparky"]


def serve_cmd(a: argparse.Namespace) -> list[str]:
    cmd = [
        "vllm", "serve", a.model,
        "--enable-prefix-caching",          # explicit even though it is the V1 default
        f"--block-size={a.block_size}",     # set explicitly so cache sizing is reproducible
        f"--max-model-len={a.max_model_len}",
        f"--gpu-memory-utilization={a.gpu_memory_utilization}",
        f"--kv-cache-dtype={a.kv_cache_dtype}",
        f"--max-num-seqs={a.max_num_seqs}",
        "--enable-chunked-prefill",
        f"--port={a.port}",
    ]
    if a.enable_lora:
        cmd += ["--enable-lora", f"--max-loras={a.max_loras}", f"--max-lora-rank={a.max_lora_rank}"]
    if a.tensor_parallel_size > 1:
        cmd += [f"--tensor-parallel-size={a.tensor_parallel_size}"]
    return cmd


def lint_prompt(prompt: str) -> dict:
    """FAIL if any dynamic field appears before the last static marker."""
    last_static = max((prompt.rfind(m) for m in STATIC_MARKERS), default=-1)
    findings: list[dict] = []
    for pat, label in DYNAMIC_PATTERNS:
        for m in re.finditer(pat, prompt, re.I):
            findings.append({
                "field": label, "at": m.start(), "match": m.group(0)[:40],
                "before_static_prefix": m.start() < last_static,
            })
    violations = [f for f in findings if f["before_static_prefix"]]
    return {
        "static_prefix_ends_at_char": last_static,
        "dynamic_fields_found": len(findings),
        "violations": violations,
        "result": "FAIL" if violations else "PASS",
        "rule": "dynamic fields (query, user, timestamp, session, store, cart) must come AFTER "
                "the static prefix, or prefix-cache hits collapse (§23 US-2 / AC1)",
    }


def build_args() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--smoke", action="store_true")
    p.add_argument("--print-cmd", action="store_true")
    p.add_argument("--serve", action="store_true")
    p.add_argument("--model", default="/models/qu-rewriter-8b-lora-fp8")
    p.add_argument("--tokenizer", default="Qwen/Qwen3-1.7B")
    p.add_argument("--block-size", type=int, default=16)
    p.add_argument("--max-model-len", type=int, default=4096)
    p.add_argument("--gpu-memory-utilization", type=float, default=0.90)
    p.add_argument("--kv-cache-dtype", default="fp8", choices=["auto", "fp8", "fp8_e5m2", "fp8_e4m3"])
    p.add_argument("--max-num-seqs", type=int, default=256)
    p.add_argument("--tensor-parallel-size", type=int, default=1)
    p.add_argument("--enable-lora", action="store_true", default=True)
    p.add_argument("--max-loras", type=int, default=4)
    p.add_argument("--max-lora-rank", type=int, default=32)
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--n-shots", type=int, default=24)
    p.add_argument("--seed", type=int, default=20260915)
    return p


def smoke(a: argparse.Namespace) -> int:
    corpus = esci.load_corpus("dev")
    prefix = bench.build_prefix(corpus, a.n_shots, a.seed)

    # The good layout: static prefix as the system message, query as the user message.
    good = prefix + "\n\nquery: {query}"
    # The bad layout the linter must catch: dynamic content hoisted to the front.
    bad = "Request at {timestamp} from user {user_id} for {query}\n\n" + prefix

    lint_good, lint_bad = lint_prompt(good), lint_prompt(bad)
    if lint_good["result"] != "PASS" or lint_bad["result"] != "FAIL":
        raise SystemExit(f"prompt linter self-test FAILED: good={lint_good} bad={lint_bad}")

    tok_stats: dict[str, object] = {}
    try:
        from transformers import AutoTokenizer

        tok = AutoTokenizer.from_pretrained(a.tokenizer)
        p_tok = len(tok(prefix)["input_ids"])
        blocks = -(-p_tok // a.block_size)
        tok_stats = {
            "tokenizer": a.tokenizer,
            "shared_prefix_tokens": p_tok,
            "block_size": a.block_size,
            "kv_blocks_for_the_shared_prefix": blocks,
            "note": "prefix length and block count are structural facts of this prompt; the "
                    "HIT RATE is only ever read from vllm:prefix_cache_hits by ../harness/bench.py",
        }
    except Exception as e:
        tok_stats = {"tokenizer": f"not loaded ({type(e).__name__}: {str(e)[:120]})"}

    return esci.smoke_report(
        f"{TECHNIQUE} - tail-QU rewriter serving",
        {
            "data": {**corpus.n, "source": corpus.meta["source"]},
            "serve_command": " \\\n    ".join(serve_cmd(a)),
            "prefix": tok_stats,
            "prompt_lint_good_layout": lint_good,
            "prompt_lint_bad_layout": {k: lint_bad[k] for k in ("dynamic_fields_found", "violations", "result")},
            "linter_selftest": "PASS (good layout passes, hoisted-dynamic layout fails)",
            "measurement": {
                "how": "python ../harness/bench.py --base-url http://localhost:8000 --model <model>",
                "metrics_read": bench.PREFIX_METRICS + bench.KV_METRICS,
                "estimated_numbers_emitted": 0,
            },
            "vllm_available_here": esci.optional_imports(["vllm"])["vllm"],
            "verdict": "flags valid, prefix layout linted, measurement delegated to the engine's counters",
        },
    )


def main() -> int:
    a = build_args().parse_args()
    if a.smoke:
        return smoke(a)
    cmd = serve_cmd(a)
    if a.print_cmd or not a.serve:
        print(" \\\n    ".join(cmd))
        return 0
    if not shutil.which("vllm"):
        raise SystemExit("vllm is not installed here. This technique runs on a GPU target; "
                         "see README.md for the Azure ML / Vertex AI one-command path.")
    print(json.dumps({"exec": cmd}, indent=2))
    return subprocess.call(cmd)


if __name__ == "__main__":
    raise SystemExit(main())
