# Technique 23. PagedAttention + automatic prefix caching (vLLM)

> **Status: script ready - NOT EXECUTED ON THIS MACHINE.**
> vLLM has no Apple-silicon GPU backend, so no server can start here.
> Nothing in this directory reports a measured result for a production retailer's model. Every quantitative
> claim below is either arithmetic shown in full, or a published figure with its citation.

## What it does

Emits (and, on a GPU host, launches) the exact `vllm serve` invocation for the Compass
tail-QU rewriter with paged KV, automatic prefix caching, an explicit block size, chunked
prefill, FP8 KV cache and multi-LoRA.

It also implements the CI lint rule §23 US-2 asks for: dynamic fields (query, user id,
timestamp, session, store, cart) must appear **after** the static prefix, because hoisting them
to the front silently destroys cache hits. `--smoke` runs that linter against a good layout and
a deliberately broken one and fails if either verdict is wrong.

## Run it

```bash
# CPU validation - config, data loading and shapes. Never trains. Runs on a laptop.
python serve_prefix_cache.py --smoke
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
cluster once with `vm_size = Standard_NV36ads_A10_v5`.

### GCP Vertex AI

```bash
gcloud ai custom-jobs create \
  --region=us-central1 \
  --display-name=sota-23-prefix-caching \
  --config=job.yaml
```

`job.yaml` pins the machine type `g2-standard-8` with 1x `NVIDIA_L4` and the GCS paths for data and outputs.

## GPU SKU

1x NVIDIA L4 (GCP g2-standard-8) / 1x A10 (Azure Standard_NV36ads_A10_v5) for the 8B FP8 tail-QU rewriter

## Cost estimate

GPU-hours are derived and shown; the **hourly rate is an input you supply from the live
pricing page**, because quoting a rate from memory would be a fabricated number.

```
GPU-hours   = 4
              (playbook §23 Cost and effort: "S. Config + prompt restructuring, 1-2 weeks incl. load tests." 1 GPU x 4 h of load testing)

cost_usd    = GPU-hours x R
            = 4 x R

worked example at an ILLUSTRATIVE R = $1/GPU-hr (a round placeholder, NOT a quoted price):
            = 4 x $1 = $4
```

Substitute the real `R` for **L4 / A10** from:
* Azure - <https://azure.microsoft.com/pricing/details/machine-learning/>
* GCP - <https://cloud.google.com/vertex-ai/pricing>

Add storage and egress separately. Spot/low-priority capacity changes `R` substantially.

## Expected result

Expect large throughput gains over naive serving and a TTFT drop roughly proportional to
the share of prompt tokens that are shared prefix - PagedAttention's published result is 2-4x
throughput over prior systems at the same latency. Expect the gain to be workload-shaped: it
comes from the shared prefix, so it evaporates on unique long documents. Expect prompt-layout
regressions, not engine problems, to be the usual cause of a hit-rate drop, which is why the
lint rule and a hit-rate alert both exist. The playbook's "prefix hit ~95%, p99 fits 60 ms on L4
FP8" for UC1 is marked `[PROPOSAL, benchmark in PoC]` there and is not claimed here.

**This is an expectation, not a measurement.**

### Citations

vLLM PagedAttention, Kwon et al., SOSP 2023, arXiv:2309.06180 - 2-4x throughput against
prior systems. SGLang RadixAttention, NeurIPS 2024, arXiv:2312.07104. Automatic prefix caching
is on by default in the vLLM V1 engine.

### Measuring it
```bash
python ../harness/bench.py --base-url http://localhost:8000 --model /models/qu-rewriter-8b --n 500
```
Read `engine_metrics.prefix_cache_hit_rate` from the output. That is the only hit-rate number
this project should ever quote.

## Files

| File | Purpose |
|---|---|
| `serve_prefix_cache.py` | entrypoint + prompt linter; `--smoke` validates on CPU |
| `requirements.txt` | pinned dependencies for the GPU target |
| `job.yml` | Azure ML job - `az ml job create -f job.yml` |
| `job.yaml` | Vertex AI CustomJob - `gcloud ai custom-jobs create --config=job.yaml` |
