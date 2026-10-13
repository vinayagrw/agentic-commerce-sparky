import { Bar, BarChart, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { ChartFrame, useChartTheme } from "@/components/charts/chart";
import { ProvenanceChip } from "@/components/Provenance";
import { cn } from "@/lib/utils";
import type { CoverageBoardData, CoverageStatus } from "./types";
import { STATUS_LABEL, STATUS_ORDER, splitStage, stagesOf } from "./model";

const BAR: Record<CoverageStatus, string> = {
  "real-measured": "bg-ok",
  "real-no-metric": "bg-info",
  "script-ready-not-executed": "bg-warn",
  absent: "bg-line-strong",
};

/** Every count here is read from the board (tally, null_or_negative, total). Nothing is typed in. */
export function SummaryBand({ board, onStatus, onFlagged }: { board: CoverageBoardData; onStatus: (s: CoverageStatus) => void; onFlagged: () => void }) {
  const total = board.total;
  const nn = board.null_or_negative.length;
  const tallySum = STATUS_ORDER.reduce((a, s) => a + (board.tally[s] ?? 0), 0);
  return (
    <section aria-labelledby="summary-h" className="grid gap-4 rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="summary-h" className="m-0 text-md font-semibold">
          <span className="tabular">{total}</span> techniques:{" "}
          {STATUS_ORDER.map((s, i) => (
            <span key={s} className="font-normal text-fg-muted">
              <span className="tabular font-semibold text-fg">{board.tally[s] ?? 0}</span> {STATUS_LABEL[s].toLowerCase()}
              {i < STATUS_ORDER.length - 1 ? ", " : "."}
            </span>
          ))}
        </h2>
        <ProvenanceChip provenance={{ service: board.provenance.service, endpoint: board.provenance.endpoint, timestamp: board.provenance.timestamp, note: `${board.provenance.source} · ${board.provenance.note}` }} />
      </div>
      {tallySum !== total && (
        <p role="alert" className="m-0 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
          The tally sums to {tallySum} but the board says total {total}. The data is inconsistent; rebuild it with make smoke-sota.
        </p>
      )}

      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label={STATUS_ORDER.map((s) => `${board.tally[s] ?? 0} ${STATUS_LABEL[s]}`).join(", ")}>
        {STATUS_ORDER.map((s) => (board.tally[s] ? <div key={s} className={cn(BAR[s], "h-full border-r-2 border-surface last:border-r-0")} style={{ width: `${(board.tally[s] / total) * 100}%` }} /> : null))}
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {STATUS_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onStatus(s)}
            className="group grid content-start gap-1 rounded-lg border border-line p-3 text-left transition-colors hover:border-line-strong hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
              <span className={cn("size-2 rounded-full", BAR[s])} aria-hidden />
              {STATUS_LABEL[s]}
            </span>
            <span className="tabular text-3xl font-semibold tracking-[-0.03em]">{board.tally[s] ?? 0}</span>
            <span className="text-xs text-fg-muted">{board.statuses[s]}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={onFlagged}
          className="col-span-2 grid content-start gap-1 rounded-lg border border-bad/40 bg-bad-soft p-3 text-left transition-colors hover:border-bad focus-visible:outline-2 focus-visible:outline-focus md:col-span-1"
        >
          <span className="text-xs font-semibold tracking-wide text-bad uppercase">Null or negative</span>
          <span className="tabular text-3xl font-semibold tracking-[-0.03em] text-bad">{nn}</span>
          <span className="text-xs text-fg-muted">Results that did not show a gain, reported with the same weight as the ones that did.</span>
        </button>
      </div>

      <StageChart board={board} />
    </section>
  );
}

function StageChart({ board }: { board: CoverageBoardData }) {
  const t = useChartTheme();
  const rows = stagesOf(board).map((stage) => {
    const list = board.techniques.filter((x) => x.stage === stage);
    return {
      stage: splitStage(stage).name,
      ...Object.fromEntries(STATUS_ORDER.map((s) => [s, list.filter((x) => x.status === s).length])),
    };
  });
  const fill: Record<CoverageStatus, string> = { "real-measured": t.color.ok, "real-no-metric": t.color.series[1], "script-ready-not-executed": t.color.warn, absent: t.color.grid };
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs font-medium text-fg-muted select-none hover:text-fg">Status by lifecycle stage</summary>
      <ChartFrame height={Math.max(180, rows.length * 30)} label="Technique status counts by lifecycle stage" className="mt-3">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barCategoryGap={6}>
          <XAxis type="number" allowDecimals={false} {...t.axis} />
          <YAxis type="category" dataKey="stage" width={170} {...t.axis} />
          <RTooltip {...t.tooltip} />
          {STATUS_ORDER.map((s) => (
            <Bar key={s} dataKey={s} name={STATUS_LABEL[s]} stackId="a" fill={fill[s]} />
          ))}
        </BarChart>
      </ChartFrame>
    </details>
  );
}
