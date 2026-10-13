import { test } from "node:test";
import assert from "node:assert/strict";
import { hashKey, TtlCache } from "./ttlCache.js";

test("TtlCache hits within TTL, expires after, evicts oldest at max", () => {
  let t = 0;
  const c = new TtlCache<number>(1000, 2, () => t);
  c.set(hashKey("a", 1), 1);
  assert.equal(c.get(hashKey("a", 1))?.value, 1);
  t = 1001;
  assert.equal(c.get(hashKey("a", 1)), null);
  c.set("x", 1);
  c.set("y", 2);
  c.set("z", 3);
  assert.equal(c.get("x"), null);
  assert.equal(c.get("z")?.value, 3);
  assert.notEqual(hashKey("a", 1), hashKey("a", 2));
});
