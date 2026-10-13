# services/ops-mcp — approvals, audit, gates, guardrail watcher, ops copilot

Port 8803 (`ops-http`), or spawned as an MCP server. Python (uv).

## Key files
- `src/ops_mcp/server.py` — MCP tool registration (entry point).
- `src/ops_mcp/http_app.py` — HTTP wrapper (`ops-http`).
- `src/ops_mcp/tools.py`, `copilot.py` — ops tool implementations; `copilot.py` is the OPS1–OPS10 "ops_insight" surface reading `data/token_ledger.jsonl` and `data/agui_runs/`.
- `src/ops_mcp/mlops_top10.py` — the MLO1–MLO10 tools (interleaving, CUPED A/B, skew, lineage, retrain trigger, exposure audit, config registry, SLO budget, golden-set diff, shadow deploy); each writes `../../docs/evidence/mlops_<n>_<slug>.json`, surfaced in `data/coverage.json` → `mlops_top10`. See `../../docs/MLOPS_TOP10_SELECTION.md`.
- `src/ops_mcp/guardrail.py` — guardrail watcher / canary rollback.
- `src/ops_mcp/redteam.py`, `dq.py`, `measure.py` — eval-side checks (red team, data quality, technique measurement).
- `src/ops_mcp/online_eval.py` — reads/writes `data/online_sessions.jsonl`.
- `src/ops_mcp/db.py` — `data/ops.db` access (approvals/audit state).

## Commands
- Run: `SEARCH_SVC_URL=http://127.0.0.1:8801 uv run ops-http` (or `make ops` / `make dev`).
- Tests: `cd services/ops-mcp && uv run pytest -q`.

## Contracts
Tool names/CUSTOM event correlations are in `../../docs/CONTRACTS.md`. Tools are proxied + tier-checked through `services/policy-mcp`.

## Don't read whole
- `.venv/` — never source.
- `../../data/agui_runs/*.jsonl`, `../../data/token_ledger.jsonl` — tail or grep, don't cat.
- Never mutate `data/registry.json` / `data/ops.db` without backing up and restoring after (repo rule).
