# `training/` - SOTA techniques that need GPUs we do not have here

Every technique in this directory is a **real, runnable program with a one-command cloud path**
that has **not been executed on this machine**. There is no CUDA device on the development
MacBook, so none of these has produced a number, and none of them reports one.

The app labels all of it **"script ready - not executed on this machine"**. That label is
generated from [`NOT_RUN_HERE.json`](NOT_RUN_HERE.json), which is the machine-readable index the
coverage board consumes.

## The honesty rule

No fabricated benchmark numbers, anywhere. Every quantitative claim in a technique README is
either:

1. **arithmetic shown in full** - GPU-hours derived from a cited basis, multiplied by an hourly
   rate you supply from the live cloud pricing page (the READMEs show a worked example at an
   explicitly illustrative round rate, never a rate quoted from memory); or
2. **a published figure with its citation** - somebody else's measurement on somebody else's
   workload, labelled as such.

`expected_result` strings are phrased as expectations with citations. They are never phrased as
measurements.

## Proving these are not vapourware

Each entrypoint takes `--smoke`, which validates config, data loading and tensor shapes on CPU
without training. Run them all:

```bash
cd services/search-svc
for f in ../../training/*/[a-z]*.py; do uv run --no-sync python "$f" --smoke; done
```

The smoke path loads this repo's real ESCI parquet files (`data/*.parquet`, produced by
`scripts/fetch_data.py`) and prints actual row counts and tokenised shapes.

## Contents

| Dir | Technique | Entrypoint | GPU |
|---|---|---|---|
| [`11_lora_qlora/`](11_lora_qlora/) | LoRA / QLoRA tail-query rewriter | `train_lora.py` | 1x A100 80GB |
| [`12_dpo/`](12_dpo/) | DPO preference tuning | `train_dpo.py` | 1x A100 80GB |
| [`13_rlvr_verifier/`](13_rlvr_verifier/) | RLVR + programmatic verifier (GRPO) | `train_rlvr.py` | 2x H100 80GB |
| [`14_on_policy_distillation/`](14_on_policy_distillation/) | On-policy distillation (GKD) | `distill.py` | 2x H100 80GB |
| [`15_fp4_training/`](15_fp4_training/) | FP4 (NVFP4) continued pre-training spike | `train_fp4.py` | 8x B200 (Blackwell) |
| [`17_research_replication_agent/`](17_research_replication_agent/) | Research replication agent | `replicate.py` | 1x L4, T1 sandbox |
| `common/` | shared ESCI data access - no entrypoint | `esci.py` | - |

The serving-side techniques (23, 24, 25) and the shared benchmark harness live in
[`../serving/`](../serving/) and are indexed in the same `NOT_RUN_HERE.json`.

## Where the data comes from

`common/esci.py` is the single place these scripts touch data. It builds four task datasets
from the same parquet files the rest of Compass uses, and the supervision is always the real
Amazon ESCI human judgement (E / S / C / I), never a synthesised label:

| Builder | Used by | Signal |
|---|---|---|
| `build_rewrite_pairs` | 11, 14, serving prefix | rewrite target extracted from an **E**-judged product |
| `build_preference_pairs` | 12 | chosen = **E** product, rejected = **I** product, same query |
| `build_filter_tasks` | 13 | gold filter derived from the **E** products' catalogue attributes |
| `build_catalog_corpus` | 15 | product text, with `untrusted_seller_text` excluded |

Point it elsewhere with `SPARKY_DATA_DIR`; the cloud job specs already do.
