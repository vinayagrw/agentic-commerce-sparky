# Token optimisation (Phase 2)

Measured with `scripts/token_bench.ts` (`make token-bench LABEL=…`) against the live stack: one fixed
session of **10 shopper turns** (the coffee + #4 cone filters headline beat and nine follow-on turns, HITL on,
every proposal approved, plus the follow-up-chip call the chat makes after each turn) and **5 Ops Copilot
prompts** (read-only / propose-only; `data/registry.json` and `data/ops.db` are backed up and restored).
Tokens and cost are the CLI's own `result` usage, one line per model call in `data/token_ledger.jsonl`.
First-token latency is client-side, POST to first `TEXT_MESSAGE_CONTENT`.

> [!IMPORTANT]
> **n is small.** Each arm is ONE live run: n = 10 shopper turns / 5 ops turns (37–44 model calls). Latency
> p50s move by several seconds between identical runs (compare `after_v1` and `after` below). Treat the cost
> and output-token changes as the robust result, the latency changes as indicative.

## Before / after

| Plane | Arm | Model calls | Input tokens (all) | Cache read | Cache hit | Output tokens | Cost (USD) | First token p50 | Turn p50 | Correctness | n |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Shopper | before | 44 | 172,417 | 101,839 | 59.1% | 69,718 | 0.6345 | 20.5 s | 45.3 s | 14/14 | 10 turns |
| Shopper | after_v1 | 40 | 149,575 | 85,602 | 57.2% | 11,960 | 0.2933 | 8.0 s | 23.3 s | 14/14 | 10 turns |
| Shopper | **after** | 37 | 126,757 | 69,317 | 54.7% | 11,005 | **0.2649 (−58%)** | 12.2 s | 22.4 s | 14/14 | 10 turns |
| Ops | before | 5 | 74,947 | 42,047 | 56.1% | 3,003 | 0.1700 | 3.6 s | 12.0 s | 5/5 | 5 turns |
| Ops | **after** | 5 | 64,887 | 38,823 | 59.8% | 2,740 | **0.1394 (−18%)** | 3.1 s | 10.4 s | 5/5 | 5 turns |

Raw: `docs/evidence/token_bench_before.json`, `token_bench_after_v1.json`, `token_bench_after.json` (+ `.log`).
`after_v1` is the first pass; `after` adds the deterministic $-figure check to the Critic gate. The
coverage block is `data/coverage.json` → `token_optimisation`.

## Where the saving came from (shopper, by role)

| Role | Calls before → after | Output tokens before → after | Cost before → after | Attributable to |
|---|---|---|---|---|
| Planner (haiku) | 10 → 5 | 13,724 → 742 | $0.0727 → $0.0056 | **router** (5 simple turns skip it) + **thinking off** (−95% output on the calls that remain) |
| Critic (haiku) | 10 → 7 | 20,322 → 1,081 | $0.1106 → $0.0114 | **thinking off** (most of it) + **critic gate** (3 calls skipped) |
| Follow-ups (haiku) | 10 → 10 | 26,880 → 675 | $0.1416 → $0.0102 | **thinking off** (the response cache did not hit: every bench turn is a new input) |
| Shopper (sonnet; haiku for show-cart/help) | 9 → 9 | 6,568 → 6,290 | $0.2423 → $0.1792 | **router** (cheap model on the 3 show-cart/help turns, narrowed tool lists) + **prompt diet** (cart summary, trimmed tool results) |
| Checkout (sonnet) | 1 → 1 | 927 → 673 | $0.0342 → $0.0170 | **prompt diet** |
| Shopper revision (sonnet) | 4 → 5 | 1,297 → 1,544 | $0.0332 → $0.0414 | cost went **up**: see "weaker than planned" |

Latency: the run start used to spend ~7 s in the health gate (`claude --version` + `uv --version` spawned on every run).
Those binary probes are now cached for 5 min once they succeed; the service health checks still run live every turn.
Together with skipping the Planner on simple turns this is most of the first-token drop.

## The optimisations

| # | Optimisation | Where | Switch |
|---|---|---|---|
| 1 | Rules-first intent router: add / remove / show cart / compare / help skip the LLM Planner; show cart + help run on haiku; help starts no MCP server | `bff/src/agents/intent.ts`, `agui/bridge.ts` | `OPT_ROUTER=0` |
| 2 | Critic only when the cart changed, the answer makes dietary / budget / sponsored claims, or quotes a $ figure that is not a cart price, line total, total or budget | `intent.ts criticNeeded` | `OPT_CRITIC_GATE=0` |
| 3 | Per-intent MCP tool allow-lists: policy-mcp registers only the intent's tools (`POLICY_TOOLS_ALLOW`, can only narrow a role) so other schemas never enter the prompt | `agents/mcpConfig.ts`, `policy-mcp policy.tools_for` | via router |
| 4 | Prompt diet: cart summary (id, qty, price, short title, total) and `key=value(status)` ledger instead of JSON; compact ops approvals; tool results trimmed to the fields answers and cards use (`POLICY_TRIM=1`) | `agents/prompt.ts`, `ops/prompt.ts`, `policy-mcp forward.trim_result` | `OPT_DIET=0` |
| 5 | Stable cache prefix: byte-identical `--system-prompt`, policy-mcp tool list in fixed order, session-stable prompt lines first, volatile state and the question last | `agents/prompt.ts buildPrompt` | always on |
| 6 | Model right-sizing: haiku for follow-ups, Critic, Planner and simple intents; **no extended thinking** (`MAX_THINKING_TOKENS=0`) for the short JSON roles (Planner, Critic, follow-ups, CaMeL planner/extractor) | `llm/claudeCode.ts thinking`, callers | `OPT_THINKING_OFF=0` |
| 7 | Per-session budget with graceful degradation: from 80% of `SESSION_COST_BUDGET_USD` (default $3) economy mode (haiku, rules-based planner and critic) with a visible notice; at 100% new agent runs pause with a message, the store keeps working | `agents/budget.ts`, `bridge.ts`, chat `budget-notice` | `SESSION_COST_BUDGET_USD` |
| 8 | Response cache by input hash + TTL: follow-ups (10 min), starters (5 min), compare (60 s); hits are labelled `cached` with their age | `lib/ttlCache.ts`, `assist/routes.ts` | `OPT_CACHE=0` |
| 9 | Dead ops-mcp config writer (`writeOpsMcpConfig`, `OPS_TOOLS`, `opsMcpAvailable`) deleted; the CLI only ever gets policy-mcp | `bff/src/ops/prompt.ts` | – |

No optimisation was backed off: every correctness check (14 shopper, 5 ops) passed before and after.

## Weaker than planned (read before quoting numbers)

- **Cache hit ratio did not rise on the shopper plane** (59.1% → 54.7%). Absolute cache reads fell with the smaller
  prompts, and the new haiku Shopper calls (show cart, help) and all Planner/Critic prompts are below the minimum
  cacheable prompt length, so they are uncached by construction. Ops rose 56.1% → 59.8%. The stable-prefix
  reordering is in place but its effect is not separable at this n.
- **Critic revisions went up** (4 → 5 revised answers) while Critic calls went down (10 → 7): without extended
  thinking the haiku Critic rejects a larger share of drafts (5 of 7). The correctness checks still pass and every
  rejected draft stays visible as superseded, but this is the first thing to re-measure with a larger n; if the
  false-reject rate holds, give the Critic thinking back (`OPT_THINKING_OFF` is global today) before shipping.
- **The response cache is not exercised by the bench** (no repeated inputs), so its saving is 0 here; it is covered by
  unit tests only.
- **Per-optimisation isolation** (one bench per `OPT_*` switch) was not run; the by-role table attributes by which
  role's tokens moved, which is exact for thinking-off and the Planner skip but mixes router and diet on the Shopper.
- One run per arm; latency p50 is noisy (after_v1 8.0 s vs after 12.2 s first-token on identical code paths except the gate).
