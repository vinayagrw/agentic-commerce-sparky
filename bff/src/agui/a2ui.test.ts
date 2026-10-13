import { test } from "node:test";
import assert from "node:assert/strict";
import type { A2uiComponent, UiHint } from "@sparky/shared";
import { buildA2ui, hintOf, emojiFor } from "./a2ui.js";

const products = [
  { product_id: "W-900002", title: "Casa Rosa Gluten Free Cassava Flour Tortillas 8 ct", price: 4.98, rating: 4.4, sponsored: true, dietary: ["gluten_free"], pt: "Tortillas", stock: { "4108": 33 }, scores: { bm25: 1, rrf: 0.016, rerank: 0.9 } },
  { product_id: "W-900005", title: "HomeValue Medium Chunky Salsa 16 oz", price: 1.98, pt: "Salsa", stock: { "4108": 0 } },
];

const ALLOWED = new Set(["List", "Card", "Column", "Row", "Image", "Text", "Button"]);

function checkSurface(hint: UiHint, data: any) {
  const msgs = buildA2ui(hint, data, `s-${hint}`);
  assert.equal(msgs.length, 3);
  assert.ok("createSurface" in msgs[0]);
  assert.ok("updateComponents" in msgs[1]);
  assert.ok("updateDataModel" in msgs[2]);
  for (const m of msgs) assert.equal(m.version, "v0.9");
  const comps = (msgs[1] as any).updateComponents.components as A2uiComponent[];
  const ids = new Set(comps.map((c) => c.id));
  assert.equal(ids.size, comps.length, "component ids unique");
  assert.ok(ids.has("root"), "root component present");
  for (const c of comps) {
    assert.ok(ALLOWED.has(c.component), `basic catalog only: ${c.component}`);
    if (c.child) assert.ok(ids.has(c.child), `child ${c.child} resolves`);
    if (Array.isArray(c.children)) for (const k of c.children) assert.ok(ids.has(k), `child ${k} resolves`);
  }
  return { msgs, comps, model: (msgs[2] as any).updateDataModel.value };
}

test("product_grid: valid v0.9 set with add_to_cart actions and sponsored label", () => {
  const { comps, model } = checkSurface("product_grid", { query: "gf tortillas", results: products });
  const btns = comps.filter((c) => c.component === "Button");
  assert.equal(btns.length, 2);
  assert.equal(btns[0].action?.event.name, "add_to_cart");
  assert.equal(model.items[0].badge, "Sponsored");
  assert.ok(model.items[0].icon.startsWith("data:image/svg+xml"));
});

test("every hint builds a well-formed surface", () => {
  checkSurface("compare_table", { items: products });
  checkSurface("cart", { cart: { lines: products, total: 6.96 } });
  checkSurface("storefront", { title: "Back to school", sections: [{ title: "Lunch", products }] });
  checkSurface("agent_api", { tier: "verified", rate_limit: "600/min", items: products });
  const { comps } = checkSurface("substitutes", { original: products[1], substitutes: products });
  assert.ok(comps.some((c) => c.action?.event.name === "substitute_accept"));
  const { model, comps: mc } = checkSurface("mandate", { mandate: { mandate_id: "md_1", spend_cap: 40, cart_total: 31.2, signature: "abc" } });
  assert.match(model.json, /md_1/);
  assert.ok(mc.some((c) => c.action?.event.name === "mandate_approve"));
});

test("hintOf and emojiFor", () => {
  assert.equal(hintOf({ ui: "cart" }), "cart");
  assert.equal(hintOf({ ui: { type: "mandate" } }), "mandate");
  assert.equal(hintOf({ ui: "nope" }), null);
  assert.equal(emojiFor({ pt: "Tortillas" }), "🌮");
});
