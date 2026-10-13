/**
 * Offline evals: NDCG@10 by retrieval mode on held-out ESCI queries (search-svc /eval/ndcg) and
 * agent pass^k (search-svc /eval/passk, produced by `make eval`). Every number carries the
 * provenance of the payload it came from; release gates that depend on a missing result say so.
 */
import { Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from "recharts";
import { CheckCircle2, CircleHelp, ListChecks, Target, XCircle } from "lucide-react";
import type { Provenance } from "@sparky/shared";
import { agentState, useStore } from "../store";
import { cn } from "@/lib/utils";
import { usePoll } from "@/lib/usePoll";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartFrame, useChartTheme } from "@/components/charts/chart";
import { ProvenanceChip, Stat, provenanceIn } from "@/components/Provenance";
import { EmptyState, ErrorState, PanelSkeleton } from "@/components/states";
import { useCoverage } from "../coverage/useCoverage";

interface Row {
  mode: string;
  ndcg: number;
}

/** Normalise the several plausible /eval/ndcg shapes into rows. */
export function ndcgRows(d: any): Row[] {
  if (!d) return [];
  const src = d.rows ?? d.results ?? d.modes ?? d.metrics ?? d;
  if (Array.isArray(src)) return src.map((r: any) => ({ mode: String(r.mode ?? r.name), ndcg: Number(r["ndcg@10"] ?? r.ndcg10 ?? r.ndcg ?? r.value) })).filter((r) => Number.isFinite(r.ndcg));
  return Object.entries(src)
    .filter(([k, v]) => k !== "provenance" && typeof v === "object")
    .map(([mode, v]: [string, any]) => ({ mode, ndcg: Number(typeof v === "number" ? v : v?.["ndcg@10"] ?? v?.ndcg10 ?? v?.ndcg ?? v?.mean) }))
    .filter((r) => Number.isFinite(r.ndcg));
}

type GateState = "pass" | "fail" | "unknown";

function Gate({ label, state, reason }: { label: string; state: GateState; reason?: string }) {
  const Icon = state === "pass" ? CheckCircle2 : state === "fail" ? XCircle : CircleHelp;
  return (
    <li className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2.5", state === "pass" ? "border-ok/40 bg-ok-soft/60" : state === "fail" ? "border-bad/40 bg-bad-soft/60" : "border-line bg-surface-sunken/60")}>
      <Icon aria-hidden className={cn("mt-0.5 size-4 flex-none", state === "pass" ? "text-ok" : state === "fail" ? "text-bad" : "text-fg-subtle")} />
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-fg-muted">{state === "unknown" ? reason ?? "not measured" : state === "pass" ? "pass" : "fail"}</div>
      </div>
    </li>
  );
}

export function OpsEvals() {
  const t = useChartTheme();
  const ndcg = usePoll<any>("/api/eval/ndcg");
  const passk = usePoll<any>("/api/eval/passk");
  const s = useStore(agentState);
  // B02: thresholds are read from data/coverage.json gate_config (built from evals/results.json), never typed here.
  // Gates with no enforcing source (constraint rate, session cost) were removed rather than invented.
  const cov = useCoverage();
  const passKMin = cov.status === "ready" ? cov.data.gate_config?.release_gate.pass_k_min ?? null : null;

  const rows = ndcgRows(ndcg.data);
  const by = Object.fromEntries(rows.map((r) => [r.mode, r.ndcg]));
  const best = rows.reduce((a, r) => Math.max(a, r.ndcg), 0);
  const ndcgProv: Provenance | null = ndcg.data ? provenanceIn(ndcg.data) ?? { service: "search-svc", endpoint: "GET /eval/ndcg via /api/eval/ndcg", timestamp: "time not reported" } : null;
  const passkProv: Provenance | null = passk.data ? provenanceIn(passk.data) ?? { service: "search-svc", endpoint: "GET /eval/passk via /api/eval/passk", timestamp: "time not reported" } : null;
  const tasks: any[] = passk.data?.tasks ?? [];
  const passAll = tasks.length ? tasks.filter((x) => Number(x.pass_hat_k ?? (x.passes === x.trials ? 1 : 0)) >= 1).length / tasks.length : null;
  const csr = Number(passk.data?.constraint_satisfaction_rate);
  const ran = s.trace.length > 0 || s.tokens.input > 0;

  const gates: { label: string; state: GateState; reason?: string }[] = [
    { label: "Rerank beats BM25 on NDCG@10", state: by.rrf_rerank != null && by.bm25 != null ? (by.rrf_rerank > by.bm25 ? "pass" : "fail") : "unknown", reason: ndcg.loading ? "waiting for the NDCG eval" : ndcg.error ? "NDCG eval unavailable" : "bm25 or rrf_rerank missing from the eval result" },
    {
      label: passKMin != null ? `pass^k ≥ ${passKMin} (gate_config)` : "pass^k gate",
      state: passAll == null || passKMin == null ? "unknown" : passAll >= passKMin ? "pass" : "fail",
      reason: passKMin == null ? "no pass_k_min in data/coverage.json: run make smoke-sota" : passk.loading ? "waiting for pass^k results" : "no pass^k results: run make eval",
    },
    {
      label: "Injection seed suite blocked",
      state: passk.data?.injection_blocked || s.guard_events.some((g) => g.kind === "injection" && g.severity === "block") ? "pass" : "unknown",
      reason: "run beat 7 or make eval",
    },
  ];

  const cli: Provenance = { service: "claude-cli", endpoint: "result.total_cost_usd (shopper session)", timestamp: "reported at run end" };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ListChecks className="size-4 text-fg-subtle" aria-hidden />
              Release gates
            </CardTitle>
            <CardDescription>Offline search quality on held-out ESCI queries plus agent reliability, measured by search-svc on this laptop.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2 xl:grid-cols-3">
            {gates.map((g) => (
              <Gate key={g.label} {...g} />
            ))}
          </ul>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {passAll != null && passkProv && <Stat size="sm" label="pass^k (all tasks)" value={{ value: passAll, provenance: passkProv }} format={(v) => v.toFixed(2)} tone={passKMin == null ? "default" : passAll >= passKMin ? "ok" : "bad"} />}
            {Number.isFinite(csr) && passkProv && <Stat size="sm" label="Constraint satisfaction" value={{ value: csr, provenance: passkProv }} format={(v) => v.toFixed(2)} />}
            {ran && <Stat size="sm" label="Session cost" value={{ value: s.cost_usd, provenance: cli }} format={(v) => `$${v.toFixed(3)}`} />}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader className="items-center pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Target className="size-4 text-fg-subtle" aria-hidden />
              NDCG@10 by retrieval mode
            </CardTitle>
            {ndcgProv && rows.length > 0 && <ProvenanceChip compact provenance={ndcgProv} />}
          </CardHeader>
          <CardContent className="grid gap-3">
            {ndcg.loading ? (
              <>
                <PanelSkeleton chart rows={3} label="Running NDCG eval" />
                <p className="m-0 text-xs text-fg-muted">Running the eval on search-svc. The first run can take a while.</p>
              </>
            ) : ndcg.error ? (
              <ErrorState title="NDCG eval unavailable" fix={ndcg.errorBody?.service_unavailable?.fix ?? ndcg.errorBody?.fix ?? "make dev"}>
                {ndcg.error}
              </ErrorState>
            ) : rows.length === 0 || !ndcgProv ? (
              <EmptyState icon={Target}>search-svc answered, but with no NDCG@10 per mode. Re-run the eval after make data.</EmptyState>
            ) : (
              <>
                <ChartFrame height="11rem" label="NDCG@10 by retrieval mode">
                  <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid {...t.grid} />
                    <XAxis dataKey="mode" {...t.axis} />
                    <YAxis domain={[0, 1]} {...t.axis} />
                    <Tooltip {...t.tooltip} formatter={(v: any) => Number(v).toFixed(3)} />
                    <Bar dataKey="ndcg" radius={[6, 6, 0, 0]} isAnimationActive={false}>
                      {rows.map((r) => (
                        <Cell key={r.mode} fill={r.ndcg === best ? t.color.highlight : t.color.accent} />
                      ))}
                    </Bar>
                  </BarChart>
                </ChartFrame>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>mode</TableHead>
                      <TableHead>NDCG@10</TableHead>
                      <TableHead>Δ vs bm25</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.mode}>
                        <TableCell className="font-mono text-xs">{r.mode}</TableCell>
                        <TableCell>
                          <Stat inline hideChip label="NDCG@10" value={{ value: r.ndcg, provenance: ndcgProv }} format={(v) => v.toFixed(3)} />
                        </TableCell>
                        <TableCell>
                          {by.bm25 != null ? (
                            <Stat inline hideChip label="Δ vs bm25" value={{ value: r.ndcg - by.bm25, provenance: ndcgProv }} format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`} tone={r.ndcg - by.bm25 > 0 ? "ok" : r.ndcg - by.bm25 < 0 ? "bad" : "default"} />
                          ) : (
                            <span className="text-xs text-fg-subtle">no bm25 baseline</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="items-center pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ListChecks className="size-4 text-fg-subtle" aria-hidden />
              Agent pass^k {passk.data?.k ? <span className="font-normal text-fg-muted">k={passk.data.k}</span> : null}
            </CardTitle>
            {passkProv && tasks.length > 0 && <ProvenanceChip compact provenance={passkProv} />}
          </CardHeader>
          <CardContent>
            {passk.loading ? (
              <PanelSkeleton rows={4} label="Loading pass^k results" />
            ) : passk.error || !passkProv ? (
              <EmptyState icon={ListChecks}>
                No pass^k results yet. Run <code className="rounded-sm bg-code-bg px-1 text-xs text-code-fg">{passk.errorBody?.fix ?? "make eval"}</code>: nothing is shown until a real eval has produced them.
              </EmptyState>
            ) : tasks.length === 0 ? (
              <EmptyState icon={ListChecks}>The pass^k result lists no tasks.</EmptyState>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>task</TableHead>
                    <TableHead>passes</TableHead>
                    <TableHead>pass^k</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasks.map((x) => (
                    <TableRow key={x.task}>
                      <TableCell className="text-sm">{x.task}</TableCell>
                      <TableCell>
                        <Stat inline hideChip label="passes" value={{ value: `${x.passes}/${x.trials}`, provenance: passkProv }} />
                      </TableCell>
                      <TableCell>
                        <Stat inline hideChip label="pass^k" value={{ value: Number(x.pass_hat_k ?? 0), provenance: passkProv }} format={(v) => v.toFixed(2)} tone={Number(x.pass_hat_k) >= 1 ? "ok" : "bad"} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
