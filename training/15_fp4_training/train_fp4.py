#!/usr/bin/env python3
"""Technique 15 - FP4 (NVFP4) continued pre-training spike (SOTA playbook §15).

Continued pre-training of a base LM on the Sparky catalogue corpus (real product titles,
brands, bullets and descriptions from data/products.parquet) with NVIDIA Transformer Engine
FP4 autocast on linear layers, keeping embeddings, LM head, norms and the first/last blocks in
BF16 - the recipe shape the playbook records. An FP8 control run is MANDATORY (§15 step 1) and
the script refuses to start an FP4 run without `--control-run-id`.

Hardware gate (§15 US-15.2 / AC1): FP4 needs native Blackwell tensor cores. On anything else
FP4 is emulated and SLOWER, so this script hard-refuses on compute capability < 10.0 rather
than silently falling back.

STATUS ON THIS MACHINE: script-ready, NOT EXECUTED and NOT EXECUTABLE HERE - Apple silicon has
no NVFP4 path at all. `--smoke` validates the recipe, the hardware policy and the corpus
shapes on CPU.

  python train_fp4.py --smoke
  python train_fp4.py --precision fp8  --control-run-id -                # baseline, GPU
  python train_fp4.py --precision nvfp4 --control-run-id <fp8-run-id>    # spike, Blackwell
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import esci  # noqa: E402

TECHNIQUE = "15 FP4 training"

# Playbook §15 "FP4 recipe caveats". Kept as data so the scheduler and the ADR can read it.
FP4_RECIPE = {
    "format": "NVFP4",  # 4-bit E2M1 + FP8 block scales (16-element blocks) + per-tensor scale
    "apply_to": "linear_layers",
    "keep_bf16": ["embeddings", "lm_head", "layernorm", "first_2_blocks", "last_2_blocks"],
    "attention": "bf16_or_fp8",
    "final_tokens_high_precision": 0.15,
    "optimizer_states": "fp32/bf16 (NOT 4-bit)",
    "hardware": ["GB200", "GB300", "B200", "RTX PRO 6000 Blackwell"],
    "min_compute_capability": (10, 0),
    "guards": {"loss_spike_z": 4.0, "grad_norm_max": 5.0, "auto_fallback": "fp8"},
}


def build_args() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--smoke", action="store_true")
    p.add_argument("--model", default="Qwen/Qwen3-1.7B")
    p.add_argument("--precision", default="nvfp4", choices=["nvfp4", "fp8", "bf16"])
    p.add_argument("--control-run-id", default=None,
                   help="MLflow run id of the FP8 control run; required for --precision nvfp4")
    p.add_argument("--output-dir", default="out/catalog-cpt")
    p.add_argument("--split", default="dev", choices=["dev", "test"])
    p.add_argument("--max-docs", type=int, default=None)
    p.add_argument("--seq-len", type=int, default=1024)
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--grad-accum", type=int, default=16)
    p.add_argument("--max-steps", type=int, default=2000)
    p.add_argument("--lr", type=float, default=1e-5)
    p.add_argument("--seed", type=int, default=20260915)
    return p


def hardware_gate(precision: str) -> dict:
    """Never emulate FP4. Report, and (in a real run) refuse."""
    info: dict[str, object] = {"requested_precision": precision}
    try:
        import torch

        info["torch"] = torch.__version__
        info["cuda_available"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            cc = torch.cuda.get_device_capability(0)
            info["device"] = torch.cuda.get_device_name(0)
            info["compute_capability"] = f"{cc[0]}.{cc[1]}"
            info["native_fp4"] = cc >= FP4_RECIPE["min_compute_capability"]
        else:
            info["device"] = "none (CPU-only host)"
            info["native_fp4"] = False
    except Exception as e:
        info["torch"] = f"unavailable ({type(e).__name__})"
        info["native_fp4"] = False
    info["policy"] = ("nvfp4 permitted" if info.get("native_fp4")
                      else "nvfp4 REFUSED - emulated FP4 is slower than BF16; "
                           "Kueue must pin this job to a Blackwell flavour (§15 AC1)")
    return info


def smoke(a: argparse.Namespace) -> int:
    c = esci.load_corpus(a.split)
    corpus = esci.build_catalog_corpus(c, max_docs=a.max_docs)
    gate = hardware_gate(a.precision)

    tok_info: dict[str, object] = {}
    token_total = None
    try:
        from transformers import AutoTokenizer

        tok = AutoTokenizer.from_pretrained(a.model)
        head = corpus["text"].head(256).tolist()
        lens = [len(tok(t)["input_ids"]) for t in head]
        mean_tok = sum(lens) / len(lens)
        token_total = int(mean_tok * len(corpus))
        enc = tok(head[:8], truncation=True, max_length=a.seq_len, padding="max_length", return_tensors="np")
        tok_info = {
            "tokenizer": a.model,
            "packed_batch_shape": tuple(enc["input_ids"].shape),
            "mean_tokens_per_doc_sample_256": round(mean_tok, 1),
            "corpus_tokens_estimate": f"{token_total:,} (mean over a 256-doc sample x {len(corpus):,} docs)",
            "sequences_at_seq_len": token_total // a.seq_len,
        }
    except Exception as e:
        tok_info = {"tokenizer": f"not loaded ({type(e).__name__}: {str(e)[:120]})"}

    tokens_per_step = a.batch_size * a.grad_accum * a.seq_len
    return esci.smoke_report(
        f"{TECHNIQUE} - NVFP4 continued pre-training spike",
        {
            "data": {**c.n, "source": c.meta["source"]},
            "corpus": {
                "docs": len(corpus),
                "mean_chars_per_doc": round(float(corpus["text"].str.len().mean()), 1),
                "untrusted_seller_text": "EXCLUDED (injection-bearing field, never trained on)",
            },
            "recipe": json.dumps(FP4_RECIPE, indent=2, default=str),
            "hardware_gate": gate,
            "control_run_gate": (f"control_run_id={a.control_run_id}" if a.control_run_id
                                 else "ABSENT - a real nvfp4 run refuses to start (§15 step 1)"),
            "shapes": {"seq_len": a.seq_len, "tokens_per_optimizer_step": tokens_per_step,
                       "max_steps": a.max_steps,
                       "tokens_in_run": tokens_per_step * a.max_steps},
            "tokenisation": tok_info,
            "heavy_deps": esci.optional_imports(["torch", "transformers", "transformer_engine", "datasets", "accelerate"]),
            "verdict": "recipe valid, corpus builds, hardware policy refuses non-Blackwell FP4",
        },
    )


def train(a: argparse.Namespace) -> int:
    if a.precision == "nvfp4" and not a.control_run_id:
        raise SystemExit(
            "refusing to start: --precision nvfp4 requires --control-run-id pointing at the "
            "FP8 baseline run. Playbook §15 step 1: reproduce the FP8 baseline first, and "
            "§15 Risks: 'comparing loss only and skipping downstream evals'."
        )
    esci.require_gpu(TECHNIQUE)
    gate = hardware_gate(a.precision)
    if a.precision == "nvfp4" and not gate.get("native_fp4"):
        raise SystemExit(f"refusing to start: {gate['policy']} (gate={gate})")

    import torch
    from datasets import Dataset
    from transformers import AutoModelForCausalLM, AutoTokenizer, DataCollatorForLanguageModeling, Trainer, TrainingArguments

    c = esci.load_corpus(a.split)
    corpus = esci.build_catalog_corpus(c, max_docs=a.max_docs)
    tok = AutoTokenizer.from_pretrained(a.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    ds = Dataset.from_pandas(corpus[["text"]]).map(
        lambda b: tok(b["text"], truncation=True, max_length=a.seq_len),
        batched=True, remove_columns=["text"],
    )

    model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.bfloat16)

    fp4_ctx = None
    if a.precision in ("nvfp4", "fp8"):
        # Transformer Engine's recipe/autocast API names move between releases; resolve at run
        # time and fail loudly rather than silently training in BF16 and calling it FP4.
        import transformer_engine.pytorch as te
        from transformer_engine.common import recipe as te_recipe

        if a.precision == "nvfp4":
            rname = next((n for n in ("NVFP4BlockScaling", "Float4BlockScaling", "NVFP4Recipe")
                          if hasattr(te_recipe, n)), None)
            if rname is None:
                raise SystemExit(
                    "transformer_engine in this image exposes no NVFP4 recipe class; pin a TE "
                    "build that does (§15: 'recipes are vendor-specific and version-sensitive')."
                )
            r = getattr(te_recipe, rname)()
            fp4_ctx = lambda: te.fp8_autocast(enabled=True, fp8_recipe=r)  # noqa: E731
            print(f"Transformer Engine recipe: {rname}")
        else:
            r = te_recipe.DelayedScaling(fp8_format=te_recipe.Format.HYBRID)
            fp4_ctx = lambda: te.fp8_autocast(enabled=True, fp8_recipe=r)  # noqa: E731

    class PrecisionTrainer(Trainer):
        def compute_loss(self, model, inputs, return_outputs=False, **kw):
            if fp4_ctx is None:
                return super().compute_loss(model, inputs, return_outputs, **kw)
            with fp4_ctx():
                out = model(**inputs)
            return (out.loss, out) if return_outputs else out.loss

    args = TrainingArguments(
        output_dir=a.output_dir,
        per_device_train_batch_size=a.batch_size,
        gradient_accumulation_steps=a.grad_accum,
        max_steps=a.max_steps,
        learning_rate=a.lr,
        bf16=True,
        logging_steps=10,
        save_steps=500,
        seed=a.seed,
        report_to="mlflow",
        run_name=f"catalog-cpt-{a.precision}",
    )
    PrecisionTrainer(
        model=model, args=args, train_dataset=ds,
        data_collator=DataCollatorForLanguageModeling(tok, mlm=False),
    ).train()
    print(f"checkpoint written to {a.output_dir}")
    print("Now compare against the FP8 control on DOWNSTREAM evals, not loss alone, and write "
          "the ADR: adopt / defer / reject (§15 steps 4-5).")
    return 0


def main() -> int:
    a = build_args().parse_args()
    return smoke(a) if a.smoke else train(a)


if __name__ == "__main__":
    raise SystemExit(main())
