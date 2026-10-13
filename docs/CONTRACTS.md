# Contracts (code-grounded, do not invent)

Derived by grep from actual source. If code changes, update this file and the tests together.
Full narrative context: `bff/src/agui/bridge.ts` header comment (read only the top ~30 lines, not the whole 798-line file).

## AG-UI SSE events (`bff/src/agui/bridge.ts`)

Standard AG-UI types: `STATE_SNAPSHOT` (once at start + once at end), `STATE_DELTA` (JSON-Patch on top-level state keys), `TOOL_CALL_RESULT`.

CUSTOM events (`{ type: "CUSTOM", name, value }`):
| name | value shape | when |
|---|---|---|
| `a2ui` | `{ surfaceId, hint, messages }` | a tool result carries a `ui` hint |
| `role_stream` | `{ role, delta }` | Router/Planner/Critic streaming their own output |
| `role_summary` | `{ role, text }` | a role finishes a step (Router/Planner/Critic) |
| `answer_verdict` | `{ messageIds, verdict: "unchecked"\|"checked"\|"revised", note, issues? }` | verifier + Critic finish checking a draft answer |
| `answer_revised` | `{ messageIds }` | a revised answer replaces a checked one |
| `budget` | budget object | `budget.mode !== "normal"` |
| `trace` | `{ traceId, spanId, runId, replayRunId }` | right after `RUN_STARTED`, when tracing is active (see `docs/TRACING.md`); the web keeps it per run (`web/src/lib/trace.ts`) |

## HTTP endpoints (`bff/src/server.ts`)

Shopper/session: `POST /api/agui`, `POST /api/agui/ops`, `POST /api/agui/stop {threadId}`, `GET /api/threads`, `GET /api/threads/:id/state`, `GET /api/cart/:sid`.
Replay: `GET /api/replay/runs`, `GET /api/replay/runs/:id` (backed by `data/agui_runs/`).
A2UI/HITL: `POST /api/a2ui/action`, `GET /api/mandates/:id`, `POST /api/mandates/:id/:decision`.
Ops: `GET /api/ops/watch`, `GET /api/ops/tokens`, `POST /api/ops/inject-latency`, `POST /api/ops/gate-preregistered`, `GET /api/ops/audit`, `GET /api/ops/registry`, `GET /api/ops/finops`, `GET /api/ops/router`, `GET /api/ops/tracing`, `POST /api/ops/online-evals/export`, `GET /api/ops/online-evals/agreement`.
Tracing (`bff/src/trace/routes.ts`): `POST /api/traces/web` (browser spans, kind `ui`, ≤50 spans / 64 KB), `GET /api/traces?limit=`, `GET /api/traces/:traceId` (span tree + `kind_counts`), `GET /api/traces/run/:runId` (AG-UI or replay run id → trace id; `?detail=full` adds the per-call detail: generations, tool calls, retrieval/policy/hitl/verifier spans), `GET /api/traces/config`, `POST /api/traces/config {file?, capture?}` (localhost only; `capture` is the prompt/output text switch, default on).
Token meter (`bff/src/tokens/routes.ts`): `GET /api/tokens/ledger?from&to&plane&role&model&ok&run_id&intent&min_cost&limit&cursor`, `GET /api/tokens/summary?group_by=role|model|plane|intent|hour` (+ the same filters). Both read `data/token_ledger.jsonl`; no prompt or output text is stored there. `GET /api/replay/runs/:id` also returns `trace_id`; `POST /api/session/:sid/feedback` and `/actions/:aid/:decision` return `trace_id`.
Guide: `GET /api/guide/features` (`docs/features.json`, 503 if missing/malformed; `bff/src/guide/features.ts`; every feature carries `coverage_ids[]` — `#n` integers are `data/coverage.json` `techniques[].id` rows, `"MLOn"` strings are `mlops_top10.rows[].id` rows, sourced from the `**Coverage.**` lines in `docs/FEATURE_CATALOGUE.md` and validated by `make docs-check`; an empty array means no coverage row genuinely measures that feature). `GET /api/guide/spec-results` (`bff/src/guide/specResults.ts`) parses the Playwright JSON report `docs/recording/e2e-results.json` and returns `{timestamp, durationMs, count, tally, specs:[{file, status, tests:[{title, status}]}]}` where status is `passed|failed|flaky|not-run`; a spec file or test title with no row in the report is `not-run` and a file with any not-run test is `not-run` at file level, so nothing is ever assumed passing; 503 (same shape as `/api/guide/features`) if the report is missing or malformed. The report is only rewritten by a Playwright run that does **not** pass `--reporter=` on the CLI (a CLI reporter replaces the config list), i.e. `make e2e` refreshes it and `make e2e-agent` / `e2e-fast` / `e2e-batch` do not — so its `timestamp` may be older than the last run.
Eval/coverage: `GET /api/coverage`, `GET /api/eval/ndcg`, `GET /api/eval/passk`, `GET /api/metrics`, `GET /api/policy/events`.
Misc: `GET /api/health`, `GET /api/diag`, `POST /api/upload`, `GET /api/queries/sample`, `POST /api/route`, `GET /api/agent/feed`, `GET /api/agent/readiness`.

Streaming REST variants (`?stream=1`, SSE `data:{type}`): `/api/session/:sid/followups` (`partial|done|error`), `/api/session/:sid/photo` (`delta|item|done|error`).

## Stable `data-testid` values (67 total in `web/src`; sample — grep for the full list)

`add-to-cart`, `answer-text`, `answer-verdict`, `budget-notice`, `cart-count`, `chat-empty`, `chat-error`, `chat-thread`, `checkout-revalidate`, `citations`, `claim-chip`, `clarify-option`, `clarify-question`, `compare-card`, `constraint-chip`, `could-not-do`, `critic-verdict`, `feedback`, `feedback-saved`, `followup-chip`, `help-answer`, `mandate-signature`, `memory-item`, `msg-assistant`, `msg-user`, `no-payment-note`, `notification`, `open-memory`, `open-watches`, ...

Guide portal / tracing: `guide`, `guide-feature`, `guide-search`, `guide-result-count`, `guide-area`, `guide-area-link`, `guide-area-count`, `guide-filters`, `guide-chip-{area,maturity,plane}`, `guide-clear-filters`, `guide-index-{area,feature,atlas}`, `guide-detail`, `guide-breadcrumbs`, `guide-maturity`, `guide-plane`, `guide-owner-route`, `guide-print`, `guide-tab-{overview,stories,stack,diagram,try,telemetry}`, `guide-panel-*`, `guide-proven-by`, `guide-spec-link`, `guide-unproven-count`, `guide-coverage-rows`, `guide-related`, `guide-related-link`, `guide-prevnext`, `guide-prev`, `guide-next`, `guide-copy-link`, `guide-story`, `guide-story-spec`, `guide-story-unproven`, `stack-{current,alt1,alt2}`, `not-built-label`, `guide-diagram`, `guide-diagram-svg`, `diagram-zoom`, `diagram-zoom-in`, `diagram-zoom-out`, `diagram-fullscreen`, `guide-example`, `guide-run`, `guide-span-kinds`, `guide-span-kind`, `guide-ledger`, `guide-link-traces`, `guide-link-tokens`, `guide-area-page`, `guide-area-table`, `guide-area-row`, `guide-area-tally`, `guide-atlas`, `guide-atlas-toggle`, `guide-atlas-close`, `guide-atlas-jump`, `guide-open-atlas`, `view-trace`, `trace-waterfall`, `trace-span`, `kind-chip`, `kind-count`, `span-panel`, `trace-row`, `trace-list`, `replay-tab-events`, `replay-tab-trace`, `ops-nav-traces`.

Inspector Trace tab: `trace-panel`, `trace-capture-banner`, `trace-capture-toggle`, `trace-turn-header`, `trace-intent`, `trace-verdict`, `trace-tokens-{in,out,cache}`, `trace-cost`, `trace-ttft`, `trace-total-ms`, `trace-route-reason`, `trace-id`, `trace-copy-id`, `trace-view-link`, `trace-span-count`, `trace-generations`, `trace-generation`, `trace-generation-toggle`, `trace-generation-role`, `trace-generation-tokens`, `trace-gen-tab-{prompt,output,tokens,meta}`, `trace-gen-{prompt,tokens,meta}`, `trace-prompt-text`, `trace-system-prompt`, `trace-output-text`, `trace-reasoning-row`, `trace-reasoning-note`, `trace-tool-row`, `trace-tool-args`, `trace-tool-span-link`, `trace-gen-span-link`, `trace-{retrieval,policy,hitl,verifier,error}-row`, `trace-detail-error`.
Token meter: `token-strip`, `token-strip-{in,out,cost,budget,link,degraded}`, `token-meter-page`, `token-filters`, `token-filter-{range,group,plane,role,model,intent,min-cost,errors}`, `token-tiles`, `token-tile-{cost,calls,in,out,cache,p50,p95,errors}`, `token-budget`, `token-budget-note`, `token-chart`, `token-table`, `token-sort-<column>`, `token-row`, `token-drill`, `token-drill-panel`, `token-ledger-line`, `token-line-trace`, `token-export-csv` (plus the existing `ops-tokens`, `ops-tokens-summary`, `ops-tokens-anomalies`).

Get the current full list: `grep -rhoE 'data-testid="[a-zA-Z0-9_-]+"' web/src | sort -u`

## Data files read by application code at runtime (do NOT deny-list, do NOT delete)

- `data/coverage.json`, `data/registry.json` — read by `bff/src/server.ts`, `bff/src/ops/{gateConfig,a2uiOps}.ts`, `web/src/coverage/*`, `services/search-svc/mlops.py`.
- `data/token_ledger.jsonl` — every model call (`bff/src/llm/ledger.ts`), read by the ops-mcp/policy-mcp cost dashboard and by `GET /api/tokens/*` (`bff/src/tokens/query.ts`). Lines now also carry `trace_id`, `span_id`, `intent`, `tool_calls`; lines written before those fields simply lack the keys and every reader treats a missing key as null. Never any prompt or output text.
- `data/policy_events.jsonl`, `data/online_feedback.jsonl` (rows now carry `trace_id` written at capture time by `POST /api/session/:sid/feedback`, null when the turn had no trace; older rows lack the key and readers keep the `run_id` join), `data/online_sessions.jsonl` — read/written by `bff/src/policyEvents.ts`, `bff/src/assist/store.ts`, `services/ops-mcp/.../online_eval.py`.
- `data/traces/YYYY-MM-DD.jsonl` (+ `.1.jsonl` rotation) and `data/traces/runs.jsonl` — span lines written by bff, policy-mcp and search-svc, read by `/api/traces*` and ops-mcp `trace_summary`. Deny-listed for agent Read (large, generated); never delete while the stack runs.
- `data/agui_runs/*.jsonl` — one file per recorded run, read by replay endpoints and ops-mcp's `replay_summary`. Individually generated/noisy; don't read a run file whole unless debugging that specific run (tail it instead).
