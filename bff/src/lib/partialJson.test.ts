import { test } from "node:test";
import assert from "node:assert/strict";
import { completedObjects, completedStrings } from "./partialJson.js";

test("completedStrings returns only fully written elements", () => {
  assert.deepEqual(completedStrings('{"clarify":null,"followups":["Add milk","Compare pri', "followups"), ["Add milk"]);
  assert.deepEqual(completedStrings('{"followups":["a \\"q\\"","b"]}', "followups"), ['a "q"', "b"]);
  assert.deepEqual(completedStrings('{"clarify":null', "followups"), []);
});

test("completedObjects parses closed objects of an unterminated array", () => {
  const t = '{"items":[{"name":"jar","attributes":["x}"],"query":"peanut butter"},{"name":"bre';
  assert.deepEqual(completedObjects(t, "items"), [{ name: "jar", attributes: ["x}"], query: "peanut butter" }]);
  assert.equal(completedObjects('{"items":[]}', "items").length, 0);
});
