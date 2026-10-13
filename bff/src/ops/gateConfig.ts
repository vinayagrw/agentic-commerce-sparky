/**
 * B02: thresholds and presenter inputs come from data/coverage.json (gate_config, demo_inputs), which
 * scripts/build_coverage.py reads out of the code that enforces them. Nothing here is typed by hand:
 * when the board is missing, the value is null and the caller must say so.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";

const PATH = join(ROOT, "data", "coverage.json");
let cache: { mtime: number; board: any } | null = null;

function board(): any {
  if (!existsSync(PATH)) return null;
  const mtime = statSync(PATH).mtimeMs;
  if (!cache || cache.mtime !== mtime) {
    try {
      cache = { mtime, board: JSON.parse(readFileSync(PATH, "utf8")) };
    } catch {
      return null;
    }
  }
  return cache.board;
}

export function canaryP95Guardrail(): number | null {
  const v = board()?.gate_config?.canary_guardrail?.p95_ms_le;
  return typeof v === "number" ? v : null;
}

export function injectLatencyMs(): number | null {
  const v = board()?.demo_inputs?.inject_latency_ms;
  return typeof v === "number" ? v : null;
}
