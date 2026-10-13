/**
 * Pure trace helpers: span-tree assembly, recent-trace summaries, browser span batch validation.
 * No I/O here, so every rule is unit-tested in tree.test.ts.
 */
import { createHash } from "node:crypto";
import type { SpanLine } from "./jsonl.js";

export const SPAN_KINDS = ["turn", "router", "llm", "tool", "retrieval", "policy", "hitl", "verifier", "state", "budget", "error", "feedback", "ui"] as const;

export interface SpanNode extends SpanLine {
  duration_ms: number;
  children: SpanNode[];
}

export interface TraceTree {
  traceId: string;
  root: SpanNode | null;
  /** Spans whose parent is not in the file (e.g. a parent from a process that has not flushed yet). */
  orphans: SpanNode[];
  span_count: number;
  kind_counts: Record<string, number>;
  services: string[];
  start: number | null;
  end: number | null;
  duration_ms: number | null;
}

export function assembleTree(lines: SpanLine[], traceId: string): TraceTree {
  const spans = lines.filter((l) => l.traceId === traceId);
  const nodes = new Map<string, SpanNode>();
  for (const s of spans) nodes.set(s.spanId, { ...s, duration_ms: Math.round((s.end - s.start) * 10) / 10, children: [] });
  const tops: SpanNode[] = [];
  for (const n of nodes.values()) {
    const p = n.parentId ? nodes.get(n.parentId) : undefined;
    if (p && p !== n) p.children.push(n);
    else tops.push(n);
  }
  const byStart = (a: SpanNode, b: SpanNode) => a.start - b.start;
  for (const n of nodes.values()) n.children.sort(byStart);
  tops.sort(byStart);
  const rootIdx = tops.findIndex((t) => !t.parentId && t.kind === "turn");
  const root = rootIdx >= 0 ? tops[rootIdx] : tops.find((t) => !t.parentId) ?? null;
  const orphans = tops.filter((t) => t !== root);
  const kind_counts: Record<string, number> = {};
  for (const s of spans) kind_counts[s.kind] = (kind_counts[s.kind] ?? 0) + 1;
  const start = spans.length ? Math.min(...spans.map((s) => s.start)) : null;
  const end = spans.length ? Math.max(...spans.map((s) => s.end)) : null;
  return {
    traceId,
    root,
    orphans,
    span_count: spans.length,
    kind_counts,
    services: [...new Set(spans.map((s) => s.service))].sort(),
    start,
    end,
    duration_ms: start != null && end != null ? Math.round(end - start) : null,
  };
}

export interface TraceSummary {
  traceId: string;
  name: string | null;
  start: number;
  duration_ms: number;
  span_count: number;
  kind_counts: Record<string, number>;
  error_count: number;
  services: string[];
  attrs: Record<string, unknown>;
}

export function summarizeTraces(lines: SpanLine[], limit = 20): TraceSummary[] {
  const by = new Map<string, SpanLine[]>();
  for (const l of lines) {
    const a = by.get(l.traceId);
    if (a) a.push(l);
    else by.set(l.traceId, [l]);
  }
  const out: TraceSummary[] = [];
  for (const [traceId, spans] of by) {
    const root = spans.find((s) => s.kind === "turn" && !s.parentId) ?? null;
    const start = Math.min(...spans.map((s) => s.start));
    const end = Math.max(...spans.map((s) => s.end));
    const kind_counts: Record<string, number> = {};
    for (const s of spans) kind_counts[s.kind] = (kind_counts[s.kind] ?? 0) + 1;
    out.push({
      traceId,
      name: root?.name ?? null,
      start,
      duration_ms: Math.round(end - start),
      span_count: spans.length,
      kind_counts,
      error_count: spans.filter((s) => s.status === "error" || s.kind === "error").length,
      services: [...new Set(spans.map((s) => s.service))].sort(),
      attrs: root ? pick(root.attrs, ["sparky.session", "sparky.surface", "sparky.beat", "sparky.run_id", "sparky.layout"]) : {},
    });
  }
  return out.sort((a, b) => b.start - a.start).slice(0, Math.max(1, Math.min(limit, 200)));
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

// ------------------------------------------------------------------ browser span batches
export const WEB_LIMITS = { maxBody: 64_000, maxSpans: 50, maxAttrs: 24, maxStr: 128, maxNameLen: 80 } as const;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
/** Attribute keys that could carry shopper text: hashed unless OTEL_CAPTURE_CONTENT=1. */
const CONTENT_KEY = /prompt|text|query|content|message|input|answer|comment/i;

const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export type WebBatchResult = { ok: true; spans: SpanLine[] } | { ok: false; error: string };

/** Validate + normalise a browser span batch. Everything the page sends is untrusted. */
export function validateWebBatch(body: unknown, opts: { captureContent?: boolean; now?: number; bodyBytes?: number } = {}): WebBatchResult {
  const now = opts.now ?? Date.now();
  if ((opts.bodyBytes ?? JSON.stringify(body ?? null).length) > WEB_LIMITS.maxBody) return { ok: false, error: `batch larger than ${WEB_LIMITS.maxBody} bytes` };
  const spans = (body as any)?.spans;
  if (!Array.isArray(spans) || !spans.length) return { ok: false, error: "spans must be a non-empty array" };
  if (spans.length > WEB_LIMITS.maxSpans) return { ok: false, error: `at most ${WEB_LIMITS.maxSpans} spans per batch` };
  const out: SpanLine[] = [];
  for (const [i, s] of spans.entries()) {
    if (!s || typeof s !== "object") return { ok: false, error: `span ${i} is not an object` };
    if ((s.kind ?? "ui") !== "ui") return { ok: false, error: `span ${i}: browser spans must have kind "ui"` };
    if (!HEX32.test(String(s.traceId)) || /^0+$/.test(s.traceId)) return { ok: false, error: `span ${i}: traceId must be 32 lowercase hex` };
    if (!HEX16.test(String(s.spanId))) return { ok: false, error: `span ${i}: spanId must be 16 lowercase hex` };
    if (s.parentId != null && !HEX16.test(String(s.parentId))) return { ok: false, error: `span ${i}: parentId must be 16 lowercase hex or null` };
    if (typeof s.name !== "string" || !s.name || s.name.length > WEB_LIMITS.maxNameLen) return { ok: false, error: `span ${i}: name must be 1-${WEB_LIMITS.maxNameLen} chars` };
    const start = Number(s.start);
    const end = Number(s.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return { ok: false, error: `span ${i}: start/end must be epoch ms with end >= start` };
    if (Math.abs(now - start) > 24 * 3600_000 || end - start > 3600_000) return { ok: false, error: `span ${i}: timestamps outside the accepted window` };
    const rawAttrs = s.attrs ?? {};
    if (typeof rawAttrs !== "object" || Array.isArray(rawAttrs)) return { ok: false, error: `span ${i}: attrs must be an object` };
    const entries = Object.entries(rawAttrs);
    if (entries.length > WEB_LIMITS.maxAttrs) return { ok: false, error: `span ${i}: at most ${WEB_LIMITS.maxAttrs} attrs` };
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      if (!/^[a-z0-9_.]{1,64}$/i.test(k)) return { ok: false, error: `span ${i}: bad attr key ${k.slice(0, 40)}` };
      if (typeof v === "number" || typeof v === "boolean") attrs[k] = v;
      else if (typeof v === "string") {
        if (CONTENT_KEY.test(k) && !opts.captureContent) {
          attrs[`${k}.sha256_16`] = sha16(v);
          attrs[`${k}.chars`] = v.length;
        } else attrs[k] = v.slice(0, WEB_LIMITS.maxStr);
      } else return { ok: false, error: `span ${i}: attr ${k} must be string, number or boolean` };
    }
    out.push({
      traceId: s.traceId,
      spanId: s.spanId,
      parentId: s.parentId ?? null,
      name: s.name,
      kind: "ui",
      service: "sparky-web",
      start,
      end,
      attrs,
      status: s.status === "error" ? "error" : s.status === "ok" ? "ok" : "unset",
    });
  }
  return { ok: true, spans: out };
}
