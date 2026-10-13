/**
 * Per-turn run timeline built from the AG-UI events the agent actually streamed
 * (RUN_STARTED, STEP_STARTED/FINISHED, TOOL_CALL_START/ARGS/RESULT, RUN_FINISHED/ERROR) plus the
 * shared-state cost/tokens delta. Nothing here is estimated: a missing event means a missing row.
 */
import { createStore } from "../store";

export interface ToolRow {
  id: string;
  name: string;
  args: string;
  result: string;
  t0: number;
  ms: number | null;
  ok: boolean | null;
}

export interface StepRow {
  name: string;
  t0: number;
  ms: number | null;
}

export interface RunRecord {
  runId: string;
  agentId: string;
  /** id of the user message that started this turn */
  userMessageId: string | null;
  question: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "done" | "error" | "stopped";
  error?: string;
  steps: StepRow[];
  tools: ToolRow[];
  costStart: number;
  costUsd: number | null;
  tokens: { input: number; output: number } | null;
  tokensStart: { input: number; output: number };
  critic: { verdict: string; note?: string } | null;
  productIds: string[];
  /** Planner / Critic / CaMeL role output as it streamed (CUSTOM role_stream / role_summary). */
  roles?: { role: string; text: string; summary?: string }[];
  /** Answer badge from CUSTOM answer_verdict: checked (Critic pass), revised (Critic fail), unchecked. */
  verdict?: { verdict: "checked" | "revised" | "unchecked"; note?: string; issues?: string[]; messageIds: string[] } | null;
  /** Text message ids of the revised answer (CUSTOM answer_revised). */
  revisedIds?: string[];
  /** Session budget notice (CUSTOM budget): economy mode or paused. */
  budget?: { mode: "economy" | "exhausted"; message: string; spent_usd: number; budget_usd: number } | null;
  /** Wall clock when the first answer token arrived. */
  firstTokenAt?: number | null;
  /** From CUSTOM `trace`: the turn's traceId (docs/TRACING.md) and its replay run id. */
  traceId?: string | null;
  replayRunId?: string | null;
}

export function appendRole(r: RunRecord, role: string, delta: string, summary?: string): RunRecord {
  const roles = [...(r.roles ?? [])];
  const last = roles[roles.length - 1];
  if (last && last.role === role && last.summary == null) roles[roles.length - 1] = { ...last, text: last.text + delta, ...(summary != null ? { summary } : {}) };
  else if (summary != null && last?.role === role) roles[roles.length - 1] = { ...last, summary };
  else roles.push({ role, text: delta, ...(summary != null ? { summary } : {}) });
  return { ...r, roles };
}

export const runsStore = createStore<Record<string, RunRecord[]>>({});

export function updateRun(agentId: string, runId: string, fn: (r: RunRecord) => RunRecord) {
  runsStore.set((prev) => {
    const list = prev[agentId] ?? [];
    const i = list.findIndex((r) => r.runId === runId);
    if (i < 0) return prev;
    const next = [...list];
    next[i] = fn(list[i]);
    return { ...prev, [agentId]: next };
  });
}

export function addRun(r: RunRecord) {
  runsStore.set((prev) => ({ ...prev, [r.agentId]: [...(prev[r.agentId] ?? []), r].slice(-30) }));
}

export const currentRun = (agentId: string) => {
  const l = runsStore.get()[agentId] ?? [];
  return l[l.length - 1];
};

/** Product ids mentioned in a tool result (search results, product, compare), for citations. */
export function productIdsIn(content: string): string[] {
  const ids = new Set<string>();
  for (const m of content.matchAll(/\\?"product_id\\?"\s*:\s*\\?"([A-Z0-9]{10})/g)) ids.add(m[1]);
  return [...ids].slice(0, 6);
}
