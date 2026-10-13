/**
 * Recharts wrapper. Colours come from CSS tokens (theme.css --chart-*, --ok, --bad ...),
 * resolved at runtime and re-resolved when the theme or density changes, so no chart ever
 * hard-codes a hex.
 *
 *   const t = useChartTheme();
 *   <ChartFrame height={200} label="NDCG@10 by arm">
 *     <BarChart data={rows}>
 *       <CartesianGrid {...t.grid} />
 *       <XAxis dataKey="arm" {...t.axis} />
 *       <Tooltip {...t.tooltip} />
 *       <Bar dataKey="v" fill={t.color.series[0]} />
 *     </BarChart>
 *   </ChartFrame>
 */
import * as React from "react";
import { ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";

const TOKENS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-grid", "--chart-axis", "--fg", "--fg-muted", "--surface-raised", "--line", "--ok", "--warn", "--bad", "--accent", "--highlight", "--fs-xs"] as const;

function read(): Record<(typeof TOKENS)[number], string> {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(TOKENS.map((t) => [t, cs.getPropertyValue(t).trim()])) as any;
}

function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-density"] });
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => {
    mo.disconnect();
    mq.removeEventListener("change", cb);
  };
}

export function useChartTheme() {
  const [v, setV] = React.useState(read);
  React.useEffect(() => subscribe(() => setV(read())), []);
  const fontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) * (parseFloat(v["--fs-xs"]) || 0.75);
  return React.useMemo(
    () => ({
      color: {
        series: [v["--chart-1"], v["--chart-2"], v["--chart-3"], v["--chart-4"], v["--chart-5"]],
        ok: v["--ok"],
        warn: v["--warn"],
        bad: v["--bad"],
        accent: v["--accent"],
        highlight: v["--highlight"],
        fg: v["--fg"],
        muted: v["--fg-muted"],
        grid: v["--chart-grid"],
      },
      grid: { stroke: v["--chart-grid"], strokeDasharray: "3 3", vertical: false },
      axis: { tick: { fill: v["--chart-axis"], fontSize }, axisLine: { stroke: v["--chart-grid"] }, tickLine: false as const },
      tooltip: {
        contentStyle: { background: v["--surface-raised"], border: `1px solid ${v["--line"]}`, borderRadius: 8, color: v["--fg"], fontSize },
        labelStyle: { color: v["--fg-muted"] },
        cursor: { fill: v["--chart-grid"], opacity: 0.4 },
      },
      legend: { wrapperStyle: { fontSize, color: v["--fg-muted"] } },
    }),
    [v, fontSize],
  );
}

/** Fixed-height responsive box with an accessible name. */
export function ChartFrame({ height = 200, label, className, children }: { height?: number | string; label: string; className?: string; children: React.ReactElement }) {
  return (
    <div role="img" aria-label={label} className={cn("w-full min-w-0", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}
