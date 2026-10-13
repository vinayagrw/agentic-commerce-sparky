import { test } from "node:test";
import assert from "node:assert/strict";
import { cartAmounts, cartKey, criticNeeded, routeIntent } from "./intent.js";

test("simple intents skip the Planner and narrow tools", () => {
  assert.deepEqual([routeIntent("Show my cart.", 1).intent, routeIntent("Show my cart.", 1).tools], ["show_cart", ["get_cart"]]);
  assert.equal(routeIntent("Remove the coffee filters from my cart.", 1).intent, "remove");
  assert.equal(routeIntent("Compare the top 3 #4 cone coffee filters", 2).intent, "compare");
  assert.equal(routeIntent("What can you do for me?", 1).intent, "help");
  assert.ok(routeIntent("Show my cart.", 1).skipPlanner);
});

test("goals, bundles and checkout keep the full pipeline", () => {
  assert.equal(routeIntent("Coffee plus filters bundle: one bag of ground coffee and a pack of #4 cone coffee filters, under $25 total.", 1).intent, "complex");
  assert.equal(routeIntent("Add one pack of filters and also some coffee under $25", 1).intent, "complex");
  const c = routeIntent("Check out my cart with a $40 spend cap.", 4);
  assert.equal(c.intent, "checkout");
  assert.equal(c.skipPlanner, false);
  assert.equal(routeIntent("Show my cart", 7).intent, "complex");
});

test("critic only when the cart or checkable claims changed", () => {
  const k = cartKey([{ product_id: "A", qty: 1 }]);
  assert.equal(criticNeeded({ cartBefore: "", cartAfter: k, answer: "", cartLines: 1, beat: 1 }).needed, true);
  assert.equal(criticNeeded({ cartBefore: k, cartAfter: k, answer: "Hello there", cartLines: 1, beat: 1 }).needed, false);
  assert.equal(criticNeeded({ cartBefore: k, cartAfter: k, answer: "Total is $12.40", cartLines: 1, beat: 1 }).needed, true);
  assert.equal(criticNeeded({ cartBefore: k, cartAfter: k, answer: "Total is $12.40", cartLines: 1, beat: 1, knownAmounts: cartAmounts([{ price: 6.2, qty: 2 }], 12.4, 25) }).needed, false);
  assert.equal(criticNeeded({ cartBefore: k, cartAfter: k, answer: "It is vegan, $12.40", cartLines: 1, beat: 1, knownAmounts: [12.4] }).needed, true);
  assert.equal(criticNeeded({ cartBefore: "", cartAfter: "", answer: "gluten free pasta $3", cartLines: 0, beat: 2 }).needed, false);
});
