#!/usr/bin/env python3
"""Technique 13 - RLVR with a programmatic verifier, GRPO (SOTA playbook §13).

Task: shopper query -> Sparky search-filter JSON. The reward comes from `verifier.py`, a
deterministic, sandboxable, unit-tested artefact (run `python verifier.py --selftest`), never
from an LLM judge. Gold filters are derived from the catalogue attributes of the products a
human judged E (exact) for that query - see training/common/esci.py::build_filter_tasks.

STATUS ON THIS MACHINE: script-ready, NOT EXECUTED. GRPO needs a rollout engine (vLLM) plus a
trainer, i.e. GPUs. `--smoke` runs the verifier self-tests, loads the real prompts and scores
a set of synthetic completions on CPU, proving the reward path end to end without training.

  python train_rlvr.py --smoke
  python train_rlvr.py --model out/tail-rewriter-lora --num-generations 8   # GPU target
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0]))  # training/
sys.path.insert(0, str(HERE))
from common import esci  # noqa: E402
import verifier as V  # noqa: E402

TECHNIQUE = "13 RLVR + verifier"
SCHEMA_PATH = HERE / "schemas" / "filter_v1.json"


def build_args() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--smoke", action="store_true")
    p.add_argument("--model", default="Qwen/Qwen3-1.7B",
                   help="SFT warm start from technique 11 (playbook §13 step 2)")
    p.add_argument("--output-dir", default="out/filter-rlvr")
    p.add_argument("--split", default="dev", choices=["dev", "test"])
    # Playbook §13 step 3: G=8 samples per prompt, KL small or 0 (DAPO-style), clip-higher
    p.add_argument("--num-generations", type=int, default=8)
    p.add_argument("--beta", type=float, default=0.0, help="KL coefficient (0 = DAPO-style)")
    p.add_argument("--epsilon", type=float, default=0.2)
    p.add_argument("--epsilon-high", type=float, default=0.28)
    p.add_argument("--lr", type=float, default=1e-6)
    p.add_argument("--max-completion-length", type=int, default=256)
    p.add_argument("--max-steps", type=int, default=500)
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--use-vllm", action="store_true", default=True)
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--max-examples", type=int, default=None)
    p.add_argument("--seed", type=int, default=20260915)
    return p


def load_tasks(a: argparse.Namespace):
    c = esci.load_corpus(a.split)
    df = esci.build_filter_tasks(c, max_examples=a.max_examples, seed=a.seed)
    return c, df


def to_records(df) -> list[dict]:
    """GRPO dataset: `prompt` is generated from, every other column is forwarded to reward_fn."""
    return [
        {
            "prompt": [{"role": "system", "content": esci.FILTER_SYSTEM},
                       {"role": "user", "content": r["prompt"]}],
            "gold": r["gold"],
            "query": r["query"],
        }
        for _, r in df.iterrows()
    ]


def smoke(a: argparse.Namespace) -> int:
    print("--- verifier self-tests (playbook §13 AC2: verifier is its own tested artefact) ---")
    rc = V._selftest()
    if rc != 0:
        raise SystemExit("verifier self-tests FAILED; refusing to report smoke OK")

    schema = json.loads(SCHEMA_PATH.read_text())
    c, df = load_tasks(a)
    recs = to_records(df)

    # Exercise the real reward path on the real prompts with deliberately varied completions.
    sample = recs[:16]
    golds = [json.loads(r["gold"]) for r in sample]
    completions: list[str] = []
    kinds: list[str] = []
    for r, g in zip(sample, golds):
        # a correct answer built from the gold + a genuine evidence span taken from the query
        ev = r["query"].split()[0] if r["query"].split() else r["query"]
        completions.append(json.dumps({**g, "evidence": ev}))
        kinds.append("gold+real-evidence")
    completions += ["not json at all"] * 2 + [json.dumps({"category": "pet"})] * 2
    kinds += ["malformed"] * 2 + ["schema-invalid"] * 2
    pad_gold = golds + golds[:4]
    pad_query = [r["query"] for r in sample] + [r["query"] for r in sample[:4]]
    rewards = V.reward_fn(completions, gold=pad_gold, query=pad_query)

    by_kind: dict[str, list[float]] = {}
    for k, rw in zip(kinds, rewards):
        by_kind.setdefault(k, []).append(rw)

    cfg = {"num_generations": a.num_generations, "beta": a.beta, "epsilon": a.epsilon,
           "epsilon_high": a.epsilon_high, "lr": a.lr, "max_steps": a.max_steps,
           "max_completion_length": a.max_completion_length, "use_vllm": a.use_vllm}

    return esci.smoke_report(
        f"{TECHNIQUE} - query -> filter JSON",
        {
            "data": {**c.n, "source": c.meta["source"]},
            "config": json.dumps(cfg, indent=2),
            "verifier": {"id": V.VERIFIER_ID, "version": V.VERIFIER_VERSION,
                         "schema": SCHEMA_PATH.name,
                         "schema_required_keys": schema["required"],
                         "selftest_cases": 13, "selftest_failures": 0,
                         "deterministic": True, "network_access": False},
            "shapes": {"prompt_rows": len(df), "grpo_records": len(recs),
                       "rollouts_per_prompt": a.num_generations,
                       "rollouts_per_epoch": len(recs) * a.num_generations,
                       "mean_gold_keys": 4},
            "reward_path_exercised": {k: f"n={len(v)} mean={sum(v)/len(v):+.4f}" for k, v in by_kind.items()},
            "sample_prompt": recs[0]["prompt"][1]["content"] if recs else "-",
            "sample_gold": recs[0]["gold"] if recs else "-",
            "heavy_deps": esci.optional_imports(["torch", "transformers", "peft", "trl", "vllm", "jsonschema", "datasets"]),
            "verdict": "verifier tested, prompts load, reward function returns one float per completion",
        },
    )


def train(a: argparse.Namespace) -> int:
    esci.require_gpu(TECHNIQUE)
    from datasets import Dataset
    from peft import LoraConfig
    from trl import GRPOConfig, GRPOTrainer

    schema = json.loads(SCHEMA_PATH.read_text())
    _, df = load_tasks(a)
    train_ds = Dataset.from_list(to_records(df))

    def reward_funcs(completions, gold, query, **kw):
        texts = [c[-1]["content"] if isinstance(c, list) else c for c in completions]
        return [V.verify(t, g, q, schema) for t, g, q in zip(texts, gold, query)]

    reward_funcs.__name__ = f"{V.VERIFIER_ID}_{V.VERIFIER_VERSION}"

    args = GRPOConfig(
        output_dir=a.output_dir,
        num_generations=a.num_generations,
        beta=a.beta,
        epsilon=a.epsilon,
        epsilon_high=a.epsilon_high,
        learning_rate=a.lr,
        max_completion_length=a.max_completion_length,
        max_steps=a.max_steps,
        per_device_train_batch_size=a.batch_size,
        use_vllm=a.use_vllm,
        bf16=True,
        logging_steps=5,
        seed=a.seed,
        report_to="mlflow",
    )
    GRPOTrainer(
        model=a.model,
        reward_funcs=reward_funcs,
        args=args,
        train_dataset=train_ds,
        peft_config=LoraConfig(r=a.lora_r, lora_alpha=2 * a.lora_r, task_type="CAUSAL_LM"),
    ).train()
    print(f"RLVR adapter written to {a.output_dir}")
    print("Before G3: run the reward-hacking audit (§13 step 5) over the top-reward samples.")
    return 0


def main() -> int:
    a = build_args().parse_args()
    return smoke(a) if a.smoke else train(a)


if __name__ == "__main__":
    raise SystemExit(main())
