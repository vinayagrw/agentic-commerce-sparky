# Build token playbook

Why future Claude Code agents in this repo should spend fewer tokens, and how.

## Step 1 challenge outcome

| Fix | Kept / Rejected | Why |
|---|---|---|
| Per-package `CLAUDE.md` (bff, web, 4 services) | Kept | Low risk, high value: an agent scoped to one package no longer needs to re-explore the whole tree; each file is ≤40 lines. |
| `.claude/settings.json` with `permissions.deny` on Read | Kept, narrowed | Denied only confirmed-generated/noisy paths (`node_modules`, `dist`, `.venv`, `__pycache__`, `data/agui_runs/**` per-run logs, `docs/ui`, `docs/recording`, `playwright-report`, `test-results`, lockfile, `*.log`). Verified first that `data/coverage.json` and `data/registry.json` ARE read by application code (`bff/src/server.ts`, `bff/src/ops/*`, `web/src/coverage/*`, `services/search-svc/mlops.py`) — those stay readable, not denied. |
| Quiet test scripts (`scripts/test-quiet.sh` + `make test-quiet`) | Kept | Mechanical, doesn't touch app behavior; collapses 5 verbose test suites into one line each plus first-failure detail only. Also added `make e2e-affected SPECS="..."` (dot reporter, named specs only). |
| Split `docs/FEATURE_CATALOGUE.md` into `docs/features/<area>.md` | Rejected | Only 2 inbound links exist in this repo (`README.md`, `docs/MLOPS_SUMMARY.md`), one of them to a specific anchor (`#81-ops-copilot-top-10-ops1-to-ops10`). The file is 1173 lines with 37 mermaid diagrams — splitting safely means re-deriving every heading anchor and re-validating every diagram, for a payoff (avoiding one large read) that per-package `CLAUDE.md` + `docs/CONTRACTS.md` already deliver by telling agents what to grep for instead of reading the whole file. Rejected as not worth the anchor-breakage risk within scope; the "don't read whole" note in each package's `CLAUDE.md` covers the token-saving intent instead. |
| `docs/CONTRACTS.md` derived from code | Kept | Grepped actual SSE CUSTOM event names, HTTP routes, and `data-testid` values straight from `bff/src` and `web/src` — no invented content. Root and per-package `CLAUDE.md` now point here instead of re-explaining contracts. |

## Agent rules going forward

- One agent per package/phase — don't carry streaming + token-opt + new-features in one session (Wave 8 baseline mixed 3 phases in 504,701 tokens).
- Give each agent an explicit file allow-list scoped to the package(s) it's touching; point it at that package's `CLAUDE.md` first.
- Agent reports ≤300 words.
- Model choice: Sonnet for docs/mechanical work; Haiku for greps/link-checks; reserve Opus for design-heavy code work only.
- Run only the affected e2e specs per change (`make e2e-affected SPECS="..."` or `npx playwright test e2e/<spec>.ts`); run the full suite (`make e2e`) once per wave, at a phase gate, not after every change.
- Read files by line range (`sed -n`, `grep -n`) instead of whole-file, especially `bff/src/agui/bridge.ts` (798 lines) and any file under `data/`.
- Link to `docs/CONTRACTS.md` instead of re-deriving/re-explaining contracts (event names, endpoints, testids) in every prompt.

## Measurement

| Wave | Tokens | Notes |
|---|---|---|
| Wave 8 baseline (engineering) | 504,701 | 3 phases in one session: streaming, token opt, 10 ops features |
| Wave 8 baseline (docs) | 212,416 | |
| Wave 8 baseline (refresh) | 143,519 | |
| Wave 0 storefront | 343,363 | |
| Wave 0b chat | 348,186 | |
| Wave 9 selection agent | 88,148 | Picked and confirmed the MLOps top-10 candidates (`docs/MLOPS_TOP10_SELECTION.md`) against the researched MLOps/Search TDs |
| Wave 9 setup agents | 73,349 + 75,490 = 148,839 | Two setup agents (per-package scoping, evidence/data plumbing) ahead of the build phases |
| Wave 9 build phases 1-5 | 201,000 (200,644 exact) | MLO1-MLO5 implementation + evidence |
| Wave 9 build phases 6-10 | 213,777 | MLO6-MLO10 implementation + evidence |
| Wave 9 build total (phases 1-10) | 414,777 | 200,644 + 213,777 |
| Wave 9 refresh/docs agent (this session) | see report | this agent does not self-measure; token usage is reported by the caller/host, not computed here |
| **Wave 9 total (excl. this refresh)** | **651,764** | 88,148 + 148,839 + 414,777 |

**Tokens per delivered capability, and the apples-to-oranges caveat.**

- Wave 8 baseline mixed three different kinds of work (streaming infra, token-optimisation tuning, 10 new Ops Copilot tools) in one 504,701-token session — no clean per-capability figure exists for it, only the wave total.
- Wave 9's 10 MLOps capabilities cost roughly (201,000 + 213,777) / 10 = **41,478 tokens per capability**, using only the two build phases (not selection/setup, which are one-time front-loaded costs, not per-capability).
- **This is not a fair apples-to-apples efficiency comparison.** The two waves differ in what was built (Ops Copilot read-mostly tools with existing data sources vs MLOps tools that needed new statistical methods — interleaving, CUPED/mSPRT, PSI/KS skew, lineage graph traversal, DAG orchestration, bootstrap CIs — each with its own evidence file and coverage-board wiring), in how the work was split (Wave 8 mixed 3 phases in one session; Wave 9 split selection, setup and 10 build phases across multiple agents per this playbook's "one agent per package/phase" rule), and in what "one capability" means in each case. Read the Wave 9 per-capability number as a rough planning input for future MLOps-shaped work, not as proof Wave 9 was ~12x more efficient than Wave 8 (504,701 / 3 ≈ 168,234 tokens/phase vs 41,478 tokens/capability) — the units being divided are not the same kind of unit.

## Lesson from Wave 9: no delegation chains
Three Sonnet agents handed their whole task to a helper agent instead of doing it. Each hand-off cost about 73k–79k tokens before any work started: setup 73,349 then 75,490; docs refresh 78,723 then 76,390. Every brief must say: **"Do the work yourself. Do not launch sub-agents."** Only the top-level session launches agents.

## Lesson from Wave 11: wall-clock, not just tokens

Wave 11 took 71 + 26 + 14 minutes of agent time plus a 16-minute full suite. Measured on 2026-09-17:

| Run | Time |
|---|---|
| `@nollm` specs, 96 tests, 2 workers | 4.4 min |
| Same at 4 workers | 4.2 min |
| `@llm` specs (real Claude turns) | ~11 min of the 16-minute full run |

Raising workers is nearly useless: the specs share one live stack (cart, `ops.db`, registry), so the config keeps `fullyParallel: false` and files run serially. The time is in the live model turns, not the runner.

**Rules, now enforced by Makefile targets:**
1. **Agents run `make e2e-agent`** (`@nollm` only, dot reporter, its own results dir via `AGENT=<name>`). An agent never runs `@llm` specs, and never the full suite.
2. **The wave owner runs `make e2e-batch` once at the end** (`@llm`, `PW_RETRIES=1`), so a flake reruns itself instead of costing an agent turn. Wave 11 lost several minutes to an agent rerunning one monitored spec five times.
3. **Concurrent agents must not share a results dir.** `E2E_RESULTS` (and `AGENT=`) exists because two Wave 11 agents writing `.e2e-results` produced ENOENT noise and reruns.
4. **One brief, one seam.** The Wave 11 trace brief covered capture, masking, two APIs, a panel rebuild and a dashboard rewrite: 345k tokens and 228 tool calls in one agent. Split backend from UI next time.
5. **Cap reruns at one.** Report a flake; do not chase it.

`PW_WORKERS`, `PW_RETRIES` and `E2E_RESULTS` in `web/playwright.config.ts` exist for these targets; the defaults (2 workers, 0 retries) are unchanged for everything else.
