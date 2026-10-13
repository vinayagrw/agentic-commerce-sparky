/**
 * In-memory thread store (adapted from trust-graph ask/threadStore.ts, minus the
 * file persistence). Holds per-thread shared agent state, the guard's quarantine
 * memory, prices seen in tool results, and the local cart/mandates used when
 * shop-http is down.
 */
import type { AgentState, CartLine, Plane } from "@sparky/shared";
import { emptyState } from "@sparky/shared";
import { Guard } from "../agents/guard.js";

export interface ThreadCtx {
  threadId: string;
  state: AgentState;
  guard: Guard;
  prices: Map<string, { title: string; price: number; sponsored?: boolean }>;
  localCart: CartLine[];
  localMandates: Map<string, any>;
  lastSearch: any[];
  updatedAt: number;
}

const threads = new Map<string, ThreadCtx>();

export function getThread(threadId: string, plane: Plane = "shopper"): ThreadCtx {
  let t = threads.get(threadId);
  if (!t) {
    t = {
      threadId,
      state: emptyState(plane === "ops" ? 9 : 1, plane),
      guard: new Guard(),
      prices: new Map(),
      localCart: [],
      localMandates: new Map(),
      lastSearch: [],
      updatedAt: Date.now(),
    };
    threads.set(threadId, t);
  }
  t.updatedAt = Date.now();
  return t;
}

export function listThreads() {
  return [...threads.values()].map((t) => ({ threadId: t.threadId, beat: t.state.beat, plane: t.state.plane, updatedAt: t.updatedAt, cartItems: t.state.cart.length }));
}
