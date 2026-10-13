/**
 * Trace API over the local JSONL store (docs/TRACING.md):
 *   POST /api/traces/web         browser span batch (kind "ui"), validated + capped
 *   GET  /api/traces?limit=      recent trace summaries
 *   GET  /api/traces/:traceId    assembled span tree + per-kind counts
 *   GET  /api/traces/run/:runId  replay run id -> trace id; ?detail=full adds the per-call detail
 *                                (generations, tool calls, retrieval/policy/hitl/verifier spans)
 *   GET  /api/traces/config      current tracing + text-capture state
 *   POST /api/traces/config      {file?: boolean, capture?: boolean} runtime switches (localhost only)
 */
import type { FastifyInstance } from "fastify";
import { captureContent, flushTracing, setTraceCapture, setTraceFile, status } from "../otel.js";
import { appendSpans, readSpans, TRACE_DIR } from "./jsonl.js";
import { traceForRun } from "./store.js";
import { assembleDetail } from "./detail.js";
import { assembleTree, summarizeTraces, validateWebBatch, WEB_LIMITS } from "./tree.js";

const prov = (endpoint: string) => ({ service: "bff", endpoint, source: "data/traces/*.jsonl", timestamp: new Date().toISOString() });

export function registerTraceRoutes(app: FastifyInstance) {
  app.post("/api/traces/web", { bodyLimit: WEB_LIMITS.maxBody }, async (req, reply) => {
    if (!status().file_sink) return reply.code(409).send({ ok: false, error: "trace file sink is off (TRACE_FILE=0)" });
    const r = validateWebBatch(req.body, { captureContent: captureContent(), bodyBytes: Number(req.headers["content-length"] ?? 0) || undefined });
    if (!r.ok) return reply.code(400).send({ ok: false, error: r.error });
    appendSpans(r.spans);
    return { ok: true, accepted: r.spans.length };
  });

  app.get("/api/traces", async (req) => {
    await flushTracing();
    const limit = Math.max(1, Math.min(Number((req.query as any)?.limit ?? 20) || 20, 200));
    const traces = summarizeTraces(readSpans(), limit);
    return { traces, tracing: status(), provenance: prov("GET /api/traces") };
  });

  app.get("/api/traces/run/:runId", async (req, reply) => {
    const r = traceForRun((req.params as any).runId);
    if (!r) return reply.code(404).send({ ok: false, error: "no trace recorded for this run (tracing off, or a run from before tracing)" });
    const base = { ok: true, ...r, provenance: { ...prov("GET /api/traces/run/:runId"), source: "data/traces/runs.jsonl" } };
    if (String((req.query as any)?.detail ?? "") !== "full") return base;
    await flushTracing();
    const traceId = String((r as any).trace_id ?? (r as any).traceId ?? "");
    if (!/^[0-9a-f]{32}$/.test(traceId)) return reply.code(404).send({ ok: false, error: "run row carries no trace id" });
    const detail = assembleDetail(assembleTree(readSpans(TRACE_DIR, (l) => l.traceId === traceId), traceId));
    if (!detail.span_count) return reply.code(404).send({ ok: false, error: `no spans for trace ${traceId}` });
    return { ...base, detail, tracing: status(), provenance: { ...prov("GET /api/traces/run/:runId?detail=full"), source: "data/traces/*.jsonl" } };
  });

  app.get("/api/traces/config", async () => ({ ok: true, tracing: status(), provenance: prov("GET /api/traces/config") }));

  app.get("/api/traces/:traceId", async (req, reply) => {
    const traceId = String((req.params as any).traceId ?? "");
    if (!/^[0-9a-f]{32}$/.test(traceId)) return reply.code(400).send({ ok: false, error: "traceId must be 32 lowercase hex" });
    await flushTracing();
    const tree = assembleTree(readSpans(TRACE_DIR, (l) => l.traceId === traceId), traceId);
    if (!tree.span_count) return reply.code(404).send({ ok: false, error: `no spans for trace ${traceId}` });
    return { ok: true, ...tree, provenance: prov("GET /api/traces/:traceId") };
  });

  app.post("/api/traces/config", async (req, reply) => {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip)) return reply.code(403).send({ ok: false, error: "localhost only" });
    const body = (req.body ?? {}) as { file?: unknown; capture?: unknown };
    if (typeof body.file !== "boolean" && typeof body.capture !== "boolean") return reply.code(400).send({ ok: false, error: "body must carry {file: boolean} and/or {capture: boolean}" });
    await flushTracing();
    if (typeof body.file === "boolean") setTraceFile(body.file);
    if (typeof body.capture === "boolean") setTraceCapture(body.capture);
    return { ok: true, tracing: status() };
  });
}
