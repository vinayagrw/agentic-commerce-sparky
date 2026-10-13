/**
 * Per-call detail for one traced turn: the Langfuse/LangSmith-style view behind
 * `GET /api/traces/run/:runId?detail=full` and the chat Inspector's Trace tab.
 *
 * Everything here is assembled from span lines that already exist in data/traces (docs/TRACING.md).
 * Nothing is synthesised: a field that no span reported comes back null, and reasoning tokens are
 * reported as unavailable rather than estimated (the Claude CLI does not report them).
 * Pure functions only, so tree assembly is unit-tested in detail.test.ts.
 */
import type { SpanLine } from "./jsonl.js";
import { assembleTree, type SpanNode, type TraceTree } from "./tree.js";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

export interface CapturedText {
  text: string | null;
  chars: number | null;
  sha256_16: string | null;
  truncated: boolean;
}

/** Pull one `<prefix>.text` / `.chars` / `.sha256_16` / `.text_truncated` group out of span attrs. */
export function capturedText(attrs: Record<string, unknown>, prefix: string): CapturedText {
  return {
    text: str(attrs[`${prefix}.text`]),
    chars: num(attrs[`${prefix}.chars`]),
    sha256_16: str(attrs[`${prefix}.sha256_16`]),
    truncated: attrs[`${prefix}.text_truncated`] === true,
  };
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
  status: SpanLine["status"];
  error_reason: string | null;
  aborted: boolean | null;
  timed_out: boolean | null;
  tool_calls: number | null;
  thinking: string | null;
  /** The CLI does not report reasoning tokens; this is always false and never estimated. */
  reasoning_tokens_available: boolean;
  tokens: {
    input: number | null;
    output: number | null;
    uncached_input: number | null;
    cache_read: number | null;
    cache_creation: number | null;
    cache_read_ratio: number | null;
  };
  cost_usd: number | null;
  prompt: CapturedText;
  output: CapturedText;
  system_prompt: CapturedText & { version: string | null };
  /** Every attribute the span carried, for the Metadata tab. */
  attrs: Record<string, unknown>;
}

export function toGeneration(n: SpanNode): Generation {
  const a = n.attrs ?? {};
  return {
    span_id: n.spanId,
    parent_id: n.parentId,
    name: n.name,
    role: str(a["sparky.role"]),
    intent: str(a["sparky.intent"]),
    model: str(a["gen_ai.request.model"]),
    response_model: str(a["gen_ai.response.model"]),
    service: n.service,
    start: n.start,
    duration_ms: n.duration_ms,
    ttft_ms: num(a["sparky.llm.ttft_ms"]),
    stream_ms: num(a["sparky.llm.stream_ms"]),
    total_ms: num(a["sparky.llm.total_ms"]),
    stop_reason: str(a["sparky.llm.stop_reason"]),
    ok: bool(a["sparky.llm.ok"]),
    status: n.status,
    error_reason: str(a["sparky.llm.error_reason"]),
    aborted: bool(a["sparky.llm.aborted"]),
    timed_out: bool(a["sparky.llm.timed_out"]),
    tool_calls: num(a["sparky.llm.tool_calls"]),
    thinking: str(a["sparky.llm.thinking"]),
    reasoning_tokens_available: a["sparky.llm.reasoning_tokens_available"] === true,
    tokens: {
      input: num(a["gen_ai.usage.input_tokens"]),
      output: num(a["gen_ai.usage.output_tokens"]),
      uncached_input: num(a["sparky.llm.uncached_input_tokens"]),
      cache_read: num(a["sparky.llm.cache_read_tokens"]),
      cache_creation: num(a["sparky.llm.cache_creation_tokens"]),
      cache_read_ratio: num(a["sparky.llm.cache_read_ratio"]),
    },
    cost_usd: num(a["sparky.cost_usd"]),
    prompt: capturedText(a, "sparky.prompt"),
    output: capturedText(a, "sparky.llm.output"),
    system_prompt: { ...capturedText(a, "sparky.llm.system_prompt"), version: str(a["sparky.llm.system_prompt.version"]) },
    attrs: a,
  };
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
  status: SpanLine["status"];
  error: string | null;
  attrs: Record<string, unknown>;
}

export function toToolCall(n: SpanNode): ToolCall {
  const a = n.attrs ?? {};
  return {
    span_id: n.spanId,
    parent_id: n.parentId,
    name: str(a["gen_ai.tool.name"]) ?? n.name,
    service: n.service,
    start: n.start,
    duration_ms: n.duration_ms,
    latency_ms: num(a["sparky.tool.latency_ms"]),
    arg_keys: a["sparky.tool.arg_keys"] ?? null,
    args_sha256_16: str(a["sparky.tool.args.sha256_16"]),
    args_text: str(a["sparky.tool.args.text"]),
    result_count: num(a["sparky.tool.result_count"]),
    result_bytes: num(a["sparky.tool.result_bytes"]) ?? num(a["sparky.tool.result.chars"]),
    blocked: bool(a["sparky.tool.blocked"]),
    rule: str(a["sparky.tool.rule"]),
    refused_by: str(a["sparky.tool.refused_by"]),
    tier: str(a["sparky.tool.tier"]),
    status: n.status,
    error: str(a["sparky.error.reason"]),
    attrs: a,
  };
}

/** A span of any other kind, flattened for the panel's secondary rows. */
export interface OtherSpan {
  span_id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  service: string;
  start: number;
  duration_ms: number;
  status: SpanLine["status"];
  attrs: Record<string, unknown>;
}

const toOther = (n: SpanNode): OtherSpan => ({
  span_id: n.spanId,
  parent_id: n.parentId,
  kind: n.kind,
  name: n.name,
  service: n.service,
  start: n.start,
  duration_ms: n.duration_ms,
  status: n.status,
  attrs: n.attrs ?? {},
});

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
    /** Always false: the Claude CLI does not report reasoning tokens (docs/TRACING.md). */
    reasoning_tokens_available: boolean;
    thinking: string | null;
  };
  /** True when at least one generation carries captured prompt or output text. */
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

function flatten(node: SpanNode | null, out: SpanNode[] = []): SpanNode[] {
  if (!node) return out;
  out.push(node);
  for (const c of node.children) flatten(c, out);
  return out;
}

const sum = (xs: (number | null)[]): number | null => {
  const ns = xs.filter((x): x is number => x != null);
  return ns.length ? ns.reduce((a, b) => a + b, 0) : null;
};

/** Build the per-call detail from an assembled tree (or straight from span lines). */
export function assembleDetail(tree: TraceTree): RunDetail {
  const all = [...flatten(tree.root), ...tree.orphans.flatMap((o) => flatten(o))];
  const of = (kind: string) => all.filter((n) => n.kind === kind).sort((a, b) => a.start - b.start);
  const generations = of("llm").map(toGeneration);
  const tools = of("tool").map(toToolCall);
  const input = sum(generations.map((g) => g.tokens.input));
  const cacheRead = sum(generations.map((g) => g.tokens.cache_read));
  const firstTtft = generations.map((g) => g.ttft_ms).find((v) => v != null) ?? null;
  return {
    trace_id: tree.traceId,
    span_count: tree.span_count,
    kind_counts: tree.kind_counts,
    services: tree.services,
    duration_ms: tree.duration_ms,
    turn: tree.root ? toOther(tree.root) : null,
    totals: {
      calls: generations.length,
      input_tokens: input,
      output_tokens: sum(generations.map((g) => g.tokens.output)),
      uncached_input_tokens: sum(generations.map((g) => g.tokens.uncached_input)),
      cache_read_tokens: cacheRead,
      cache_creation_tokens: sum(generations.map((g) => g.tokens.cache_creation)),
      cache_read_ratio: input && cacheRead != null ? Math.round((cacheRead / input) * 1000) / 1000 : null,
      cost_usd: sum(generations.map((g) => g.cost_usd)),
      tool_calls: tools.length,
      errors: all.filter((n) => n.status === "error" || n.kind === "error").length,
      ttft_ms: firstTtft,
      total_ms: tree.duration_ms,
      reasoning_tokens_available: false,
      thinking: generations.find((g) => g.thinking)?.thinking ?? null,
    },
    text_captured: generations.some((g) => g.prompt.text != null || g.output.text != null),
    generations,
    tools,
    retrieval: of("retrieval").map(toOther),
    policy: of("policy").map(toOther),
    hitl: of("hitl").map(toOther),
    verifier: of("verifier").map(toOther),
    router: of("router").map(toOther),
    budget: of("budget").map(toOther),
    errors: of("error").map(toOther),
    ui: of("ui").map(toOther),
  };
}

/** Convenience: span lines -> detail for one trace id. */
export const detailFromLines = (lines: SpanLine[], traceId: string): RunDetail => assembleDetail(assembleTree(lines, traceId));
