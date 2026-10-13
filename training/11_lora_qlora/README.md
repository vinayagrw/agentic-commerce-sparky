# Technique 11. LoRA / QLoRA tail-query rewriter

> **Status: script ready - NOT EXECUTED ON THIS MACHINE.**
> There is no CUDA device on this MacBook, and 4-bit/bf16 training kernels have no Apple-silicon path.
> Nothing in this directory reports a measured result for a production retailer's model. Every quantitative
> claim below is either arithmetic shown in full, or a published figure with its citation.

## What it does

Trains a LoRA (BF16) or QLoRA (4-bit NF4 base) adapter so an 8B base model rewrites a
shopper's tail query into a canonical catalogue phrase plus a category. The supervision comes
from this repo's real ESCI data: for each query, a product a human judged **E (exact match)**
supplies an extractive rewrite target, so every training row is auditable back to the
catalogue row it came from (`training/common/esci.py::build_rewrite_pairs`).

## Run it

```bash
# CPU validation - config, data loading and shapes. Never trains. Runs on a laptop.
python train_lora.py --smoke
```

The smoke path is the proof that this is a real program: it loads the project's ESCI parquet
files, builds the dataset, and reports actual row counts and tokenised shapes.

## One-command cloud path

### Azure ML

```bash
az ml job create -f job.yml \
  --resource-group <rg> --workspace-name <ws>
```

`job.yml` pins the entrypoint, the `sparky_esci` data asset and the compute cluster. Create the
cluster once with `vm_size = Standard_NC24ads_A100_v4`.

### GCP Vertex AI

```bash
gcloud ai custom-jobs create \
  --region=us-central1 \
  --display-name=sota-11-lora-qlora \
  --config=job.yaml
```

`job.yaml` pins the machine type `a2-ultragpu-1g` with 1x `NVIDIA_A100_80GB` and the GCS paths for data and outputs.

## GPU SKU

1x NVIDIA A100 80GB (Azure Standard_NC24ads_A100_v4 / GCP a2-ultragpu-1g)

## Cost estimate

GPU-hours are derived and shown; the **hourly rate is an input you supply from the live
pricing page**, because quoting a rate from memory would be a fabricated number.

```
GPU-hours   = 4
              (playbook §11 Cost and effort: "One 8B QLoRA run is hours on a single A100/H100-class GPU")

cost_usd    = GPU-hours x R
            = 4 x R

worked example at an ILLUSTRATIVE R = $3/GPU-hr (a round placeholder, NOT a quoted price):
            = 4 x $3 = $12
```

Substitute the real `R` for **A100 80GB** from:
* Azure - <https://azure.microsoft.com/pricing/details/machine-learning/>
* GCP - <https://cloud.google.com/vertex-ai/pricing>

Add storage and egress separately. Spot/low-priority capacity changes `R` substantially.

## Expected result

Expect a LoRA adapter to be a viable delivery vehicle for this task rather than full
fine-tuning, and expect the run to finish in hours on one A100/H100-class GPU. Expect the G3
gate to need BOTH a task metric and a general-capability regression suite, because LoRA's
published trade-off is that it "learns less and forgets less" than full fine-tuning.

**This is an expectation, not a measurement.**

### Citations

LoRA, Hu et al., arXiv:2106.09685 (2021). QLoRA, Dettmers et al., NeurIPS 2023,
arXiv:2305.14314. "LoRA Learns Less and Forgets Less", TMLR 2024, arXiv:2405.09673. Prior
deployment of a Llama-3-8B LoRA tail rewriter at Instacart is recorded in the playbook (§11,
Maturity and evidence). No number in this README is a measurement of a production retailer's model.

### After the run
Serve several adapters on one base rather than one GPU pool per task:

```bash
vllm serve <base> --enable-lora --max-loras 8 --max-lora-rank 32
```

That path is implemented in `serving/23_prefix_caching/`.

## Files

| File | Purpose |
|---|---|
| `train_lora.py` | entrypoint; `--smoke` validates on CPU |
| `requirements.txt` | pinned dependencies for the GPU target |
| `job.yml` | Azure ML job - `az ml job create -f job.yml` |
| `job.yaml` | Vertex AI CustomJob - `gcloud ai custom-jobs create --config=job.yaml` |
