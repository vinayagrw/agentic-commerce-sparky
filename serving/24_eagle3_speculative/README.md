# Technique 24. EAGLE-3 speculative decoding (vLLM)

> **Status: script ready - NOT EXECUTED ON THIS MACHINE.**
> vLLM has no Apple-silicon GPU backend, so no server can start here.
> Nothing in this directory reports a measured result for a production retailer's model. Every quantitative
> claim below is either arithmetic shown in full, or a published figure with its citation.

## What it does

Serves the Compass answer model with an EAGLE-3 draft head and sweeps
`num_speculative_tokens` against batch size, reading acceptance from the engine's own counters.

Three guards from §24 are implemented rather than described:
* **Draft/target binding (AC1).** `check_draft_binding` hashes both artefacts and BLOCKS a serve
  when `draft.target_digest != target.digest`, so a fine-tune can never ship with a stale draft.
  The guard is exercised on real temporary artefacts in `--smoke`.
* **Greedy equivalence (AC3).** `--verify-equivalence` diffs greedy outputs from a spec endpoint
  and a no-spec endpoint and fails on any mismatch.
* **Acceptance floor (AC2).** The sweep reports mean acceptance length per k against the
  auto-disable threshold (0.45), so the threshold is chosen from measurement.

## Run it

```bash
# CPU validation - config, data loading and shapes. Never trains. Runs on a laptop.
python bench_eagle3.py --smoke
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
cluster once with `vm_size = Standard_ND96isr_H100_v5`.

### GCP Vertex AI

```bash
gcloud ai custom-jobs create \
  --region=us-central1 \
  --display-name=sota-24-eagle3-speculative \
  --config=job.yaml
```

`job.yaml` pins the machine type `a3-highgpu-8g` with 8x `NVIDIA_H100_80GB` and the GCS paths for data and outputs.

## GPU SKU

8x NVIDIA H100 80GB (Azure Standard_ND96isr_H100_v5 / GCP a3-highgpu-8g); the 70B FP8 target uses TP=4, the draft head TP=1

## Cost estimate

GPU-hours are derived and shown; the **hourly rate is an input you supply from the live
pricing page**, because quoting a rate from memory would be a fabricated number.

```
GPU-hours   = 128
              (playbook §24 Cost and effort: "M. 2-4 weeks incl. draft training (few GPU-days) and batch sweeps." draft train 8 GPUs x 12 h = 96, k/batch sweep 8 GPUs x 4 h = 32)

cost_usd    = GPU-hours x R
            = 128 x R

worked example at an ILLUSTRATIVE R = $6/GPU-hr (a round placeholder, NOT a quoted price):
            = 128 x $6 = $768
```

Substitute the real `R` for **H100 80GB** from:
* Azure - <https://azure.microsoft.com/pricing/details/machine-learning/>
* GCP - <https://cloud.google.com/vertex-ai/pricing>

Add storage and egress separately. Spot/low-priority capacity changes `R` substantially.

## Expected result

Expect a meaningful inter-token-latency reduction at low-to-moderate batch and expect the
gain to SHRINK as batch rises - published OSS measurements on H100 show 1.81x throughput at
batch 2 falling to 1.38x at batch 64. Expect the gain to be sensitive to domain shift, so expect
to retrain the draft head after every target fine-tune. Expect output distribution to be
unchanged; if greedy outputs differ, something is wrong, not faster. Do not assume any published
speedup transfers to production retail traffic - that is exactly what the sweep is for.

**This is an expectation, not a measurement.**

### Citations

EAGLE-3, Li et al., NeurIPS 2025, arXiv:2503.01840. The 1.81x @ batch 2 / 1.38x @ batch 64
figures are SGLang project-reported on H100; P-EAGLE's 1.05-1.69x over EAGLE-3 on B200 is
vendor/OSS-reported (vLLM blog, 2026-03-13). All are other people's measurements on other
workloads.

### Auto-disable alert
```yaml
- alert: SpecDecodeLowAcceptance
  expr: |
    sum(rate(vllm:spec_decode_num_accepted_tokens_total[10m]))
      / sum(rate(vllm:spec_decode_num_draft_tokens_total[10m])) < 0.45
  for: 15m
  labels: { action: disable_spec_decode }
```
The 0.45 threshold is the playbook's proposal; replace it with the value your sweep supports.

## Files

| File | Purpose |
|---|---|
| `bench_eagle3.py` | entrypoint + binding guard; `--smoke` validates on CPU |
| `requirements.txt` | pinned dependencies for the GPU target |
| `job.yml` | Azure ML job - `az ml job create -f job.yml` |
| `job.yaml` | Vertex AI CustomJob - `gcloud ai custom-jobs create --config=job.yaml` |
