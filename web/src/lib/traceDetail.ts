/**
 * Client types for `GET /api/traces/run/:runId?detail=full` (bff/src/trace/detail.ts) and the
 * capture switch `GET|POST /api/traces/config`.
 *
 * Every field mirrors a span attribute that was actually written during the turn. A null here means
 * "no span reported this", and the UI must say so rather than showing a zero. Reasoning tokens are
 * always `reasoning_tokens_available: false`: the Claude CLI does not report them and we never estimate.
 */
import { getJson, postJson } from "../api";

export interface CapturedText {
  text: string | null;
  chars: number | null;
  sha256_16: string | null;
  truncated: boolean;
}

export interface Generation {
  span_id: string;
  parent_id: string | null;
  name: string;
  role: string | null;
  intent: string | null;
  model: string | null;
  response_model: string | null;
  service: string;
  start: number;
  duration_ms: number;
  ttft_ms: number | null;
  stream_ms: number | null;
  total_ms: number | null;
  stop_reason: string | null;
  ok: boolean | null;
  status: "ok" | "error" | "unset";
  error_reason: string | null;
  aborted: boolean | null;
  timed_out: boolean | null;
  tool_calls: number | null;
  thinking: string | null;
  reasoning_tokens_available: boolean;
  tokens: { input: number | null; output: number | null; uncached_input: number | null; cache_read: number | null; cache_creation: number | null; cache_read_ratio: number | null };
  cost_usd: number | null;
  prompt: CapturedText;
  output: CapturedText;
  system_prompt: CapturedText & { version: string | null };
  attrs: Record<string, unknown>;
}

export interface ToolCall {
  span_id: string;
  parent_id: string | null;
  name: string;
  service: string;
  start: number;
  duration_ms: number;
  latency_ms: number | null;
  arg_keys: unknown;
  args_sha256_16: string | null;
  args_text: string | null;
  result_count: number | null;
  result_bytes: number | null;
  blocked: boolean | null;
  rule: string | null;
  refused_by: string | null;
  tier: string | null;
  status: "ok" | "error" | "unset";
  error: string | null;
  attrs: Record<string, unknown>;
}

export interface OtherSpan {
  span_id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  service: string;
  start: number;
  duration_ms: number;
  status: "ok" | "error" | "unset";
  attrs: Record<string, unknown>;
}

export interface RunDetail {
  trace_id: string;
  span_count: number;
  kind_counts: Record<string, number>;
  services: string[];
  duration_ms: number | null;
  turn: OtherSpan | null;
  totals: {
    calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
    uncached_input_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    cache_read_ratio: number | null;
    cost_usd: number | null;
    tool_calls: number;
    errors: number;
    ttft_ms: number | null;
    total_ms: number | null;
    reasoning_tokens_available: boolean;
    thinking: string | null;
  };
  text_captured: boolean;
  generations: Generation[];
  tools: ToolCall[];
  retrieval: OtherSpan[];
  policy: OtherSpan[];
  hitl: OtherSpan[];
  verifier: OtherSpan[];
  router: OtherSpan[];
  budget: OtherSpan[];
  errors: OtherSpan[];
  ui: OtherSpan[];
}

export interface TracingStatus {
  file_sink: boolean;
  capture_text: boolean;
  capture_text_max_bytes: number;
  capture_content: boolean;
  active: boolean;
}

export interface RunDetailResponse {
  ok: boolean;
  error?: string;
  traceId?: string;
  trace_id?: string;
  detail?: RunDetail;
  tracing?: TracingStatus;
  provenance?: { service: string; endpoint: string; timestamp: string; source?: string };
}

export const fetchRunDetail = (runId: string) => getJson<RunDetailResponse>(`/api/traces/run/${encodeURIComponent(runId)}?detail=full`);

export const fetchTracingConfig = () => getJson<{ ok: boolean; tracing: TracingStatus }>("/api/traces/config");

/** Runtime capture switch. Localhost only on the bff; the banner reports what actually happened. */
export const setCapture = (capture: boolean) => postJson<{ ok: boolean; error?: string; tracing: TracingStatus }>("/api/traces/config", { capture });

// ---------------------------------------------------------------- token meter
export interface LedgerRow {
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
  trace_id: string | null;
  span_id: string | null;
  intent: string | null;
  tool_calls: number | null;
}

export interface Bucket {
  key: string;
  calls: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  cost_missing: number;
  cache_read_share: number | null;
  tool_calls: number;
  p50_ttft_ms: number | null;
  p95_ttft_ms: number | null;
  p50_total_ms: number | null;
  first_ts: string;
  last_ts: string;
}

export interface Facets {
  planes: string[];
  roles: string[];
  models: string[];
  intents: string[];
}

export interface TokenSummary {
  ok: boolean;
  group_by: string;
  totals: Bucket;
  buckets: Bucket[];
  by_hour: Bucket[] | null;
  facets: Facets;
  ledger_lines: number;
  budget: { mode: "normal" | "economy" | "exhausted"; ratio: number; spent_usd: number; budget_usd: number; message: string | null; env: string; note: string };
  provenance: { service: string; endpoint: string; timestamp: string; source?: string };
}

export interface TokenLedgerPage {
  ok: boolean;
  rows: LedgerRow[];
  next_cursor: string | null;
  total: number;
  facets: Facets;
  ledger_lines: number;
  provenance: { service: string; endpoint: string; timestamp: string; source?: string };
}

/** Drop empty/`all` values so the query string only carries filters the user actually set. */
export function tokenQuery(f: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== "" && v != null && v !== "all") q.set(k, String(v));
  return q.toString();
}

export const fetchTokenSummary = (f: Record<string, string | number | null | undefined>) => getJson<TokenSummary>(`/api/tokens/summary?${tokenQuery(f)}`);
export const fetchTokenLedger = (f: Record<string, string | number | null | undefined>) => getJson<TokenLedgerPage>(`/api/tokens/ledger?${tokenQuery(f)}`);

/** ISO string for "now minus N hours", for the time-range filter. */
export const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV for the breakdown table. Pure, so the export is unit-testable and deterministic. */
export function toCsv(columns: string[], rows: (string | number | null)[][]): string {
  return [columns.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
}
