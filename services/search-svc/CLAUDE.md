# services/search-svc — BM25 + bge-small + RRF + rerank, MLOps endpoints

Port 8801. Python (uv), no package subfolder — files live directly under `src`-less root (`app.py` etc.).

## Key files
- `app.py` — FastAPI entry (`uvicorn app:app`).
- `engine.py` — retrieval pipeline (BM25 + embeddings + RRF fusion + rerank).
- `graph.py` — query/session graph logic.
- `mlops.py` — champion/challenger, canary, NDCG eval endpoints; reads `data/registry.json`, `data/coverage.json`.
- `query_types.py` — query classification.
- `slice_fixes.py` — seasonal/synonym slice remediations (see `docs/MLOPS_SUMMARY.md`).
- `SOTA_MEASURED.json` — output of `scripts/measure_techniques.py` (`make sota`); measured numbers, don't hand-edit.

## Commands
- Run: `uv run uvicorn app:app --host 127.0.0.1 --port 8801` (or `make dev`).
- Tests: `cd services/search-svc && uv run pytest -q`.
- Rebuild the index: `make data` (fetch + build_index + plant_injections).
- SOTA measurement: `make sota`.
- Golden-set regression gate (MLO9): `make eval-ci` (live search-svc, exit 1 if `EVAL_CANDIDATE` newly fails more golden queries than it fixes). `services/ops-mcp/src/ops_mcp/mlops_top10.py` also queries this index for interleaving, skew, exposure, golden-set and shadow-deploy checks (MLO1, MLO3, MLO6, MLO9, MLO10).

## Contracts
See `../../docs/CONTRACTS.md`. `data/coverage.json`/`data/registry.json` are read here AND by web/bff at runtime — never delete, and always back up + restore `data/registry.json` around anything that mutates it.

## Don't read whole
- `.venv/` — never source.
- `../../data/index/`, `../../data/raw/`, `../../data/variants/*/emb.npy` — generated indices/embeddings (gitignored), not source.
