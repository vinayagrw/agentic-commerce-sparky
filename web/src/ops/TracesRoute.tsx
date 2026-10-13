/**
 * /ops/traces: recent traces from GET /api/traces; /ops/traces/:traceId: that trace's waterfall.
 * Both read the local JSONL span store (docs/TRACING.md); nothing is synthesised.
 */
import { Link, useParams } from "react-router";
import { Activity } from "lucide-react";
import { usePoll } from "@/lib/usePoll";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, PanelSkeleton } from "@/components/states";
import { TraceWaterfall } from "./TraceWaterfall";

interface TraceSummary {
  traceId: string;
  name: string | null;
  start: number;
  duration_ms: number;
  span_count: number;
  kind_counts: Record<string, number>;
  error_count: number;
  services: string[];
  attrs: Record<string, unknown>;
}

function TraceList() {
  const { data, loading, error } = usePoll<{ traces: TraceSummary[] }>("/api/traces?limit=50", 15000);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 text-fg-subtle" aria-hidden /> Recent traces
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && !data ? (
          <PanelSkeleton rows={5} label="Loading traces" />
        ) : error && !data ? (
          <ErrorState title="Traces unavailable" fix="make dev">{error}</ErrorState>
        ) : !data?.traces.length ? (
          <EmptyState icon={Activity}>No traces recorded yet. Run a shopper or ops turn with TRACE_FILE on.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="trace-list">
              <TableHeader>
                <TableRow>
                  <TableHead>started</TableHead>
                  <TableHead>root</TableHead>
                  <TableHead>layout</TableHead>
                  <TableHead>spans</TableHead>
                  <TableHead>duration</TableHead>
                  <TableHead>kinds</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.traces.map((t) => (
                  <TableRow key={t.traceId} data-testid="trace-row">
                    <TableCell className="text-xs whitespace-nowrap">
                      <Link to={`/ops/traces/${t.traceId}`} className="text-accent">{new Date(t.start).toLocaleString()}</Link>
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{t.name ?? <span className="text-fg-muted">(no turn root)</span>}</TableCell>
                    <TableCell className="font-mono text-xs">{String(t.attrs["sparky.layout"] ?? "—")}</TableCell>
                    <TableCell className="tabular text-sm">{t.span_count}{t.error_count ? <Badge size="sm" tone="bad" className="ml-1.5">{t.error_count} err</Badge> : null}</TableCell>
                    <TableCell className="tabular text-sm">{(t.duration_ms / 1000).toFixed(1)} s</TableCell>
                    <TableCell className="max-w-[40ch] truncate font-mono text-2xs text-fg-muted">{Object.entries(t.kind_counts).map(([k, n]) => `${k} ${n}`).join(" · ")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Component() {
  const { traceId } = useParams();
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-[90rem] gap-4 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 text-2xl font-semibold tracking-[-0.02em]">{traceId ? "Trace" : "Traces"}</h1>
          {traceId && <Link to="/ops/traces" className="text-sm text-accent-soft-fg underline-offset-4 hover:underline">All traces</Link>}
          <Link to="/ops/replay" className="text-sm text-accent-soft-fg underline-offset-4 hover:underline">Session replay</Link>
          <Link to="/ops/1" className="ml-auto text-sm text-accent-soft-fg underline-offset-4 hover:underline">Back to Ops</Link>
        </header>
        {traceId ? (
          <Card>
            <CardContent className="pt-4">
              <TraceWaterfall traceId={traceId} />
            </CardContent>
          </Card>
        ) : (
          <TraceList />
        )}
      </div>
    </div>
  );
}
