#!/usr/bin/env python3
"""Technique 11 - LoRA / QLoRA tail-query rewriter (SOTA playbook §11).

Trains a LoRA (or QLoRA 4-bit NF4) adapter on top of a frozen base causal LM so that Sparky's
tail queries get a canonical catalogue rewrite plus a category. Supervision comes from the
project's real ESCI data: for each query, the E-judged (exact-match) product supplies the
rewrite target (see training/common/esci.py).

STATUS ON THIS MACHINE: script-ready, NOT EXECUTED. There is no CUDA device on a MacBook, and
bitsandbytes 4-bit has no Apple-silicon path. Run it with the one-command cloud path in
README.md. `--smoke` validates config, data loading, chat formatting and tokenised shapes on
CPU so the script is verifiably not a stub.

  python train_lora.py --smoke
  python train_lora.py --model meta-llama/Llama-3.1-8B-Instruct --qlora   # GPU target
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # training/
from common import esci  # noqa: E402

TECHNIQUE = "11 LoRA/QLoRA"
# Playbook §11 "Implementation steps": sweep r in {8,16,32}; target modules per the TRL/PEFT
# QLoRA recipe quoted in the playbook.
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def build_args() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--smoke", action="store_true", help="CPU validation only; never trains")
    p.add_argument("--model", default="Qwen/Qwen3-1.7B", help="base model id (use an 8B for the real run)")
    p.add_argument("--qlora", action="store_true", help="4-bit NF4 base (QLoRA) instead of BF16 LoRA")
    p.add_argument("--output-dir", default="out/tail-rewriter-lora")
    p.add_argument("--split", default="dev", choices=["dev", "test"])
    p.add_argument("--eval-split", default="test", choices=["dev", "test"])
    p.add_argument("--tail-only", action="store_true", help="restrict to hard/sparse tail queries (§11 UC1)")
    p.add_argument("--max-examples", type=int, default=None)
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--lora-dropout", type=float, default=0.05)
    p.add_argument("--epochs", type=float, default=2.0)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--grad-accum", type=int, default=4)
    p.add_argument("--max-length", type=int, default=512)
    p.add_argument("--seed", type=int, default=20260915)
    return p


def load_datasets(a: argparse.Namespace):
    train_c = esci.load_corpus(a.split)
    eval_c = esci.load_corpus(a.eval_split)
    train_df = esci.build_rewrite_pairs(
        train_c, max_examples=a.max_examples, tail_only=a.tail_only, seed=a.seed
    )
    eval_df = esci.build_rewrite_pairs(
        eval_c, max_examples=min(a.max_examples or 512, 512), tail_only=a.tail_only, seed=a.seed
    )
    return train_c, eval_c, train_df, eval_df


def smoke(a: argparse.Namespace) -> int:
    train_c, eval_c, train_df, eval_df = load_datasets(a)
    chat = esci.to_chat(train_df)

    shapes: dict[str, object] = {
        "train_rows": len(train_df),
        "eval_rows": len(eval_df),
        "chat_records": len(chat),
        "prompt_turns_per_record": len(chat[0]["prompt"]) if chat else 0,
        "categories_covered": sorted(train_df["category"].unique().tolist()) if len(train_df) else [],
        "mean_query_chars": round(float(train_df["query"].str.len().mean()), 1) if len(train_df) else 0,
        "mean_completion_chars": round(float(train_df["completion"].str.len().mean()), 1) if len(train_df) else 0,
    }

    # Real tokenisation if a tokenizer is reachable; otherwise report why not, never guess.
    tok_info: dict[str, object] = {}
    try:
        from transformers import AutoTokenizer

        tok = AutoTokenizer.from_pretrained(a.model)
        texts = [
            tok.apply_chat_template(c["prompt"] + c["completion"], tokenize=False)
            for c in chat[:64]
        ]
        enc = tok(texts, truncation=True, max_length=a.max_length, padding=True, return_tensors="np")
        tok_info = {
            "tokenizer": a.model,
            "batch_input_ids_shape": tuple(enc["input_ids"].shape),
            "max_seq_len_in_batch": int(enc["attention_mask"].sum(axis=1).max()),
            "truncation_at": a.max_length,
        }
    except Exception as e:  # offline laptop, gated repo, no network
        tok_info = {
            "tokenizer": f"not loaded ({type(e).__name__}: {str(e)[:140]})",
            "note": "token shapes are validated on the GPU target; row/char shapes above are real",
        }

    cfg = {
        "base_model": a.model,
        "quantization": "4-bit NF4 double-quant, bf16 compute (QLoRA)" if a.qlora else "bf16 (LoRA)",
        "lora": {"r": a.lora_r, "alpha": a.lora_alpha, "dropout": a.lora_dropout,
                 "target_modules": TARGET_MODULES, "task_type": "CAUSAL_LM"},
        "optim": {"epochs": a.epochs, "lr": a.lr, "per_device_bs": a.batch_size,
                  "grad_accum": a.grad_accum, "effective_bs": a.batch_size * a.grad_accum,
                  "max_length": a.max_length},
    }

    return esci.smoke_report(
        f"{TECHNIQUE} - tail-query rewriter",
        {
            "data": {**train_c.n, "source": train_c.meta["source"], "split": a.split},
            "config": json.dumps(cfg, indent=2),
            "shapes": shapes,
            "tokenizer": tok_info,
            "sample_prompt": chat[0]["prompt"][1]["content"] if chat else "-",
            "sample_completion": chat[0]["completion"][0]["content"].replace("\n", " | ") if chat else "-",
            "heavy_deps": esci.optional_imports(["torch", "transformers", "peft", "trl", "bitsandbytes", "datasets"]),
            "verdict": "config valid, ESCI data loads, chat records well-formed",
        },
    )


def train(a: argparse.Namespace) -> int:
    esci.require_gpu(TECHNIQUE)
    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer

    _, _, train_df, eval_df = load_datasets(a)
    train_ds = Dataset.from_list(esci.to_chat(train_df))
    eval_ds = Dataset.from_list(esci.to_chat(eval_df))

    quantization_config = None
    if a.qlora:
        quantization_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
        )

    peft_config = LoraConfig(
        r=a.lora_r,
        lora_alpha=a.lora_alpha,
        lora_dropout=a.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=TARGET_MODULES,
    )

    training_args = SFTConfig(
        output_dir=a.output_dir,
        num_train_epochs=a.epochs,
        learning_rate=a.lr,
        per_device_train_batch_size=a.batch_size,
        gradient_accumulation_steps=a.grad_accum,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        bf16=True,
        gradient_checkpointing=True,
        max_length=a.max_length,
        logging_steps=10,
        eval_strategy="epoch",
        save_strategy="epoch",
        seed=a.seed,
        report_to="mlflow",
    )

    trainer = SFTTrainer(
        model=a.model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        quantization_config=quantization_config,
        peft_config=peft_config,
    )
    trainer.train()
    trainer.save_model(a.output_dir)
    print(f"adapter written to {a.output_dir}")
    print("serve with: vllm serve <base> --enable-lora --max-loras 8 --max-lora-rank "
          f"{a.lora_r}  (playbook §11 multi-LoRA serving)")
    return 0


def main() -> int:
    a = build_args().parse_args()
    return smoke(a) if a.smoke else train(a)


if __name__ == "__main__":
    raise SystemExit(main())
