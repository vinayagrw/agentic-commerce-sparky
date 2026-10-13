import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addInferred,
  addStated,
  citeClaims,
  compareProducts,
  confirmMemory,
  deleteMemory,
  detectLang,
  editMemory,
  editPlan,
  evaluateWatch,
  feedbackSample,
  inferFromConstraints,
  memoryPromptLines,
  newWatch,
  normaliseFollowUps,
  normalisePhotoItems,
  parseSize,
  planFromMealTool,
  propose,
  transition,
  usualBasket,
  validMemory,
} from "./logic.js";

test("detectLang: Spanish vs English", () => {
  assert.equal(detectLang("¿Me ayudas a buscar leche sin lactosa para mis hijos?"), "es");
  assert.equal(detectLang("necesito pan y huevos para la semana"), "es");
  assert.equal(detectLang("Find me nut-free granola bars for the kids"), "en");
  assert.equal(detectLang(""), "en");
});

test("memory: inferred is quarantined and never reaches the prompt until confirmed", () => {
  let m = addInferred([], "dietary", "nut-free", "I need nut-free bars");
  assert.equal(m[0].status, "quarantined");
  assert.deepEqual(memoryPromptLines(m), []);
  m = confirmMemory(m, m[0].id);
  assert.match(memoryPromptLines(m)[0], /dietary=nut-free/);
  m = editMemory(m, m[0].id, "peanut-free");
  assert.equal(m[0].value, "peanut-free");
  assert.equal(deleteMemory(m, m[0].id).length, 0);
});

test("memory: inference candidates from chat constraints", () => {
  assert.deepEqual(inferFromConstraints([{ key: "dietary", value: "gluten-free option required" }, { key: "headcount", value: "6 people" }, { key: "budget", value: "≤ $40" }]), [
    { key: "dietary", value: "gluten-free" },
    { key: "household_size", value: "6" },
  ]);
});

test("memory: stated is confirmed, duplicates collapse, validation", () => {
  let m = addStated([], "household_size", "4");
  m = addStated(m, "household_size", "4");
  assert.equal(m.length, 1);
  assert.equal(m[0].status, "confirmed");
  assert.equal(addInferred(m, "household_size", "4", "x").length, 1);
  assert.ok(validMemory("household_size", "four"));
  assert.ok(validMemory("store", "12"));
  assert.ok(validMemory("password", "x"));
  assert.equal(validMemory("brands", "Great Value"), null);
});

test("HITL: propose dedups pending, transitions are enforced", () => {
  const base = { kind: "cart_add" as const, product_id: "P1", title: "Jar", qty: 1, price: 2, proposed_by: "agent" as const, reason: "r" };
  const a = propose([], base);
  const b = propose(a.list, { ...base, qty: 2 });
  assert.equal(b.list.length, 1);
  assert.equal(b.list[0].qty, 2);
  assert.equal(transition(a.action, "approved"), null);
  assert.equal(transition(a.action, "undone"), "cannot move pending action to undone");
  assert.equal(transition({ ...a.action, status: "approved" }, "undone"), null);
  assert.ok(transition({ ...a.action, status: "rejected" }, "approved"));
});

test("parseSize and compare: unit price decides, out of stock and untagged excluded", () => {
  assert.deepEqual(parseSize("Peanut Butter, 16 Ounce (Pack of 2)"), { amount: 32, unit: "oz", label: "32 oz (2 pack)" });
  assert.equal(parseSize("Crunchy Peanut Butter 2 lb")?.amount, 32);
  assert.equal(parseSize("Mystery jar"), null);
  const r = compareProducts(
    [
      { product_id: "A", title: "PB 16 oz", price: 3, in_stock: true, dietary: ["vegan"], rating: 4 },
      { product_id: "B", title: "PB 40 oz", price: 6, in_stock: true, dietary: ["vegan"], rating: 4.5 },
      { product_id: "C", title: "PB 64 oz", price: 5, in_stock: false, dietary: ["vegan"] },
      { product_id: "D", title: "PB 40 oz", price: 1, in_stock: true, dietary: [] },
    ],
    ["vegan"],
  );
  assert.equal(r.recommendation?.product_id, "B");
  assert.match(r.recommendation!.reason, /lowest unit price/);
  assert.deepEqual(r.excluded.map((x) => x.product_id).sort(), ["C", "D"]);
  assert.match(r.synthetic_label, /ESCI has no price or stock/);
  assert.equal(compareProducts([{ product_id: "X", title: "x", price: null, in_stock: true }]).recommendation, null);
});

test("watches: price drop and back in stock fire once, missing quote never fires", () => {
  const w = newWatch("price_drop", "P", "Jar", "4108", 5, true);
  assert.equal(evaluateWatch(w, { price: 5, in_stock: true }).note, null);
  assert.equal(evaluateWatch(w, { price: null, in_stock: null }).note, null);
  const hit = evaluateWatch(w, { price: 4.5, in_stock: true });
  assert.match(hit.note!.text, /Price drop.*\$4\.50.*synthetic/);
  assert.equal(evaluateWatch(hit.watch, { price: 4, in_stock: true }).note, null);
  const s = newWatch("back_in_stock", "P", "Jar", "4108", 5, false);
  assert.equal(evaluateWatch(s, { price: 5, in_stock: false }).note, null);
  assert.match(evaluateWatch(s, { price: 5, in_stock: true }).note!.text, /Back in stock/);
});

test("usualBasket ranks by order frequency with median qty", () => {
  const u = usualBasket([
    { lines: [{ product_id: "A", title: "Milk", qty: 2 }, { product_id: "B", title: "Bread", qty: 1 }] },
    { lines: [{ product_id: "A", title: "Milk", qty: 1 }] },
    { lines: [{ product_id: "A", title: "Milk", qty: 2 }] },
  ]);
  assert.deepEqual(u[0], { product_id: "A", title: "Milk", qty: 2, in_orders: 3 });
  assert.equal(u.length, 2);
  assert.deepEqual(usualBasket([]), []);
});

test("mission plan: from plan_meal, edits validated", () => {
  const p = planFromMealTool({ goal: "taco night", recipe: "taco night", items: [{ ingredient: "salsa", product_id: "S", title: "Salsa", price: 2, qty: 1 }], omissions: [] })!;
  assert.equal(p.lines.length, 1);
  const lid = p.lines[0].id;
  assert.equal(editPlan(p, { type: "qty", line_id: lid, qty: 9 }), "qty must be an integer 1-5 (policy max 5)");
  const q = editPlan(p, { type: "qty", line_id: lid, qty: 3 });
  assert.ok(typeof q !== "string" && q.lines[0].qty === 3 && q.edits === 1);
  const sw = editPlan(p, { type: "swap", line_id: lid, product_id: "S2", title: "Other salsa", price: 3 });
  assert.ok(typeof sw !== "string" && sw.lines[0].product_id === "S2");
  const rm = editPlan(p, { type: "remove", line_id: lid });
  assert.ok(typeof rm !== "string" && rm.lines.length === 0);
  assert.equal(planFromMealTool({ error: "x" }), null);
});

test("citations: T3 phrased as uncertain, links to PDP attribute", () => {
  const c = citeClaims("P1", [
    { name: "dietary", value: ["gluten_free"], tier: "T2", source: "synthetic/derived (demo)" },
    { name: "may_contain_nuts", value: "inferred from keyword", tier: "T3", source: "keyword inference" },
    { name: "title", value: "x", tier: "T1", source: "ESCI" },
  ]);
  assert.equal(c.length, 2);
  assert.equal(c[0].uncertain, false);
  assert.match(c[1].text, /^Possibly .*unverified/);
  assert.equal(c[1].href, "/shop/p/P1#attr-may_contain_nuts");
});

test("follow-ups: one clarify with 2-4 options, max 3 follow-ups", () => {
  const f = normaliseFollowUps({ clarify: { question: "Which size?", options: ["Small", "Large", "XL", "XXL", "5th"] }, followups: ["a", "b", "c", "d"] });
  assert.equal(f.clarify!.options.length, 4);
  assert.equal(f.followups.length, 3);
  assert.equal(normaliseFollowUps({ clarify: { question: "Q", options: ["one"] } }).clarify, null);
  assert.deepEqual(normaliseFollowUps(null), { clarify: null, followups: [] });
});

test("photo items and feedback samples are validated", () => {
  const items = normalisePhotoItems({ items: [{ name: "peanut butter", attributes: ["creamy", "16 oz"] }, { name: "" }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].query, "creamy 16 oz peanut butter");
  assert.ok("error" in feedbackSample({ session_id: "s", message_id: "m", rating: "meh" }));
  const ok = feedbackSample({ session_id: "s", message_id: "m", rating: "down", reason: "wrong item" });
  assert.ok("sample" in ok && ok.sample!.label === 0 && ok.sample!.technique === 29);
});
