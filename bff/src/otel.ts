/**
 * Technique 29, half one: OpenTelemetry GenAI tracing from the BFF.
 *
 * Spans follow the OTel GenAI semantic conventions (still Development status upstream, so the
 * attribute names are isolated here in ATTR and nowhere else in the codebase - when the spec
 * moves, this file moves). Custom attributes the playbook asks for are added alongside:
 * `prompt.version`, `graph.hash`, `surface`, `mission.type`.
 *
 * Export: a local JSONL file sink (data/traces/YYYY-MM-DD.jsonl, see trace/jsonl.ts) is ON by
 * default (TRACE_FILE=0 disables it). OTLP/HTTP to a collector (default http://127.0.0.1:4318, a
 * local Jaeger) is optional and only added when OTEL_ENABLED=1, so nothing depends on a container.
 * Every span carries `sparky.kind` (turn, router, llm, tool, ...): see docs/TRACING.md.
 *
 * Redaction (playbook 29 US-2 AC1) happens BEFORE any attribute is set: the span carries
 * lengths and hashes of prompts, never the raw shopper text, unless OTEL_CAPTURE_CONTENT=1
 * is set explicitly for a local debugging session.
 */
import { createHash } from "node:crypto";
import { context, propagation, ROOT_CONTEXT, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import { JsonlSpanExporter, TRACE_DIR } from "./trace/jsonl.js";

export const OTEL_ENABLED = process.env.OTEL_ENABLED === "1";
/** JSONL file sink, on by default. Switchable at runtime (setTraceFile) for the overhead bench. */
let traceFileOn = process.env.TRACE_FILE !== "0";
export const KIND = "sparky.kind";
export const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318";
export const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "sparky-bff";
const CAPTURE_CONTENT = process.env.OTEL_CAPTURE_CONTENT === "1";
/**
 * Text capture for the LLM observability panel (Inspector -> Trace). ON by default, separate from
 * OTEL_CAPTURE_CONTENT: TRACE_CAPTURE=0 turns it off. Captured text is masked (emails, long digit
 * runs, secret-like tokens) and truncated to MAX_TEXT_BYTES before it reaches a span attribute.
 * It is written ONLY to spans (data/traces); the token ledger never carries text.
 */
let traceCaptureOn = process.env.TRACE_CAPTURE !== "0";
export const captureText = () => traceCaptureOn;
export function setTraceCapture(on: boolean) {
  traceCaptureOn = on;
}
/** ~8 KB per text field. */
export const MAX_TEXT_BYTES = 8192;

const MASKS: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b(?:sk|pk|rk|ghp|gho|xox[abposr])[-_][A-Za-z0-9_-]{16,}\b/g, "[secret]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[secret]"],
  [/\d[\d ._-]{10,}\d/g, "[number]"],
];

/** Mask PII-ish and secret-like substrings. Pure, exported for the masker unit test. */
export function maskText(text: string): string {
  let out = text;
  for (const [re, tag] of MASKS) out = out.replace(re, tag);
  return out;
}

/** Mask + truncate one text field into span attributes under `prefix`. */
export function textAttrs(prefix: string, text: string | null | undefined): Record<string, any> {
  if (!text) return {};
  const masked = maskText(text);
  const truncated = masked.length > MAX_TEXT_BYTES;
  return {
    [`${prefix}.text`]: truncated ? masked.slice(0, MAX_TEXT_BYTES) : masked,
    [`${prefix}.text_truncated`]: truncated,
  };
}

/** The only place OTel GenAI attribute names appear. */
export const ATTR = {
  system: "gen_ai.system",
  providerName: "gen_ai.provider.name",
  operation: "gen_ai.operation.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  toolName: "gen_ai.tool.name",
  conversationId: "gen_ai.conversation.id",
} as const;

let sdk: any = null;
let started = false;

let processors: any[] = [];

export async function startTracing(): Promise<{ enabled: boolean; endpoint?: string; file?: string; error?: string }> {
  if (!OTEL_ENABLED && !traceFileOn) return { enabled: false };
  if (started) return { enabled: true, endpoint: OTEL_ENABLED ? OTEL_ENDPOINT : undefined, file: TRACE_DIR };
  try {
    const [{ NodeSDK }, { resourceFromAttributes }, { BatchSpanProcessor }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/sdk-trace-base"),
    ]);
    processors = [new BatchSpanProcessor(new JsonlSpanExporter(SERVICE_NAME, () => traceFileOn) as any, { scheduledDelayMillis: 250 })];
    if (OTEL_ENABLED) {
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
      processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: `${OTEL_ENDPOINT}/v1/traces` }), { scheduledDelayMillis: 500 }));
    }
    sdk = new NodeSDK({
      resource: resourceFromAttributes({ "service.name": SERVICE_NAME, "deployment.environment.name": "laptop" }),
      spanProcessors: processors,
      instrumentations: [],
    });
    sdk.start();
    started = true;
    return { enabled: true, endpoint: OTEL_ENABLED ? OTEL_ENDPOINT : undefined, file: TRACE_DIR };
  } catch (e) {
    return { enabled: false, error: String((e as Error)?.message ?? e) };
  }
}

export async function stopTracing() {
  if (sdk && started) {
    try {
      await sdk.shutdown();
    } catch {
      /* shutdown is best effort; never fail a request over telemetry */
    }
    started = false;
  }
}

/** True when spans are being recorded somewhere. Every span helper is a no-op otherwise. */
export const tracingActive = () => started && (OTEL_ENABLED || traceFileOn);
export const traceFileEnabled = () => traceFileOn;
/** Runtime switch for the JSONL sink (POST /api/traces/config). With OTLP off this turns span creation off too. */
export function setTraceFile(on: boolean) {
  traceFileOn = on;
}
export async function flushTracing() {
  await Promise.all(processors.map((p) => p.forceFlush?.().catch(() => undefined)));
}

export const tracer = () => trace.getTracer("sparky-bff", "0.1.0");

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Redaction: hash and length by default; raw text only behind an explicit opt-in. */
export const captureContent = () => CAPTURE_CONTENT;
export function redact(text: string | undefined | null, prefix = "sparky.prompt"): Record<string, any> {
  if (!text) return {};
  const out: Record<string, any> = { [`${prefix}.sha256_16`]: sha(text), [`${prefix}.chars`]: text.length };
  if (CAPTURE_CONTENT || traceCaptureOn) Object.assign(out, textAttrs(prefix, text));
  return out;
}
export const sha256_16 = sha;

export interface GenAiSpanOpts {
  operation: "chat" | "invoke_agent" | "execute_tool" | "embeddings" | "retrieve";
  system?: string;
  model?: string;
  conversationId?: string;
  toolName?: string;
  /** Playbook 29 step 1 custom attributes. */
  promptVersion?: string;
  graphHash?: string;
  surface?: string;
  missionType?: string;
  prompt?: string;
  extra?: Record<string, any>;
}

/** Run `fn` inside a GenAI span. A no-op (beyond calling fn) when tracing is disabled. */
export async function withGenAiSpan<T>(name: string, opts: GenAiSpanOpts, fn: (span: Span | null) => Promise<T>): Promise<T> {
  if (!tracingActive()) return fn(null);
  return tracer().startActiveSpan(name, async (span) => {
    span.setAttributes({
      [KIND]: opts.operation === "execute_tool" ? "tool" : opts.operation === "retrieve" || opts.operation === "embeddings" ? "retrieval" : opts.operation === "invoke_agent" ? "router" : "llm",
      [ATTR.operation]: opts.operation,
      ...(opts.system ? { [ATTR.system]: opts.system, [ATTR.providerName]: opts.system } : {}),
      ...(opts.model ? { [ATTR.requestModel]: opts.model } : {}),
      ...(opts.conversationId ? { [ATTR.conversationId]: opts.conversationId } : {}),
      ...(opts.toolName ? { [ATTR.toolName]: opts.toolName } : {}),
      ...(opts.promptVersion ? { "prompt.version": opts.promptVersion } : {}),
      ...(opts.graphHash ? { "graph.hash": opts.graphHash } : {}),
      ...(opts.surface ? { surface: opts.surface } : {}),
      ...(opts.missionType ? { "mission.type": opts.missionType } : {}),
      ...redact(opts.prompt),
      ...(opts.extra ?? {}),
    });
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String((e as Error)?.message ?? e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Attach measured usage to the active span after a model call returns. */
export function recordUsage(span: Span | null, u: { model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number; ms?: number }) {
  if (!span) return;
  span.setAttributes({
    ...(u.model ? { [ATTR.responseModel]: u.model } : {}),
    ...(u.inputTokens != null ? { [ATTR.inputTokens]: u.inputTokens } : {}),
    ...(u.outputTokens != null ? { [ATTR.outputTokens]: u.outputTokens } : {}),
    ...(u.costUsd != null ? { "sparky.cost_usd": u.costUsd } : {}),
    ...(u.ms != null ? { "sparky.latency_ms": u.ms } : {}),
  });
}

export function currentTraceId(): string | null {
  const s = trace.getSpan(context.active());
  return s ? s.spanContext().traceId : null;
}

// ------------------------------------------------------------------ sparky.kind span helpers
type AttrVal = string | number | boolean | string[] | number[] | null | undefined;
/** Drop null/undefined and non-primitive values: attributes must be OTel-legal and never whole objects (redaction). */
export function cleanAttrs(a: Record<string, AttrVal>): Record<string, string | number | boolean | string[] | number[]> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(a)) {
    if (v == null) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    if (Array.isArray(v)) out[k] = v.slice(0, 50);
    else if (typeof v === "string") out[k] = v.slice(0, k.endsWith(".text") ? MAX_TEXT_BYTES : 256);
    else out[k] = v;
  }
  return out;
}

/** Start (not activate) a span of a sparky kind. Returns null when tracing is inactive. */
export function startKindSpan(name: string, kind: string, attrs: Record<string, AttrVal> = {}, opts: { parent?: Context; startTime?: number } = {}): Span | null {
  if (!tracingActive()) return null;
  return tracer().startSpan(name, { attributes: cleanAttrs({ ...attrs, [KIND]: kind }), ...(opts.startTime ? { startTime: opts.startTime } : {}) }, opts.parent ?? context.active());
}

export function endSpan(span: Span | null, attrs: Record<string, AttrVal> = {}, error?: string | null, endTime?: number) {
  if (!span || !span.isRecording()) return;
  span.setAttributes(cleanAttrs(attrs));
  span.setStatus(error ? { code: SpanStatusCode.ERROR, message: error.slice(0, 200) } : { code: SpanStatusCode.OK });
  span.end(endTime);
}

/** Run fn with a new ACTIVE span of a sparky kind, so nested spans and traceparent injection parent to it. */
export async function withKindSpan<T>(name: string, kind: string, attrs: Record<string, AttrVal>, fn: (span: Span | null) => Promise<T>, parent?: Context): Promise<T> {
  const span = startKindSpan(name, kind, attrs, { parent });
  if (!span) return fn(null);
  const ctx = trace.setSpan(parent ?? context.active(), span);
  try {
    const out = await context.with(ctx, () => fn(span));
    if (span.isRecording()) endSpan(span);
    return out;
  } catch (e) {
    endSpan(span, {}, String((e as Error)?.message ?? e));
    throw e;
  }
}

/** A zero-duration span of a kind (router decisions, feedback events). */
export function markSpan(name: string, kind: string, attrs: Record<string, AttrVal>, parent?: Context, error?: string | null) {
  const s = startKindSpan(name, kind, attrs, { parent });
  endSpan(s, {}, error);
  return s;
}

/** W3C traceparent for a span (or the active one). */
export function traceparentOf(span?: Span | null): string | null {
  const s = span ?? trace.getSpan(context.active());
  if (!s) return null;
  const c = s.spanContext();
  return `00-${c.traceId}-${c.spanId}-${(c.traceFlags & 1).toString(16).padStart(2, "0")}`;
}

/** Context whose parent is the remote span in a traceparent (null-safe: bad input gives ROOT_CONTEXT). */
export function contextFromTraceparent(tp: string | null | undefined): Context {
  if (!tp || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(tp)) return ROOT_CONTEXT;
  const [, traceId, spanId, flags] = tp.split("-");
  return trace.setSpanContext(ROOT_CONTEXT, { traceId, spanId, traceFlags: parseInt(flags, 16), isRemote: true });
}

export const contextWithSpan = (span: Span | null, base: Context = context.active()) => (span ? trace.setSpan(base, span) : base);
export { context as otelContext, propagation };

export function status() {
  return {
    enabled: OTEL_ENABLED,
    file_sink: traceFileOn,
    file_dir: TRACE_DIR,
    active: tracingActive(),
    started,
    endpoint: OTEL_ENABLED ? OTEL_ENDPOINT : null,
    service_name: SERVICE_NAME,
    capture_content: CAPTURE_CONTENT,
    capture_text: traceCaptureOn,
    capture_text_max_bytes: MAX_TEXT_BYTES,
    capture_text_env: "TRACE_CAPTURE (default 1)",
    ui: OTEL_ENABLED ? "http://127.0.0.1:16686" : null,
    conventions: "OpenTelemetry GenAI semantic conventions (Development status); names isolated in bff/src/otel.ts ATTR",
  };
}
