/** Tiny external stores: A2UI surfaces (from CUSTOM "a2ui" events) and shared agent state per plane. */
import { useSyncExternalStore } from "react";
import type { A2uiMessage, AgentState, UiHint } from "@sparky/shared";
import { emptyState } from "@sparky/shared";

export interface SurfaceEntry {
  surfaceId: string;
  hint: UiHint;
  messages: A2uiMessage[];
  /** Which CopilotKit agent / BFF thread produced it (HITL actions post back to that thread). */
  agentId?: string;
  threadId?: string | null;
  outcome?: { ok: boolean; message: string; result?: unknown };
}

export type Store<T> = ReturnType<typeof createStore<T>>;

export function createStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T | ((prev: T) => T)) => {
      value = typeof next === "function" ? (next as (p: T) => T)(value) : next;
      subs.forEach((s) => s());
    },
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export const surfaces = createStore<Record<string, SurfaceEntry>>({});
/** Shopper plane state (agent `default`). */
export const agentState = createStore<AgentState>(emptyState());
/** Ops Copilot state (agent `ops`). */
export const opsState = createStore<AgentState>(emptyState(9, "ops"));
/** Surfaces produced outside a chat run (approval follow-ups, latency injection), shown on the dashboard. */
export const opsFeed = createStore<string[]>([]);

/**
 * Per-agent run flag. Lives outside any component so it stays correct while a plane is not
 * mounted (a run that finishes on another route still clears it).
 */
export const runningStore = createStore<Record<string, boolean>>({});
export const setRunning = (agentId: string, r: boolean) => runningStore.set((prev) => (prev[agentId] === r ? prev : { ...prev, [agentId]: r }));

export const stateStoreFor =(agentId: string) => (agentId === "ops" ? opsState : agentState);

export function upsertSurface(e: SurfaceEntry) {
  surfaces.set((prev) => (prev[e.surfaceId] ? prev : { ...prev, [e.surfaceId]: e }));
}

export function setOutcome(surfaceId: string, outcome: SurfaceEntry["outcome"]) {
  surfaces.set((prev) => (prev[surfaceId] ? { ...prev, [surfaceId]: { ...prev[surfaceId], outcome } } : prev));
}

export function useStore<T>(store: { get: () => T; subscribe: (fn: () => void) => () => void }): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
