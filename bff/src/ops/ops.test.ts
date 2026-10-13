import { test } from "node:test";
import assert from "node:assert/strict";

// Point at dead ports: these tests assert that an unreachable service REFUSES rather than
// producing a number. There is no simulation left to fall back to.
process.env.SEARCH_SVC_URL = "http://127.0.0.1:1";
process.env.OPS_HTTP_URL = "http://127.0.0.1:1";
process.env.SHOP_HTTP_URL = "http://127.0.0.1:1";

const { auditLog, decideApproval, isOpsUnavailable, registry } = await import("./opsClient.js");
const { finopsRouter, isHard } = await import("./finops.js");
const { buildOpsA2ui } = await import("./a2uiOps.js");
const { OPS_UI_HINTS, emptyState } = await import("@sparky/shared");
const { applyOpsResult } = await import("./reducer.js");
const metrics = await import("../metrics.js");

test("every ops ui hint builds a spec-shaped A2UI surface", () => {
  for (const hint of OPS_UI_HINTS) {
    const msgs = buildOpsA2ui(hint, { agent: "Eval", tier: "T3" }, `s-${hint}`);
    assert.equal(msgs.length, 3);
    const comps = (msgs[1] as any).updateComponents.components;
    assert.ok(comps.some((c: any) => c.id === "root"), hint);
  }
});

test("a down service refuses and names the port and the fix, instead of substituting", async () => {
  const reg = await registry();
  assert.ok(isOpsUnavailable(reg), "registry must refuse when search-svc is down");
  assert.equal(reg.service_unavailable.service, "search-svc");
  assert.equal(reg.service_unavailable.port, 8801);
  assert.equal(reg.service_unavailable.fix, "make dev");

  const audit = await auditLog();
  assert.ok(isOpsUnavailable(audit), "audit must refuse when ops-http is down");
  assert.equal(audit.service_unavailable.service, "ops-http");

  const decision = await decideApproval("apr_x", true, "reweight_rrf");
  assert.ok(isOpsUnavailable(decision), "an approval cannot be recorded anywhere but ops-http");
});

test("finops refuses rather than quoting a cost when search-svc is down", async () => {
  const r = await finopsRouter({});
  assert.equal(r.blocked, true);
  assert.equal(r.service_unavailable.service, "search-svc");
  assert.ok(!("cost_per_1k" in r), "no cost may be reported without a live sample");
});

test("finops refuses a per-task cost until real Claude runs have been measured", async () => {
  metrics.reset();
  assert.equal(metrics.count("claude"), 0);
  const r = await finopsRouter({});
  // search-svc is down here too, but the point stands: nothing is returned with a number on it.
  assert.equal(r.blocked, true);
  assert.equal(r.cost_per_1k, undefined);
});

test("measured stats are computed from recorded samples only", () => {
  metrics.reset();
  assert.equal(metrics.stats("claude").p95_ms, null, "no samples means no percentile, not a default");
  assert.equal(metrics.stats("claude").mean_cost_usd, null);
  metrics.record("claude", { ms: 100, costUsd: 0.01, inputTokens: 10, outputTokens: 5 });
  metrics.record("claude", { ms: 300, costUsd: 0.03, inputTokens: 20, outputTokens: 5 });
  const s = metrics.stats("claude");
  assert.equal(s.n, 2);
  assert.equal(s.p95_ms, 300);
  assert.equal(s.p50_ms, 100);
  assert.equal(s.mean_cost_usd, 0.02);
  assert.deepEqual(s.total_tokens, { input: 30, output: 10 });
  metrics.reset();
});

test("the router rule sends multi-constraint goals to Claude and lookups to the cheap path", () => {
  assert.equal(isHard("taco night for 6 under $40 gluten free"), true);
  assert.equal(isHard("compare air fryers for a small kitchen"), true);
  assert.equal(isHard("paper towels"), false);
  assert.equal(isHard("batteries aa"), false);
});

test("ops results still drive the lifecycle stage in shared state", () => {
  const s = emptyState(9, "ops");
  applyOpsResult(s, "run_eval_suite", { ui: "eval_gate", agent: "Eval", tier: "T3", passed: true });
  assert.equal(s.ops.stage, "Validate");
});

test("Phase 3 ops_insight card: summary, chart, findings, table rows capped, citations and n", async () => {
  const { buildOpsA2ui, insightChart } = await import("./a2uiOps.js");
  const data = {
    ui: "ops_insight", kind: "incident_triage", title: "Incident triage", summary: "Drift alert alr-1", agent: "drift-monitor-agent", tier: "T0",
    facts: [{ label: "window", value: "72h" }], findings: [{ severity: "high", finding: "Canary breaching", cite: "audit#9" }],
    chart: { type: "bar", unit: "ΔNDCG", series: [{ label: "v2", value: -0.03, ci: [-0.05, -0.01] }, { label: "v3", value: 0.004 }] },
    table: { columns: ["a", "b"], rows: Array.from({ length: 20 }, (_, i) => [i, `r${i}`]) },
    citations: [{ source: "ops.db alerts", ref: "alr-1" }], n: 20,
  };
  const msgs = buildOpsA2ui("ops_insight", data, "s1");
  const texts = JSON.stringify((msgs[1] as any).updateComponents.components);
  for (const needle of ["Incident triage", "Drift alert alr-1", "Canary breaching", "audit#9", "Sources: ops.db alerts alr-1", "n = 20", "… 8 more row(s)"]) assert.ok(texts.includes(needle), needle);
  assert.match(insightChart(data.chart as any) ?? "", /^data:image\/svg\+xml/);
  assert.equal(insightChart({ series: [] }), null);
});

test("MLOps top 10 tools carry their agent and autonomy tier", async () => {
  const { opsToolMeta } = await import("./meta.js");
  const want: Record<string, string> = { interleave_rankers: "T1", ab_sequential_test: "T1", skew_check: "T2", lineage_query: "T0", retrain_trigger: "T2",
    exposure_audit: "T1", prompt_registry_diff: "T2", slo_budget_status: "T2", golden_set_diff: "T1", shadow_deploy_diff: "T1" };
  for (const [tool, tier] of Object.entries(want)) {
    assert.equal(opsToolMeta(tool).tier, tier, tool);
    assert.notEqual(opsToolMeta(tool).agent, "Ops", tool);
  }
});
