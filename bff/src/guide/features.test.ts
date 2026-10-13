import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { loadFeatures, registerGuideRoutes } from "./features.js";

test("GET /api/guide/features serves the real docs/features.json with every required field", async () => {
  const app = Fastify();
  registerGuideRoutes(app);
  const res = await app.inject({ method: "GET", url: "/api/guide/features" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.count, body.features.length);
  assert.ok(body.features.length >= 57);
  const ids = new Set(body.features.map((f: any) => f.id));
  assert.equal(ids.size, body.features.length, "ids are unique");
  for (const f of body.features) {
    assert.ok(f.alternatives.alt1 && f.alternatives.alt2, `${f.id} has both alternatives`);
    assert.ok(Array.isArray(f.examples) && f.examples.every((e: any) => e.title && e.link?.startsWith("/")), `${f.id} examples have in-app links`);
  }
  assert.ok(ids.has("tracing-deep-tracing"));
  await app.close();
});

test("a missing or malformed features file is refused, not faked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guide-"));
  assert.equal(loadFeatures(join(dir, "nope.json")).ok, false);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify([{ id: "x" }]));
  const r = loadFeatures(bad);
  assert.equal(r.ok, false);
  const app = Fastify();
  registerGuideRoutes(app, bad);
  const res = await app.inject({ method: "GET", url: "/api/guide/features" });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error, /missing/);
  await app.close();
});
