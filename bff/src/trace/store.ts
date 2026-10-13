/**
 * Cross-request trace glue:
 *  - runId -> traceId index (data/traces/runs.jsonl) so /ops/replay/:runId, feedback and follow-ups
 *    can attach to the turn trace that produced them;
 *  - HITL: a proposal/mandate remembers the trace context and the moment it was shown, and the
 *    decision request (a different HTTP call, maybe minutes later) closes a `hitl` span on that trace.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contextFromTraceparent, endSpan, startKindSpan, tracingActive } from "../otel.js";
import { TRACE_DIR } from "./jsonl.js";

export const RUN_INDEX = join(TRACE_DIR, "runs.jsonl");

export interface RunTrace {
  runId: string;
  traceId: string;
  spanId: string;
  threadId: string;
  plane: string;
  beat: number | null;
  ts: string;
}

const byRun = new Map<string, RunTrace>();
const byThread = new Map<string, RunTrace>();

export function recordRunTrace(r: Omit<RunTrace, "ts">) {
  const row = { ...r, ts: new Date().toISOString() };
  byRun.set(r.runId, row);
  byThread.set(r.threadId, row);
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    appendFileSync(RUN_INDEX, JSON.stringify(row) + "\n");
  } catch {
    /* index is best effort; the CUSTOM trace event in the recorded run still carries the id */
  }
}

let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  if (!existsSync(RUN_INDEX)) return;
  for (const line of readFileSync(RUN_INDEX, "utf-8").split("\n")) {
    try {
      const r = JSON.parse(line) as RunTrace;
      if (!byRun.has(r.runId)) byRun.set(r.runId, r);
    } catch {
      /* skip */
    }
  }
}

export function traceForRun(runId: string | undefined | null): RunTrace | null {
  if (!runId) return null;
  if (byRun.has(runId)) return byRun.get(runId)!;
  load();
  return byRun.get(runId) ?? null;
}

export const lastTraceForThread = (threadId: string) => byThread.get(threadId) ?? null;

export const parentOf = (r: RunTrace | null) => contextFromTraceparent(r ? `00-${r.traceId}-${r.spanId}-01` : null);

// ------------------------------------------------------------------ HITL wait
const shown = new Map<string, { run: RunTrace; at: number; what: string }>();

/** An approval became visible to the human (a proposal or a mandate), inside the given turn. */
export function noteHitlShown(key: string, run: RunTrace | null, what: string) {
  if (run && tracingActive()) shown.set(key, { run, at: Date.now(), what });
}

/** The human decided. Emits a `hitl` span on the originating trace covering shown -> decided. */
export function noteHitlDecided(key: string, decision: string, attrs: Record<string, string | number | boolean | null> = {}) {
  const s = shown.get(key);
  if (!s) return null;
  if (decision !== "undo") shown.delete(key);
  const now = Date.now();
  const span = startKindSpan(`hitl ${s.what} ${decision}`, "hitl", {
    "sparky.hitl.subject": s.what,
    "sparky.hitl.decision": decision,
    "sparky.hitl.wait_ms": now - s.at,
    "sparky.hitl.undo": decision === "undo",
    "sparky.run_id": s.run.runId,
    ...attrs,
  }, { parent: parentOf(s.run), startTime: s.at });
  endSpan(span, {}, null, now);
  // An undo can follow an approval: keep the entry so the undo still lands on the same trace.
  if (decision === "approve") shown.set(key, { ...s, at: now });
  return s.run.traceId;
}
