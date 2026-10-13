import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { loadSpecResults, registerSpecResultsRoutes, statusFor } from "./specResults.js";

function report(suites: unknown[], stats: Record<string, unknown> = {}) {
  return JSON.stringify({ config: {}, errors: [], suites, stats: { startTime: "2026-09-17T20:19:46.406Z", duration: 235.461, ...stats } });
}
function spec(file: string, title: string, tests: unknown[]) {
  return { title: file, file, specs: [{ title, file, tests }] };
}
function write(name: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), "spec-results-"));
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

test("GET /api/guide/spec-results reads the real docs/recording/e2e-results.json", async () => {
  const app = Fastify();
  registerSpecResultsRoutes(app);
  const res = await app.inject({ method: "GET", url: "/api/guide/spec-results" });
  await app.close();
  // The committed artefact may be absent on a fresh clone: then the endpoint must refuse, not fake.
  if (res.statusCode === 503) {
    assert.match(res.json().error, /docs\/recording\/e2e-results\.json/);
    return;
  }
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.timestamp === "string" && body.timestamp.length > 0);
  assert.equal(body.count, body.specs.length);
  for (const s of body.specs) {
    assert.match(s.file, /\.spec\.ts$/);
    assert.ok(["passed", "failed", "flaky", "not-run"].includes(s.status), `${s.file} status ${s.status}`);
    assert.ok(s.tests.length > 0, `${s.file} has test rows`);
    for (const t of s.tests) assert.ok(["passed", "failed", "flaky", "not-run"].includes(t.status));
  }
  const sum = Object.values(body.tally as Record<string, number>).reduce((a, b) => a + b, 0);
  assert.equal(sum, body.count);
});

test("each Playwright verdict maps to exactly one of passed/failed/flaky/not-run", () => {
  const p = write("ok.json", report([
    spec("a.spec.ts", "A passes @nollm", [{ status: "expected", results: [{ status: "passed" }] }]),
    spec("b.spec.ts", "B fails @nollm", [{ status: "unexpected", results: [{ status: "failed" }] }]),
    spec("c.spec.ts", "C is flaky @nollm", [{ status: "flaky", results: [{ status: "failed" }, { status: "passed" }] }]),
    spec("d.spec.ts", "D was skipped @llm", [{ status: "skipped", results: [] }]),
    // No per-test verdict at all: fall back to the run results, and to not-run when there are none.
    spec("e.spec.ts", "E only has results", [{ results: [{ status: "timedOut" }, { status: "passed" }] }]),
    spec("f.spec.ts", "F has nothing", [{ results: [] }]),
  ]));
  const r = loadSpecResults(p);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.results.timestamp, "2026-09-17T20:19:46.406Z");
  assert.equal(r.results.durationMs, 235.461);
  const got = Object.fromEntries(r.results.specs.map((s) => [s.file, s.status]));
  assert.deepEqual(got, {
    "a.spec.ts": "passed",
    "b.spec.ts": "failed",
    "c.spec.ts": "flaky",
    "d.spec.ts": "not-run",
    "e.spec.ts": "flaky",
    "f.spec.ts": "not-run",
  });
  assert.equal(statusFor(r.results, "a.spec.ts", "A passes @nollm"), "passed");
});

test("a spec or title with no row is not-run, and a partially skipped file is not-run", () => {
  const p = write("partial.json", report([
    {
      title: "walkthrough.spec.ts",
      file: "walkthrough.spec.ts",
      specs: [{ title: "one passed @nollm", file: "walkthrough.spec.ts", tests: [{ status: "expected", results: [{ status: "passed" }] }] }],
      // nested describe(): must be walked, not dropped
      suites: [{ title: "inner", file: "walkthrough.spec.ts", specs: [{ title: "two skipped @llm", file: "walkthrough.spec.ts", tests: [{ status: "skipped", results: [] }] }] }],
    },
  ]));
  const r = loadSpecResults(p);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.results.specs.length, 1);
  assert.equal(r.results.specs[0].tests.length, 2, "nested suite spec is collected");
  assert.equal(r.results.specs[0].status, "not-run", "one skipped test means the file is not proven");
  assert.equal(statusFor(r.results, "walkthrough.spec.ts", "one passed @nollm"), "passed");
  assert.equal(statusFor(r.results, "walkthrough.spec.ts", "no such title"), "not-run");
  assert.equal(statusFor(r.results, "never-ran.spec.ts"), "not-run", "a spec with no row at all is not-run");
});

test("a missing or malformed report is refused with 503, never faked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-results-missing-"));
  assert.equal(loadSpecResults(join(dir, "nope.json")).ok, false);
  for (const [name, body, rx] of [
    ["bad.json", "{not json", /could not be parsed/],
    ["array.json", "[]", /must be a Playwright JSON report object/],
    ["nosuites.json", JSON.stringify({ stats: { startTime: "x" } }), /no suites\[\] array/],
    ["nostart.json", JSON.stringify({ suites: [], stats: {} }), /no stats\.startTime/],
  ] as const) {
    const p = write(name, body);
    const r = loadSpecResults(p);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.match(r.error, rx);
    const app = Fastify();
    registerSpecResultsRoutes(app, p);
    const res = await app.inject({ method: "GET", url: "/api/guide/spec-results" });
    assert.equal(res.statusCode, 503, name);
    assert.match(res.json().fix, /e2e/);
    await app.close();
  }
});
