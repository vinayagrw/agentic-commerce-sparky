import { homedir } from "node:os";
import { join, resolve, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

// Gotcha (trust-graph RUNBOOK): the claude CLI lives in ~/.local/bin, and a BFF
// started from a shell without it on PATH silently falls back. Prepend idempotently.
const userBin = join(homedir(), ".local", "bin");
const parts = (process.env.PATH ?? "").split(delimiter);
if (!parts.includes(userBin)) process.env.PATH = [userBin, ...parts].join(delimiter);

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "../..");

export const config = {
  port: Number(process.env.BFF_PORT ?? 8787),
  corsOrigin: process.env.CORS_ORIGIN ?? true,
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  model: process.env.AGENT_MODEL ?? "sonnet",
  /** Per-role models (Planner/Critic are cheap; Shopper does the tool work). */
  models: {
    planner: process.env.PLANNER_MODEL ?? "haiku",
    shopper: process.env.SHOPPER_MODEL ?? process.env.AGENT_MODEL ?? "sonnet",
    critic: process.env.CRITIC_MODEL ?? "haiku",
    ops: process.env.OPS_MODEL ?? process.env.AGENT_MODEL ?? "sonnet",
  },
  /** "split" = Planner -> Shopper -> Critic as three CLI runs; "single" = Shopper only (deterministic planner/critic). */
  roleMode: (process.env.ROLE_MODE ?? "split") as "split" | "single",
  /** Lean CLI flags (no user settings/plugins/skills/session files). Set LEAN_CLI=0 to disable. */
  leanCli: process.env.LEAN_CLI !== "0",
  maxTurns: Number(process.env.AGENT_MAX_TURNS ?? 16),
  idleTimeoutMs: Number(process.env.AGENT_IDLE_TIMEOUT_MS ?? 90_000),
  hardTimeoutMs: Number(process.env.AGENT_HARD_TIMEOUT_MS ?? 240_000),
  searchSvcUrl: (process.env.SEARCH_SVC_URL ?? "http://127.0.0.1:8801").replace(/\/$/, ""),
  shopHttpUrl: (process.env.SHOP_HTTP_URL ?? "http://127.0.0.1:8802").replace(/\/$/, ""),
  shopMcpDir: process.env.SHOP_MCP_DIR ?? join(ROOT, "services", "shop-mcp"),
  opsMcpDir: process.env.OPS_MCP_DIR ?? join(ROOT, "services", "ops-mcp"),
  /**
   * The ONLY MCP server the Claude CLI is ever given. It proxies shop-mcp and ops-mcp
   * and enforces the capability + guard policy before forwarding, so a blocked call
   * never reaches the underlying tool (see services/policy-mcp/README.md).
   */
  policyMcpDir: process.env.POLICY_MCP_DIR ?? join(ROOT, "services", "policy-mcp"),
  opsHttpUrl: (process.env.OPS_HTTP_URL ?? "http://127.0.0.1:8803").replace(/\/$/, ""),
  uploadsDir: process.env.UPLOADS_DIR ?? join(ROOT, "data", "uploads"),
  /**
   * Phase 2 token optimisations, each switchable so its contribution can be measured (OPT_<NAME>=0 disables).
   * router: rules-first intent router (skip Planner, narrow tools, cheap model for simple intents)
   * criticGate: Critic only when the cart or checkable claims changed
   * thinkingOff: no extended thinking for Planner / Critic / follow-ups / CaMeL (short JSON roles)
   * diet: cart summary + compact ledger in prompts, trimmed tool results
   * cache: follow-up / starter / compare response cache
   */
  optimise: {
    router: process.env.OPT_ROUTER !== "0",
    criticGate: process.env.OPT_CRITIC_GATE !== "0",
    thinkingOff: process.env.OPT_THINKING_OFF !== "0",
    diet: process.env.OPT_DIET !== "0",
    cache: process.env.OPT_CACHE !== "0",
  },
  /** Per-session model spend budget (USD). Economy mode from 80%, runs refused at 100%. */
  sessionCostBudgetUsd: Number(process.env.SESSION_COST_BUDGET_USD ?? 3),
  /** policy-mcp appends one JSON object per policy decision here; the BFF reads it into the trace. */
  policyEventsPath: process.env.POLICY_EVENTS_PATH ?? join(ROOT, "data", "policy_events.jsonl"),
};
