/**
 * Per-call detail assembly (bff/src/trace/detail.ts) and the text masker (bff/src/otel.ts).
 * Both are pure, so the whole Inspector Trace panel's data shape is covered without a live run.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { maskText, textAttrs, MAX_TEXT_BYTES } from "../otel.js";
import type { SpanLine } from "./jsonl.js";
import { detailFromLines } from "./detail.js";

const TRACE = "a".repeat(32);
const span = (p: Partial<SpanLine> & { spanId: string; kind: string }): SpanLine => ({
  traceId: TRACE,
  parentId: null,
  name: p.kind,
  service: "sparky-bff",
  start: 1000,
  end: 1100,
  attrs: {},
  status: "ok",
  ...p,
});

const LINES: SpanLine[] = [
  span({ spanId: "0".repeat(16), kind: "turn", name: "turn shopper", start: 1000, end: 9000, attrs: { "sparky.session": "s1", "sparky.beat": 1 } }),
  span({ spanId: "1".repeat(16), parentId: "0".repeat(16), kind: "router", name: "router", attrs: { "sparky.router.route": "cheap_lookup", "sparky.router.reason": "anchored phrase" } }),
  span({
    spanId: "2".repeat(16),
    parentId: "0".repeat(16),
    kind: "llm",
    name: "llm Planner",
    start: 1100,
    end: 3100,
    attrs: {
      "sparky.role": "Planner",
      "sparky.intent": "cheap_lookup",
      "gen_ai.request.model": "haiku",
      "gen_ai.response.model": "haiku",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 100,
      "sparky.llm.uncached_input_tokens": 200,
      "sparky.llm.cache_read_tokens": 800,
      "sparky.llm.cache_creation_tokens": 0,
      "sparky.cost_usd": 0.01,
      "sparky.llm.ttft_ms": 400,
      "sparky.llm.stream_ms": 1600,
      "sparky.llm.total_ms": 2000,
      "sparky.llm.stop_reason": "success",
      "sparky.llm.ok": true,
      "sparky.llm.tool_calls": 0,
      "sparky.llm.thinking": "off",
      "sparky.llm.reasoning_tokens_available": false,
      "sparky.prompt.text": "plan this",
      "sparky.prompt.chars": 9,
      "sparky.prompt.sha256_16": "abc123",
      "sparky.llm.output.text": "step 1",
      "sparky.llm.system_prompt.version": "sp-deadbeef",
      "sparky.llm.system_prompt.sha256_16": "deadbeefdeadbeef",
    },
  }),
  span({
    spanId: "3".repeat(16),
    parentId: "0".repeat(16),
    kind: "llm",
    name: "llm Shopper",
    start: 3200,
    end: 8000,
    status: "error",
    attrs: {
      "sparky.role": "Shopper",
      "gen_ai.request.model": "sonnet",
      "gen_ai.usage.input_tokens": 3000,
      "gen_ai.usage.output_tokens": 300,
      "sparky.llm.cache_read_tokens": 1000,
      "sparky.cost_usd": 0.05,
      "sparky.llm.ttft_ms": 900,
      "sparky.llm.ok": false,
      "sparky.llm.error_reason": "timeout",
      "sparky.llm.tool_calls": 2,
    },
  }),
  span({ spanId: "4".repeat(16), parentId: "3".repeat(16), kind: "tool", name: "tool search_products", attrs: { "gen_ai.tool.name": "search_products", "sparky.tool.latency_ms": 120, "sparky.tool.result_count": 8, "sparky.tool.blocked": false } }),
  span({ spanId: "5".repeat(16), parentId: "3".repeat(16), kind: "policy", name: "policy", attrs: { "sparky.policy.decision": "allow" }, service: "policy-mcp" }),
  span({ spanId: "6".repeat(16), parentId: "5".repeat(16), kind: "retrieval", name: "retrieval", attrs: { "sparky.retrieval.k": 8 }, service: "search-svc" }),
  span({ spanId: "7".repeat(16), parentId: "0".repeat(16), kind: "verifier", name: "verifier critic", attrs: { "sparky.verifier.verdict": "pass" } }),
  span({ spanId: "8".repeat(16), parentId: "0".repeat(16), kind: "hitl", name: "hitl", attrs: { "sparky.hitl.decision": "approved" } }),
  // a span from a different trace must never leak in
  span({ traceId: "b".repeat(32), spanId: "9".repeat(16), kind: "llm", attrs: { "sparky.cost_usd": 99 } }),
];

test("detail: generations carry per-call tokens, cost, timings and captured text", () => {
  const d = detailFromLines(LINES, TRACE);
  assert.equal(d.generations.length, 2);
  const [planner, shopper] = d.generations;
  assert.equal(planner.role, "Planner");
  assert.equal(planner.model, "haiku");
  assert.equal(planner.tokens.cache_read, 800);
  assert.equal(planner.tokens.uncached_input, 200);
  assert.equal(planner.ttft_ms, 400);
  assert.equal(planner.stop_reason, "success");
  assert.equal(planner.prompt.text, "plan this");
  assert.equal(planner.output.text, "step 1");
  assert.equal(planner.system_prompt.version, "sp-deadbeef");
  assert.equal(planner.reasoning_tokens_available, false);
  assert.equal(shopper.ok, false);
  assert.equal(shopper.error_reason, "timeout");
  assert.equal(shopper.status, "error");
});

test("detail: totals sum only this trace's generations and report cache-read share", () => {
  const d = detailFromLines(LINES, TRACE);
  assert.equal(d.totals.calls, 2);
  assert.equal(d.totals.input_tokens, 4000);
  assert.equal(d.totals.output_tokens, 400);
  assert.equal(d.totals.cache_read_tokens, 1800);
  assert.equal(d.totals.cache_read_ratio, 0.45);
  assert.equal(Math.round(d.totals.cost_usd! * 100) / 100, 0.06);
  assert.equal(d.totals.ttft_ms, 400, "ttft is the first generation's, never an average");
  assert.equal(d.totals.tool_calls, 1);
  assert.equal(d.totals.errors, 1);
  assert.equal(d.totals.reasoning_tokens_available, false);
  assert.equal(d.totals.thinking, "off");
  assert.equal(d.text_captured, true);
});

test("detail: tool, policy, retrieval, verifier, hitl and router rows come from the same trace", () => {
  const d = detailFromLines(LINES, TRACE);
  assert.equal(d.tools.length, 1);
  assert.equal(d.tools[0].name, "search_products");
  assert.equal(d.tools[0].latency_ms, 120);
  assert.equal(d.tools[0].result_count, 8);
  assert.equal(d.tools[0].parent_id, "3".repeat(16));
  assert.equal(d.policy.length, 1);
  assert.equal(d.policy[0].service, "policy-mcp");
  assert.equal(d.retrieval.length, 1, "a grandchild span is still reached");
  assert.equal(d.verifier.length, 1);
  assert.equal(d.hitl.length, 1);
  assert.equal(d.router.length, 1);
  assert.equal(d.turn?.name, "turn shopper");
  assert.equal(d.span_count, 9);
});

test("detail: an empty trace assembles to zeroed totals, not to invented ones", () => {
  const d = detailFromLines(LINES, "c".repeat(32));
  assert.equal(d.span_count, 0);
  assert.equal(d.totals.calls, 0);
  assert.equal(d.totals.input_tokens, null);
  assert.equal(d.totals.cost_usd, null);
  assert.equal(d.text_captured, false);
});

test("masker: emails, long digit runs and secret-like tokens never reach a span", () => {
  const masked = maskText("mail shopper@example.com card 4111 1111 1111 1111 key sk-abcdefghijklmnopqrstuvwx token " + "Z".repeat(48));
  assert.ok(!masked.includes("shopper@example.com"));
  assert.ok(masked.includes("[email]"));
  assert.ok(!masked.includes("4111 1111 1111 1111"));
  assert.ok(masked.includes("[number]"));
  assert.ok(!masked.includes("sk-abcdefghijklmnopqrstuvwx"));
  assert.ok(!masked.includes("Z".repeat(48)));
  assert.ok(masked.includes("[secret]"));
});

test("masker: ordinary shopper text and short numbers survive untouched", () => {
  const t = "Find a cheaper ground coffee under $10, 2 bags, order 12345";
  assert.equal(maskText(t), t);
});

test("textAttrs: truncates at the cap and flags it", () => {
  const long = "coffee ".repeat(Math.ceil((MAX_TEXT_BYTES + 500) / 7));
  const a = textAttrs("sparky.prompt", long);
  assert.equal((a["sparky.prompt.text"] as string).length, MAX_TEXT_BYTES);
  assert.equal(a["sparky.prompt.text_truncated"], true);
  const short = textAttrs("sparky.prompt", "hi");
  assert.equal(short["sparky.prompt.text"], "hi");
  assert.equal(short["sparky.prompt.text_truncated"], false);
  assert.deepEqual(textAttrs("sparky.prompt", ""), {});
});
