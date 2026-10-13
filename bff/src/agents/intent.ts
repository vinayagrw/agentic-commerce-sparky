/**
 * Rules-first intent router (Phase 2 token optimisation). No model call: a handful of anchored
 * patterns decide whether a turn is SIMPLE (skip the LLM Planner, narrow the tool list, use the cheap
 * model) or needs the full Planner -> Shopper -> Critic pipeline. Anything ambiguous is "complex":
 * the router only ever removes work when it is sure the work is not needed.
 */
export type Intent = "add" | "remove" | "show_cart" | "compare" | "help" | "checkout" | "complex";

export interface Route {
  intent: Intent;
  /** Skip the LLM Planner (a deterministic plan is used). */
  skipPlanner: boolean;
  /** policy-mcp tool allow-list for this turn (null = every tool the role has). */
  tools: string[] | null;
  /** Model for the worker turn: "cheap" (haiku) for simple intents. */
  tier: "cheap" | "default";
  /** Why, for the timeline. */
  reason: string;
}

const MULTI = /\b(and then|then|also|plus|bundle|under \$|budget|for \d+ (people|guests)|recipe|plan|party|night)\b/i;

export function routeIntent(question: string, beat: number): Route {
  const q = question.trim();
  const route = (intent: Intent, tools: string[] | null, tier: Route["tier"], reason: string): Route => ({ intent, skipPlanner: intent !== "complex" && intent !== "checkout", tools, tier, reason });
  if (beat === 4 || /\b(check ?out|mandate|spend cap)\b/i.test(q)) return { intent: "checkout", skipPlanner: false, tools: null, tier: "default", reason: "checkout is T2: full pipeline" };
  if (beat !== 1 && beat !== 2 && beat !== 3) return { intent: "complex", skipPlanner: false, tools: null, tier: "default", reason: `beat ${beat} keeps the full pipeline` };
  if (/^\s*(\/?help\b|what can you do|how do(es)? (this|sparky|you) work)/i.test(q)) return route("help", [], "cheap", "help needs no tools");
  if (/^\s*(show|view|what('?s| is) in|list|open)\b.{0,20}\b(my )?(cart|basket)\b|^\s*(my )?cart\??\s*$/i.test(q) && !MULTI.test(q) && q.length < 90)
    return route("show_cart", ["get_cart"], "cheap", "show cart: get_cart only");
  if (/^\s*(remove|delete|take out|drop)\b/i.test(q) && !MULTI.test(q) && q.length < 120) return route("remove", ["get_cart", "remove_from_cart"], "default", "remove: cart tools only");
  if (/^\s*(compare)\b/i.test(q) && q.length < 160) return route("compare", ["search_products", "compare_products", "get_product"], "default", "compare: search + compare tools");
  if (/^\s*(add|put)\b/i.test(q) && !MULTI.test(q) && q.length < 120) return route("add", ["search_products", "get_product", "check_store_stock", "add_to_cart", "get_cart"], "default", "add: search + cart tools");
  return { intent: "complex", skipPlanner: false, tools: null, tier: "default", reason: "open-ended goal: full pipeline" };
}

/** Run the Critic only when something it checks changed this turn: the cart, or claims in the answer. */
export function criticNeeded(opts: { cartBefore: string; cartAfter: string; answer: string; cartLines: number; beat: number; knownAmounts?: number[] }): { needed: boolean; reason: string } {
  if (opts.beat === 7) return { needed: true, reason: "trust & safety beat" };
  if (opts.cartBefore !== opts.cartAfter) return { needed: true, reason: "cart changed this turn" };
  if (opts.cartLines > 0 && /\b(gluten|vegan|organic|nut[- ]free|dairy|allerg\w*|over (the )?budget|sponsored)\b/i.test(opts.answer))
    return { needed: true, reason: "answer makes dietary/budget/sponsored claims about a non-empty cart" };
  const amounts = [...opts.answer.matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
  if (opts.cartLines > 0 && amounts.length) {
    // Deterministic claim check: every $ figure is a cart price, line total, cart total or the budget -> nothing new to verify.
    const known = opts.knownAmounts ?? [];
    const unknown = amounts.filter((a) => !known.some((k) => Math.abs(k - a) < 0.011));
    if (unknown.length) return { needed: true, reason: `answer quotes $ figures not in the cart (${unknown.slice(0, 3).map((a) => `$${a}`).join(", ")})` };
    return { needed: false, reason: "cart unchanged; every $ figure matches the cart deterministically" };
  }
  return { needed: false, reason: opts.cartLines ? "cart unchanged and no checkable claims" : "no cart and no cart change" };
}

/** $ figures a correct answer may quote about this cart. */
export function cartAmounts(cart: { price?: number | null; qty: number }[], total: number, budget: number | null | undefined): number[] {
  const out = [total];
  for (const l of cart) if (typeof l.price === "number") out.push(l.price, Math.round(l.price * l.qty * 100) / 100);
  if (typeof budget === "number") out.push(budget, Math.round((budget - total) * 100) / 100);
  return out;
}

/** Stable fingerprint of cart contents (ids + qty), for "did the cart change this turn". */
export const cartKey = (cart: { product_id: string; qty: number }[]) => cart.map((l) => `${l.product_id}x${l.qty}`).sort().join(",");
