import type { Measured } from "@sparky/shared";
import type { CoverageBoardData, CoverageStatus, Measurement, Technique } from "./types";

/** Verbatim: no rounding, sign kept. String(-0.00015) === "-0.00015". */
export const raw = (v: number | string) => String(v);
export const rawCi = (ci: [number, number]) => `[${raw(ci[0])}, ${raw(ci[1])}]`;

export type ResultFlag = "open" | "negative" | "null";

/** Derived only from the row's own flags and text. `open` = an unresolved security bypass. */
export function flagOf(t: Technique): ResultFlag | null {
  if (/OPEN BYPASS/i.test(t.headline ?? "") || /BYPASS FOUND/i.test(t.verdict ?? "")) return "open";
  if (t.negative_result) return "negative";
  if (t.null_result) return "null";
  return null;
}

export const FLAG_LABEL: Record<ResultFlag, string> = { open: "Open bypass", negative: "Negative result", null: "Null result" };

export const STATUS_ORDER: CoverageStatus[] = ["real-measured", "real-no-metric", "script-ready-not-executed", "absent"];
export const STATUS_LABEL: Record<CoverageStatus, string> = {
  "real-measured": "Measured",
  "real-no-metric": "Runs, no metric",
  "script-ready-not-executed": "Script ready, not run",
  absent: "Absent",
};

/**
 * The number a row leads with. Rules, in order, chosen so a null/negative row leads with the
 * figure its verdict rests on (never a flattering side metric):
 * sealed holdout > kappa > production-path delta > cascade saving > attack success > any delta
 * > state-based pass^k > first numeric value that is not a configured threshold.
 */
const LEAD: RegExp[] = [/sealed|holdout/i, /kappa/i, /delta.*production/i, /saving.*WITH cascade/, /attack success/i, /delta/i, /pass\^k \(state/i];
export function primaryMeasurement(t: Technique): (Measurement & { value: number }) | null {
  const withValue = t.measurements.filter((m): m is Measurement & { value: number } => typeof m.value === "number");
  for (const re of LEAD) {
    const hit = withValue.find((m) => re.test(m.label));
    if (hit) return hit;
  }
  return withValue.find((m) => !/threshold|floor/i.test(m.label)) ?? withValue[0] ?? null;
}

/** Wrap a board number in Measured<> so it can only render with a ProvenanceChip. */
export function measuredOf<V extends number | string>(t: Technique, m: Measurement & { value: V }, board: CoverageBoardData): Measured<V> {
  const src = (t.provenance[0] ?? board.provenance.source).split(" (")[0].split(";")[0];
  return {
    value: m.value,
    provenance: {
      service: "coverage",
      endpoint: src,
      timestamp: board.provenance.generated_at ?? board.provenance.file_mtime,
      note: `${t.provenance.join("\n")}\nServed by ${board.provenance.endpoint}. ${board.provenance.note}`,
    },
  };
}

export function stagesOf(board: CoverageBoardData): string[] {
  const seen: string[] = [];
  for (const t of board.techniques) if (!seen.includes(t.stage)) seen.push(t.stage);
  return seen;
}

/** "1-2 Data" -> { num: "1-2", name: "Data" } */
export function splitStage(stage: string) {
  const m = /^([\d-]+)\s+(.*)$/.exec(stage);
  return m ? { num: m[1], name: m[2] } : { num: "", name: stage };
}
