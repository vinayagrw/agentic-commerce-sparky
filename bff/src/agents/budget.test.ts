import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetState } from "./budget.js";

test("budget degrades to economy at 80% and pauses at 100%", () => {
  assert.equal(budgetState(1, 3).mode, "normal");
  assert.equal(budgetState(2.4, 3).mode, "economy");
  assert.match(budgetState(2.5, 3).message ?? "", /Economy mode: 83%/);
  assert.equal(budgetState(3, 3).mode, "exhausted");
  assert.equal(budgetState(99, 0).mode, "normal");
});
