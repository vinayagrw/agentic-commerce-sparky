/**
 * Token meter over data/token_ledger.jsonl (one line per real model call, bff/src/llm/ledger.ts).
 *
 * Nothing here estimates: every number is the Claude CLI's own reported usage/cost, and a line that
 * predates a field (the ledger's first 637 lines have no trace_id/span_id/intent/tool_calls) reads
 * that field as null rather than as a zero. No prompt or output text lives in this file — text is
 * only ever written to data/traces.
 *
 * Pure filtering/grouping lives here so it is unit-testable; the only I/O is one mtime-keyed cache
 * of the parsed file (readLedger), so repeated dashboard queries do not re-read the JSONL.
 */
import { readFileSync, statSync } from "node:fs";
import { LEDGER_PATH } from "../llm/ledger.js";

export interface LedgerLine {
  ts: string;
  run_id: string | null;
  plane: string | null;
  role: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number | null;
  first_token_ms: number | null;
  total_ms: number;
  ok: boolean;
  label: string | null;
  trace_id: string | null;
  span_id: string | null;
  intent: string | null;
  tool_calls: number | null;
}

const n = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const nn = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Normalise one raw JSON line. Missing fields become null, never invented values. */
export function normalise(raw: any): LedgerLine | null {
  if (!raw || typeof raw !== "object" || typeof raw.ts !== "string") return null;
  return {
    ts: raw.ts,
    run_id: s(raw.run_id),
    plane: s(raw.plane),
    role: s(raw.role) ?? "unlabelled",
    model: s(raw.model) ?? "unknown",
    input_tokens: n(raw.input_tokens),
    output_tokens: n(raw.output_tokens),
    cache_read_input_tokens: n(raw.cache_read_input_tokens),
    cache_creation_input_tokens: n(raw.cache_creation_input_tokens),
    cost_usd: nn(raw.cost_usd),
    first_token_ms: nn(raw.first_token_ms),
    total_ms: n(raw.total_ms),
    ok: raw.ok !== false,
    label: s(raw.label),
    trace_id: s(raw.trace_id),
    span_id: s(raw.span_id),
    intent: s(raw.intent),
    tool_calls: nn(raw.tool_calls),
  };
}

export function parseLedger(text: string): LedgerLine[] {
  const out: LedgerLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const l = normalise(JSON.parse(line));
      if (l) out.push(l);
    } catch {
      /* a torn line from a crash: skip it rather than failing the dashboard */
    }
  }
  return out;
}

let cache: { key: string; lines: LedgerLine[] } | null = null;

/** Parsed ledger, cached by (mtime, size) so a dashboard refresh does not re-read the file. */
export function readLedger(path = LEDGER_PATH): LedgerLine[] {
  let key: string;
  try {
    const st = statSync(path);
    key = `${path}:${st.mtimeMs}:${st.size}`;
  } catch {
    return [];
  }
  if (cache?.key === key) return cache.lines;
  let text = "";
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const lines = parseLedger(text);
  cache = { key, lines };
  return lines;
}

export function clearLedgerCache() {
  cache = null;
}

export interface LedgerFilters {
  from?: string | null;
  to?: string | null;
  plane?: string | null;
  role?: string | null;
  model?: string | null;
  ok?: boolean | null;
  run_id?: string | null;
  intent?: string | null;
  min_cost?: number | null;
}

const eq = (want: string | null | undefined, got: string | null) => want == null || want === "" || want === "all" || (got ?? "") === want;

/** Apply the filter set. Time bounds are ISO strings compared lexically (ledger ts is ISO-8601 UTC). */
export function filterLedger(lines: LedgerLine[], f: LedgerFilters): LedgerLine[] {
  return lines.filter((l) => {
    if (f.from && l.ts < f.from) return false;
    if (f.to && l.ts > f.to) return false;
    if (!eq(f.plane, l.plane)) return false;
    if (!eq(f.role, l.role)) return false;
    if (!eq(f.model, l.model)) return false;
    if (!eq(f.run_id, l.run_id)) return false;
    if (!eq(f.intent, l.intent)) return false;
    if (f.ok != null && l.ok !== f.ok) return false;
    if (f.min_cost != null && !((l.cost_usd ?? 0) >= f.min_cost)) return false;
    return true;
  });
}

export type GroupBy = "role" | "model" | "plane" | "intent" | "hour";
export const GROUP_BYS: GroupBy[] = ["role", "model", "plane", "intent", "hour"];

export const groupKeyOf = (l: LedgerLine, by: GroupBy): string =>
  by === "hour" ? `${l.ts.slice(0, 13)}:00` : by === "plane" ? (l.plane ?? "unassigned") : by === "intent" ? (l.intent ?? "not recorded") : by === "model" ? l.model : l.role;

export interface Bucket {
  key: string;
  calls: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  /** Calls whose line carried no cost (the CLI did not report one): excluded from cost_usd. */
  cost_missing: number;
  cache_read_share: number | null;
  tool_calls: number;
  p50_ttft_ms: number | null;
  p95_ttft_ms: number | null;
  p50_total_ms: number | null;
  first_ts: string;
  last_ts: string;
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return Math.round(v[i]);
}

function bucketOf(key: string, ls: LedgerLine[]): Bucket {
  const ttfts = ls.map((l) => l.first_token_ms).filter((x): x is number => x != null);
  const read = ls.reduce((a, l) => a + l.cache_read_input_tokens, 0);
  const inTotal = ls.reduce((a, l) => a + l.input_tokens + l.cache_read_input_tokens + l.cache_creation_input_tokens, 0);
  const ts = ls.map((l) => l.ts).sort();
  return {
    key,
    calls: ls.length,
    errors: ls.filter((l) => !l.ok).length,
    input_tokens: ls.reduce((a, l) => a + l.input_tokens, 0),
    output_tokens: ls.reduce((a, l) => a + l.output_tokens, 0),
    cache_read_tokens: read,
    cache_creation_tokens: ls.reduce((a, l) => a + l.cache_creation_input_tokens, 0),
    cost_usd: Math.round(ls.reduce((a, l) => a + (l.cost_usd ?? 0), 0) * 1e6) / 1e6,
    cost_missing: ls.filter((l) => l.cost_usd == null).length,
    cache_read_share: inTotal ? Math.round((read / inTotal) * 1000) / 1000 : null,
    tool_calls: ls.reduce((a, l) => a + (l.tool_calls ?? 0), 0),
    p50_ttft_ms: percentile(ttfts, 50),
    p95_ttft_ms: percentile(ttfts, 95),
    p50_total_ms: percentile(ls.map((l) => l.total_ms), 50),
    first_ts: ts[0] ?? "",
    last_ts: ts[ts.length - 1] ?? "",
  };
}

/** Group filtered lines into buckets, biggest cost first (hour buckets stay chronological). */
export function groupLedger(lines: LedgerLine[], by: GroupBy): Bucket[] {
  const map = new Map<string, LedgerLine[]>();
  for (const l of lines) {
    const k = groupKeyOf(l, by);
    const a = map.get(k);
    if (a) a.push(l);
    else map.set(k, [l]);
  }
  const out = [...map].map(([k, ls]) => bucketOf(k, ls));
  return by === "hour" ? out.sort((a, b) => a.key.localeCompare(b.key)) : out.sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls);
}

/** Overall totals for the tile row: one bucket over everything that passed the filters. */
export const summariseLedger = (lines: LedgerLine[]): Bucket => bucketOf("all", lines);

/** Distinct values for the filter bar's dropdowns, over the whole (unfiltered) ledger. */
export function facets(lines: LedgerLine[]) {
  const uniq = (f: (l: LedgerLine) => string | null) => [...new Set(lines.map(f).filter((x): x is string => !!x))].sort();
  return { planes: uniq((l) => l.plane), roles: uniq((l) => l.role), models: uniq((l) => l.model), intents: uniq((l) => l.intent) };
}

export interface PageOpts {
  limit?: number;
  cursor?: string | null;
}

/** Newest-first page. The cursor is the index into the newest-first list, as a string. */
export function pageLedger(lines: LedgerLine[], { limit = 100, cursor }: PageOpts = {}) {
  const lim = Math.max(1, Math.min(limit, 1000));
  const sorted = [...lines].sort((a, b) => b.ts.localeCompare(a.ts));
  const start = Math.max(0, Number(cursor ?? 0) || 0);
  const rows = sorted.slice(start, start + lim);
  const next = start + lim < sorted.length ? String(start + lim) : null;
  return { rows, next_cursor: next, total: sorted.length };
}
