/**
 * Trace waterfall over GET /api/traces/:traceId (docs/TRACING.md). One row per recorded span, depth-first
 * in parent order: a bar placed by start and sized by duration, coloured by `sparky.kind`, labelled with
 * its service. Kind chips filter rows (and show per-kind counts); clicking a row opens its attributes.
 */
import { useMemo, useState } from "react";
import { Activity, X } from "lucide-react";
import { usePoll } from "@/lib/usePoll";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PanelSkeleton } from "@/components/states";

export interface SpanNode {
  traceId: string;
  spanId: string;
  parentId: string | null;
  name: string;
  kind: string;
  service: string;
  start: number;
  end: number;
  duration_ms: number;
  attrs: Record<string, unknown>;
  status: string;
  events?: unknown[];
  children: SpanNode[];
}
export interface TraceTree {
  ok: boolean;
  traceId: string;
  root: SpanNode | null;
  orphans: SpanNode[];
  span_count: number;
  kind_counts: Record<string, number>;
  services: string[];
  start: number | null;
  duration_ms: number | null;
}

/** Colour per kind, theme tokens only. */
export const KIND_COLOR: Record<string, string> = {
  turn: "var(--fg-subtle)",
  router: "var(--chart-2)",
  llm: "var(--accent)",
  tool: "var(--info)",
  policy: "var(--bad)",
  retrieval: "var(--ok)",
  hitl: "var(--highlight)",
  verifier: "var(--warn)",
  state: "var(--line-strong)",
  budget: "var(--chart-2)",
  error: "var(--bad)",
  feedback: "var(--highlight)",
  ui: "var(--accent-soft-fg)",
};
const colorOf = (k: string) => KIND_COLOR[k] ?? "var(--fg-muted)";

export function flatten(tree: Pick<TraceTree, "root" | "orphans">): { span: SpanNode; depth: number }[] {
  const out: { span: SpanNode; depth: number }[] = [];
  const walk = (n: SpanNode, d: number) => {
    out.push({ span: n, depth: d });
    for (const c of n.children) walk(c, d + 1);
  };
  if (tree.root) walk(tree.root, 0);
  for (const o of tree.orphans) walk(o, 0);
  return out;
}

export function TraceWaterfall({ traceId }: { traceId: string }) {
  const { data, loading, error } = usePoll<TraceTree>(`/api/traces/${encodeURIComponent(traceId)}`, 0);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useMemo(() => (data?.ok ? flatten(data) : []), [data]);

  if (loading && !data) return <PanelSkeleton rows={6} label="Loading trace" />;
  if (error || !data?.ok) return <ErrorState title="Trace unavailable" fix="make dev">{error ?? "No spans recorded for this trace."}</ErrorState>;
  if (!rows.length) return <EmptyState icon={Activity}>No spans recorded for this trace.</EmptyState>;

  const t0 = data.start ?? Math.min(...rows.map((r) => r.span.start));
  const total = Math.max(1, data.duration_ms ?? Math.max(...rows.map((r) => r.span.end)) - t0);
  const kinds = Object.entries(data.kind_counts).sort((a, b) => b[1] - a[1]);
  const visible = rows.filter((r) => !off.has(r.span.kind));
  const sel = rows.find((r) => r.span.spanId === selected)?.span ?? null;
  const toggle = (k: string) =>
    setOff((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div data-testid="trace-waterfall" data-trace-id={data.traceId} className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
        <span className="font-mono text-xs break-all" data-testid="trace-id">trace {data.traceId}</span>
        <span className="tabular">{data.span_count} spans</span>
        <span className="tabular">{(total / 1000).toFixed(2)} s</span>
        <span>{data.services.join(" · ")}</span>
      </div>
      <div role="group" aria-label="Filter spans by kind" className="flex flex-wrap gap-1.5">
        {kinds.map(([k, n]) => {
          const on = !off.has(k);
          return (
            <button
              key={k}
              type="button"
              data-testid="kind-chip"
              data-kind={k}
              aria-pressed={on}
              onClick={() => toggle(k)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
                on ? "border-line-strong bg-surface text-fg" : "border-line bg-surface-sunken text-fg-muted line-through",
              )}
            >
              <span aria-hidden className="size-2.5 rounded-full" style={{ background: colorOf(k) }} />
              {k}
              <span className="tabular text-fg-muted" data-testid="kind-count">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <ol className="m-0 grid min-w-[36rem] list-none p-1" aria-label="Spans">
            {visible.map(({ span: s, depth }) => {
              const left = ((s.start - t0) / total) * 100;
              const width = Math.max(0.4, ((s.end - s.start) / total) * 100);
              const active = s.spanId === selected;
              return (
                <li key={s.spanId}>
                  <button
                    type="button"
                    data-testid="trace-span"
                    data-kind={s.kind}
                    aria-pressed={active}
                    onClick={() => setSelected(active ? null : s.spanId)}
                    className={cn("grid w-full grid-cols-[minmax(10rem,16rem)_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-1 text-left text-xs focus-visible:outline-2 focus-visible:outline-focus", active ? "bg-accent-soft" : "hover:bg-surface-hover")}
                  >
                    <span className="flex min-w-0 flex-col" style={{ paddingLeft: `${Math.min(depth, 8) * 0.6}rem` }}>
                      <span className="truncate font-medium text-fg">{s.name}</span>
                      <span className="truncate text-2xs text-fg-muted">{s.service}</span>
                    </span>
                    <span className="relative h-5 rounded-sm bg-surface-sunken">
                      <span aria-hidden className={cn("absolute top-0.5 bottom-0.5 rounded-sm", s.status === "error" && "outline-2 outline-bad")} style={{ left: `${Math.min(left, 99.6)}%`, width: `${Math.min(width, 100 - Math.min(left, 99.6))}%`, background: colorOf(s.kind) }} />
                      <span className="tabular absolute top-1/2 right-1 -translate-y-1/2 rounded-sm bg-surface/85 px-1 text-2xs text-fg">{s.duration_ms} ms</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
        <aside aria-label="Span attributes" data-testid="span-panel" className="min-w-0 rounded-lg border border-line bg-surface p-3">
          {sel ? (
            <div className="grid gap-2">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{sel.name}</div>
                  <div className="flex flex-wrap gap-1 pt-1">
                    <Badge size="sm">{sel.kind}</Badge>
                    <Badge size="sm" tone="outline">{sel.service}</Badge>
                    <Badge size="sm" tone={sel.status === "error" ? "bad" : "neutral"}>{sel.status}</Badge>
                  </div>
                </div>
                <Button size="icon" variant="ghost" aria-label="Close attributes" onClick={() => setSelected(null)}>
                  <X />
                </Button>
              </div>
              <dl className="m-0 grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-3 gap-y-1">
                {Object.entries({ span_id: sel.spanId, parent_id: sel.parentId, start: new Date(sel.start).toISOString(), duration_ms: sel.duration_ms, ...sel.attrs }).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="font-mono text-2xs break-all text-fg-muted">{k}</dt>
                    <dd className="m-0 min-w-0 font-mono text-2xs break-all text-fg">{v == null ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <p className="m-0 text-sm text-fg-muted">Select a span to see its recorded attributes.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
