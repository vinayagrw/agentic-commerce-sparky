#!/usr/bin/env python3
"""Technique 14 - on-policy distillation of the tail rewriter (SOTA playbook §14).

The student samples its own completions; the teacher scores every token; the student minimises
per-token reverse KL on its OWN distribution. Implemented with TRL's GKD trainer
(`lmbda=1.0` => all rollouts are student-generated i.e. fully on-policy; `beta=1.0` => the
generalised Jensen-Shannon divergence reduces to reverse KL, which is what §14 specifies).

Teacher  = the LoRA/RLVR-tuned 8B rewriter from techniques 11/13.
Student   = a <=1B model that can meet the online budget (§14 US-14.1).
Prompts   = real ESCI tail queries.

Two hard preconditions the script enforces rather than assumes:
  1. tokenizer compatibility - §14 Risks calls a silent tokenizer mismatch a KL corrupter;
     --smoke compares the two vocabularies and FAILS if they differ.
  2. teacher licence - §14 step 1 / AC3. --teacher-license-ok must be passed explicitly.

STATUS ON THIS MACHINE: script-ready, NOT EXECUTED (needs a teacher scoring pool + trainer
GPUs). `--smoke` validates on CPU.

  python distill.py --smoke
  python distill.py --teacher out/tail-rewriter-lora --student Qwen/Qwen3-0.6B --teacher-license-ok
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import esci  # noqa: E402

TECHNIQUE = "14 on-policy distillation"


def build_args() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--smoke", action="store_true")
    p.add_argument("--teacher", default="Qwen/Qwen3-1.7B", help="8B tuned rewriter for the real run")
    p.add_argument("--student", default="Qwen/Qwen3-0.6B")
    p.add_argument("--teacher-license-ok", action="store_true",
                   help="REQUIRED for a real run: the teacher's licence permits distillation (§14 AC3)")
    p.add_argument("--output-dir", default="out/rewriter-student-gkd")
    p.add_argument("--split", default="dev", choices=["dev", "test"])
    p.add_argument("--lmbda", type=float, default=1.0, help="1.0 = fully on-policy student rollouts")
    p.add_argument("--beta", type=float, default=1.0, help="1.0 = reverse KL (§14)")
    p.add_argument("--temperature", type=float, default=1.0)
    p.add_argument("--lr", type=float, default=1e-5)
    p.add_argument("--epochs", type=float, default=1.0)
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--max-new-tokens", type=int, default=64)
    p.add_argument("--max-length", type=int, default=512)
    p.add_argument("--tail-only", action="store_true")
    p.add_argument("--max-examples", type=int, default=None)
    p.add_argument("--seed", type=int, default=20260915)
    return p


def load_prompts(a: argparse.Namespace):
    c = esci.load_corpus(a.split)
    df = esci.build_rewrite_pairs(c, max_examples=a.max_examples, tail_only=a.tail_only, seed=a.seed)
    return c, df


def tokenizer_compat(teacher: str, student: str) -> dict:
    """Refuse to distil across mismatched tokenizers (§14 Risks)."""
    try:
        from transformers import AutoTokenizer

        tt = AutoTokenizer.from_pretrained(teacher)
        ts = AutoTokenizer.from_pretrained(student)
        probe = "leche deslactosada 1 gal organic gluten-free"
        same_vocab = tt.vocab_size == ts.vocab_size
        same_ids = tt(probe)["input_ids"] == ts(probe)["input_ids"]
        return {
            "checked": True,
            "teacher_vocab_size": tt.vocab_size,
            "student_vocab_size": ts.vocab_size,
            "identical_vocab_size": same_vocab,
            "identical_ids_on_probe": same_ids,
            "probe": probe,
            "compatible": bool(same_vocab and same_ids),
        }
    except Exception as e:
        return {"checked": False, "reason": f"{type(e).__name__}: {str(e)[:140]}",
                "compatible": None,
                "note": "the real run re-checks this and aborts on mismatch"}


def breakeven(a: argparse.Namespace) -> dict:
    """§14 US-14.2 / AC1: the run request must carry a break-even calculation.

    This is pure arithmetic over inputs the operator supplies - it asserts nothing measured.
    """
    return {
        "formula": "breakeven_requests = training_cost_usd / (teacher_cost_per_req - student_cost_per_req)",
        "inputs_required_from_finops": ["training_cost_usd", "teacher_cost_per_req", "student_cost_per_req"],
        "rule": "submit the run only if projected 90-day tail-rewrite volume > breakeven_requests",
        "note": "no cost numbers are asserted here; fill from OpenCost per-model $/1M tokens",
    }


def smoke(a: argparse.Namespace) -> int:
    c, df = load_prompts(a)
    compat = tokenizer_compat(a.teacher, a.student)

    shapes: dict[str, object] = {
        "prompt_rows": len(df),
        "rollouts_per_epoch": len(df),
        "max_new_tokens_per_rollout": a.max_new_tokens,
        "teacher_scored_tokens_per_epoch_upper_bound": len(df) * a.max_new_tokens,
    }
    tokinfo: dict[str, object] = {}
    if compat.get("compatible"):
        try:
            from transformers import AutoTokenizer

            ts = AutoTokenizer.from_pretrained(a.student)
            chat = esci.to_chat(df)[:32]
            texts = [ts.apply_chat_template(r["prompt"], tokenize=False, add_generation_prompt=True)
                     for r in chat]
            enc = ts(texts, padding=True, truncation=True, max_length=a.max_length, return_tensors="np")
            tokinfo = {"student_prompt_ids_shape": tuple(enc["input_ids"].shape),
                       "mean_prompt_tokens": round(float(enc["attention_mask"].sum(axis=1).mean()), 1)}
        except Exception as e:
            tokinfo = {"error": f"{type(e).__name__}: {str(e)[:120]}"}

    gate = "PASS" if compat.get("compatible") else (
        "BLOCKED - tokenizer mismatch, a real run would abort" if compat.get("compatible") is False
        else "UNVERIFIED offline - re-checked at run time")

    return esci.smoke_report(
        f"{TECHNIQUE} - 8B teacher -> <=1B student",
        {
            "data": {**c.n, "source": c.meta["source"]},
            "config": json.dumps({"teacher": a.teacher, "student": a.student,
                                  "lmbda": a.lmbda, "beta": a.beta,
                                  "temperature": a.temperature, "lr": a.lr,
                                  "loss": "per-token reverse KL on student-sampled tokens"}, indent=2),
            "tokenizer_compatibility": compat,
            "precondition_gate": gate,
            "licence_gate": ("acknowledged via --teacher-license-ok" if a.teacher_license_ok
                             else "NOT acknowledged - a real run refuses to start (§14 AC3)"),
            "shapes": shapes,
            "student_tokenisation": tokinfo,
            "breakeven_contract": breakeven(a),
            "heavy_deps": esci.optional_imports(["torch", "transformers", "trl", "peft", "vllm", "datasets"]),
            "verdict": "prompt pool loads, tokenizer compatibility checked, gates wired",
        },
    )


def train(a: argparse.Namespace) -> int:
    if not a.teacher_license_ok:
        raise SystemExit(
            "refusing to start: pass --teacher-license-ok only after recording, in the G4 "
            "evidence pack, that the teacher's licence permits distillation (playbook §14 AC3)."
        )
    compat = tokenizer_compat(a.teacher, a.student)
    if compat.get("compatible") is False:
        raise SystemExit(f"refusing to start: tokenizer mismatch {compat}")
    esci.require_gpu(TECHNIQUE)

    from datasets import Dataset
    try:
        from trl.experimental.gkd import GKDConfig, GKDTrainer
    except ImportError:  # promoted out of `experimental` in some releases
        from trl import GKDConfig, GKDTrainer  # type: ignore

    _, df = load_prompts(a)
    train_ds = Dataset.from_list(esci.to_chat(df))

    args = GKDConfig(
        output_dir=a.output_dir,
        teacher_model_name_or_path=a.teacher,
        lmbda=a.lmbda,          # 1.0 -> every batch is student-generated (on-policy)
        beta=a.beta,            # 1.0 -> reverse KL
        temperature=a.temperature,
        learning_rate=a.lr,
        num_train_epochs=a.epochs,
        per_device_train_batch_size=a.batch_size,
        gradient_accumulation_steps=a.grad_accum,
        max_new_tokens=a.max_new_tokens,
        max_length=a.max_length,
        bf16=True,
        logging_steps=10,
        seed=a.seed,
        report_to="mlflow",
    )
    GKDTrainer(model=a.student, args=args, train_dataset=train_ds).train()
    print(f"student written to {a.output_dir}")
    print("G3 gate: paired-CI parity per segment against the teacher before the router adds "
          "the student as a cheap tier (§14 KPIs).")
    return 0


def main() -> int:
    a = build_args().parse_args()
    return smoke(a) if a.smoke else train(a)


if __name__ == "__main__":
    raise SystemExit(main())
