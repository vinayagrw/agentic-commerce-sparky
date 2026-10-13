import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCliLine, newCliLineState, classify, type CliEvent } from "./claudeCode.js";

function drive(events: unknown[], streamPartial: boolean) {
  const out: CliEvent[] = [];
  const state = newCliLineState();
  for (const e of events) handleCliLine(e, { sink: (x) => out.push(x), streamPartial }, state);
  return { out, state };
}

const partials = [
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Taco " } } },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "night" } } },
];
const toolUse = {
  type: "assistant",
  message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "mcp__shop__search_products", input: { query: "tortillas" } }] },
};
const toolResult = {
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "{\"ui\":\"product_grid\"}" }] }] },
};
const terminal = { type: "result", subtype: "success", result: "Taco night", usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.012 };

test("text_delta streams as tokens; terminal result not re-emitted as prose", () => {
  const { out } = drive([...partials, terminal], true);
  assert.deepEqual(out.filter((e) => e.type === "token").map((e) => (e as any).text), ["Taco ", "night"]);
});

test("non-streaming: terminal result emits once", () => {
  const { out } = drive([terminal], false);
  assert.deepEqual(out.filter((e) => e.type === "token").map((e) => (e as any).text), ["Taco night"]);
});

test("usage carries tokens incl. cache and CLI cost", () => {
  const { out } = drive([terminal], true);
  const u = out.find((e) => e.type === "usage") as any;
  assert.equal(u.input, 15);
  assert.equal(u.output, 7);
  assert.equal(u.costUsd, 0.012);
});

test("tool_use and tool_result pair by id, deduped on repeat", () => {
  const { out } = drive([toolUse, toolUse, toolResult, toolResult], true);
  const uses = out.filter((e) => e.type === "tool_use") as any[];
  const results = out.filter((e) => e.type === "tool_result") as any[];
  assert.equal(uses.length, 1);
  assert.equal(uses[0].name, "mcp__shop__search_products");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "tu1");
  assert.equal(results[0].content, "{\"ui\":\"product_grid\"}");
});

test("assistant text blocks are never emitted as prose (no double answer)", () => {
  const { out } = drive([{ type: "assistant", message: { content: [{ type: "text", text: "dup" }] } }], true);
  assert.equal(out.length, 0);
});

test("classify maps stderr to reasons", () => {
  assert.equal(classify("zsh: command not found: claude", false, true), "spawn-failed");
  assert.equal(classify("Not logged in", false, true), "not-authenticated");
  assert.equal(classify("", true, false), "timeout");
});
