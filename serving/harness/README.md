# Serving harness. Serving benchmark harness (shared by 23/24/25)

> **Status: script ready - NOT EXECUTED ON THIS MACHINE.**
> It is CPU-only and would run fine here, but there is no vLLM endpoint on this machine to measure, so no serving number has been produced.
> Nothing in this directory reports a measured result for a production retailer's model. Every quantitative
> claim below is either arithmetic shown in full, or a published figure with its citation.

## What it does

The measurement layer for techniques 23, 24 and 25. It builds a real Compass workload from
this repo's ESCI data - a long static system prefix (instructions + attribute schema + locale
few-shots taken from actual catalogue rows) followed by a short per-request query - drives an
OpenAI-compatible vLLM endpoint with streaming, and records TTFT, inter-token latency and
end-to-end latency per request.

Engine-side numbers are scraped from vLLM's own Prometheus `/metrics` before and after the run
and reported as counter **deltas**, so prefix-cache hit rate and speculative acceptance come
from the engine, not from inference. Any metric the engine did not export comes back as `null`
with a reason string. The harness emits no estimated numbers.

## Run it

```bash
# CPU validation - config, data loading and shapes. Never trains. Runs on a laptop.
python bench.py --smoke
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
cluster once with `vm_size = Standard_D8s_v5`.

### GCP Vertex AI

```bash
gcloud ai custom-jobs create \
  --region=us-central1 \
  --display-name=sota-harness \
  --config=job.yaml
```

`job.yaml` pins the machine type `n2-standard-8` and the GCS paths for data and outputs.

## GPU SKU

none - CPU load-generator client; it runs beside the endpoint under test

## Cost estimate

**No GPU cost.** This is a CPU-only load-generator client; it adds one small VM (Azure `Standard_D8s_v5` / GCP `n2-standard-8`) for the duration of a load test. The GPU cost belongs to the endpoint under test (see 23/24/25).

## Expected result

Expect the harness to be the single place a serving number is allowed to originate in
this project. Expect the structural prefix ratio it reports in `--smoke`
(shared prefix tokens / (prefix + query tokens)) to be a **ceiling** on prefix reuse for this
prompt layout, never a cache hit rate - the hit rate is only ever read from
`vllm:prefix_cache_hits / vllm:prefix_cache_queries`.

**This is an expectation, not a measurement.**

### Citations

vLLM Prometheus metric names checked against vLLM stable docs; the parser is unit-tested
in `--smoke` against a recorded exposition string.

## Files

| File | Purpose |
|---|---|
| `bench.py` | the harness; `--smoke` unit-tests the metric parser |
| `requirements.txt` | pinned dependencies for the GPU target |
| `job.yml` | Azure ML job - `az ml job create -f job.yml` |
| `job.yaml` | Vertex AI CustomJob - `gcloud ai custom-jobs create --config=job.yaml` |
