# bff/ — Fastify BFF, AG-UI SSE, CopilotKit runtime

Port 8787. Entry: `src/server.ts` (all HTTP routes registered here).

## Key files (one-line purpose each)
- `src/agui/bridge.ts` — AG-UI SSE event bridge (STATE_SNAPSHOT/DELTA, CUSTOM events). 798 lines: read by line range, see `docs/CONTRACTS.md` for the event contract instead of reading the whole file.
- `src/agui/a2ui.ts` — shopper A2UI surface builders.
- `src/agui/stateReducer.ts`, `threadStore.ts` — shared state reducer + per-thread store.
- `src/agents/{roles,planner,guard,camel,intent,budget}.ts` — Router/Planner/Critic roles, prompt-injection guard, budget checks.
- `src/llm/claudeCode.ts` — `runClaudeCode`, the ONLY place model calls happen (fresh `claude -p` per call, stream-json).
- `src/llm/ledger.ts` — appends one line per model call to `data/token_ledger.jsonl` (now incl. `trace_id`, `span_id`, `intent`, `tool_calls`; older lines lack them and read as null). Never any prompt/output text.
- `src/tokens/query.ts`, `src/tokens/routes.ts` — token meter: mtime-cached ledger read, pure filters/grouping (`query.test.ts`), `GET /api/tokens/{ledger,summary}`.
- `src/trace/detail.ts` — per-call trace detail (generations, tool calls, other kinds) behind `GET /api/traces/run/:runId?detail=full` (`detail.test.ts`).
- `src/otel.ts` — span helpers, `redact()`, `maskText()`/`textAttrs()` and the `TRACE_CAPTURE` switch (prompt/output capture, ON by default, masked + 8 KB cap; see `../docs/TRACING.md`).
- `src/ops/a2uiOps.ts`, `gateConfig.ts`, `finops.ts`, `router.ts` — ops-plane builders/config (approvals, gates, cost, routing).
- `src/replay/eventLog.ts` — reads/writes `data/agui_runs/`.
- `src/policyEvents.ts` — tails `data/policy_events.jsonl` for refusals.
- `src/config.ts` — env-driven paths/ports.
- MLO7 (`prompt_registry_diff` in `services/ops-mcp/src/ops_mcp/mlops_top10.py`) diffs this package's `ops/prompt.ts`, `agents/roles.ts` and `config.ts` against a previous hashed version — don't rename those files without checking that tool.

## Commands
- Dev: `npm run dev --workspace bff` (or `make dev` for the whole stack).
- Typecheck: `cd bff && npx tsc --noEmit`
- Unit tests: `npm run test:unit --workspace bff` (node:test, lists suites in `bff/package.json`).

## Contracts
See `../docs/CONTRACTS.md` for SSE event names, HTTP endpoint list, and which `data/*.json(l)` files are runtime-read (don't delete/deny those).

## Don't read whole
- `src/agui/bridge.ts` (798 lines) — use `sed -n` line ranges or `grep -n`.
- Anything under `../data/` (especially `../data/agui_runs/*.jsonl`, `../data/coverage.json`, `../data/registry.json`) — large generated/data files, not source.
- `*.test.ts` files only when debugging that specific test.
