# `serving/` - vLLM serving techniques that need GPUs we do not have here

vLLM has no Apple-silicon GPU backend, so nothing in this directory has been executed on this
machine and nothing here reports a serving measurement. Status for all of it is
**"script ready - not executed on this machine"**, indexed alongside the training techniques in
[`../training/NOT_RUN_HERE.json`](../training/NOT_RUN_HERE.json).

## Contents

| Dir | Technique | Entrypoint | GPU |
|---|---|---|---|
| [`harness/`](harness/) | Benchmark harness shared by 23/24/25 | `bench.py` | none (CPU client) |
| [`23_prefix_caching/`](23_prefix_caching/) | PagedAttention + automatic prefix caching | `serve_prefix_cache.py` | 1x L4 / A10 |
| [`24_eagle3_speculative/`](24_eagle3_speculative/) | EAGLE-3 speculative decoding | `bench_eagle3.py` | 8x H100 80GB |
| [`25_pd_disaggregation/`](25_pd_disaggregation/) | Prefill/decode disaggregation + KV tiering | `run_pd.py` | 2x 8-GPU H100 nodes, RDMA |

## One measurement path

`harness/bench.py` is the only place a serving number in this project is allowed to originate.
It drives a live OpenAI-compatible vLLM endpoint and takes the engine-side figures - prefix
cache hit rate, speculative acceptance, KV usage - from vLLM's own Prometheus counters as
**deltas across the run**. Anything the engine did not export is returned as `null` with a
reason string. It never estimates.

The three technique scripts deliberately publish no performance numbers of their own. What they
do publish is *structure*: the shared-prefix token count, the KV block count, the prompt:output
ratio - facts about the prompt and the workload that are computed, not guessed, and are labelled
as ceilings or inputs rather than results.

## Guards implemented as code, not prose

Each script enforces the adoption condition its playbook section names, and each guard is
exercised in `--smoke`:

* **23** - a prompt linter fails when a dynamic field (query, user, timestamp, session, store,
  cart) appears before the static prefix, which is what silently collapses cache hits.
* **24** - a draft/target digest guard blocks serving a stale EAGLE-3 head after a target
  fine-tune, and `--verify-equivalence` fails on any greedy-output mismatch.
* **25** - a workload qualifier refuses to recommend the split when the prompt:output ratio is
  too low, and an interconnect check refuses to start without RDMA.

## Run the smoke tests

```bash
cd services/search-svc
for f in ../../serving/*/[a-z]*.py; do uv run --no-sync python "$f" --smoke; done
```

These are CPU-only and take seconds. They load the project's real ESCI data, build the actual
workload, and unit-test the Prometheus parser against a recorded exposition string.
