/**
 * Persisted token ledger: one JSON line per model call in data/token_ledger.jsonl.
 * { ts, run_id, role, model, input_tokens (uncached), output_tokens, cache_read_input_tokens,
 *   cache_creation_input_tokens, cost_usd, first_token_ms, total_ms, ok, label,
 *   trace_id, span_id, intent, tool_calls }
 * The last four were added later: lines written before them simply lack the keys, and every reader
 * here treats a missing key as null. NO prompt/output text ever goes in this file (see docs/TRACING.md);
 * captured text lives only in data/traces.
 * The run id comes from an AsyncLocalStorage context set by the AG-UI bridge (or a REST route), so
 * callers do not have to thread it through. Numbers are the CLI's own `result` usage, never estimated.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../config.js";

export const LEDGER_PATH = process.env.TOKEN_LEDGER_PATH ?? join(ROOT, "data", "token_ledger.jsonl");

const ctx = new AsyncLocalStorage<{ runId: string; plane?: string; intent?: string | null }>();
export const withRun = <T>(runId: string, fn: () => T, plane?: string) => ctx.run({ runId, plane, intent: null }, fn);
export const currentRun = () => ctx.getStore();
/** The router decides the intent after the run context is open, so it is set in place. */
export function setRunIntent(intent: string | null) {
  const st = ctx.getStore();
  if (st) st.intent = intent;
}
export const currentIntent = () => ctx.getStore()?.intent ?? null;

export interface LedgerEntry {
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
  label?: string;
  run_id?: string;
  /** Trace correlation, so a ledger line can be opened as its trace (added after the first 637 lines). */
  trace_id?: string | null;
  span_id?: string | null;
  intent?: string | null;
  tool_calls?: number | null;
}

export function appendLedger(e: LedgerEntry) {
  const line = { ts: new Date().toISOString(), trace_id: null, span_id: null, tool_calls: null, ...e, run_id: e.run_id ?? ctx.getStore()?.runId ?? null, intent: e.intent ?? ctx.getStore()?.intent ?? null, plane: ctx.getStore()?.plane ?? (e.role === "followups" ? null : null) };
  try {
    mkdirSync(dirname(LEDGER_PATH), { recursive: true });
    appendFileSync(LEDGER_PATH, JSON.stringify(line) + "\n");
  } catch {
    /* ledger is observability; never break a run on it */
  }
}
