import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySession, type LineFacts } from "./verifier.js";
import { appliesAs, detectConstraints } from "./constraints.js";

const line = (o: Partial<LineFacts>): LineFacts => ({ product_id: "P1", title: "Oat Crackers", qty: 1, price: 3, dietary: [], in_stock: true, snap_eligible: true, age_restricted: false, ...o });

test("budget ok, violated and could-not entry", () => {
  const base = { constraints: [{ key: "budget", value: "≤ $20", status: "unknown" as const }], store_id: "4108" };
  const ok = verifySession({ ...base, lines: [line({ price: 5, qty: 2 })], budget: 20, cart_total: 10 });
  assert.equal(ok.constraints[0].status, "ok");
  assert.equal(ok.could_not.length, 0);
  const bad = verifySession({ ...base, lines: [line({ price: 25 })], budget: 20, cart_total: 25 });
  assert.equal(bad.constraints[0].status, "violated");
  assert.equal(bad.verdict, "fail");
  assert.match(bad.could_not[0].reason, /\$5\.00 over budget/);
});

test("dietary tag: a missing tag names the offending line", () => {
  const r = verifySession({
    constraints: [{ key: "dietary", value: "gluten-free option required", status: "unknown" }],
    lines: [line({ product_id: "A", title: "GF Pasta", dietary: ["gluten_free"] }), line({ product_id: "B", title: "Wheat Bread", dietary: [] })],
    budget: null,
    cart_total: 6,
    store_id: "4108",
  });
  assert.equal(r.constraints[0].status, "violated");
  assert.deepEqual(r.could_not[0].product_ids, ["B"]);
});

test("dietary: failed lookup is unknown, never ok", () => {
  const r = verifySession({ constraints: [{ key: "dietary", value: "vegan", status: "unknown" }], lines: [line({ dietary: null })], budget: null, cart_total: 3, store_id: "4108" });
  assert.equal(r.constraints[0].status, "unknown");
  assert.equal(r.verdict, "unknown");
});

test("nut-free is never marked ok: no allergen data", () => {
  const c = [{ key: "allergy", value: "nut-free", status: "unknown" as const }];
  const clean = verifySession({ constraints: c, lines: [line({ title: "Rice Cakes" })], budget: null, cart_total: 3, store_id: "4108" });
  assert.equal(clean.constraints[0].status, "unknown");
  assert.match(clean.could_not[0].reason, /no allergen data/);
  const hit = verifySession({ constraints: c, lines: [line({ product_id: "N", title: "Salted Peanuts 16oz" }), line({ product_id: "D", title: "Glazed Donuts" })], budget: null, cart_total: 3, store_id: "4108" });
  assert.equal(hit.constraints[0].status, "violated");
  assert.deepEqual(hit.could_not[0].product_ids, ["N"], "donuts is not a nut");
});

test("store stock, SNAP, qty and age checks", () => {
  const r = verifySession({
    constraints: [
      { key: "store", value: "pickup at 2231", status: "unknown" },
      { key: "payment", value: "pay with SNAP/EBT", status: "unknown" },
    ],
    lines: [line({ product_id: "O", title: "Paper Towels", in_stock: false, snap_eligible: false, qty: 7 }), line({ product_id: "L", title: "Butane Lighter", age_restricted: true })],
    budget: null,
    cart_total: 10,
    store_id: "4108",
  });
  assert.equal(r.constraints[0].status, "violated");
  assert.equal(r.constraints[1].status, "violated");
  assert.ok(r.could_not.some((x) => /Quantity above 5/.test(x.reason)));
  assert.ok(r.could_not.some((x) => /Needs ID/.test(x.reason)));
  assert.equal(r.verdict, "fail");
});

test("inventory service down makes store constraint unknown with a reason", () => {
  const r = verifySession({ constraints: [{ key: "store", value: "pickup at 4108", status: "unknown" }], lines: [line({ in_stock: null })], budget: null, cart_total: 3, store_id: "4108" });
  assert.equal(r.constraints[0].status, "unknown");
  assert.match(r.could_not[0].reason, /Inventory service unavailable/);
});

test("constraint detection and filter mapping", () => {
  const found = detectConstraints("nut-free organic snacks for school, pay with SNAP");
  const keys = found.map((c) => c.value);
  assert.ok(keys.includes("nut-free"));
  assert.ok(keys.includes("organic"));
  assert.ok(keys.some((k) => /SNAP/.test(k)));
  assert.deepEqual(appliesAs({ key: "dietary", value: "gluten-free option required", status: "unknown" }), { filter: "dietary", value: "gluten_free" });
  const nut = appliesAs({ key: "allergy", value: "nut-free", status: "unknown" });
  assert.equal(nut?.filter, "exclude_terms");
  assert.equal(appliesAs({ key: "budget", value: "≤ $20", status: "unknown" }), null);
  assert.deepEqual(appliesAs({ key: "store", value: "pickup at 2231", status: "unknown" }), { filter: "store", value: "2231" });
});
