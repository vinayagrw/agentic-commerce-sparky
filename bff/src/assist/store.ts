/**
 * Per-session assistant state (Wave 0b): memory, HITL pending actions + audit, watches +
 * notifications, the editable mission plan. Persisted to data/assist_state.json so memory and
 * watches survive a bff restart. Added to SessionView as new top-level keys (additive only).
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../config.js";
import type { AuditEntry, MemoryItem, MissionPlan, Notification, PendingAction, Watch } from "./logic.js";

export interface AssistState {
  memory: MemoryItem[];
  pending_actions: PendingAction[];
  audit: AuditEntry[];
  watches: Watch[];
  notifications: Notification[];
  plan: MissionPlan | null;
}

export const ASSIST_PATH = process.env.ASSIST_STATE_PATH ?? join(ROOT, "data", "assist_state.json");
export const FEEDBACK_PATH = process.env.FEEDBACK_PATH ?? join(ROOT, "data", "online_feedback.jsonl");

let all: Record<string, AssistState> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function load() {
  if (all) return all;
  try {
    all = JSON.parse(readFileSync(ASSIST_PATH, "utf-8"));
  } catch {
    all = {};
  }
  return all!;
}

export function assistFor(sid: string): AssistState {
  const db = load();
  db[sid] ??= { memory: [], pending_actions: [], audit: [], watches: [], notifications: [], plan: null };
  return db[sid];
}

export function allSessions(): [string, AssistState][] {
  return Object.entries(load());
}

export function saveSoon() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      mkdirSync(dirname(ASSIST_PATH), { recursive: true });
      writeFileSync(ASSIST_PATH, JSON.stringify(load()), { mode: 0o600 });
    } catch {
      /* disk issue: state stays in memory for this process */
    }
  }, 250);
}

export function assistView(sid: string) {
  const a = assistFor(sid);
  return {
    memory: a.memory,
    pending_actions: a.pending_actions.slice(-20),
    audit: a.audit.slice(-30),
    watches: a.watches,
    notifications: a.notifications.slice(-20),
    plan: a.plan,
  };
}

export function appendFeedback(sample: object) {
  mkdirSync(dirname(FEEDBACK_PATH), { recursive: true });
  appendFileSync(FEEDBACK_PATH, JSON.stringify(sample) + "\n");
}
