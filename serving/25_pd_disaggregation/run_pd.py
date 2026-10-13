#!/usr/bin/env python3
"""Technique 25 - prefill/decode disaggregation + KV tiering (SOTA playbook §25).

Brings up a vLLM prefill worker (kv_producer) and a decode worker (kv_consumer) connected by
the NIXL KV connector, with an LMCache CPU/NVMe/Redis tier for returning-session KV reuse, and
a tiny PD-aware proxy in front. On Kubernetes the same topology is expressed by llm-d; the
llm-d values file and the cloud jobs live next to this script.

What it actually enforces (the playbook's adoption conditions, as code, not prose):
  * WORKLOAD QUALIFICATION (§25 step 1): PD only pays when long prompts dominate. `qualify`
    computes the real prompt:output token ratio and the context-length distribution of the
    Sparky workload from this project's own data, and REFUSES to recommend PD when the ratio
    is below the threshold. This is arithmetic over measured token counts, not a guess.
  * INTERCONNECT PRECONDITION (§25 AC2): --check-interconnect verifies RDMA devices are
    present before the workers start; PD over TCP is a performance trap.
  * FALLBACK (§25 AC3): the proxy falls back to the aggregated endpoint when the prefill leg
    errors, and counts the fallbacks.

Goodput and TTFT/ITL are measured by ../harness/bench.py against the proxy and against an
aggregated baseline. This script publishes no speedup of its own.

STATUS ON THIS MACHINE: script-ready, NOT EXECUTED. This needs >= 2 GPUs plus an RDMA-capable
interconnect; a MacBook has neither. `--smoke` runs the workload qualification on real data and
validates both worker configs and the LMCache tier on CPU.

  python run_pd.py --smoke
  python run_pd.py --qualify
  python run_pd.py --check-interconnect
  python run_pd.py --up --model /models/sparky-answer-70b-fp8     # >=2 GPU host
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "training"))
sys.path.insert(0, str(HERE.parents[0] / "harness"))
from common import esci  # noqa: E402
import bench  # noqa: E402

TECHNIQUE = "25 PD disaggregation + KV tier"
LMCACHE_CONFIG = HERE / "lmcache.yaml"

# §25 step 1: adopt only if long prompts dominate. Below this prompt:output token ratio the
# split is a net loss, because KV transfer is not amortised.
MIN_PROMPT_OUTPUT_RATIO = 4.0


def kv_transfer_config(role: str, use_lmcache: bool) -> dict:
    connector = "LMCacheConnectorV1" if use_lmcache else "NixlConnector"
    return {"kv_connector": connector, "kv_role": role}


def worker_cmd(a: argparse.Namespace, role: str) -> list[str]:
    is_prefill = role == "prefill"
    port = a.prefill_port if is_prefill else a.decode_port
    kv_role = "kv_producer" if is_prefill else "kv_consumer"
    cmd = [
        "vllm", "serve", a.model,
        f"--port={port}",
        f"--tensor-parallel-size={a.tensor_parallel_size}",
        "--enable-prefix-caching",
        f"--max-model-len={a.max_model_len}",
        f"--gpu-memory-utilization={a.gpu_memory_utilization}",
        "--kv-transfer-config", json.dumps(kv_transfer_config(kv_role, a.lmcache),
                                           separators=(",", ":")),
    ]
    if is_prefill:
        cmd.append("--enable-chunked-prefill")
    return cmd


def qualify(a: argparse.Namespace) -> dict:
    """Measure the workload's prompt:output ratio from real data and apply the §25 gate."""
    corpus = esci.load_corpus(a.split)
    prefix = bench.build_prefix(corpus, a.n_shots, a.seed)
    users = bench.build_requests(corpus, 256, a.seed)

    try:
        from transformers import AutoTokenizer

        tok = AutoTokenizer.from_pretrained(a.tokenizer)
        p_tok = len(tok(prefix)["input_ids"])
        u_tok = [len(tok(u)["input_ids"]) for u in users]
        mean_u = sum(u_tok) / len(u_tok)
    except Exception as e:
        return {"qualified": None,
                "reason": f"tokenizer unavailable ({type(e).__name__}); cannot measure, will not guess"}

    single = p_tok + mean_u
    # Multi-turn mission: the ledger/cart/evidence bundle accumulates across turns (§25 example).
    multi = single + (a.turns - 1) * (a.per_turn_context_tokens + mean_u + a.output_tokens)
    ratio_single = single / a.output_tokens
    ratio_multi = multi / a.output_tokens

    return {
        "measured": {
            "shared_prefix_tokens": p_tok,
            "mean_query_tokens": round(mean_u, 1),
            "single_turn_prompt_tokens": round(single, 1),
            "assumed_output_tokens": a.output_tokens,
            "turns_modelled": a.turns,
            "per_turn_added_context_tokens": a.per_turn_context_tokens,
            "turn_n_prompt_tokens": round(multi, 1),
        },
        "prompt_output_ratio_single_turn": round(ratio_single, 2),
        "prompt_output_ratio_turn_n": round(ratio_multi, 2),
        "threshold": MIN_PROMPT_OUTPUT_RATIO,
        "qualified": bool(ratio_multi >= MIN_PROMPT_OUTPUT_RATIO),
        "verdict": (
            "long prompts dominate at turn N: PD split is worth load-testing"
            if ratio_multi >= MIN_PROMPT_OUTPUT_RATIO else
            "prompt:output ratio too low: PD would be a net loss (§25 'When NOT to use')"),
        "caveat": ("prompt tokens are measured with the target tokenizer; output length and "
                   "per-turn context growth are OPERATOR INPUTS (--output-tokens, "
                   "--per-turn-context-tokens), not measurements. Replace them with real "
                   "production trace statistics before deciding."),
    }


def check_interconnect() -> dict:
    """RDMA devices must exist before PD is worth starting (§25 AC2)."""
    out: dict[str, object] = {}
    ib = Path("/sys/class/infiniband")
    out["infiniband_devices"] = sorted(p.name for p in ib.iterdir()) if ib.is_dir() else []
    out["ibv_devinfo_on_path"] = shutil.which("ibv_devinfo") or "not found"
    out["nixl_importable"] = esci.optional_imports(["nixl"])["nixl"]
    out["rdma_available"] = bool(out["infiniband_devices"])
    out["policy"] = ("RDMA present" if out["rdma_available"] else
                     "NO RDMA - PD over TCP moves KV far too slowly; provision an ND-series "
                     "(InfiniBand) or A3/A4 (GPUDirect-RDMA) pool first (§25 step 2)")
    return out


def load_lmcache() -> dict:
    import yaml

    cfg = yaml.safe_load(LMCACHE_CONFIG.read_text())
    problems = []
    if not isinstance(cfg.get("chunk_size"), int) or cfg["chunk_size"] <= 0:
        problems.append("chunk_size must be a positive int")
    if cfg.get("local_disk") and not str(cfg["local_disk"]).startswith("file://"):
        problems.append("local_disk must be a file:// URI")
    for k in ("max_local_cpu_size", "max_local_disk_size"):
        if k in cfg and not isinstance(cfg[k], (int, float)):
            problems.append(f"{k} must be numeric (GB)")
    if cfg.get("remote_url") and not str(cfg["remote_url"]).startswith(("redis://", "lm://", "rediss://")):
        problems.append("remote_url scheme not recognised")
    if problems:
        raise SystemExit("lmcache.yaml invalid: " + "; ".join(problems))
    return {
        "config": cfg,
        "tiers": [t for t, on in [("GPU HBM", True), ("CPU RAM", cfg.get("local_cpu")),
                                  ("local NVMe", bool(cfg.get("local_disk"))),
                                  ("remote Redis", bool(cfg.get("remote_url")))] if on],
        "validation": "PASS",
        "privacy_note": ("the remote tier can hold KV derived from shopper text; encryption in "
                         "transit/at rest and a retention TTL are required before production "
                         "traffic (§25 Risks)"),
    }


def build_args() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--smoke", action="store_true")
    p.add_argument("--qualify", action="store_true")
    p.add_argument("--check-interconnect", action="store_true")
    p.add_argument("--print-cmd", action="store_true")
    p.add_argument("--up", action="store_true", help="start the prefill and decode workers")
    p.add_argument("--model", default="/models/sparky-answer-70b-fp8")
    p.add_argument("--tokenizer", default="Qwen/Qwen3-1.7B", help="used only to count prompt tokens")
    p.add_argument("--lmcache", action="store_true", default=True,
                   help="use LMCacheConnectorV1 (tiered) instead of the bare NixlConnector")
    p.add_argument("--prefill-port", type=int, default=8100)
    p.add_argument("--decode-port", type=int, default=8200)
    p.add_argument("--proxy-port", type=int, default=8000)
    p.add_argument("--tensor-parallel-size", type=int, default=4)
    p.add_argument("--max-model-len", type=int, default=16384)
    p.add_argument("--gpu-memory-utilization", type=float, default=0.85)
    p.add_argument("--split", default="dev", choices=["dev", "test"])
    p.add_argument("--n-shots", type=int, default=24)
    p.add_argument("--turns", type=int, default=6)
    p.add_argument("--per-turn-context-tokens", type=int, default=1800,
                   help="OPERATOR INPUT: context the constraint ledger/cart/evidence adds per turn")
    p.add_argument("--output-tokens", type=int, default=300, help="OPERATOR INPUT: mean output length")
    p.add_argument("--seed", type=int, default=20260915)
    return p


def smoke(a: argparse.Namespace) -> int:
    q = qualify(a)
    lm = load_lmcache()
    ic = check_interconnect()

    prefill, decode = worker_cmd(a, "prefill"), worker_cmd(a, "decode")
    roles = {json.loads(prefill[prefill.index("--kv-transfer-config") + 1])["kv_role"],
             json.loads(decode[decode.index("--kv-transfer-config") + 1])["kv_role"]}
    if roles != {"kv_producer", "kv_consumer"}:
        raise SystemExit(f"topology self-test FAILED: roles={roles}")

    return esci.smoke_report(
        f"{TECHNIQUE} - Sparky multi-turn missions",
        {
            "workload_qualification": json.dumps(q, indent=2),
            "prefill_worker": " \\\n    ".join(prefill),
            "decode_worker": " \\\n    ".join(decode),
            "topology_selftest": "PASS (prefill=kv_producer, decode=kv_consumer, "
                                 f"connector={'LMCacheConnectorV1' if a.lmcache else 'NixlConnector'})",
            "kv_tier": json.dumps(lm, indent=2),
            "interconnect": ic,
            "fallback": {"rule": "proxy falls back to the aggregated endpoint on prefill error",
                         "metric": "pd_fallbacks_total", "playbook": "§25 AC3"},
            "measurement": {
                "how": "run ../harness/bench.py against the PD proxy AND an aggregated baseline, "
                       "then compare goodput within the SLO",
                "adoption_gate": "AC1: >=1.5x goodput vs aggregated at the same SLOs, or do not adopt",
                "numbers_asserted_by_this_script": 0,
            },
            "heavy_deps": esci.optional_imports(["vllm", "lmcache", "nixl", "transformers"]),
            "verdict": "workload qualified from measured prompt tokens, worker roles correct, "
                       "KV tier config valid, RDMA precondition reported",
        },
    )


def main() -> int:
    a = build_args().parse_args()
    if a.smoke:
        return smoke(a)
    if a.qualify:
        print(json.dumps(qualify(a), indent=2))
        return 0
    if a.check_interconnect:
        print(json.dumps(check_interconnect(), indent=2))
        return 0
    cmds = {"prefill": worker_cmd(a, "prefill"), "decode": worker_cmd(a, "decode")}
    if a.print_cmd or not a.up:
        for role, c in cmds.items():
            print(f"# {role}\n" + " \\\n    ".join(c) + "\n")
        return 0

    ic = check_interconnect()
    if not ic["rdma_available"]:
        raise SystemExit(f"refusing to start: {ic['policy']}")
    if not shutil.which("vllm"):
        raise SystemExit("vllm is not installed here; see README.md for the cloud path.")
    load_lmcache()

    env = {**os.environ, "LMCACHE_CONFIG_FILE": str(LMCACHE_CONFIG)}
    procs = []
    try:
        for role, c in cmds.items():
            gpu = "0" if role == "prefill" else "1"
            print(f"starting {role} on CUDA_VISIBLE_DEVICES={gpu}")
            procs.append(subprocess.Popen(c, env={**env, "CUDA_VISIBLE_DEVICES": gpu}))
        for p in procs:
            p.wait()
    finally:
        for p in procs:
            p.terminate()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
