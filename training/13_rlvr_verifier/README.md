# Technique 13. RLVR with a programmatic verifier (GRPO)

> **Status: script ready - NOT EXECUTED ON THIS MACHINE.**
> There is no CUDA device on this MacBook, and 4-bit/bf16 training kernels have no Apple-silicon path.
> Nothing in this directory reports a measured result for a production retailer's model. Every quantitative
> claim below is either arithmetic shown in full, or a published figure with its citation.

## What it does

GRPO reinforcement learning where the reward comes from `verifier.py` - a deterministic,
network-free, unit-tested artefact - rather than from a judge model. The task is
query -> Compass search-filter JSON, and the gold filter for each query is derived from the
catalogue attributes of the products humans judged E for it.

Run the verifier's own tests first; they are part of the deliverable:

```bash
python verifier.py --selftest      # 13 cases incl. reward-hacking ordering invariants
```

## Run it

```bash
# CPU validation - config, data loading and shapes. Never trains. Runs on a laptop.
python train_rlvr.py --smoke
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
cluster once with `vm_size = Standard_NC80adis_H100_v5`.

### GCP Vertex AI

```bash
gcloud ai custom-jobs create \
  --region=us-central1 \
  --display-name=sota-13-rlvr-verifier \
  --config=job.yaml
```

`job.yaml` pins the machine type `a3-highgpu-2g` with 2x `NVIDIA_H100_80GB` and the GCS paths for data and outputs.

## GPU SKU

2x NVIDIA H100 80GB - one rollout (vLLM) + one trainer (Azure Standard_NC80adis_H100_v5 / GCP a3-highgpu-2g)

## Cost estimate

GPU-hours are derived and shown; the **hourly rate is an input you supply from the live
pricing page**, because quoting a rate from memory would be a fabricated number.

```
GPU-hours   = 24
              (playbook §13 Cost and effort: "L. Rollout GPU plus trainer plus verifier engineering." 2 GPUs x 12 h)

cost_usd    = GPU-hours x R
            = 24 x R

worked example at an ILLUSTRATIVE R = $6/GPU-hr (a round placeholder, NOT a quoted price):
            = 24 x $6 = $144
```

Substitute the real `R` for **H100 80GB** from:
* Azure - <https://azure.microsoft.com/pricing/details/machine-learning/>
* GCP - <https://cloud.google.com/vertex-ai/pricing>

Add storage and egress separately. Spot/low-priority capacity changes `R` substantially.

## Expected result

Expect RLVR to sharpen a capability the SFT model already has - schema validity, unit
normalisation, evidence grounding - rather than to add knowledge; that is the consistent
finding in the RLVR literature and the reason the playbook warns against "expecting new
knowledge from RL". Expect the binding constraint to be verifier quality: a weak verifier is
rewarded by degenerate outputs, which is why `verifier.py` carries an F1 term and an evidence
-grounding term and asserts that the honest answer outscores every hack in its self-test.
Expect a human reward-hacking audit before G3. The playbook's "schema-valid rate from ~96% to
over 99.5%" is marked `[PROPOSAL target]` there and is not claimed here.

**This is an expectation, not a measurement.**

### Citations

GRPO in DeepSeekMath, arXiv:2402.03300. DeepSeek-R1, arXiv:2501.12948 (Nature 2025).
DAPO, arXiv:2503.14476. On the limits: "Does RL really incentivise reasoning beyond the base
model?", arXiv:2504.13837.

### Verifier registry
The verifier is a signed, versioned artefact (§13 AC2). Register `verifier.py` +
`schemas/filter_v1.json` together with their self-test result, and freeze that version into the
model's evidence pack.

## Files

| File | Purpose |
|---|---|
| `train_rlvr.py` | entrypoint; `--smoke` validates on CPU |
| `verifier.py` | the reward verifier; `--selftest` runs 13 cases |
| `schemas/filter_v1.json` | the JSON Schema the verifier enforces |
| `requirements.txt` | pinned dependencies for the GPU target |
| `job.yml` | Azure ML job - `az ml job create -f job.yml` |
| `job.yaml` | Vertex AI CustomJob - `gcloud ai custom-jobs create --config=job.yaml` |
