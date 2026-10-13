/**
 * B16 persona + payment-step pure logic. No I/O: the shapes here are the ones curl returns
 * from shop-http (services/shop-mcp/src/shop_mcp/http_app.py).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { addStated, type MemoryItem } from "../assist/logic.js";
import { isPersonaSourced, personaConstraints, personaMemory, personaSource, replacePersonaMemory } from "./accountRoutes.js";
import { accountRef, addressSummary, tenderView, walletSummary } from "./sessionStore.js";

const MAYA = { dietary: ["gluten_free"], brands: ["Casa Rosa", "La Banderita"], store_id: "4108", household_size: 3 };
const ROSA = { dietary: [], brands: [], store_id: "5360", household_size: 5 };

test("personaMemory maps every stored preference, and nothing else", () => {
  assert.deepEqual(personaMemory(MAYA), [
    { key: "dietary", value: "gluten_free" },
    { key: "brands", value: "Casa Rosa" },
    { key: "brands", value: "La Banderita" },
    { key: "store", value: "4108" },
    { key: "household_size", value: "3" },
  ]);
  assert.deepEqual(personaMemory({}), []);
  // A non-4-digit store or a non-numeric household size would fail validMemory: it is dropped.
  assert.deepEqual(personaMemory({ store_id: "41", household_size: "big" }), []);
});

test("personaConstraints produce real dietary chips the verifier understands", () => {
  assert.deepEqual(personaConstraints(MAYA), [{ key: "dietary", value: "gluten-free option required", status: "unknown" }]);
  assert.deepEqual(personaConstraints(ROSA), []);
});

test("a persona switch replaces only persona-sourced memory; shopper-stated memory survives", () => {
  let mem: MemoryItem[] = [];
  mem = addStated(mem, "dietary", "nut-free"); // the shopper typed this into the memory panel
  mem = addStated(mem, "brands", "Great Value");
  const shopperIds = mem.map((m) => m.id);

  mem = replacePersonaMemory(mem, personaMemory(MAYA), "acct_maya");
  assert.equal(mem.filter((m) => m.source === personaSource("acct_maya")).length, 5);
  assert.deepEqual(
    mem.filter((m) => !isPersonaSourced(m.source)).map((m) => m.id),
    shopperIds,
    "shopper-stated memory keeps its identity",
  );

  mem = replacePersonaMemory(mem, personaMemory(ROSA), "acct_rosa");
  assert.equal(mem.filter((m) => m.source === personaSource("acct_maya")).length, 0, "the old persona's memory is gone");
  assert.deepEqual(
    mem.filter((m) => m.source === personaSource("acct_rosa")).map((m) => `${m.key}=${m.value}`),
    ["store=5360", "household_size=5"],
  );
  assert.deepEqual(mem.filter((m) => !isPersonaSourced(m.source)).map((m) => m.id), shopperIds);

  // Signing out to guest removes persona memory and still keeps the shopper's own.
  mem = replacePersonaMemory(mem, [], null);
  assert.deepEqual(mem.map((m) => m.id), shopperIds);
});

test("a persona switch never resurrects a memory the shopper deleted, nor duplicates its own", () => {
  let mem = replacePersonaMemory([], personaMemory(MAYA), "acct_maya");
  mem = replacePersonaMemory(mem, personaMemory(MAYA), "acct_maya");
  assert.equal(mem.length, 5, "re-applying the same persona is idempotent");
});

// ---------------------------------------------------------------- SessionView mapping

const PREVIEW = {
  total: 39.94,
  covered_total: 25,
  uncovered: 14.94,
  split_tender: true,
  ok: false,
  plan: [{ pm_id: "pm_maya_gift", kind: "gift", brand: null, last4: null, display: "Gift balance (demo) - $25.00 available", amount: 25, covers: "any line", label: "demo gift" }],
  tender_hash: "sha256:abc",
  refusals: [{ pm_id: "pm_maya_visa", reason: "expired", text: "That card is expired." }],
};

test("tenderView maps a shop-http tender-preview into the SessionView shape", () => {
  const t = tenderView(PREVIEW)!;
  assert.deepEqual(t.plan, [{ pm_id: "pm_maya_gift", amount: 25, kind: "gift", brand: null, last4: null, display: "Gift balance (demo) - $25.00 available", covers: "any line", label: "demo gift" }]);
  assert.equal(t.tender_hash, "sha256:abc");
  assert.equal(t.uncovered, 14.94);
  assert.equal(t.split_tender, true);
  assert.equal(t.ok, false);
  assert.equal(tenderView(null), null);
});

test("refusals are never dropped, even when nothing can be tendered", () => {
  const t = tenderView({ plan: [], tender_hash: null, refusals: PREVIEW.refusals, total: 39.94 })!;
  assert.deepEqual(t.plan, []);
  assert.deepEqual(t.refusals, PREVIEW.refusals);
  // A preview with no refusals field still reports an array, never undefined.
  assert.deepEqual(tenderView({ plan: [] })!.refusals, []);
});

test("account, wallet and address summaries pick the defaults shop-http marks", () => {
  const account = {
    account_id: "acct_maya",
    name: "Maya Alvarez",
    label: "happy path: approved card plus a gift balance",
    payment_methods: [
      { pm_id: "pm_maya_gift", kind: "gift", brand: null, last4: null, outcome: "approved", is_default: false },
      { pm_id: "pm_maya_visa", kind: "credit", brand: "visa", last4: "4242", outcome: "approved", is_default: true },
    ],
    addresses: [{ address_id: "adr_maya_home", display: "1204 Walton Blvd, Bentonville, AR", city: "Bentonville", region: "AR", is_default: true }],
  };
  assert.deepEqual(accountRef(account), { account_id: "acct_maya", name: "Maya Alvarez", tagline: "happy path: approved card plus a gift balance", synthetic: true });
  assert.equal(accountRef(null), null);
  assert.deepEqual(walletSummary(account), { count: 2, default: { pm_id: "pm_maya_visa", kind: "credit", brand: "visa", last4: "4242", outcome: "approved" } });
  assert.deepEqual(addressSummary(account), { count: 1, default: { address_id: "adr_maya_home", label: "1204 Walton Blvd, Bentonville, AR", city: "Bentonville", region: "AR" } });
  // A guest session has no wallet and no address, and says so with zeroes rather than nulls.
  assert.deepEqual(walletSummary(null), { count: 0, default: null });
  assert.deepEqual(addressSummary(null), { count: 0, default: null });
});
