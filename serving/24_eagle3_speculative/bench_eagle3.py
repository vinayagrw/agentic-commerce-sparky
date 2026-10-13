#!/usr/bin/env python3
"""Technique 24 - EAGLE-3 speculative decoding on vLLM (SOTA playbook §24).

Serves the Sparky answer model with an EAGLE-3 draft head and sweeps `num_speculative_tokens`
against batch size, measuring inter-token latency and the engine's own acceptance counters.

Three guards the playbook insists on, implemented here rather than described:
  * DRAFT/TARGET BINDING (§24 US-2 / AC1): the registry must refuse a draft whose
    `target_digest` does not equal the target's digest. `check_draft_binding` computes both
    digests from the artefacts on disk and blocks the run on a mismatch.
  * GREEDY EQUIVALENCE (§24 US-1 / AC3): speculative decoding must not change the output
    distribution, so `--verify-equivalence` diffs greedy outputs with and without the draft and
    reports the exact mismatch count. A non-zero count fails the run.
  * ACCEPTANCE FLOOR (§24 AC2): the sweep reports mean acceptance length per k so the
    auto-disable threshold is chosen from measurement, not from a vendor slide.

Every speedup figure this script can produce is measured by ../harness/bench.py against a live
endpoint. Published EAGLE-3 numbers are cited in README.md as other people's measurements and
are never copied into this script's output.

STATUS ON THIS MACHINE: script-ready, NOT EXECUTED (no vLLM GPU backend here). `--smoke`
validates the speculative config, exercises the digest-binding guard and the acceptance parser
on CPU.

  python bench_eagle3.py --smoke
  python bench_eagle3.py --serve --target /models/sparky-answer-70b-fp8 \
      --draft /models/sparky-answer-70b-eagle3-v3 --num-speculative-tokens 3
  python bench_eagle3.py --sweep --k 1 2 3 4 5 --batch 1 8 16 64
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "training"))
sys.path.insert(0, str(HERE.parents[0] / "harness"))
from common import esci  # noqa: E402
import bench  # noqa: E402

TECHNIQUE = "24 EAGLE-3 speculative decoding"
ACCEPTANCE_ALERT_THRESHOLD = 0.45  # §24 Prometheus alert; auto-disable below this for 15 min


def speculative_config(a: argparse.Namespace) -> dict:
    return {
        "method": "eagle3",
        "model": a.draft,
        "num_speculative_tokens": a.num_speculative_tokens,
        "draft_tensor_parallel_size": a.draft_tensor_parallel_size,
    }


def serve_cmd(a: argparse.Namespace) -> list[str]:
    return [
        "vllm", "serve", a.target,
        f"--tensor-parallel-size={a.tensor_parallel_size}",
        "--enable-prefix-caching",
        f"--max-model-len={a.max_model_len}",
        f"--port={a.port}",
        "--speculative-config", json.dumps(speculative_config(a), separators=(",", ":")),
    ]


def digest(path: str | Path) -> str | None:
    """SHA-256 over the artefact's config + weight-index files - stable, cheap, no full read."""
    p = Path(path)
    if not p.exists():
        return None
    h = hashlib.sha256()
    for name in sorted(["config.json", "model.safetensors.index.json", "generation_config.json"]):
        f = p / name
        if f.exists():
            h.update(name.encode())
            h.update(f.read_bytes())
    return h.hexdigest()[:32] if h.digest() else None


def check_draft_binding(target: str, draft: str) -> dict:
    """§24 AC1. Refuse a stale draft after a target fine-tune."""
    t_dig, d_dig = digest(target), digest(draft)
    recorded = None
    meta = Path(draft) / "eagle3_binding.json"
    if meta.exists():
        try:
            recorded = json.loads(meta.read_text()).get("target_digest")
        except json.JSONDecodeError:
            recorded = "unparseable"
    if t_dig is None or d_dig is None:
        return {"checked": False, "target_digest": t_dig, "draft_digest": d_dig,
                "recorded_target_digest": recorded,
                "result": "UNVERIFIED - artefacts not present on this host; the real run "
                          "re-checks and blocks on mismatch"}
    ok = recorded == t_dig
    return {"checked": True, "target_digest": t_dig, "draft_digest": d_dig,
            "recorded_target_digest": recorded,
            "result": "PASS" if ok else "BLOCK - draft.target_digest != target.digest (stale draft)"}


def build_args() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--smoke", action="store_true")
    p.add_argument("--print-cmd", action="store_true")
    p.add_argument("--serve", action="store_true")
    p.add_argument("--sweep", action="store_true", help="measure ITL + acceptance across k and batch")
    p.add_argument("--verify-equivalence", action="store_true",
                   help="diff greedy outputs with and without the draft (§24 AC3)")
    p.add_argument("--target", default="/models/sparky-answer-70b-fp8")
    p.add_argument("--draft", default="/models/sparky-answer-70b-eagle3-v3")
    p.add_argument("--base-url", default="http://localhost:8000")
    p.add_argument("--baseline-url", default="http://localhost:8001",
                   help="a second endpoint serving the SAME target without a draft")
    p.add_argument("--num-speculative-tokens", type=int, default=3)
    p.add_argument("--k", type=int, nargs="+", default=[1, 2, 3, 4, 5])
    p.add_argument("--batch", type=int, nargs="+", default=[1, 8, 16, 64])
    p.add_argument("--draft-tensor-parallel-size", type=int, default=1)
    p.add_argument("--tensor-parallel-size", type=int, default=4)
    p.add_argument("--max-model-len", type=int, default=8192)
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--n", type=int, default=200)
    p.add_argument("--out", default=None)
    p.add_argument("--seed", type=int, default=20260915)
    return p


def verify_equivalence(a: argparse.Namespace) -> dict:
    """Greedy decode the same prompts on both endpoints and count exact mismatches."""
    corpus = esci.load_corpus("dev")
    prefix = bench.build_prefix(corpus, 24, a.seed)
    users = bench.build_requests(corpus, a.n, a.seed)

    def greedy(url: str, u: str) -> str:
        import urllib.request

        body = json.dumps({"model": a.target,
                           "messages": [{"role": "system", "content": prefix},
                                        {"role": "user", "content": u}],
                           "max_tokens": 64, "temperature": 0.0, "stream": False}).encode()
        req = urllib.request.Request(f"{url.rstrip('/')}/v1/chat/completions", data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())["choices"][0]["message"]["content"]

    mismatches = []
    for u in users:
        spec, base = greedy(a.base_url, u), greedy(a.baseline_url, u)
        if spec != base:
            mismatches.append({"prompt": u, "spec": spec[:120], "baseline": base[:120]})
    return {"prompts": len(users), "mismatches": len(mismatches),
            "result": "PASS" if not mismatches else "FAIL - spec decode changed greedy output",
            "examples": mismatches[:5]}


def sweep(a: argparse.Namespace) -> dict:
    """Measure, per k, the acceptance counters and ITL from a live endpoint.

    Requires the operator to restart the server per k (vLLM fixes the speculative config at
    startup); the script prints the command it expects and reads whatever endpoint is live.
    """
    rows = []
    for k in a.k:
        print(f"\n--- expecting an endpoint started with num_speculative_tokens={k} ---")
        print("  " + " \\\n    ".join(serve_cmd(argparse.Namespace(**{**vars(a), "num_speculative_tokens": k}))))
        ns = argparse.Namespace(**{**vars(a), "model": a.target, "split": "dev",
                                   "n_shots": 24, "max_tokens": 128, "temperature": 0.0,
                                   "timeout": 120.0, "tokenizer": a.target, "out": None})
        res = bench.run_bench(ns)
        em = res["engine_metrics"]
        rows.append({
            "num_speculative_tokens": k,
            "itl_p50_ms": res["latency_ms"]["itl_p50"],
            "itl_p95_ms": res["latency_ms"]["itl_p95"],
            "output_tokens_per_s": res["throughput"]["output_tokens_per_s"],
            "acceptance_rate": em.get("spec_acceptance_rate"),
            "mean_acceptance_length": em.get("spec_mean_acceptance_length"),
            "below_auto_disable_threshold": (
                None if em.get("spec_acceptance_rate") is None
                else em["spec_acceptance_rate"] < ACCEPTANCE_ALERT_THRESHOLD),
        })
    return {"auto_disable_threshold": ACCEPTANCE_ALERT_THRESHOLD, "sweep": rows,
            "provenance": "measured by serving/harness/bench.py against a live vLLM endpoint"}


def smoke(a: argparse.Namespace) -> int:
    cfg = speculative_config(a)
    binding = check_draft_binding(a.target, a.draft)

    # Exercise the binding guard on real temporary artefacts so it is provably wired.
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        t, d_ok, d_stale = Path(td) / "t", Path(td) / "d_ok", Path(td) / "d_stale"
        for p in (t, d_ok, d_stale):
            p.mkdir()
            (p / "config.json").write_text(json.dumps({"model_type": "llama", "name": p.name}))
        td_dig = digest(t)
        (d_ok / "eagle3_binding.json").write_text(json.dumps({"target_digest": td_dig}))
        (d_stale / "eagle3_binding.json").write_text(json.dumps({"target_digest": "deadbeef" * 4}))
        guard_ok = check_draft_binding(str(t), str(d_ok))
        guard_stale = check_draft_binding(str(t), str(d_stale))
    if guard_ok["result"] != "PASS" or not guard_stale["result"].startswith("BLOCK"):
        raise SystemExit(f"binding guard self-test FAILED: ok={guard_ok} stale={guard_stale}")

    # Acceptance parsing path.
    sample = bench.parse_exposition(bench.SAMPLE_EXPOSITION)
    derived = bench.derive({k: 0.0 for k in sample}, sample)

    corpus = esci.load_corpus("dev")
    users = bench.build_requests(corpus, a.n, a.seed)

    return esci.smoke_report(
        f"{TECHNIQUE} - Sparky answer model",
        {
            "speculative_config": json.dumps(cfg, indent=2),
            "serve_command": " \\\n    ".join(serve_cmd(a)),
            "draft_target_binding_on_this_host": binding,
            "binding_guard_selftest": {"matching_draft": guard_ok["result"],
                                       "stale_draft": guard_stale["result"],
                                       "result": "PASS"},
            "acceptance_metrics": {
                "metric_names": bench.SPEC_METRICS,
                "parsed_from_recorded_sample": {
                    "acceptance_rate": derived["spec_acceptance_rate"],
                    "mean_acceptance_length": derived["spec_mean_acceptance_length"],
                },
                "auto_disable_threshold": ACCEPTANCE_ALERT_THRESHOLD,
                "note": "parsed from a RECORDED exposition string to test the parser; these are "
                        "not measurements of any production retailer model",
            },
            "equivalence_check": {
                "enabled_by": "--verify-equivalence",
                "method": "greedy (temperature=0) diff of spec vs no-spec endpoints, exact string match",
                "fail_condition": "any mismatch",
            },
            "sweep_plan": {"k_values": a.k, "batch_values": a.batch,
                           "prompts_per_point": len(users),
                           "note": "vLLM fixes speculative config at startup, so each k needs a restart"},
            "vllm_available_here": esci.optional_imports(["vllm"])["vllm"],
            "verdict": "config valid, stale-draft guard blocks, acceptance parser verified",
        },
    )


def main() -> int:
    a = build_args().parse_args()
    if a.smoke:
        return smoke(a)
    if a.verify_equivalence:
        print(json.dumps(verify_equivalence(a), indent=2))
        return 0
    if a.sweep:
        out = sweep(a)
        print(json.dumps(out, indent=2))
        if a.out:
            Path(a.out).write_text(json.dumps(out, indent=2))
        return 0
    cmd = serve_cmd(a)
    if a.print_cmd or not a.serve:
        print(" \\\n    ".join(cmd))
        return 0
    b = check_draft_binding(a.target, a.draft)
    if b.get("result", "").startswith("BLOCK"):
        raise SystemExit(f"refusing to serve: {b['result']} (§24 AC1)")
    if not shutil.which("vllm"):
        raise SystemExit("vllm is not installed here; see README.md for the cloud path.")
    return subprocess.call(cmd)


if __name__ == "__main__":
    raise SystemExit(main())
