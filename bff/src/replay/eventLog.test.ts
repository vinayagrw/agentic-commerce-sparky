import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns, parseSseFrames, readRun, RunRecorder } from "./eventLog.js";

const frame = (e: Record<string, unknown>) => `data: ${JSON.stringify(e)}\n\n`;

test("parseSseFrames splits complete frames and keeps the partial tail", () => {
  const s = frame({ type: "RUN_STARTED", runId: "r1" }) + frame({ type: "TEXT_MESSAGE_CONTENT", delta: "hi" }) + 'data: {"type":"STATE';
  const [frames, rest] = parseSseFrames(s);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].delta, "hi");
  assert.equal(rest, 'data: {"type":"STATE');
});

test("parseSseFrames skips malformed JSON rather than inventing an event", () => {
  const [frames] = parseSseFrames("data: {not json}\n\n" + frame({ type: "RUN_FINISHED" }));
  assert.deepEqual(frames.map((f) => f.type), ["RUN_FINISHED"]);
});

test("RunRecorder persists events split across writes and indexes the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  const rec = new RunRecorder("fallback", { threadId: "t1", plane: "ops", question: "gate it", beat: 9 }, dir);
  const all = frame({ type: "RUN_STARTED", runId: "run-abc", timestamp: 1000 }) + frame({ type: "TOOL_CALL_START", toolCallName: "x", timestamp: 1250 }) + frame({ type: "RUN_FINISHED", timestamp: 1400 });
  rec.feed(all.slice(0, 30));
  rec.feed(Buffer.from(all.slice(30)));
  const s = rec.close();
  assert.ok(s);
  assert.equal(s!.runId, "run-abc");
  assert.equal(s!.event_count, 3);
  assert.equal(s!.outcome, "finished");
  assert.equal(s!.duration_ms, 400);
  assert.equal(rec.close(), null, "closing twice does not write twice");
  const back = readRun("run-abc", dir);
  assert.equal(back?.events.length, 3);
  assert.equal(back?.events[1].t_ms, 250);
  assert.equal(listRuns(10, dir)[0].question, "gate it");
});

test("readRun refuses unsafe ids and unknown runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  assert.equal(readRun("../etc/passwd", dir), null);
  assert.equal(readRun("nope", dir), null);
});

test("a run with no events is not recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  const rec = new RunRecorder("empty", { threadId: null, plane: "shopper", question: "", beat: null }, dir);
  assert.equal(rec.close(), null);
  assert.equal(listRuns(10, dir).length, 0);
});
