/**
 * Runtime: measured run metrics per model arm (GET /api/metrics, sampled from real runs in this
 * BFF process) and the OpenTelemetry GenAI tracing status (GET /api/ops/tracing).
 */
import { Gauge, Waypoints } from "lucide-react";
import type { Provenance } from "@sparky/shared";
import { cn } from "@/lib/utils";
import { usePoll } from "@/lib/usePoll";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProvenanceChip, Stat } from "@/components/Provenance";
import { EmptyState, ErrorState, PanelSkeleton } from "@/components/states";

interface ArmStats {
  n: number;
  p50_ms: number | null;
  p95_ms: number | null;
  mean_cost_usd: number | null;
  total_cost_usd: number;
  total_tokens: { input: number; output: number };
  last_at: string | null;
}

interface Tracing {
  enabled: boolean;
  started: boolean;
  endpoint: string | null;
  service_name: string;
  capture_content: boolean;
  ui: string | null;
  conventions: string;
  startup?: { enabled: boolean; endpoint?: string; error?: string };
}

/** A cell value: a Stat when measured, the reason when not. */
function Cell({ v, prov, format, label, reason }: { v: number | null | undefined; prov: Provenance; format: (n: number) => string; label: string; reason: string }) {
  return typeof v === "number" && Number.isFinite(v) ? <Stat inline hideChip label={label} value={{ value: v, provenance: prov }} format={format} /> : <span className="text-xs text-fg-subtle">{reason}</span>;
}

export function RuntimePanel({ className }: { className?: string }) {
  const metrics = usePoll<Record<string, ArmStats | Provenance> & { provenance: Provenance }>("/api/metrics", 10_000);
  const tracing = usePoll<Tracing>("/api/ops/tracing", 30_000);
  const prov = metrics.data?.provenance;
  const arms = Object.entries(metrics.data ?? {}).filter(([k, v]) => k !== "provenance" && v && typeof v === "object" && "n" in v) as [string, ArmStats][];

  return (
    <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]", className)}>
      <Card className="min-w-0">
        <CardHeader className="items-center pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4 text-fg-subtle" aria-hidden />
            Measured run metrics
          </CardTitle>
          {prov && <ProvenanceChip compact provenance={prov} />}
        </CardHeader>
        <CardContent>
          {metrics.loading && !metrics.data ? (
            <PanelSkeleton rows={3} label="Loading run metrics" />
          ) : metrics.error && !metrics.data ? (
            <ErrorState title="Run metrics unavailable" fix="make dev">
              {metrics.error}
            </ErrorState>
          ) : !prov || arms.every(([, a]) => a.n === 0) ? (
            <EmptyState icon={Gauge}>No measured runs yet. Run a shopper beat, then 8c, to sample latency and cost.</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>arm</TableHead>
                  <TableHead className="text-right">runs</TableHead>
                  <TableHead>p50</TableHead>
                  <TableHead>p95</TableHead>
                  <TableHead>mean cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {arms.map(([name, a]) => (
                  <TableRow key={name}>
                    <TableCell className="font-mono text-xs">{name}</TableCell>
                    <TableCell className="text-right">
                      <Cell v={a.n} prov={prov} format={String} label="runs" reason="—" />
                    </TableCell>
                    <TableCell>
                      <Cell v={a.p50_ms} prov={prov} format={(n) => `${n} ms`} label="p50" reason="no samples" />
                    </TableCell>
                    <TableCell>
                      <Cell v={a.p95_ms} prov={prov} format={(n) => `${n} ms`} label="p95" reason="no samples" />
                    </TableCell>
                    <TableCell>
                      <Cell v={a.mean_cost_usd} prov={prov} format={(n) => `$${n.toFixed(4)}`} label="mean cost" reason={a.n ? "not reported" : "no samples"} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader className="items-center pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Waypoints className="size-4 text-fg-subtle" aria-hidden />
            Tracing
          </CardTitle>
          {tracing.data && <Badge size="sm" tone={tracing.data.started ? "ok" : "neutral"}>{tracing.data.started ? "exporting" : "off"}</Badge>}
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {tracing.loading && !tracing.data ? (
            <PanelSkeleton rows={3} label="Loading tracing status" />
          ) : tracing.error && !tracing.data ? (
            <ErrorState title="Tracing status unavailable">{tracing.error}</ErrorState>
          ) : tracing.data ? (
            <>
              {tracing.data.enabled ? (
                <p className="m-0">
                  OTel GenAI spans from <span className="font-mono">{tracing.data.service_name}</span> to <span className="font-mono">{tracing.data.endpoint}</span>.
                  {tracing.data.ui && (
                    <>
                      {" "}
                      View in{" "}
                      <a className="text-accent underline-offset-4 hover:underline" href={tracing.data.ui} target="_blank" rel="noreferrer">
                        Jaeger
                      </a>
                      .
                    </>
                  )}
                </p>
              ) : (
                <p className="m-0 text-fg-muted">
                  Tracing is off. Start Jaeger with <code className="rounded-sm bg-code-bg px-1 text-xs text-code-fg">make tracing</code> and run the BFF with <code className="rounded-sm bg-code-bg px-1 text-xs text-code-fg">OTEL_ENABLED=1</code>.
                </p>
              )}
              {tracing.data.startup?.error && <ErrorState title="Exporter failed to start">{tracing.data.startup.error}</ErrorState>}
              <p className="m-0 text-xs text-fg-subtle">
                Prompt content {tracing.data.capture_content ? "IS captured (debug)" : "is redacted to lengths and hashes"}. {tracing.data.conventions}.
              </p>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
