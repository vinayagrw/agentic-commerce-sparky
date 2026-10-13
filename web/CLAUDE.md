# web/ — React 19, Tailwind v4, shadcn, CopilotKit v2 UI

Port 5173. Entry: `src/main.tsx` → `src/router.tsx`.

## Key files (one-line purpose each)
- `src/router.tsx`, `src/routes/` — route table and pages.
- `src/chat/` — shopper chat UI (messages, streaming, followups).
- `src/a2ui/` — renders A2UI surfaces sent from the bff.
- `src/ops/` — ops-plane UI (approvals, audit, gates, finops dashboard).
- `src/coverage/types.ts`, `nameHonesty.ts` — reads `../data/coverage.json` shape; keep in sync if that JSON's schema changes.
- `src/store.ts`, `src/store/` — client state.
- `src/api.ts` — fetch wrappers for bff endpoints (see `docs/CONTRACTS.md`).
- `src/guide/` — the Guide docs portal over `GET /api/guide/features` (docs/features.json) + `GET /api/coverage`. `GuideRoute.tsx` is the shell (sidebar grouped by area with counts, area/maturity/plane chips and search all kept in the URL: `?q=&area=&maturity=&plane=&atlas=`, ↓/↑ walk the results); `guideModel.ts` derives maturity (measured → a real-measured `data/coverage.json` row cites a file this feature names; built → a story names a Playwright spec; synthetic → the feature labels its own data synthetic; proposal → neither), plane/owner route, related features, telemetry span kinds and atlas node↔feature mapping — nothing is invented; `FeaturePage.tsx` (sub-tabs Overview · Stories · Stack & alternatives · Diagram · Try it · Telemetry in `?tab=`, breadcrumbs, prev/next, anchors with copy-link, "not proven" stories); `AreaPage.tsx` (`/guide/area:<Area>` — summary + maturity table); `AtlasView.tsx` (`?atlas=1`, full-screen area diagram with clickable mapped nodes); `MermaidView.tsx` (lazy `mermaid`, zoom/pan/fullscreen); `guide.css` (print stylesheet only). Spec `e2e/guide.spec.ts`.
- Deep-link prefill: `?chat=<prompt>` (shopper/shop; `/shopper/1?layout=site|chat|split` redirects to `/shop?view=`) and `?copilot=<prompt>` (ops, opens the dock) put text in the composer without sending (`src/chat/CompassChat.tsx`). Ops beats are `/ops/1..3` or labels `/ops/8a|8b|8c`.
- `src/components/TraceInspector.tsx` + `src/lib/traceDetail.ts` — the Inspector's Trace tab as an LLM observability panel (turn header, generations with Prompt/Output/Tokens/Metadata tabs, tool + retrieval/policy/HITL/verifier rows, capture toggle) over `GET /api/traces/run/:runId?detail=full`. `src/components/TokenStrip.tsx` is the compact session meter; `src/ops/OpsTokens.tsx` + `src/ops/TokensRoute.tsx` are the full meter at `/ops/tokens` (URL-reflected filters, CSV export, drill-through to a trace) over `GET /api/tokens/{summary,ledger}`. Specs `e2e/inspector-trace.spec.ts` (`@llm`), `e2e/token-meter.spec.ts` (`@nollm`).
- `src/lib/trace.ts` — keeps the CUSTOM `trace` traceId per agent, posts `ui` spans (send→first token, A2UI render, LCP/INP) to `POST /api/traces/web` at run end, reports `layout` in agent state. `src/ops/TraceWaterfall.tsx` + `TracesRoute.tsx` (`/ops/traces`, `/ops/traces/:traceId`) and the Trace tab on `/ops/replay/:runId?tab=trace`; "View trace" (`view-trace`) sits under each chat run timeline. Spec `e2e/tracing.spec.ts`.
- `src/styles/theme.css` — the ONLY source of color/spacing tokens; UI must use these tokens, not ad hoc values (repo rule, axe-checked).
- `e2e/` — Playwright specs; `@nollm` = no live Claude calls, `@llm` = real Claude turns. 139 specs total, 138 passing + 1 flaky (`beat1-headline.spec.ts`, passes on rerun). `e2e/mlops-top10.spec.ts` covers MLO1–MLO10 ops_insight cards (`@llm`, serial); `e2e/ops-copilot-top10.spec.ts` covers OPS1–OPS10.

## Commands
- Dev: `npm run dev --workspace web` (or `make dev`).
- Typecheck/build: `cd web && npx tsc --noEmit` / `npm run build --workspace web`.
- E2E, one spec: `cd web && E2E_BASE_URL=http://localhost:5173 npx playwright test e2e/<spec>.ts`
- E2E, no-LLM only (seconds): `make e2e-fast`. Full suite (`make e2e`) is for phase gates only — don't run it after every small change.
- E2E, named specs only (dot reporter): `make e2e-affected SPECS="beat1-headline ai-hitl"`.

## Contracts
See `../docs/CONTRACTS.md` for stable `data-testid` values, SSE CUSTOM event names the UI listens for, and the endpoint list.

## Don't read whole
- `dist/`, `node_modules/` — build output/deps, never source.
- `../data/coverage.json`, `../data/registry.json` — large generated data; read the `../docs/CONTRACTS.md` summary or grep for the one key you need.
- `../docs/ui/` — screenshot/recording assets (23MB+), not code.
