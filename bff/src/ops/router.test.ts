/**
 * Technique 26 (router / cascade) and 29 (OTel GenAI tracing) unit tests.
 *
 * The ports point at a dead address on purpose: like the rest of this plane, the router must
 * REFUSE and name the service rather than report a number it did not measure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SEARCH_SVC_URL = "http://127.0.0.1:1";
process.env.OPS_HTTP_URL = "http://127.0.0.1:1";

const { decide, features, margin, MARGIN_ESCALATE, ROUTER_POLICY_VERSION, route, routerReport, USD_PER_CPU_MIN } =
  await import("./router.js");
const { judgeAgreement } = await import("./onlineEval.js");
const { redact, status: otelStatus, ATTR } = await import("../otel.js");
const metrics = await import("../metrics.js");

test("the router policy sends each intent class to a different arm", () => {
  assert.equal(decide("batteries").arm, "lexical");
  assert.equal(decide("organic whole milk").arm, "hybrid");
  assert.equal(decide("taco night for 6 under $40 gluten free").arm, "premium");
  assert.equal(decide("compare air fryers for a small kitchen").arm, "premium");
});

test("features are the things the policy actually reads", () => {
  const f = features("taco night for 6 under $40");
  assert.equal(f.isMultiConstraintGoal, true);
  assert.equal(f.hasConstraint, true);
  assert.equal(features("aa batteries").isNavigational, true);
});

test("the cascade margin is computed from search-svc's own per-signal scores", () => {
  const data = { results: [{ scores: { rrf: 0.03 } }, { scores: { rrf: 0.029 } }, { scores: { rrf: 0.028 } }] };
  const m = margin(data);
  assert.ok(m !== null && m < MARGIN_ESCALATE, "a flat top-3 must escalate");
  const wide = { results: [{ scores: { rrf: 0.9 } }, { scores: { rrf: 0.4 } }, { scores: { rrf: 0.1 } }] };
  assert.ok((margin(wide) ?? 0) > MARGIN_ESCALATE, "a clear winner must not escalate");
  assert.equal(margin({ results: [{ scores: { rrf: 1 } }] }), null, "too few results means unknown, not a guess");
});

test("a route receipt names the policy version and carries only measured figures", async () => {
  metrics.reset();
  const r = await route("paper towels");
  assert.equal(r.policy_version, ROUTER_POLICY_VERSION);
  assert.equal(r.ok, false, "search-svc is down here");
  assert.ok(r.calls.length >= 1);
  assert.equal(r.cost_usd, Number(((r.ms / 60_000) * USD_PER_CPU_MIN).toFixed(8)), "cost is derived from measured ms");
});

test("the router refuses rather than quoting a cost when search-svc is down", async () => {
  const r: any = await routerReport({ n: 8 });
  assert.equal(r.blocked, true);
  assert.equal(r.service_unavailable.service, "search-svc");
  assert.equal(r.service_unavailable.port, 8801);
  assert.equal(r.cost_per_1k, undefined, "no cost per 1k may be reported without real requests");
});

test("an arm with no samples reports null, never a default", () => {
  metrics.reset();
  const s = metrics.stats("route:lexical");
  assert.equal(s.n, 0);
  assert.equal(s.p50_ms, null);
  assert.equal(s.p95_ms, null);
  assert.equal(s.mean_cost_usd, null);
});

test("metrics buckets are open so the router can add arms", () => {
  metrics.reset();
  metrics.record("route:premium", { ms: 100, costUsd: 0.000003, inputTokens: 0, outputTokens: 0 });
  metrics.record("route:premium", { ms: 200, costUsd: 0.000006, inputTokens: 0, outputTokens: 0 });
  const s = metrics.stats("route:premium");
  assert.equal(s.n, 2);
  assert.equal(s.p95_ms, 200);
  assert.ok(metrics.arms().includes("route:premium"));
  assert.ok("route:premium" in metrics.all());
  metrics.reset();
});

test("the online judge client refuses when ops-http is down", async () => {
  const r: any = await judgeAgreement();
  assert.equal(r.blocked, true);
  assert.equal(r.service_unavailable.service, "ops-http");
  assert.equal(r.service_unavailable.port, 8803);
  assert.equal(r.agreement, undefined);
});

test("prompt capture: masked text with TRACE_CAPTURE on, hash-and-length only when it is off", async () => {
  const { setTraceCapture } = await import("../otel.js");
  const q = "gluten free snacks for my daughter, mail me at shopper@example.com";
  setTraceCapture(false);
  const off = redact(q);
  assert.equal(off["sparky.prompt.chars"], q.length);
  assert.match(String(off["sparky.prompt.sha256_16"]), /^[0-9a-f]{16}$/);
  assert.equal(off["sparky.prompt.text"], undefined, "TRACE_CAPTURE=0 means hash and length only");
  setTraceCapture(true);
  const on = redact(q);
  assert.equal(on["sparky.prompt.text"], "gluten free snacks for my daughter, mail me at [email]", "captured text is masked first");
  assert.equal(on["sparky.prompt.text_truncated"], false);
  assert.equal(on["sparky.prompt.chars"], q.length, "chars is the length of the original, not of the masked copy");
  assert.deepEqual(redact(""), {});
  setTraceCapture(false);
});

test("OTel GenAI attribute names live in exactly one place", () => {
  assert.equal(ATTR.operation, "gen_ai.operation.name");
  assert.equal(ATTR.inputTokens, "gen_ai.usage.input_tokens");
  assert.equal(ATTR.providerName, "gen_ai.provider.name");
});

test("tracing is off unless it is switched on, and says so", () => {
  const s = otelStatus();
  assert.equal(typeof s.enabled, "boolean");
  assert.equal(s.enabled, process.env.OTEL_ENABLED === "1");
  if (!s.enabled) assert.equal(s.endpoint, null, "a disabled exporter must not advertise an endpoint");
});
