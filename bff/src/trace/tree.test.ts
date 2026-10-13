/**
 * Deep tracing: span-tree assembly, browser batch validation, and redaction at the real code points
 * (runClaudeCode with a fake CLI, AguiRun tool spans). No raw prompt/shopper text may reach a span line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "sparky-traces-"));
process.env.SPARKY_TRACE_DIR = dir;
process.env.TRACE_FILE = "1";
delete process.env.OTEL_CAPTURE_CONTENT;
process.env.CLAUDE_BIN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");
process.env.TOKEN_LEDGER_PATH = join(dir, "ledger.jsonl");
// Text capture (TRACE_CAPTURE, on by default) is exercised separately below; this file's
// redaction test asserts the capture-OFF contract: hashes only, no raw text anywhere.
process.env.TRACE_CAPTURE = "0";

const { assembleTree, summarizeTraces, validateWebBatch, WEB_LIMITS } = await import("./tree.js");
const { appendSpans, readSpans } = await import("./jsonl.js");
const otel = await import("../otel.js");

const T = "a".repeat(32);
const line = (spanId: string, parentId: string | null, kind: string, start: number, end: number, name = kind) => ({ traceId: T, spanId, parentId, name, kind, service: "t", start, end, attrs: {}, status: "ok" as const });

test("assembleTree nests children under parents, sorts by start, counts kinds and keeps orphans", () => {
  const lines = [
    line("0000000000000001", null, "turn", 0, 100),
    line("0000000000000003", "0000000000000002", "tool", 30, 40),
    line("0000000000000002", "0000000000000001", "llm", 10, 90),
    line("0000000000000004", "0000000000000002", "policy", 20, 25),
    line("0000000000000005", "00000000000000ff", "retrieval", 21, 24),
    { ...line("0000000000000006", null, "turn", 0, 1), traceId: "b".repeat(32) },
  ];
  const t = assembleTree(lines, T);
  assert.equal(t.span_count, 5);
  assert.equal(t.root?.kind, "turn");
  assert.deepEqual(t.root?.children.map((c) => c.kind), ["llm"]);
  assert.deepEqual(t.root?.children[0].children.map((c) => c.kind), ["policy", "tool"], "children sorted by start");
  assert.deepEqual(t.orphans.map((o) => o.kind), ["retrieval"]);
  assert.deepEqual(t.kind_counts, { turn: 1, llm: 1, tool: 1, policy: 1, retrieval: 1 });
  assert.equal(t.duration_ms, 100);
  assert.equal(assembleTree(lines, "c".repeat(32)).root, null);
});

test("summarizeTraces returns newest first with per-kind counts and errors", () => {
  const lines = [line("0000000000000001", null, "turn", 0, 10), { ...line("0000000000000002", null, "turn", 50, 60), traceId: "b".repeat(32) }, { ...line("0000000000000003", "0000000000000002", "error", 55, 55), traceId: "b".repeat(32), status: "error" as const }];
  const s = summarizeTraces(lines, 10);
  assert.equal(s[0].traceId, "b".repeat(32));
  assert.equal(s[0].error_count, 1);
  assert.deepEqual(s[0].kind_counts, { turn: 1, error: 1 });
});

test("web batches: accepted when well formed, content-like strings hashed, everything else refused", () => {
  const now = Date.now();
  const good = { spans: [{ traceId: T, spanId: "1234567890abcdef", parentId: null, name: "ui render answer", kind: "ui", start: now - 5, end: now, attrs: { "ui.route": "/shop", "ui.input_text": "my secret basket", "ui.ms": 5 } }] };
  const r = validateWebBatch(good, { now });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.spans[0].kind, "ui");
    assert.equal(r.spans[0].service, "sparky-web");
    assert.ok(!JSON.stringify(r.spans).includes("my secret basket"));
    assert.equal(r.spans[0].attrs["ui.input_text.chars"], 16);
  }
  const bad = (patch: any, why: RegExp) => {
    const res = validateWebBatch({ spans: [{ ...good.spans[0], ...patch }] }, { now });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, why);
  };
  bad({ kind: "llm" }, /kind "ui"/);
  bad({ traceId: "XYZ" }, /traceId/);
  bad({ spanId: "short" }, /spanId/);
  bad({ end: now - 100 }, /end >= start/);
  bad({ start: now - 3 * 86400_000, end: now - 3 * 86400_000 }, /window/);
  bad({ attrs: { nested: { a: 1 } } }, /string, number or boolean/);
  bad({ attrs: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])) }, /at most/);
  assert.equal(validateWebBatch({ spans: [] }).ok, false);
  assert.equal(validateWebBatch({ spans: Array.from({ length: WEB_LIMITS.maxSpans + 1 }, () => good.spans[0]) }, { now }).ok, false);
  assert.equal(validateWebBatch(good, { now, bodyBytes: WEB_LIMITS.maxBody + 1 }).ok, false);
});

test("JSONL store round-trips span lines", () => {
  const d = mkdtempSync(join(tmpdir(), "sparky-jsonl-"));
  appendSpans([line("0000000000000009", null, "turn", 1, 2)], d);
  assert.equal(readSpans(d).length, 1);
  assert.equal(readdirSync(d).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).length, 1);
});

test("TRACE_CAPTURE=1: the llm span carries masked prompt and output text, and the ledger still carries none", async () => {
  const EMAIL = "shopper@example.com";
  otel.setTraceCapture(true);
  await otel.startTracing();
  const { runClaudeCode } = await import("../llm/claudeCode.js");
  const res = await runClaudeCode({ prompt: `Email me at ${EMAIL} about coffee`, systemPrompt: "sys prompt v1", role: "Capture", sink: () => undefined, signal: new AbortController().signal });
  assert.equal(res.ok, true);
  await otel.flushTracing();
  const llm = readSpans(dir).filter((s) => s.kind === "llm" && s.attrs["sparky.role"] === "Capture").pop();
  assert.ok(llm, "llm span written");
  assert.equal(typeof llm!.attrs["sparky.prompt.text"], "string");
  assert.ok(String(llm!.attrs["sparky.prompt.text"]).includes("coffee"));
  assert.ok(!String(llm!.attrs["sparky.prompt.text"]).includes(EMAIL), "the email is masked before it is written");
  assert.ok(String(llm!.attrs["sparky.prompt.text"]).includes("[email]"));
  assert.equal(llm!.attrs["sparky.prompt.text_truncated"], false);
  assert.equal(typeof llm!.attrs["sparky.llm.output.text"], "string");
  assert.match(String(llm!.attrs["sparky.llm.system_prompt.version"]), /^sp-[0-9a-f]{8}$/);
  assert.equal(llm!.attrs["sparky.llm.reasoning_tokens_available"], false, "the CLI reports no reasoning tokens and we never estimate them");
  const ledger = readFileSync(join(dir, "ledger.jsonl"), "utf-8");
  assert.ok(!ledger.includes("coffee") && !ledger.includes(EMAIL), "no text ever reaches data/token_ledger.jsonl");
  const last = JSON.parse(ledger.trim().split("\n").pop()!);
  assert.match(String(last.trace_id), /^[0-9a-f]{32}$/);
  assert.match(String(last.span_id), /^[0-9a-f]{16}$/);
  assert.equal(typeof last.tool_calls, "number");
  assert.ok("intent" in last, "intent is present (null when the router did not run)");
  otel.setTraceCapture(false);
});

test("redaction with TRACE_CAPTURE=0: an llm span (runClaudeCode) and a tool span (AguiRun) carry hashes, never the raw text", async () => {
  otel.setTraceCapture(false);
  const SECRET = "gluten free birthday cake for Maria at 12 Elm Street";
  const started = await otel.startTracing();
  assert.equal(started.enabled, true);
  const { runClaudeCode } = await import("../llm/claudeCode.js");
  const mcp = join(dir, "mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { policy: { command: "uv", env: { POLICY_ROLE: "ops" } } } }));
  const res = await runClaudeCode({ prompt: `Shopper said: ${SECRET}`, systemPrompt: "sys", role: "Test", sink: () => undefined, signal: new AbortController().signal, mcpConfigPath: mcp, allowedTools: ["mcp__policy__*"] });
  assert.equal(res.ok, true);
  const tp = JSON.parse(readFileSync(mcp, "utf-8")).mcpServers.policy.env.TRACEPARENT as string;
  assert.match(tp, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/, "policy-mcp gets a W3C traceparent in its env");

  const { AguiRun } = await import("../agui/bridge.js");
  const { getThread } = await import("../agui/threadStore.js");
  const run = new AguiRun(() => undefined, getThread("trace-test", "ops"), "trace-test", "ops");
  run.toolUse("call_1", "mcp__policy__metric_query", { query: SECRET });
  await run.toolResult("call_1", JSON.stringify({ ok: true }), false);

  await otel.flushTracing();
  const raw = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && /^\d/.test(f)).map((f) => readFileSync(join(dir, f), "utf-8")).join("");
  assert.ok(raw.length > 0, "spans were written");
  assert.ok(!raw.includes(SECRET) && !raw.includes("Maria"), "no raw prompt or tool-argument text in any span");
  const spans = readSpans(dir);
  const llm = spans.find((s) => s.kind === "llm" && s.attrs["sparky.role"] === "Test");
  assert.ok(llm, "llm span written");
  assert.equal(llm!.attrs["gen_ai.usage.input_tokens"], 100);
  assert.equal(llm!.attrs["sparky.llm.cache_read_ratio"], 0.9);
  assert.equal(llm!.attrs["sparky.llm.stop_reason"], "end_turn");
  assert.equal(typeof llm!.attrs["sparky.prompt.sha256_16"], "string");
  assert.equal(tp.split("-")[2], llm!.spanId, "the injected traceparent names the llm span");
  const tool = spans.find((s) => s.kind === "tool");
  assert.ok(tool && tool.attrs["sparky.tool.args.sha256_16"]);
  assert.ok(spans.some((s) => s.kind === "state"), "state delta span written");
  await otel.stopTracing();
});

