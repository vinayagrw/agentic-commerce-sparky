/**
 * Token benchmark (Phase 2). Runs a FIXED live session against the running stack and records
 * tokens, cost, cache hits, first-token latency and task-correctness checks.
 *
 *   npx tsx scripts/token_bench.ts --label before      (bff :8787 must be up: `make dev`)
 *
 *  - 10 shopper turns in one thread (the coffee + #4 filters headline beat and follow-on turns),
 *    HITL on, every proposal approved as it appears, plus the follow-up suggestions call the chat
 *    makes after each turn;
 *  - 5 Ops Copilot prompts (read-only / propose-only). data/registry.json and data/ops.db are
 *    backed up before and restored after, so the registry state never changes permanently.
 *
 * Tokens / cost / cache come from data/token_ledger.jsonl (one line per model call, written by the
 * BFF); first-token latency is measured here, client side, from POST to the first
 * TEXT_MESSAGE_CONTENT. Output: docs/evidence/token_bench_<label>.json. Nothing is estimated.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BFF = process.env.BFF_URL ?? "http://127.0.0.1:8787";
const label = process.argv[process.argv.indexOf("--label") + 1] ?? "run";
const only = process.argv.includes("--ops-only") ? "ops" : process.argv.includes("--shopper-only") ? "shopper" : "all";
const LEDGER = join(ROOT, "data", "token_ledger.jsonl");

type Check = { name: string; pass: boolean; detail: string };
interface Turn {
  plane: "shopper" | "ops";
  n: number;
  prompt: string;
  runId: string;
  first_token_ms: number | null;
  total_ms: number;
  tools: string[];
  answer: string;
  approved: number;
  checks: Check[];
}

async function sseRun(path: string, body: any, onTick?: () => Promise<void>) {
  const t0 = Date.now();
  let first: number | null = null;
  const tools: string[] = [];
  let answer = "";
  let state: any = null;
  const res = await fetch(`${BFF}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) throw new Error(`${path} ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let ticking = false;
  const tick = setInterval(async () => {
    if (ticking || !onTick) return;
    ticking = true;
    await onTick().catch(() => undefined);
    ticking = false;
  }, 2000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!chunk.startsWith("data: ")) continue;
        const e = JSON.parse(chunk.slice(6));
        if (e.type === "TEXT_MESSAGE_CONTENT") {
          first ??= Date.now() - t0;
          answer += e.delta;
        } else if (e.type === "TOOL_CALL_START" && e.toolCallName !== "render_a2ui") tools.push(e.toolCallName);
        else if (e.type === "STATE_SNAPSHOT") state = e.snapshot;
      }
    }
  } finally {
    clearInterval(tick);
  }
  return { first_token_ms: first, total_ms: Date.now() - t0, tools, answer, state };
}

const j = (url: string, init?: RequestInit) => fetch(`${BFF}${url}`, { headers: { "content-type": "application/json" }, ...init }).then((r) => r.json());

async function approveAll(sid: string): Promise<number> {
  const s = await j(`/api/session/${sid}`);
  let n = 0;
  for (const a of s.pending_actions ?? []) {
    if (a.status !== "pending") continue;
    const r = await j(`/api/session/${sid}/actions/${a.id}/approve`, { method: "POST", body: "{}" });
    if (r.ok) n++;
  }
  return n;
}

const money = (t: string) => [...t.matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
const isFilter = (t: string) => /filter/i.test(t) && /(#|No\.?\s*|number\s*)4\b/i.test(t);
const isCoffee = (t: string) => /coffee/i.test(t) && !/filter/i.test(t);

async function shopper(): Promise<Turn[]> {
  const sid = randomUUID();
  const turns: Turn[] = [];
  const script: { beat: number; prompt: string; check: (ctx: { s: any; answer: string; tools: string[]; before: any }) => Check[] }[] = [
    {
      beat: 1,
      prompt: "Coffee plus filters bundle: one bag of ground coffee and a pack of #4 cone coffee filters, under $25 total.",
      check: ({ s }) => {
        const titles: string[] = s.cart.items.map((i: any) => i.title);
        return [
          { name: "cart has ground coffee", pass: titles.some(isCoffee), detail: titles.join(" | ") },
          { name: "cart has #4 filters", pass: titles.some(isFilter), detail: titles.join(" | ") },
          { name: "total <= $25", pass: s.cart.total > 0 && s.cart.total <= 25, detail: String(s.cart.total) },
        ];
      },
    },
    { beat: 1, prompt: "What is in my cart right now and what is the total?", check: ({ s, answer }) => [{ name: "answer states the real cart total", pass: money(answer).some((m) => Math.abs(m - s.cart.total) < 0.011), detail: `total ${s.cart.total}; answer $ ${money(answer).join(",")}` }] },
    { beat: 2, prompt: "Compare the top 3 #4 cone coffee filters and explain why each ranks where it does.", check: ({ tools, answer }) => [{ name: "used live search/compare tools", pass: tools.some((t) => /search_products|compare_products|explain/.test(t)), detail: tools.join(",") }, { name: "answer names 3 options", pass: (answer.match(/\n\s*(\d\.|[-*])\s/g) ?? []).length >= 3 || /3|three/i.test(answer), detail: String(answer.length) }] },
    { beat: 1, prompt: "Remove the coffee filters from my cart.", check: ({ s }) => [{ name: "filters removed", pass: !s.cart.items.some((i: any) => isFilter(i.title)), detail: s.cart.items.map((i: any) => i.title).join(" | ") }] },
    { beat: 1, prompt: "Add one pack of #4 cone coffee filters back to my cart, keeping the total under $25.", check: ({ s }) => [{ name: "filters back in cart", pass: s.cart.items.some((i: any) => isFilter(i.title)), detail: s.cart.items.map((i: any) => i.title).join(" | ") }, { name: "total <= $25", pass: s.cart.total <= 25, detail: String(s.cart.total) }] },
    { beat: 1, prompt: "Show my cart.", check: ({ s, answer }) => [{ name: "answer reflects cart lines", pass: s.cart.items.every((i: any) => answer.toLowerCase().includes(String(i.title).toLowerCase().split(/[ ,]/).filter((w: string) => w.length > 3)[0] ?? "")), detail: answer.slice(0, 160) }] },
    { beat: 1, prompt: "Is anything in my cart a sponsored listing?", check: ({ s, answer }) => [{ name: "sponsored status stated correctly", pass: s.cart.items.some((i: any) => i.sponsored) ? /sponsored/i.test(answer) && !/no(ne|thing)? .*sponsored/i.test(answer) : /(no|not|none|nothing)\b/i.test(answer), detail: answer.slice(0, 160) }] },
    { beat: 1, prompt: "Find a cheaper ground coffee under $10, but do not change my cart.", check: ({ s, before }) => [{ name: "cart unchanged", pass: JSON.stringify(s.cart.items.map((i: any) => [i.product_id, i.qty])) === JSON.stringify(before.cart.items.map((i: any) => [i.product_id, i.qty])), detail: "" }] },
    { beat: 1, prompt: "Help: what can you do for me?", check: ({ answer }) => [{ name: "help answer given", pass: answer.trim().length > 40, detail: String(answer.length) }] },
    { beat: 4, prompt: "Check out my cart with a $40 spend cap. Do not pay, create a mandate for my approval.", check: ({ s, tools }) => [{ name: "mandate created, not paid", pass: tools.includes("create_checkout_mandate") && !(s.orders ?? []).length, detail: tools.join(",") }] },
  ];
  let n = 0;
  for (const step of script) {
    n++;
    const runId = randomUUID();
    const before = await j(`/api/session/${sid}`);
    let approved = 0;
    const r = await sseRun(
      "/api/agui",
      { threadId: sid, runId, messages: [{ role: "user", content: step.prompt }], state: { beat: step.beat, hitl: true } },
      async () => {
        approved += await approveAll(sid);
      },
    );
    approved += await approveAll(sid);
    // the chat asks for follow-up chips after every turn: part of the real per-turn cost
    await fetch(`${BFF}/api/session/${sid}/followups`, { method: "POST", headers: { "content-type": "application/json", "x-bench-run": runId }, body: JSON.stringify({ question: step.prompt, answer: r.answer, run_id: runId }) }).catch(() => undefined);
    const s = await j(`/api/session/${sid}`);
    const checks = step.check({ s, answer: r.answer, tools: r.tools, before });
    turns.push({ plane: "shopper", n, prompt: step.prompt, runId, first_token_ms: r.first_token_ms, total_ms: r.total_ms, tools: r.tools, answer: r.answer.slice(0, 600), approved, checks });
    console.log(`shopper ${n}: ${r.total_ms}ms first ${r.first_token_ms}ms tools ${r.tools.join(",")} checks ${checks.map((c) => (c.pass ? "PASS" : "FAIL") + " " + c.name).join("; ")}`);
  }
  return turns;
}

async function ops(): Promise<Turn[]> {
  const reg = JSON.parse(readFileSync(join(ROOT, "data", "registry.json"), "utf-8"));
  const champion = Object.values<any>(reg.versions).find((v) => v.status === "champion")?.version ?? "?";
  const tid = randomUUID();
  const script: { beat: number; prompt: string; check: (x: { answer: string; tools: string[] }) => Check[] }[] = [
    { beat: 9, prompt: "Read the model registry and name the current champion version.", check: ({ answer, tools }) => [{ name: "names the real champion", pass: new RegExp(`\\b${champion}\\b`).test(answer) && tools.includes("get_registry"), detail: `champion ${champion}` }] },
    { beat: 9, prompt: "Show the 5 most recent audit log entries.", check: ({ tools }) => [{ name: "read the audit log", pass: tools.includes("get_audit_log"), detail: tools.join(",") }] },
    { beat: 9, prompt: "Check the live query stream for drift and estimate the NDCG impact. Do not propose anything yet.", check: ({ tools }) => [{ name: "computed drift", pass: tools.includes("compute_drift"), detail: tools.join(",") }] },
    { beat: 9, prompt: "What is the canary status right now?", check: ({ tools }) => [{ name: "read canary status", pass: tools.includes("get_canary_status"), detail: tools.join(",") }] },
    { beat: 9, prompt: "Propose remediations for the latest drift alert for my approval. Do not build anything.", check: ({ tools }) => [{ name: "proposed, did not build", pass: tools.includes("propose_remediation") && !tools.includes("build_candidate"), detail: tools.join(",") }] },
  ];
  const turns: Turn[] = [];
  let n = 0;
  for (const step of script) {
    n++;
    const runId = randomUUID();
    const r = await sseRun("/api/agui/ops", { threadId: tid, runId, messages: [{ role: "user", content: step.prompt }], state: { beat: step.beat } });
    const checks = step.check(r);
    turns.push({ plane: "ops", n, prompt: step.prompt, runId, first_token_ms: r.first_token_ms, total_ms: r.total_ms, tools: r.tools, answer: r.answer.slice(0, 600), approved: 0, checks });
    console.log(`ops ${n}: ${r.total_ms}ms first ${r.first_token_ms}ms tools ${r.tools.join(",")} checks ${checks.map((c) => (c.pass ? "PASS" : "FAIL") + " " + c.name).join("; ")}`);
  }
  return turns;
}

function ledgerSince(ts: number) {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((x) => Date.parse(x.ts) >= ts);
}

const p50 = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.ceil(0.5 * s.length) - 1] : null;
};

async function main() {
  const re = process.argv.indexOf("--recompute");
  if (re > 0) {
    const prev = JSON.parse(readFileSync(process.argv[re + 1], "utf-8"));
    return summarise(prev.turns, Date.parse(prev.started_at), Date.parse(prev.finished_at), prev.label, prev.started_at);
  }
  const started = Date.now();
  const bk = join(ROOT, "data", `.bench-backup-${started}`);
  mkdirSync(bk, { recursive: true });
  for (const f of ["registry.json", "ops.db"]) copyFileSync(join(ROOT, "data", f), join(bk, f));
  let turns: Turn[] = [];
  try {
    if (only !== "ops") turns.push(...(await shopper()));
    if (only !== "shopper") turns.push(...(await ops()));
  } finally {
    for (const f of ["registry.json", "ops.db"]) copyFileSync(join(bk, f), join(ROOT, "data", f));
  }
  return summarise(turns, started, Date.now(), label, new Date(started).toISOString());
}

async function summarise(turns: Turn[], started: number, finished: number, label: string, startedIso: string) {
  const calls = ledgerSince(started).filter((c) => Date.parse(c.ts) <= finished + 120_000);
  const sum = (xs: any[], k: string) => xs.reduce((a, x) => a + Number(x[k] ?? 0), 0);
  const byPlane = (plane: string) => {
    const ts = turns.filter((t) => t.plane === plane);
    const ids = new Set(ts.map((t) => t.runId));
    // Attribution: by run id; lines without one (ledger v1 bug, fixed) fall back to plane within the bench window
    // (the bench is the only traffic while it runs). Follow-up calls belong to the shopper plane.
    const planeOf = (c: any) => c.plane ?? (c.role === "followups" ? "shopper" : null);
    const cs = calls.filter((c) => ids.has(c.run_id) || (c.run_id == null || !turns.some((t) => t.runId === c.run_id)) && planeOf(c) === plane);
    const input = sum(cs, "input_tokens") + sum(cs, "cache_read_input_tokens") + sum(cs, "cache_creation_input_tokens");
    const checks = ts.flatMap((t) => t.checks);
    return {
      turns: ts.length,
      model_calls: cs.length,
      input_tokens_total: input,
      uncached_input_tokens: sum(cs, "input_tokens"),
      cache_read_input_tokens: sum(cs, "cache_read_input_tokens"),
      cache_creation_input_tokens: sum(cs, "cache_creation_input_tokens"),
      output_tokens: sum(cs, "output_tokens"),
      cost_usd: Number(sum(cs, "cost_usd").toFixed(5)),
      cache_hit_ratio: input ? Number((sum(cs, "cache_read_input_tokens") / input).toFixed(3)) : null,
      first_token_p50_ms: p50(ts.map((t) => t.first_token_ms).filter((x): x is number => x != null)),
      total_p50_ms: p50(ts.map((t) => t.total_ms)),
      checks_passed: checks.filter((c) => c.pass).length,
      checks_total: checks.length,
      by_role: Object.fromEntries([...new Set(cs.map((c) => c.role))].map((r) => [r, { calls: cs.filter((c) => c.role === r).length, cost_usd: Number(sum(cs.filter((c) => c.role === r), "cost_usd").toFixed(5)), output_tokens: sum(cs.filter((c) => c.role === r), "output_tokens") }])),
    };
  };
  const out = { label, started_at: startedIso, finished_at: new Date(finished).toISOString(), bff: BFF, shopper: byPlane("shopper"), ops: byPlane("ops"), turns, ledger_calls: calls.length };
  const path = join(ROOT, "docs", "evidence", `token_bench_${label}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ shopper: out.shopper, ops: out.ops }, null, 2));
  console.log(`wrote ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
