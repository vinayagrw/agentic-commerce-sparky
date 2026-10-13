# services/policy-mcp — the CLI's only MCP server, tool tiering/forwarding

No fixed port; the Claude CLI spawns this per run as its ONLY MCP server (`stdio_client.py`). Python (uv).

## Key files
- `src/policy_mcp/server.py` — MCP server entry; registers/exposes only the current role's tools.
- `src/policy_mcp/policy.py` — tier checks (which role may call which tool).
- `src/policy_mcp/forward.py` — forwards allowed calls to shop-mcp / ops-mcp / search-svc.
- `src/policy_mcp/events.py` — writes `data/policy_events.jsonl` (refusals/audit trail); default path resolved relative to repo root.
- `src/policy_mcp/bypass_gate.py` — pre-registered gate bypass path.

## Commands
- Smoke test the tool path: `make policy-smoke` (proves a role only sees its tools and a guard violation is refused).
- Tests: `cd services/policy-mcp && uv run pytest -q`.

## Contracts
See `../../docs/CONTRACTS.md`. This service is the enforcement point — an agent can never approve its own action; ops approvals always go through ops-http. The MLO1–MLO10 tools in `services/ops-mcp/src/ops_mcp/mlops_top10.py` are proxied and tier-checked here the same as OPS1–OPS10.

## Don't read whole
- `.venv/` — never source.
- `../../data/policy_events.jsonl` — grep/tail, it's an append-only log.
