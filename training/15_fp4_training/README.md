# Technique 15. FP4 (NVFP4) continued pre-training spike

> **Status: script ready - NOT EXECUTED ON THIS MACHINE.**
> NVFP4 needs native Blackwell tensor cores. Apple silicon has no FP4 path at all, and emulated FP4 would be slower than BF16 - so the script refuses rather than pretending.
> Nothing in this directory reports a measured result for a production retailer's model. Every quantitative
> claim below is either arithmetic shown in full, or a published figure with its citation.

## What it does

Continued pre-training of a base LM on the Compass catalogue corpus (real product titles,
brands, bullets and descriptions) under NVIDIA Transformer Engine FP4 autocast on linear layers,
with embeddings, LM head, norms and the first/last blocks held in BF16.

Two refusals are built in, because both are failure modes the playbook names:
* **No Blackwell, no FP4.** FP4 is emulated (and slower) below compute capability 10.0, so the
  script exits rather than silently running a different recipe.
* **No FP8 control run, no FP4 run.** `--control-run-id` is mandatory for `--precision nvfp4`.

The `untrusted_seller_text` column is excluded from the corpus - it carries the planted
prompt-injection strings from `scripts/plant_injections.py` and must never be trained on.

## Run it

```bash
# CPU validation - config, data loading and shapes. Never trains. Runs on a laptop.
python train_fp4.py --smoke
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
cluster once with `vm_size = Standard_ND96isr_B200_v6`.

### GCP Vertex AI

```bash
gcloud ai custom-jobs create \
  --region=us-central1 \
  --display-name=sota-15-fp4-training \
  --config=job.yaml
```

`job.yaml` pins the machine type `a4-highgpu-8g` with 8x `NVIDIA_B200` and the GCS paths for data and outputs.

## GPU SKU

8x NVIDIA B200 (Blackwell, native NVFP4). Azure ND B200 v6 / GCP A4 [VERIFY region + quota; lead times are the real constraint]

## Cost estimate

GPU-hours are derived and shown; the **hourly rate is an input you supply from the live
pricing page**, because quoting a rate from memory would be a fabricated number.

```
GPU-hours   = 48
              (playbook §15 retailer example: a 1B-token continued-pre-training spike. 8 GPUs x 6 h. Doubles because the FP8 control run is mandatory)

cost_usd    = GPU-hours x R
            = 48 x R

worked example at an ILLUSTRATIVE R = $10/GPU-hr (a round placeholder, NOT a quoted price):
            = 48 x $10 = $480
```

Substitute the real `R` for **B200 (Blackwell)** from:
* Azure - <https://azure.microsoft.com/pricing/details/virtual-machines/linux/>
* GCP - <https://cloud.google.com/compute/gpus-pricing>

Add storage and egress separately. Spot/low-priority capacity changes `R` substantially.

## Expected result

Expect this to be a **feasibility spike whose likely outcome is "defer"**, not a
deliverable. The only large-scale evidence today is vendor-reported at 12B scale, the recipes
are version-sensitive, optimizer states stay FP32/BF16 so the run is not 4-bit end to end, and
the playbook places FP4 in the Assess ring and explicitly outside 90-day scope. Expect the
decision criterion to be a loss curve within ~1% of the FP8 control at equal tokens AND a
downstream eval delta inside the CI - loss alone is not sufficient. Expect FP4 to bring **no**
benefit to techniques 11-14; QLoRA's NF4 is a storage quantisation and a different thing.

**This is an expectation, not a measurement.**

### Citations

NVIDIA, "Pretraining LLMs with NVFP4", arXiv:2509.25149 - a 12B model trained on 10T
tokens tracking the FP8 baseline; vendor-reported. TetraJet-v2, arXiv:2510.27527. FP8 as the
mainstream default: DeepSeek-V3, arXiv:2412.19437. The +-1% loss-gap criterion is the playbook's
§15 AC1 acceptance criterion, not an observed result.

### Capacity warning
Blackwell region/quota lead time is the real constraint, not the software. Do not reserve
capacity before the spike (§15 Risks).

## Files

| File | Purpose |
|---|---|
| `train_fp4.py` | entrypoint; `--smoke` validates on CPU |
| `requirements.txt` | pinned dependencies for the GPU target |
| `job.yml` | Azure ML job - `az ml job create -f job.yml` |
| `job.yaml` | Vertex AI CustomJob - `gcloud ai custom-jobs create --config=job.yaml` |
