# Technique 17. Research replication agent

> **Status: script ready - NOT EXECUTED ON THIS MACHINE.**
> This needs an L4 in a network-isolated T1 sandbox with hard budget caps. A laptop has neither the GPU nor the isolation, and running an unbounded agent outside the sandbox is the §17 anti-pattern.
> Nothing in this directory reports a measured result for a production retailer's model. Every quantitative
> claim below is either arithmetic shown in full, or a published figure with its citation.

## What it does

Drives a coding agent inside a budgeted, network-isolated (T1) sandbox to rebuild a
paper's method on **public data only**, then collects the artefacts and a rubric assessment for
a human grader. `task_spec.yaml` carries the paper, the scope, the budget caps, the forbidden
list and a PaperBench-style hierarchical rubric whose weights must sum to 1.0.

The script validates the spec, refuses `--allow-network` at tier T1, materialises the
deliverable skeleton, invokes the agent under a hard wall-clock cap, checks every deliverable
exists, and writes `rubric_self_assessment.json` in which **only mechanically checkable leaves
are auto-scored** - every judgement leaf stays `null` and `aggregate_score` stays `null` until a
human grades it.

## Run it

```bash
# CPU validation - config, data loading and shapes. Never trains. Runs on a laptop.
python replicate.py --smoke
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
  --display-name=sota-17-research-replication-agent \
  --config=job.yaml
```

`job.yaml` pins the machine type `g2-standard-8` with 1x `NVIDIA_L4` and the GCS paths for data and outputs.

## GPU SKU

1x NVIDIA L4 (GCP g2-standard-8) / 1x A10 (Azure Standard_NV36ads_A10_v5) in a T1 sandbox with egress limited to a package mirror

## Cost estimate

GPU-hours are derived and shown; the **hourly rate is an input you supply from the live
pricing page**, because quoting a rate from memory would be a fabricated number.

```
GPU-hours   = 8
              (task_spec.yaml budget.wall_clock_h = 8, gpu {type: L4, count: 1}; usd_hard_cap 150 is the binding cap)

cost_usd    = GPU-hours x R
            = 8 x R

worked example at an ILLUSTRATIVE R = $1/GPU-hr (a round placeholder, NOT a quoted price):
            = 8 x $1 = $8
```

Substitute the real `R` for **L4 / A10** from:
* Azure - <https://azure.microsoft.com/pricing/details/machine-learning/>
* GCP - <https://cloud.google.com/vertex-ai/pricing>

Add storage and egress separately. Spot/low-priority capacity changes `R` substantially.

## Expected result

Expect a scaffold, not a replication. The strongest published evidence is that 2025
frontier agents reached a 21.0% replication score on PaperBench, below the ML PhD baseline, with
the characteristic failure being a plausible method description attached to a codebase that does
not run correctly. Expect most runs to land under the playbook's 0.5 engineer-handoff threshold.
Expect the value to be engineer-hours saved on scaffolding, and expect any agent self-report of
"reproduced" to be treated as unverified until the human grader signs it.

**This is an expectation, not a measurement.**

### Citations

PaperBench, Starace et al. (OpenAI), ICML 2025, arXiv:2504.01848 - best agent 21.0%
replication score. The rubric hierarchy and the 0.3/0.5 decision thresholds follow the
playbook's §17 spec.

### Hard rule
The publishable claim from this technique is a *scaffold quality score*. It is never
"the paper replicates". That is encoded in `task_spec.yaml` under `honesty:`.

## Files

| File | Purpose |
|---|---|
| `replicate.py` | entrypoint; `--smoke` validates on CPU |
| `task_spec.yaml` | paper, budget caps, forbidden list, rubric |
| `requirements.txt` | pinned dependencies for the GPU target |
| `job.yml` | Azure ML job - `az ml job create -f job.yml` |
| `job.yaml` | Vertex AI CustomJob - `gcloud ai custom-jobs create --config=job.yaml` |
