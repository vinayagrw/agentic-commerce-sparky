/** Per-session spend budget with graceful degradation (Phase 2). Pure so it is unit-tested. */
export type BudgetMode = "normal" | "economy" | "exhausted";

export function budgetState(spentUsd: number, budgetUsd: number): { mode: BudgetMode; ratio: number; spent_usd: number; budget_usd: number; message: string | null } {
  const ratio = budgetUsd > 0 ? spentUsd / budgetUsd : 0;
  const pct = Math.round(ratio * 100);
  const base = { ratio: Number(ratio.toFixed(3)), spent_usd: Number(spentUsd.toFixed(5)), budget_usd: budgetUsd };
  if (!(budgetUsd > 0)) return { mode: "normal", ...base, message: null };
  if (ratio >= 1 - 1e-9) return { mode: "exhausted", ...base, message: `This session has used its $${budgetUsd.toFixed(2)} model budget ($${spentUsd.toFixed(2)}). New agent runs are paused; the store, cart and checkout still work without the agent.` };
  if (ratio >= 0.8 - 1e-9) return { mode: "economy", ...base, message: `Economy mode: ${pct}% of this session's $${budgetUsd.toFixed(2)} model budget is used, so Compass now answers with the smaller model and a rules-based planner and critic.` };
  return { mode: "normal", ...base, message: null };
}
