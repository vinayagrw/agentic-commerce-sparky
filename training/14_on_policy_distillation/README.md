# Technique 14. On-policy distillation (GKD, reverse KL)

> **Status: script ready - NOT EXECUTED ON THIS MACHINE.**
> There is no CUDA device on this MacBook, and 4-bit/bf16 training kernels have no Apple-silicon path.
> Nothing in this directory reports a measured result for a production retailer's model. Every quantitative
> claim below is either arithmetic shown in full, or a published figure with its citation.

## What it does

On-policy distillation with TRL's GKD trainer: the student samples its own completions
(`lmbda=1.0`), the teacher scores every token, and the student minimises per-token reverse KL
(`beta=1.0`) on its own distribution. Teacher = the 8B tuned rewriter from techniques 11/13;
student = a <=1B model that can meet the online budget.

Two preconditions are enforced in code rather than assumed:
* **Tokenizer compatibility.** A silent mismatch corrupts the KL. `--smoke` compares both
  vocabularies on a probe string and a real run aborts on mismatch.
* **Teacher licence.** `--teacher-license-ok` must be passed explicitly (§14 AC3).

## Run it

```bash
# CPU validation - config, data loading and shapes. Never trains. Runs on a laptop.
python distill.py --smoke
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
  --display-name=sota-14-on-policy-distillation \
  --config=job.yaml
```

`job.yaml` pins the machine type `a3-highgpu-2g` with 2x `NVIDIA_H100_80GB` and the GCS paths for data and outputs.

## GPU SKU

2x NVIDIA H100 80GB - teacher scoring pool + student trainer (Azure Standard_NC80adis_H100_v5 / GCP a3-highgpu-2g)

## Cost estimate

GPU-hours are derived and shown; the **hourly rate is an input you supply from the live
pricing page**, because quoting a rate from memory would be a fabricated number.

```
GPU-hours   = 20
              (playbook §14 Cost and effort: "M-L. Cheaper than RL per point of quality, but needs a teacher scoring pool." 2 GPUs x 10 h)

cost_usd    = GPU-hours x R
            = 20 x R

worked example at an ILLUSTRATIVE R = $6/GPU-hr (a round placeholder, NOT a quoted price):
            = 20 x $6 = $120
```

Substitute the real `R` for **H100 80GB** from:
* Azure - <https://azure.microsoft.com/pricing/details/machine-learning/>
* GCP - <https://cloud.google.com/vertex-ai/pricing>

Add storage and egress separately. Spot/low-priority capacity changes `R` substantially.

## Expected result

Expect on-policy distillation to beat offline distillation on the student's own error
distribution, because offline training never shows the student the states it actually reaches -
this is the exposure-bias argument the GKD paper makes. Expect the economics, not the quality,
to decide the run: §14 US-14.2 requires a break-even calculation
(`breakeven_requests = training_cost / (teacher_cost_per_req - student_cost_per_req)`) attached
to the request, and the script prints that contract with no numbers filled in, because they are
FinOps inputs.

**This is an expectation, not a measurement.**

### Citations

GKD / on-policy distillation, Agarwal et al., ICLR 2024, arXiv:2306.13649. Thinking
Machines Lab, "On-Policy Distillation", Oct 2025 (vendor blog). A large US retailer's existing 7B->BERT-base
offline distillation on 170M pairs is recorded in the playbook (§14, Maturity and evidence).

## Files

| File | Purpose |
|---|---|
| `distill.py` | entrypoint; `--smoke` validates on CPU |
| `requirements.txt` | pinned dependencies for the GPU target |
| `job.yml` | Azure ML job - `az ml job create -f job.yml` |
| `job.yaml` | Vertex AI CustomJob - `gcloud ai custom-jobs create --config=job.yaml` |
