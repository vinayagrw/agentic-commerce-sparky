# Compass — map for Claude Code

Pre-sales demo: agentic shopping + agent-run MLOps on one AG-UI / A2UI stack. **Live-only**: no mocks shown as live,
no invented numbers. New measured numbers go to `data/coverage.json` via `scripts/coverage_extras.py` → `build_coverage.py`, always with n.

## Services and ports
| Service | Port | Code |
|---|---|---|
| web (React 19, Tailwind v4, shadcn, CopilotKit v2 UI) | 5173 | `web/src` |
| bff (Fastify, AG-UI SSE, CopilotKit runtime, A2UI builders) | 8787 | `bff/src` |
| search-svc (BM25 + bge-small + RRF + rerank, MLOps endpoints) | 8801 | `services/search-svc` |
| shop-http / shop-mcp | 8802 | `services/shop-mcp` |
| ops-http / ops-mcp (approvals, audit, gates, guardrail watcher) | 8803 | `services/ops-mcp` |
| policy-mcp (no port; spawned per CLI run, the CLI's ONLY MCP server) | – | `services/policy-mcp` |

## Commands
- `make dev` — whole stack (run it in the background, never foreground). bff/web hot-reload: **editing bff/web src restarts runs in flight.**
- Unit: `npm run test:unit` (bff, node:test) · `cd services/<svc> && uv run pytest -q`
- Typecheck: `cd bff && npx tsc --noEmit` · `cd web && npx tsc --noEmit`
- E2E (live stack): `make e2e-fast` (`@nollm`, seconds) · `make e2e-llm` (`@llm`, real Claude turns, minutes, costs money) · `make e2e-smoke-haiku` (`@llm` with `E2E_MODEL=haiku`, labelled haiku smoke — not the demo configuration)
- Token bench: `npx tsx scripts/token_bench.ts --label <name>` → `docs/evidence/token_bench_<name>.json`

**Run only the affected specs**: `cd web && E2E_BASE_URL=http://localhost:5173 npx playwright test e2e/<spec>.ts`. The full suite is for phase gates.

## Per-package maps (read the one you're working in, not this whole tree)
`bff/CLAUDE.md` · `web/CLAUDE.md` · `services/ops-mcp/CLAUDE.md` · `services/policy-mcp/CLAUDE.md` · `services/search-svc/CLAUDE.md` · `services/shop-mcp/CLAUDE.md`

## Contracts (change deliberately, update tests)
Code-grounded SSE event names, HTTP endpoints, `data-testid` values, and which `data/*.json(l)` files are runtime-read: **`docs/CONTRACTS.md`**. Don't re-derive these by hand — link to that file instead of re-explaining contracts in every prompt.

## Rules
- Theme tokens only (`web/src/styles/theme.css`), axe clean (`e2e/a11y.spec.ts`).
- Never change the model registry permanently: back up/restore `data/registry.json` and `data/ops.db` around anything that mutates them.
- Keep new files inside this repository; nothing here should write to a path outside it.
