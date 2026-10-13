/** Deterministic planner + constraint-ledger extraction shown as live state. */
import type { ConstraintEntry, PlanStep } from "@sparky/shared";

interface StepDef {
  label: string;
  tools: RegExp;
}

const PLANS: Record<number, StepDef[]> = {
  1: [
    { label: "Parse goal into constraints", tools: /^$/ },
    { label: "Search each ingredient (hybrid)", tools: /search_products|get_product/ },
    { label: "Check stock at the store", tools: /check_store_stock/ },
    { label: "Add items within budget", tools: /add_to_cart/ },
    { label: "Review cart and flag omissions", tools: /get_cart/ },
  ],
  2: [
    { label: "Retrieve candidates", tools: /search_products/ },
    { label: "Compare with score breakdown", tools: /compare/ },
    { label: "Label sponsored vs organic", tools: /sponsored_slots/ },
  ],
  3: [
    { label: "Detect out-of-stock line", tools: /check_store_stock|get_cart/ },
    { label: "Rank substitutes", tools: /find_substitutes/ },
    { label: "Wait for human accept / reject", tools: /add_to_cart/ },
  ],
  4: [
    { label: "Price the cart", tools: /get_cart/ },
    { label: "Create spend mandate (no payment)", tools: /create_checkout_mandate/ },
    { label: "Wait for human approval", tools: /approve/ },
  ],
  5: [
    { label: "Agent presents signed identity", tools: /agent_feed|feed/ },
    { label: "Verify signature and tier", tools: /verify/ },
    { label: "Serve structured catalog", tools: /search_products/ },
  ],
  6: [
    { label: "Understand the request (photo / voice / text)", tools: /Read/ },
    { label: "Hybrid search + optional reasoning rerank", tools: /search_products/ },
    { label: "Compose storefront surface", tools: /storefront|plan_meals/ },
  ],
  7: [
    { label: "Fetch seller listing (untrusted)", tools: /get_product/ },
    { label: "Quarantine untrusted content", tools: /^$/ },
    { label: "Gate cart actions", tools: /add_to_cart/ },
  ],
  8: [
    { label: "Collect trace, tokens, cost", tools: /^$/ },
    { label: "Run evals: NDCG@10, pass^k", tools: /eval/ },
    { label: "Apply release gates", tools: /^$/ },
  ],
};

export function planFor(beat: number): PlanStep[] {
  return (PLANS[beat] ?? PLANS[1]).map((s, i) => ({ id: `s${i + 1}`, label: s.label, status: i === 0 ? "done" : "pending" }));
}

/** Advance plan status when a tool is used. Returns true if anything changed. */
export function advancePlan(beat: number, plan: PlanStep[], tool: string): boolean {
  const defs = PLANS[beat] ?? PLANS[1];
  const idx = defs.findIndex((d) => d.tools.source !== "^$" && d.tools.test(tool));
  if (idx < 0) return false;
  let changed = false;
  plan.forEach((s, i) => {
    const next = i < idx ? "done" : i === idx ? "running" : s.status;
    if (i <= idx && s.status !== next && s.status !== "done") {
      s.status = next;
      changed = true;
    }
  });
  return changed;
}

export function finishPlan(plan: PlanStep[]) {
  for (const s of plan) if (s.status === "running") s.status = "done";
}

export function constraintsFrom(text: string, prev: ConstraintEntry[]): { constraints: ConstraintEntry[]; budget: number | null } {
  const map = new Map(prev.map((c) => [c.key, c]));
  // "under $20", "budget of $20" and "my budget is $20" all set the ledger budget, which
  // the guard then enforces: a prompt that states a budget must never run without one.
  const budget =
    text.match(/(?:under|below|max(?:imum)?|cap(?: of)?|budget(?:\s+(?:of|is))?)\s*\$?\s*(\d+(?:\.\d+)?)/i) ??
    text.match(/\$(\d+(?:\.\d+)?)\s*(?:spend )?cap/i);
  if (budget) map.set("budget", { key: "budget", value: `≤ $${budget[1]}`, status: "unknown" });
  const people = text.match(/for\s+(\d+)\b/i);
  if (people) map.set("headcount", { key: "headcount", value: `${people[1]} people`, status: "ok" });
  if (/gluten[- ]?free|\bgf\b/i.test(text)) map.set("dietary", { key: "dietary", value: "gluten-free option required", status: "unknown" });
  if (/vegan/i.test(text)) map.set("dietary_vegan", { key: "dietary", value: "vegan", status: "unknown" });
  const store = text.match(/store\s*#?\s*(\d{4})/i);
  if (store) map.set("store", { key: "store", value: `pickup at ${store[1]}`, status: "unknown" });
  const all = [...map.values()];
  const b = all.find((c) => c.key === "budget");
  return { constraints: all, budget: b ? Number(b.value.replace(/[^\d.]/g, "")) : null };
}
