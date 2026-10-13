# Technique 25. Prefill/decode disaggregation + KV tiering

> **Status: script ready - NOT EXECUTED ON THIS MACHINE.**
> This needs at least two GPU pools plus an RDMA-capable interconnect. `--smoke` reports `rdma_available: False` on this host, which is why the script refuses to start.
> Nothing in this directory reports a measured result for a production retailer's model. Every quantitative
> claim below is either arithmetic shown in full, or a published figure with its citation.

## What it does

Brings up a vLLM prefill worker (`kv_role: kv_producer`) and a decode worker
(`kv_role: kv_consumer`) joined by the NIXL/LMCache KV connector, with `lmcache.yaml` defining
the GPU -> CPU RAM -> NVMe -> Redis KV tier for returning-session reuse.

Adoption conditions are enforced as code:
* **Workload qualification (step 1).** `--qualify` measures the real prompt token count with the
  target tokenizer and computes the prompt:output ratio at turn 1 and turn N. Below the
  threshold it returns "PD would be a net loss". Prompt tokens are measured; output length and
  per-turn context growth are explicitly OPERATOR INPUTS and labelled as such in the output.
* **Interconnect (AC2).** `--check-interconnect` looks for RDMA devices and refuses to start
  without them; PD over TCP is a trap.
* **Fallback (AC3).** The proxy falls back to aggregated serving on a prefill error.

## Run it

```bash
# CPU validation - config, data loading and shapes. Never trains. Runs on a laptop.
python run_pd.py --smoke
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
  --display-name=sota-25-pd-disaggregation \
  --config=job.yaml
```

`job.yaml` pins the machine type `a3-highgpu-8g` with 16x `NVIDIA_H100_80GB` and the GCS paths for data and outputs.

## GPU SKU

2x 8-GPU H100 80GB nodes with RDMA (Azure ND96isr_H100_v5 InfiniBand / GCP a3-highgpu-8g GPUDirect-RDMA): 1 prefill pool + 1 decode pool

## Cost estimate

GPU-hours are derived and shown; the **hourly rate is an input you supply from the live
pricing page**, because quoting a rate from memory would be a fabricated number.

```
GPU-hours   = 128
              (playbook §25 Cost and effort: "L. 8-12 weeks incl. RDMA capacity, tuning and failure-mode testing." a replayed-peak load-test campaign of 16 GPUs x 8 h)

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

Expect roughly 1.5-2x goodput under SLOs **for long-prompt workloads**, and expect a net
loss on short prompts - the split only pays when prefill genuinely stalls decode. Expect the
adoption gate to be the playbook's own AC1: >=1.5x goodput against an aggregated baseline at the
same TTFT/ITL SLOs on replayed peak traffic, or do not adopt. Expect the real constraints to be
RDMA SKU availability and quota lead time, plus the ops complexity of pinning llm-d/Dynamo/vLLM
versions together. Expect a privacy review: the remote KV tier can hold state derived from
shopper text and needs encryption plus a retention TTL.

**This is an expectation, not a measurement.**

### Citations

DistServe, OSDI 2024, arXiv:2401.09670. Mooncake, FAST 2025, arXiv:2407.00079. LMCache,
arXiv:2510.09665. The ~1.5-2x goodput range for long-prompt workloads is the playbook's §25
summary of that literature; the >=1.5x adoption gate is the playbook's §25 AC1 target.

### Kubernetes
`llm-d-values.yaml` expresses the same topology as an llm-d release. Pin llm-d, vLLM and the
KV connector versions together (§25 Risks: vendor version churn).

## Files

| File | Purpose |
|---|---|
| `run_pd.py` | entrypoint + workload qualifier; `--smoke` validates on CPU |
| `lmcache.yaml` | GPU/CPU/NVMe/Redis KV tier config |
| `llm-d-values.yaml` | the same topology as an llm-d release |
| `requirements.txt` | pinned dependencies for the GPU target |
| `job.yml` | Azure ML job - `az ml job create -f job.yml` |
| `job.yaml` | Vertex AI CustomJob - `gcloud ai custom-jobs create --config=job.yaml` |
