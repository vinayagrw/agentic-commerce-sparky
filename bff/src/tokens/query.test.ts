/**
 * Token meter filtering and grouping (bff/src/tokens/query.ts). Pure over parsed ledger lines,
 * including the backward-compatibility rule: older lines carry no trace_id/intent/tool_calls and
 * must read as null rather than as zero or as a made-up value.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { facets, filterLedger, groupLedger, normalise, pageLedger, parseLedger, percentile, summariseLedger } from "./query.js";

const line = (o: Record<string, unknown>) =>
  JSON.stringify({ ts: "2026-09-17T10:00:00.000Z", role: "Shopper", model: "sonnet", input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.01, first_token_ms: 100, total_ms: 1000, ok: true, run_id: "r1", plane: "shopper", ...o });

const TEXT = [
  line({ ts: "2026-09-17T10:00:00.000Z", role: "Planner", model: "haiku", cost_usd: 0.002, first_token_ms: 200, cache_read_input_tokens: 400, intent: "cheap_lookup", trace_id: "a".repeat(32), tool_calls: 0 }),
  line({ ts: "2026-09-17T11:00:00.000Z", role: "Shopper", model: "sonnet", cost_usd: 0.05, first_token_ms: 900, cache_read_input_tokens: 900, intent: "cheap_lookup", trace_id: "b".repeat(32), tool_calls: 3 }),
  line({ ts: "2026-09-17T11:30:00.000Z", role: "Shopper", model: "sonnet", cost_usd: 0.03, first_token_ms: 700, ok: false, plane: "ops", run_id: "r2" }),
  line({ ts: "2026-09-16T09:00:00.000Z", role: "Critic", model: "haiku", cost_usd: null, first_token_ms: null }),
  "not json at all",
  "",
].join("\n");

const LINES = parseLedger(TEXT);

test("parse: torn/blank lines are skipped, old lines read their missing fields as null", () => {
  assert.equal(LINES.length, 4);
  const critic = LINES.find((l) => l.role === "Critic")!;
  assert.equal(critic.trace_id, null);
  assert.equal(critic.intent, null);
  assert.equal(critic.tool_calls, null);
  assert.equal(critic.cost_usd, null, "no reported cost is null, never 0");
  assert.equal(normalise({ nope: 1 }), null);
});

test("filters: time range, plane, role, model, ok, run_id, intent and min_cost", () => {
  assert.equal(filterLedger(LINES, { from: "2026-09-17T00:00:00.000Z" }).length, 3);
  assert.equal(filterLedger(LINES, { to: "2026-09-16T23:59:59.999Z" }).length, 1);
  assert.equal(filterLedger(LINES, { plane: "ops" }).length, 1);
  assert.equal(filterLedger(LINES, { role: "Shopper" }).length, 2);
  assert.equal(filterLedger(LINES, { model: "haiku" }).length, 2);
  assert.equal(filterLedger(LINES, { ok: false }).length, 1);
  assert.equal(filterLedger(LINES, { ok: true }).length, 3);
  assert.equal(filterLedger(LINES, { run_id: "r2" }).length, 1);
  assert.equal(filterLedger(LINES, { intent: "cheap_lookup" }).length, 2);
  assert.equal(filterLedger(LINES, { min_cost: 0.04 }).length, 1);
  assert.equal(filterLedger(LINES, { role: "Shopper", model: "sonnet", ok: true }).length, 1, "filters combine");
  assert.equal(filterLedger(LINES, {}).length, 4, "no filters keeps everything");
  assert.equal(filterLedger(LINES, { role: "all" }).length, 4, "'all' is a pass-through");
});

test("grouping: by role, model, plane, intent and hour", () => {
  const byRole = groupLedger(LINES, "role");
  assert.deepEqual(byRole.map((b) => b.key), ["Shopper", "Planner", "Critic"], "most expensive first");
  assert.equal(byRole[0].calls, 2);
  assert.equal(byRole[0].cost_usd, 0.08);
  assert.equal(byRole[0].errors, 1);
  assert.equal(byRole[0].tool_calls, 3);
  assert.equal(byRole.find((b) => b.key === "Critic")!.cost_missing, 1);
  assert.deepEqual(groupLedger(LINES, "plane").map((b) => b.key).sort(), ["ops", "shopper"]);
  assert.ok(groupLedger(LINES, "intent").some((b) => b.key === "not recorded"), "lines with no intent group honestly");
  const byHour = groupLedger(LINES, "hour");
  assert.deepEqual(byHour.map((b) => b.key), ["2026-09-16T09:00", "2026-09-17T10:00", "2026-09-17T11:00"], "hours stay chronological");
  assert.equal(byHour[2].calls, 2);
  assert.deepEqual(groupLedger([], "role"), []);
});

test("summary totals: cache-read share and ttft percentiles over reported values only", () => {
  const t = summariseLedger(LINES);
  assert.equal(t.calls, 4);
  assert.equal(t.cost_usd, 0.082, "the line with no reported cost adds nothing");
  assert.equal(t.cache_read_tokens, 1300);
  assert.equal(t.cache_read_share, Math.round((1300 / (400 + 1300)) * 1000) / 1000);
  assert.equal(t.p50_ttft_ms, 700, "the line with no first_token_ms is excluded, not counted as 0");
  assert.equal(t.p95_ttft_ms, 900);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
});

test("facets list the distinct filter values actually present", () => {
  const f = facets(LINES);
  assert.deepEqual(f.roles, ["Critic", "Planner", "Shopper"]);
  assert.deepEqual(f.models, ["haiku", "sonnet"]);
  assert.deepEqual(f.planes, ["ops", "shopper"]);
  assert.deepEqual(f.intents, ["cheap_lookup"]);
});

test("paging is newest-first and hands back a usable cursor", () => {
  const p1 = pageLedger(LINES, { limit: 2 });
  assert.equal(p1.rows.length, 2);
  assert.equal(p1.total, 4);
  assert.equal(p1.rows[0].ts, "2026-09-17T11:30:00.000Z");
  assert.equal(p1.next_cursor, "2");
  const p2 = pageLedger(LINES, { limit: 2, cursor: p1.next_cursor });
  assert.equal(p2.rows.length, 2);
  assert.equal(p2.next_cursor, null);
  assert.equal(p2.rows[1].ts, "2026-09-16T09:00:00.000Z");
});
