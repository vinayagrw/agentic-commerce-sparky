/** Apply a parsed tool result to shared agent state (cart, mandate, ledger, omissions, prices). */
import type { CartLine, ConstraintEntry } from "@sparky/shared";
import type { ThreadCtx } from "./threadStore.js";
import { productsOf } from "./a2ui.js";

export function rememberPrices(ctx: ThreadCtx, data: any) {
  for (const p of productsOf(data)) {
    const price = Number(p?.price ?? p?.offers?.price);
    if (p?.product_id && Number.isFinite(price)) ctx.prices.set(String(p.product_id), { title: String(p.title ?? p.product_id), price, sponsored: Boolean(p.sponsored) });
  }
}

export function applyCart(ctx: ThreadCtx, cart: any) {
  const items: any[] = Array.isArray(cart?.items) ? cart.items : Array.isArray(cart?.lines) ? cart.lines : [];
  ctx.state.cart = items.map<CartLine>((i) => ({
    product_id: String(i.product_id),
    title: String(i.title ?? ctx.prices.get(String(i.product_id))?.title ?? i.product_id),
    qty: Number(i.qty ?? 1),
    price: Number(i.price ?? ctx.prices.get(String(i.product_id))?.price ?? 0),
    sponsored: ctx.prices.get(String(i.product_id))?.sponsored,
  }));
  ctx.state.cart_total = Number(cart?.total ?? ctx.state.cart.reduce((a, l) => a + l.price * l.qty, 0));
  ctx.state.cart_total = Math.round(ctx.state.cart_total * 100) / 100;
  refreshBudgetConstraint(ctx);
}

export function refreshBudgetConstraint(ctx: ThreadCtx) {
  const b = ctx.state.constraints.find((c) => c.key === "budget");
  if (b && ctx.state.budget != null) {
    b.status = ctx.state.cart_total <= ctx.state.budget ? "ok" : "violated";
    b.note = `cart $${ctx.state.cart_total.toFixed(2)}`;
  }
  const d = ctx.state.constraints.find((c) => c.key === "dietary");
  if (d && ctx.state.cart.length) {
    d.status = "unknown";
    d.note = "verify gluten-free labels per line";
  }
}

export function applyToolResult(ctx: ThreadCtx, tool: string, data: any): void {
  if (!data || typeof data !== "object") return;
  rememberPrices(ctx, data);
  if (tool === "search_products" && Array.isArray(data.results)) ctx.lastSearch = data.results;
  if (data.cart) applyCart(ctx, data.cart);
  if (tool === "plan_meal") {
    if (Array.isArray(data.constraint_ledger)) {
      const extra: ConstraintEntry[] = data.constraint_ledger.map((c: any) => ({
        key: String(c.constraint),
        value: String(c.evidence ?? ""),
        status: c.status === "met" ? "ok" : c.status === "violated" ? "violated" : "unknown",
      }));
      const keep = ctx.state.constraints.filter((c) => !extra.some((e) => e.key === c.key));
      ctx.state.constraints = [...keep, ...extra];
    }
    if (Array.isArray(data.omissions)) ctx.state.omissions = data.omissions.map((o: any) => (typeof o === "string" ? o : `${o.ingredient}: ${o.reason}`));
  }
  if (data.mandate && typeof data.mandate === "object") {
    const m = data.mandate;
    ctx.state.mandate = {
      ...m,
      mandate_id: String(m.mandate_id ?? data.mandate_id ?? ""),
      status: /approved/.test(String(data.status)) ? "approved" : /reject/.test(String(data.status)) ? "rejected" : "pending_approval",
      cart_total: Number(m.cart_total ?? m.total ?? ctx.state.cart_total),
      spend_cap: Number(m.spend_cap ?? 0),
      signature: typeof data.signature === "object" ? data.signature?.value : data.signature,
    };
  }
  if (Array.isArray(data.omissions) && tool !== "plan_meal") ctx.state.omissions = data.omissions.map(String);
}
