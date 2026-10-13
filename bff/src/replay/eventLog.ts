/**
 * B14: operator session replay. Persists every AG-UI event a real run streamed, so an operator
 * can replay exactly what the shopper or ops user saw.
 *
 * Additive by design: the AG-UI bridge (bff/src/agui/**) is not edited. `recording()` wraps a
 * Fastify handler and taps `reply.raw.write`, parsing the `data: {...}\n\n` SSE frames the bridge
 * already writes. What is stored is what was sent, byte for byte after JSON parsing: a replay can
 * only show recorded events, never a re-run or a reconstruction.
 *
 * Layout under data/agui_runs/:
 *   index.jsonl          one summary row per run (appended when the run's stream ends)
 *   <runId>.jsonl        one AG-UI event per line, with the ms offset from the first event
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ROOT } from "../config.js";

export const RUNS_DIR = process.env.AGUI_RUNS_DIR ?? join(ROOT, "data", "agui_runs");
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

export interface RecordedEvent {
  seq: number;
  /** ms since the first event of this run */
  t_ms: number;
  event: Record<string, unknown>;
}

export interface RunSummary {
  runId: string;
  threadId: string | null;
  plane: string;
  question: string;
  beat: number | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  event_count: number;
  outcome: "finished" | "error" | "aborted";
  event_types: Record<string, number>;
}

/** Split an SSE byte stream into complete `data:` JSON frames. Returns [frames, leftover]. */
export function parseSseFrames(buffer: string): [Record<string, unknown>[], string] {
  const out: Record<string, unknown>[] = [];
  let rest = buffer;
  let i: number;
  while ((i = rest.indexOf("\n\n")) >= 0) {
    const frame = rest.slice(0, i);
    rest = rest.slice(i + 2);
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const obj = JSON.parse(data);
      if (obj && typeof obj === "object") out.push(obj);
    } catch {
      /* a malformed frame is skipped, not invented */
    }
  }
  return [out, rest];
}

export class RunRecorder {
  readonly events: RecordedEvent[] = [];
  private buf = "";
  private t0: number | null = null;
  private readonly startedAt = new Date();
  private closed = false;

  constructor(
    readonly runId: string,
    readonly meta: { threadId: string | null; plane: string; question: string; beat: number | null },
    private readonly dir = RUNS_DIR,
  ) {}

  feed(chunk: unknown) {
    if (this.closed) return;
    const s = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "";
    if (!s) return;
    const [frames, rest] = parseSseFrames(this.buf + s);
    this.buf = rest;
    for (const ev of frames) {
      const ts = typeof ev.timestamp === "number" ? ev.timestamp : Date.now();
      if (this.t0 == null) this.t0 = ts;
      this.events.push({ seq: this.events.length, t_ms: ts - this.t0, event: ev });
    }
  }

  close(): RunSummary | null {
    if (this.closed) return null;
    this.closed = true;
    if (!this.events.length) return null;
    const types: Record<string, number> = {};
    for (const e of this.events) types[String(e.event.type)] = (types[String(e.event.type)] ?? 0) + 1;
    const outcome: RunSummary["outcome"] = types.RUN_FINISHED ? "finished" : types.RUN_ERROR ? "error" : "aborted";
    const runIdFromStream = this.events.find((e) => e.event.type === "RUN_STARTED")?.event.runId;
    const runId = typeof runIdFromStream === "string" && SAFE_ID.test(runIdFromStream) ? runIdFromStream : this.runId;
    const last = this.events[this.events.length - 1];
    const summary: RunSummary = {
      runId,
      threadId: this.meta.threadId,
      plane: this.meta.plane,
      question: this.meta.question.slice(0, 300),
      beat: this.meta.beat,
      started_at: new Date(this.t0 ?? this.startedAt.getTime()).toISOString(),
      finished_at: new Date((this.t0 ?? this.startedAt.getTime()) + last.t_ms).toISOString(),
      duration_ms: last.t_ms,
      event_count: this.events.length,
      outcome,
      event_types: types,
    };
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, `${runId}.jsonl`), this.events.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    appendFileSync(join(this.dir, "index.jsonl"), JSON.stringify(summary) + "\n", { mode: 0o600 });
    return summary;
  }
}

function lastUserText(body: any): string {
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const m = [...msgs].reverse().find((x) => x?.role === "user");
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join(" ");
  return "";
}

type Handler = (req: FastifyRequest, reply: FastifyReply) => unknown;

/** Wrap an AG-UI handler so every SSE frame it writes is also recorded. The stream itself is untouched. */
export function recording(plane: string, handler: Handler, dir = RUNS_DIR): Handler {
  return async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const replayRunId = randomUUID();
    // The bridge reads this to index replay run id -> trace id (data/traces/runs.jsonl).
    (req as any).replayRunId = replayRunId;
    const rec = new RunRecorder(replayRunId, { threadId: body.threadId ?? null, plane, question: lastUserText(body), beat: Number.isFinite(Number(body?.state?.beat)) ? Number(body.state.beat) : null }, dir);
    const raw = reply.raw;
    const write = raw.write.bind(raw) as (...a: any[]) => boolean;
    (raw as any).write = (chunk: any, ...rest: any[]) => {
      try {
        rec.feed(chunk);
      } catch {
        /* recording must never break the live stream */
      }
      return write(chunk, ...rest);
    };
    raw.once("close", () => {
      try {
        rec.close();
      } catch (e) {
        req.log.warn({ err: e }, "session replay: could not persist run");
      }
    });
    try {
      return await handler(req, reply);
    } finally {
      if (raw.writableEnded) {
        try {
          rec.close();
        } catch (e) {
          req.log.warn({ err: e }, "session replay: could not persist run");
        }
      }
    }
  };
}

export function listRuns(limit = 50, dir = RUNS_DIR): RunSummary[] {
  const p = join(dir, "index.jsonl");
  if (!existsSync(p)) return [];
  const rows: RunSummary[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return rows.reverse().slice(0, limit);
}

export function readRun(runId: string, dir = RUNS_DIR): { summary: RunSummary | null; events: RecordedEvent[] } | null {
  if (!SAFE_ID.test(runId)) return null;
  const p = join(dir, `${runId}.jsonl`);
  if (!existsSync(p)) return null;
  const events = readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RecordedEvent);
  const summary = listRuns(100000, dir).find((r) => r.runId === runId) ?? null;
  return { summary, events };
}

export function runFiles(dir = RUNS_DIR): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl") && f !== "index.jsonl") : [];
}
