# Technique 12. DPO preference tuning of the Compass rewriter

> **Status: script ready - NOT EXECUTED ON THIS MACHINE.**
> There is no CUDA device on this MacBook, and 4-bit/bf16 training kernels have no Apple-silicon path.
> Nothing in this directory reports a measured result for a production retailer's model. Every quantitative
> claim below is either arithmetic shown in full, or a published figure with its citation.

## What it does

Direct Preference Optimisation over (prompt, chosen, rejected) triples, trained as a LoRA
adapter on top of the technique-11 SFT checkpoint. The preference signal is **not an LLM
judge**: `chosen` derives from a product a human judged E (exact) for that query and `rejected`
from a product the same human judged I (irrelevant). Every row carries
`chosen_product_id` / `rejected_product_id` / `source`, which is what §12 US-12.2 requires for
audit. The length-exploitation guard (§12 step 3) runs before training and its drop count is
printed.

## Run it

```bash
# CPU validation - config, data loading and shapes. Never trains. Runs on a laptop.
python train_dpo.py --smoke
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
  --display-name=sota-12-dpo \
  --config=job.yaml
```

`job.yaml` pins the machine type `a2-ultragpu-1g` with 1x `NVIDIA_A100_80GB` and the GCS paths for data and outputs.

## GPU SKU

1x NVIDIA A100 80GB (Azure Standard_NC24ads_A100_v4 / GCP a2-ultragpu-1g)

## Cost estimate

GPU-hours are derived and shown; the **hourly rate is an input you supply from the live
pricing page**, because quoting a rate from memory would be a fabricated number.

```
GPU-hours   = 3
              (playbook §12 Cost and effort: "M. Training is cheap (LoRA). Preference data and judge calibration are the effort.")

cost_usd    = GPU-hours x R
            = 3 x R

worked example at an ILLUSTRATIVE R = $3/GPU-hr (a round placeholder, NOT a quoted price):
            = 3 x $3 = $9
```

Substitute the real `R` for **A100 80GB** from:
* Azure - <https://azure.microsoft.com/pricing/details/machine-learning/>
* GCP - <https://cloud.google.com/vertex-ai/pricing>

Add storage and egress separately. Spot/low-priority capacity changes `R` substantially.

## Expected result

Expect DPO to move tone/format/preference behaviour, and expect it NOT to fix factual
errors - the playbook and the DPO literature both route factual correctness to retrieval or to
a verifier (technique 13). Expect the dominant failure mode to be length exploitation, which is
why the harness reports pairs dropped by the length guard. The playbook's own acceptance
criterion - win rate >=55% against the SFT model with a 95% CI lower bound above 50% - is a
**target to be measured**, not a result.

**This is an expectation, not a measurement.**

### Citations

DPO, Rafailov et al., NeurIPS 2023, arXiv:2305.18290. SimPO, NeurIPS 2024,
arXiv:2405.14734. The >=55% win-rate figure is the playbook's §12 AC1 target and is explicitly
marked as a proposal there.

## Files

| File | Purpose |
|---|---|
| `train_dpo.py` | entrypoint; `--smoke` validates on CPU |
| `requirements.txt` | pinned dependencies for the GPU target |
| `job.yml` | Azure ML job - `az ml job create -f job.yml` |
| `job.yaml` | Vertex AI CustomJob - `gcloud ai custom-jobs create --config=job.yaml` |
