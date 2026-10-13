#!/usr/bin/env python3
"""Technique 12 - DPO on the Sparky rewriter (SOTA playbook §12).

Direct Preference Optimisation over (prompt, chosen, rejected) triples. The preference signal
here is NOT an LLM judge: `chosen` is derived from a product a human judged **E (exact)** for
that query and `rejected` from a product the same human judged **I (irrelevant)**. Playbook
§12 US-12.2 demands every pair be traceable to its source, so each row carries
chosen_product_id / rejected_product_id / source (see training/common/esci.py).

The length-exploitation guard from §12 step 3 / AC2 is applied before training.

STATUS ON THIS MACHINE: script-ready, NOT EXECUTED (no CUDA device). See README.md for the
one-command Azure ML / Vertex AI submission. `--smoke` validates on CPU.

  python train_dpo.py --smoke
  python train_dpo.py --model out/tail-rewriter-lora --beta 0.1     # GPU target
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import esci  # noqa: E402

TECHNIQUE = "12 DPO"


def build_args() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--smoke", action="store_true")
    p.add_argument("--model", default="Qwen/Qwen3-1.7B",
                   help="the SFT checkpoint from technique 11 for a real run")
    p.add_argument("--output-dir", default="out/sparky-dpo")
    p.add_argument("--split", default="dev", choices=["dev", "test"])
    p.add_argument("--eval-split", default="test", choices=["dev", "test"])
    # Playbook §12 step 4: beta=0.1 to start, sweep {0.05, 0.1, 0.3}
    p.add_argument("--beta", type=float, default=0.1)
    p.add_argument("--loss-type", default="sigmoid",
                   choices=["sigmoid", "hinge", "ipo", "apo_zero", "apo_down"])
    p.add_argument("--lr", type=float, default=5e-6)
    p.add_argument("--epochs", type=float, default=1.0)
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--max-length", type=int, default=1024)
    p.add_argument("--max-prompt-length", type=int, default=512)
    p.add_argument("--length-ratio", type=float, default=1.5,
                   help="max chosen/rejected char ratio kept (length-exploitation guard)")
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--max-examples", type=int, default=None)
    p.add_argument("--seed", type=int, default=20260915)
    return p


def load_pairs(a: argparse.Namespace):
    tr_c = esci.load_corpus(a.split)
    ev_c = esci.load_corpus(a.eval_split)
    tr = esci.build_preference_pairs(tr_c, max_examples=a.max_examples, seed=a.seed)
    ev = esci.build_preference_pairs(ev_c, max_examples=a.max_examples, seed=a.seed)
    tr_f = esci.length_balance_filter(tr, a.length_ratio)
    ev_f = esci.length_balance_filter(ev, a.length_ratio)
    return tr_c, tr, tr_f, ev_f


def to_dpo_records(df, system: str = esci.REWRITE_SYSTEM) -> list[dict]:
    """TRL conversational preference format."""
    return [
        {
            "prompt": [{"role": "system", "content": system},
                       {"role": "user", "content": r["prompt"]}],
            "chosen": [{"role": "assistant", "content": r["chosen"]}],
            "rejected": [{"role": "assistant", "content": r["rejected"]}],
        }
        for _, r in df.iterrows()
    ]


def smoke(a: argparse.Namespace) -> int:
    tr_c, tr_raw, tr, ev = load_pairs(a)
    recs = to_dpo_records(tr)

    guard = {
        "pairs_before_length_guard": len(tr_raw),
        "pairs_after_length_guard": len(tr),
        "dropped_by_guard": len(tr_raw) - len(tr),
        "max_chosen_over_rejected_char_ratio": a.length_ratio,
        "mean_len_delta_chars_after": round(float(tr["len_delta"].mean()), 2) if len(tr) else 0.0,
    }
    prov = {
        "source": sorted(tr["source"].unique().tolist()) if len(tr) else [],
        "human_verified_rows": int(tr["human_verified"].sum()) if len(tr) else 0,
        "rows_with_chosen_product_id": int(tr["chosen_product_id"].notna().sum()) if len(tr) else 0,
        "rows_with_rejected_product_id": int(tr["rejected_product_id"].notna().sum()) if len(tr) else 0,
    }
    tok_info: dict[str, object] = {}
    try:
        from transformers import AutoTokenizer

        tok = AutoTokenizer.from_pretrained(a.model)
        ch = [tok.apply_chat_template(r["prompt"] + r["chosen"], tokenize=False) for r in recs[:32]]
        rj = [tok.apply_chat_template(r["prompt"] + r["rejected"], tokenize=False) for r in recs[:32]]
        ec = tok(ch, padding=True, truncation=True, max_length=a.max_length, return_tensors="np")
        er = tok(rj, padding=True, truncation=True, max_length=a.max_length, return_tensors="np")
        tok_info = {
            "tokenizer": a.model,
            "chosen_input_ids_shape": tuple(ec["input_ids"].shape),
            "rejected_input_ids_shape": tuple(er["input_ids"].shape),
            "mean_chosen_tokens": round(float(ec["attention_mask"].sum(axis=1).mean()), 1),
            "mean_rejected_tokens": round(float(er["attention_mask"].sum(axis=1).mean()), 1),
        }
    except Exception as e:
        tok_info = {"tokenizer": f"not loaded ({type(e).__name__}: {str(e)[:140]})"}

    cfg = {"beta": a.beta, "loss_type": a.loss_type, "lr": a.lr, "epochs": a.epochs,
           "per_device_bs": a.batch_size, "grad_accum": a.grad_accum,
           "max_length": a.max_length, "max_prompt_length": a.max_prompt_length,
           "ref_model": "None + peft_config => frozen base acts as the reference policy"}

    return esci.smoke_report(
        f"{TECHNIQUE} - preference tuning of the rewriter",
        {
            "data": {**tr_c.n, "source": tr_c.meta["source"]},
            "config": json.dumps(cfg, indent=2),
            "length_guard": guard,
            "provenance": prov,
            "shapes": {"train_pairs": len(tr), "eval_pairs": len(ev), "dpo_records": len(recs)},
            "tokenizer": tok_info,
            "sample_pair": (f"prompt={recs[0]['prompt'][1]['content']!r} "
                            f"chosen={recs[0]['chosen'][0]['content'].splitlines()[0]!r} "
                            f"rejected={recs[0]['rejected'][0]['content'].splitlines()[0]!r}")
            if recs else "-",
            "heavy_deps": esci.optional_imports(["torch", "transformers", "peft", "trl", "datasets"]),
            "verdict": "pairs are E-vs-I human judgements, length-balanced, traceable",
        },
    )


def train(a: argparse.Namespace) -> int:
    esci.require_gpu(TECHNIQUE)
    from datasets import Dataset
    from peft import LoraConfig
    from trl import DPOConfig, DPOTrainer

    _, _, tr, ev = load_pairs(a)
    train_ds = Dataset.from_list(to_dpo_records(tr))
    eval_ds = Dataset.from_list(to_dpo_records(ev))

    peft_config = LoraConfig(r=a.lora_r, lora_alpha=2 * a.lora_r, lora_dropout=0.05,
                             bias="none", task_type="CAUSAL_LM")
    args = DPOConfig(
        output_dir=a.output_dir,
        beta=a.beta,
        loss_type=a.loss_type,
        learning_rate=a.lr,
        num_train_epochs=a.epochs,
        per_device_train_batch_size=a.batch_size,
        gradient_accumulation_steps=a.grad_accum,
        max_length=a.max_length,
        max_prompt_length=a.max_prompt_length,
        bf16=True,
        logging_steps=10,
        eval_strategy="epoch",
        seed=a.seed,
        report_to="mlflow",
    )
    # ref_model=None together with peft_config: TRL disables the adapter to obtain the
    # reference log-probs, so no second copy of the weights is loaded.
    DPOTrainer(
        model=a.model,
        ref_model=None,
        args=args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        peft_config=peft_config,
    ).train()
    print(f"DPO adapter written to {a.output_dir}")
    return 0


def main() -> int:
    a = build_args().parse_args()
    return smoke(a) if a.smoke else train(a)


if __name__ == "__main__":
    raise SystemExit(main())
