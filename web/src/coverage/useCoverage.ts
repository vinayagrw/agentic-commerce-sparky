import { useEffect, useSyncExternalStore } from "react";
import type { CoverageBoardData, CoverageRefusal } from "./types";

type State = { status: "idle" | "loading" } | { status: "ready"; data: CoverageBoardData } | { status: "refused"; refusal: CoverageRefusal; httpStatus: number | null };

let state: State = { status: "idle" };
const subs = new Set<() => void>();
const set = (s: State) => {
  state = s;
  subs.forEach((f) => f());
};

/** One fetch shared by the board, the detail sheet and the command palette. Never substitutes. */
export async function loadCoverage(force = false) {
  if (!force && (state.status === "loading" || state.status === "ready")) return;
  set({ status: "loading" });
  try {
    const r = await fetch("/api/coverage");
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || !Array.isArray(body.techniques)) {
      set({
        status: "refused",
        httpStatus: r.status,
        refusal: body?.error ? body : { error: `GET /api/coverage answered HTTP ${r.status} without a board.`, service: "bff", fix: "make smoke-sota" },
      });
      return;
    }
    set({ status: "ready", data: body as CoverageBoardData });
  } catch (e) {
    set({ status: "refused", httpStatus: null, refusal: { error: `The BFF did not answer GET /api/coverage (${(e as Error).message}).`, service: "bff", endpoint: "GET /api/coverage", fix: "make dev" } });
  }
}

export function useCoverage(): State {
  const s = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
  useEffect(() => {
    void loadCoverage();
  }, []);
  return s;
}
