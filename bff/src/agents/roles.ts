/**
 * Shopper-plane agent roles: Planner -> Shopper -> Critic, with Checkout gated (T2).
 *
 * Each LLM role runs as its own `claude -p` call so each can use its own model
 * (Planner/Critic default to haiku, Shopper to sonnet) with no built-in tools and a short
 * system prompt. Planner and Critic get NO tools at all; only the Shopper (or Checkout in
 * beat 4) is given policy-mcp, in the matching role. The Guard is not an LLM: it is the
 * policy-mcp proxy, which refuses a call before the underlying tool runs.
 */
import type { AgentRole, AgentState, ConstraintEntry, Tier } from "@sparky/shared";
import { config } from "../config.js";

export const ROLE_TIERS: Record<string, Tier> = { Planner: "T1", Shopper: "T1", Critic: "T1", Checkout: "T2", Guard: "—" };

export function rolesFor(beat: number): AgentRole[] {
  const split = config.roleMode === "split";
  const worker = beat === 4 ? "Checkout" : "Shopper";
  return [
    { name: "Planner", tier: "T1", status: "idle", model: split ? config.models.planner : "deterministic" },
    { name: worker, tier: ROLE_TIERS[worker], status: "idle", model: config.models.shopper },
    { name: "Critic", tier: "T1", status: "idle", model: split ? config.models.critic : "deterministic" },
    { name: "Guard", tier: "—", status: "idle", model: "policy-mcp (pre-execution)" },
  ];
}

export const PLANNER_SYSTEM = `You are the Planner in a retail shopping agent team. You have no tools.
Turn the shopper's goal into a short plan and a constraint ledger. Reply with ONLY compact JSON:
{"steps":["..."],"constraints":[{"key":"budget|headcount|dietary|store|other","value":"..."}],"budget":number|null}
At most 5 steps, each under 10 words. Never invent products or prices.`;

export const CRITIC_SYSTEM = `You are the Critic in a retail shopping agent team. You have no tools.
Check the cart against the constraint ledger (budget, dietary, headcount, stock) and the shopper's draft answer.
Flag omissions and violations. Reply with ONLY compact JSON:
{"verdict":"pass"|"fail","issues":["..."],"omissions":["..."],"note":"one sentence for the shopper"}`;

export function plannerPrompt(question: string, state: AgentState): string {
  return `Beat ${state.beat}. Known ledger: ${JSON.stringify(state.constraints)}.\nGoal: ${question}`;
}

export function criticPrompt(question: string, state: AgentState, draft: string): string {
  const cart = state.cart.map((l) => ({ id: l.product_id, title: l.title, qty: l.qty, price: l.price, sponsored: l.sponsored }));
  return [
    `Goal: ${question}`,
    `Ledger: ${JSON.stringify(state.constraints)}`,
    `Budget: ${state.budget ?? "none"}; cart total $${state.cart_total.toFixed(2)}`,
    `Cart: ${JSON.stringify(cart)}`,
    `Guard blocks this run: ${JSON.stringify(state.guard_events.filter((g) => g.severity === "block").map((g) => g.message))}`,
    `Shopper draft answer:\n${draft.slice(0, 2500)}`,
  ].join("\n");
}

/** Pull the first JSON object out of model text (tolerates ```json fences). */
export function parseJsonObject<T = any>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

export interface CriticVerdict {
  verdict: "pass" | "fail";
  issues: string[];
  omissions: string[];
  note: string;
}

/** Deterministic critic: always runs, and is the whole critic in single-role mode. */
export function deterministicCritic(state: AgentState): CriticVerdict {
  const issues: string[] = [];
  if (state.budget != null && state.cart_total > state.budget) issues.push(`Cart $${state.cart_total.toFixed(2)} is over the $${state.budget} budget.`);
  for (const l of state.cart) if (l.qty > 5) issues.push(`${l.title} qty ${l.qty} is above the 5-unit limit.`);
  const diet = state.constraints.find((c) => c.key === "dietary");
  if (diet && state.cart.length && diet.status !== "ok") issues.push(`Dietary constraint "${diet.value}" is not verified for every line.`);
  const sponsored = state.cart.filter((l) => l.sponsored).length;
  const omissions: string[] = [];
  if (sponsored) omissions.push(`${sponsored} cart line(s) are Sponsored listings.`);
  const hardFail = issues.some((i) => /over the|above the/.test(i));
  return { verdict: hardFail ? "fail" : "pass", issues, omissions, note: hardFail ? "Fix the cart before checkout." : issues.length ? "Passes hard limits; see caveats." : "Cart matches the ledger." };
}

export function mergeVerdicts(det: CriticVerdict, llm: Partial<CriticVerdict> | null): CriticVerdict {
  if (!llm) return det;
  const uniq = (a: string[]) => [...new Set(a.filter(Boolean))];
  return {
    verdict: det.verdict === "fail" || llm.verdict === "fail" ? "fail" : "pass",
    issues: uniq([...det.issues, ...(llm.issues ?? [])]).slice(0, 6),
    omissions: uniq([...det.omissions, ...(llm.omissions ?? [])]).slice(0, 6),
    note: llm.note || det.note,
  };
}

export function applyPlannerLedger(state: AgentState, plan: { constraints?: { key: string; value: string }[]; budget?: number | null } | null) {
  if (!plan) return;
  const have = new Set(state.constraints.map((c) => `${c.key}:${c.value}`.toLowerCase()));
  for (const c of plan.constraints ?? []) {
    if (!c?.key || !c?.value) continue;
    if (state.constraints.some((x) => x.key === c.key)) continue;
    if (have.has(`${c.key}:${c.value}`.toLowerCase())) continue;
    state.constraints.push({ key: String(c.key), value: String(c.value), status: "unknown", note: "from Planner" } as ConstraintEntry);
  }
  if (state.budget == null && typeof plan.budget === "number" && plan.budget > 0) state.budget = plan.budget;
}
