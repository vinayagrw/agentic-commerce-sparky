/**
 * Deep-tracing overhead, measured live: p50/p95 turn latency with the JSONL trace sink ON vs OFF.
 *
 *   npx tsx scripts/trace_overhead.ts [--n 10]      (bff :8787 must be up: `make dev`)
 *
 * The same real shopper turn (fresh thread each time, beat 1, HITL on, read-only prompt) is run 2n
 * times, alternating ON/OFF (ABAB...) so model/network drift hits both arms equally. The sink is
 * switched with POST /api/traces/config {file} (with OTLP off, that turns span creation off too, and no
 * traceparent reaches policy-mcp/search-svc). Latency is client side: POST -> end of the SSE stream.
 * Output: docs/evidence/tracing_overhead.json. Nothing is estimated; the sink is left ON afterwards.
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BFF = process.env.BFF_URL ?? "http://127.0.0.1:8787";
const n = Number(process.argv[process.argv.indexOf("--n") + 1]) || 10;
const PROMPT = "Find a cheaper ground coffee under $10, but do not change my cart.";

const post = (path: string, body: unknown) => fetch(`${BFF}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function turn() {
  const threadId = `bench-trace-${randomUUID().slice(0, 8)}`;
  const runId = randomUUID();
  const t0 = performance.now();
  const res = await post("/api/agui", { threadId, runId, messages: [{ role: "user", content: PROMPT }], state: { beat: 1, hitl: true } });
  if (!res.ok || !res.body) throw new Error(`agui ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let first: number | null = null;
  let traceId: string | null = null;
  let finished = false;
  let tools = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!frame.startsWith("data:")) continue;
      const e = JSON.parse(frame.slice(5));
      if (e.type === "TEXT_MESSAGE_CONTENT" && first == null) first = performance.now() - t0;
      if (e.type === "CUSTOM" && e.name === "trace") traceId = e.value.traceId;
      if (e.type === "TOOL_CALL_START") tools++;
      if (e.type === "RUN_FINISHED") finished = true;
    }
  }
  return { runId, threadId, total_ms: Math.round(performance.now() - t0), first_token_ms: first == null ? null : Math.round(first), trace_id: traceId, finished, tool_calls: tools };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)) : null;
};

async function main() {
const runs: any[] = [];
for (let i = 0; i < 2 * n; i++) {
  const on = i % 2 === 0;
  const cfg = await post("/api/traces/config", { file: on });
  if (!cfg.ok) throw new Error(`traces/config ${cfg.status}: is the bff up and new enough?`);
  const r = await turn();
  let spans: number | null = null;
  let kinds: Record<string, number> | null = null;
  if (on && r.trace_id) {
    const t = await fetch(`${BFF}/api/traces/${r.trace_id}`).then((x) => x.json()).catch(() => null);
    spans = t?.span_count ?? null;
    kinds = t?.kind_counts ?? null;
  }
  runs.push({ i, trace_file: on, ...r, spans, kind_counts: kinds });
  console.log(`${on ? "ON " : "OFF"} #${i} ${r.total_ms}ms first=${r.first_token_ms} tools=${r.tool_calls} spans=${spans ?? "-"} finished=${r.finished}`);
}
await post("/api/traces/config", { file: true });

const arm = (on: boolean) => {
  const xs = runs.filter((r) => r.trace_file === on && r.finished);
  const tot = xs.map((r) => r.total_ms);
  const ft = xs.map((r) => r.first_token_ms).filter((x): x is number => x != null);
  return { n: xs.length, p50_total_ms: median(tot), p95_total_ms: pct(tot, 95), min_total_ms: Math.min(...tot), max_total_ms: Math.max(...tot), p50_first_token_ms: median(ft), mean_tool_calls: xs.length ? Math.round((xs.reduce((a, r) => a + r.tool_calls, 0) / xs.length) * 10) / 10 : null };
};
const on = arm(true);
const off = arm(false);
const spanCounts = runs.filter((r) => r.spans != null).map((r) => r.spans as number);
const out = {
  measured_at: new Date().toISOString(),
  method: "live stack, same real shopper turn (Claude CLI + policy-mcp + search-svc), fresh thread per turn, alternating ON/OFF; client-side POST -> SSE end",
  prompt: PROMPT,
  beat: 1,
  n_per_arm: n,
  trace_file_on: on,
  trace_file_off: off,
  p50_delta_ms: on.p50_total_ms != null && off.p50_total_ms != null ? on.p50_total_ms - off.p50_total_ms : null,
  p50_delta_pct: on.p50_total_ms && off.p50_total_ms ? Math.round(((on.p50_total_ms - off.p50_total_ms) / off.p50_total_ms) * 1000) / 10 : null,
  spans_per_traced_turn_p50: median(spanCounts),
  interpretation: "Turn latency is dominated by model calls whose run-to-run spread is seconds; a p50 difference smaller than that spread is not evidence of tracing overhead in either direction.",
  runs,
};
writeFileSync(join(ROOT, "docs", "evidence", "tracing_overhead.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ on, off, p50_delta_ms: out.p50_delta_ms, p50_delta_pct: out.p50_delta_pct, spans_per_traced_turn_p50: out.spans_per_traced_turn_p50 }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
