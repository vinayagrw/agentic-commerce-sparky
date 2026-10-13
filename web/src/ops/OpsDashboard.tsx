/**
 * Ops Copilot dashboard: lifecycle stepper with active agent + tier, eval gate (NDCG champion vs
 * candidate with CI), drift timeline, canary arms, FinOps cost, registry / signature, audit log,
 * runtime (measured run metrics + tracing), plus presenter controls.
 *
 * Every figure renders through <Stat>/<Metric> with the provenance its payload carries; a value
 * without one shows the reason instead.
 */
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ErrorBar, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import type { AgentState } from "@sparky/shared";
import { Activity, BadgeCheck, BadgeX, ClipboardList, Coins, FlaskConical, GitBranch, Layers, PauseCircle, Radar, Rocket, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { postJson } from "../api";
import { applyServerState, pushFeed, SurfaceView, threadIdFor, type ActionResponse } from "../components/ChatPane";
import { opsFeed, surfaces, useStore } from "../store";
import { cn } from "@/lib/utils";
import { usePoll } from "@/lib/usePoll";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartFrame, useChartTheme } from "@/components/charts/chart";
import { Metric, ProvenanceChip, provenanceIn, Stat } from "@/components/Provenance";
import { Segmented } from "@/components/ui/segmented";
import { TierBadge } from "@/components/TierBadge";
import { EmptyState, ErrorState, KeyValue, PanelSkeleton } from "@/components/states";
import { LifecycleStepper } from "./LifecycleStepper";
import { useCoverage } from "../coverage/useCoverage";
import { AlertOctagon, History } from "lucide-react";
import { Link } from "react-router";
import { OpsEvals } from "./OpsEvals";
import { RuntimePanel } from "./RuntimePanel";
import { OpsTokens } from "./OpsTokens";

const f = (d: number) => (v: number) => v.toFixed(d);
const signed = (d: number) => (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;

function Panel({ title, icon: Icon, source, status, children, className }: { title: string; icon: LucideIcon; source?: any; status?: React.ReactNode; children: React.ReactNode; className?: string }) {
  const prov = source ? provenanceIn(source) : null;
  return (
    <Card className={cn("flex min-w-0 flex-col", className)}>
      <CardHeader className="items-center pb-3">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <Icon className="size-4 flex-none text-fg-subtle" aria-hidden />
          <span className="truncate">{title}</span>
          {status}
        </CardTitle>
        {prov && <ProvenanceChip compact provenance={prov} />}
      </CardHeader>
      <CardContent className="grid flex-1 content-start gap-3">{children}</CardContent>
    </Card>
  );
}

const Verdict = ({ pass, pos = "PASS", neg = "FAIL" }: { pass: boolean; pos?: string; neg?: string }) => (
  <Badge size="sm" tone={pass ? "ok" : "solidBad"} className="font-bold tracking-wide">
    {pass ? pos : neg}
  </Badge>
);

function GatePanel({ gate }: { gate: any }) {
  const t = useChartTheme();
  const nd = gate?.metrics?.ndcg10;
  const ci: number[] | undefined = nd?.delta?.ci95;
  const passed = gate ? Boolean(gate.passed ?? gate.gate?.passed) : null;
  const rows =
    nd && Number.isFinite(nd.champion) && Number.isFinite(nd.candidate)
      ? [
          { name: "champion", ndcg: nd.champion, err: [0, 0] },
          { name: "candidate", ndcg: nd.candidate, err: ci ? [Math.max(0, -(ci[0] - (nd.candidate - nd.champion))), Math.max(0, ci[1] - (nd.candidate - nd.champion))] : [0, 0] },
        ]
      : [];
  return (
    <Panel title="Eval gate · NDCG@10" icon={FlaskConical} source={gate} status={passed != null && <Verdict pass={passed} />}>
      {!gate ? (
        <EmptyState icon={FlaskConical}>Run 8b to build a candidate and gate it, or gate the preregistered null above.</EmptyState>
      ) : (
        <>
          {passed === false && <GateRed gate={gate} />}
          {rows.length > 0 ? (
            <ChartFrame height="10rem" label={`NDCG@10 champion ${nd.champion} vs candidate ${nd.candidate}`}>
              <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid {...t.grid} />
                <XAxis dataKey="name" {...t.axis} />
                <YAxis domain={[0.4, 0.7]} {...t.axis} />
                <Tooltip {...t.tooltip} formatter={(v: any) => Number(v).toFixed(3)} />
                <Bar dataKey="ndcg" radius={[6, 6, 0, 0]} isAnimationActive={false}>
                  {rows.map((r) => (
                    <Cell key={r.name} fill={r.name === "champion" ? t.color.accent : passed ? t.color.ok : t.color.bad} />
                  ))}
                  <ErrorBar dataKey="err" width={10} strokeWidth={2} stroke={t.color.fg} />
                </Bar>
              </BarChart>
            </ChartFrame>
          ) : (
            <p className="m-0 text-sm text-fg-muted">The gate result carries no champion/candidate NDCG to chart.</p>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Metric hideChip label="Δ NDCG@10" value={nd?.delta?.mean} source={gate} format={signed(4)} tone={passed ? "ok" : "bad"} missing="no delta reported" />
            <Metric hideChip label="95% CI low" value={ci?.[0]} source={gate} format={signed(3)} missing="no CI reported" />
            <Metric hideChip label="95% CI high" value={ci?.[1]} source={gate} format={signed(3)} missing="no CI reported" />
            <Metric hideChip label="pass^k" value={gate?.pass_k?.pass_hat_k} source={gate} format={f(2)} missing="pass^k not in this gate run" />
            <Metric
              hideChip
              label="Red-team blocked"
              value={gate?.red_team?.blocked}
              source={gate}
              format={(v) => `${v}/${gate?.red_team?.attacks ?? "?"}`}
              missing="red team not in this gate run"
            />
          </div>
        </>
      )}
    </Panel>
  );
}

/** B08: when the gate fails, the failing checks are the headline, each with measured value vs threshold. */
function GateRed({ gate }: { gate: any }) {
  const rows: { check: string; value: any; threshold?: string; passed: boolean }[] =
    Array.isArray(gate.check_rows) && gate.check_rows.length
      ? gate.check_rows
      : Object.entries(gate.checks ?? gate.gate?.checks ?? {}).map(([check, v]: [string, any]) => ({ check, value: typeof v === "object" && v ? v.value : undefined, passed: typeof v === "object" && v ? Boolean(v.passed) : Boolean(v) }));
  const failing = rows.filter((r) => !r.passed);
  const pre = gate.preregistered;
  return (
    <div role="alert" aria-live="assertive" data-gate="red" className="grid gap-2 rounded-lg border-2 border-bad bg-bad-soft px-3 py-3">
      <div className="flex flex-wrap items-center gap-2 text-bad">
        <AlertOctagon className="size-6 flex-none" aria-hidden />
        <span className="text-xl font-bold tracking-tight uppercase">Gate red · release blocked</span>
        <Badge size="sm" tone="solidBad">{failing.length} of {rows.length} checks failed</Badge>
        {gate.live && <Badge size="sm" tone="bad">measured live</Badge>}
      </div>
      {pre && (
        <p className="m-0 text-sm">
          Candidate: <span className="font-semibold">{pre.label}</span> <span className="text-fg-muted">({pre.record}; paired verdict: {pre.paired_verdict})</span>
        </p>
      )}
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {rows.map((r) => (
          <li key={r.check} className={cn("flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5 text-sm", r.passed ? "bg-surface/60 text-fg-muted" : "bg-surface font-semibold text-bad")}>
            <span className="font-mono text-xs">{r.passed ? "PASS" : "FAIL"}</span>
            <span className="font-mono">{r.check}</span>
            <span className="tabular">measured {typeof r.value === "object" ? JSON.stringify(r.value) : String(r.value ?? "–")}</span>
            {r.threshold && <span className="text-fg-muted">threshold {r.threshold}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DriftPanel({ drift }: { drift: any }) {
  const t = useChartTheme();
  // Two ops-mcp shapes land here: detect_drift {timeline[], current} and estimate_ndcg_impact {trend[], estimated_*}.
  const rows = (drift?.timeline ?? drift?.trend ?? []).map((x: any) => ({ w: `w${x.window}`, mmd2: x.mmd2, est: x.est_ndcg10, alert: x.alert }));
  const hasMmd = rows.some((r: any) => Number.isFinite(r.mmd2));
  const cur = drift?.current;
  return (
    <Panel title="Drift · query stream" icon={Radar} source={drift} status={cur && <Verdict pass={!cur.alert} pos="OK" neg="ALERT" />}>
      {!drift ? (
        <EmptyState icon={Radar}>Run 8b to replay the seasonal query stream.</EmptyState>
      ) : (
        <>
          {rows.length > 0 && (
            <ChartFrame height="10rem" label="Drift and estimated NDCG@10 per window">
              <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid {...t.grid} />
                <XAxis dataKey="w" {...t.axis} />
                {hasMmd && <YAxis yAxisId="l" {...t.axis} />}
                <YAxis yAxisId="r" orientation={hasMmd ? "right" : "left"} domain={[0.3, 0.8]} {...t.axis} />
                <Tooltip {...t.tooltip} />
                <Legend {...t.legend} />
                {hasMmd && <Line yAxisId="l" dataKey="mmd2" name="MMD²" stroke={t.color.bad} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />}
                <Line yAxisId="r" dataKey="est" name="est NDCG@10" stroke={t.color.accent} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              </LineChart>
            </ChartFrame>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {cur ? (
              <>
                <Metric hideChip label="MMD² now" value={cur.mmd2} source={drift} format={f(4)} tone={cur.alert ? "bad" : "default"} missing="no current window" />
                <Metric hideChip label="p-value" value={cur.p_value} source={drift} format={f(3)} missing="no p-value reported" />
              </>
            ) : null}
            <Metric hideChip label="est NDCG@10 now" value={cur?.est_ndcg10 ?? drift.estimated_ndcg10_now} source={drift} format={f(3)} missing="no estimate" />
            <Metric
              hideChip
              label="est Δ vs reference"
              value={cur?.est_ndcg10_delta ?? drift.estimated_delta_vs_reference}
              source={drift}
              format={signed(3)}
              tone={(cur?.est_ndcg10_delta ?? drift.estimated_delta_vs_reference) < -0.02 ? "bad" : "default"}
              missing="no impact estimate"
            />
          </div>
          {drift.caveat && <p className="m-0 text-xs text-fg-muted">{drift.caveat}</p>}
        </>
      )}
    </Panel>
  );
}

function CanaryPanel({ canary }: { canary: any }) {
  const t = useChartTheme();
  const cov = useCoverage();
  const guard = cov.status === "ready" ? cov.data.gate_config?.canary_guardrail : undefined;
  const p95Max = guard?.p95_ms_le ?? null;
  const arms = canary?.arms;
  const rows = arms ? (["champion", "canary"] as const).filter((k) => Number.isFinite(arms[k]?.p95_ms)).map((k) => ({ arm: k, p95: arms[k].p95_ms })) : [];
  const status = canary?.status as string | undefined;
  return (
    <Panel
      title="Canary"
      icon={Rocket}
      source={canary}
      status={status && <Badge size="sm" tone={status === "rolled_back" ? "solidBad" : status === "promoted" ? "ok" : "info"}>{status.replace("_", " ")}</Badge>}
    >
      {!canary ? (
        <EmptyState icon={Rocket}>No canary running. Approve a promotion in 8b to start one.</EmptyState>
      ) : (
        <>
          {rows.length > 0 && (
            <ChartFrame height="9rem" label="p95 latency by arm">
              <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid {...t.grid} />
                <XAxis dataKey="arm" {...t.axis} />
                <YAxis {...t.axis} />
                <Tooltip {...t.tooltip} formatter={(v: any) => `${v} ms`} />
                <Bar dataKey="p95" name="p95 ms" radius={[6, 6, 0, 0]} isAnimationActive={false}>
                  {rows.map((r) => (
                    <Cell key={r.arm} fill={p95Max != null && r.p95 > p95Max ? t.color.bad : r.arm === "canary" ? t.color.highlight : t.color.accent} />
                  ))}
                </Bar>
              </BarChart>
            </ChartFrame>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Metric hideChip label="Canary traffic" value={canary.traffic_pct} source={canary} suffix="%" missing="split not reported" />
            <Metric hideChip label="p95 canary" value={arms?.canary?.p95_ms} source={canary} suffix="ms" tone={p95Max != null && arms?.canary?.p95_ms > p95Max ? "bad" : "default"} missing="no canary requests yet" />
            <Metric hideChip label="NDCG champion" value={arms?.champion?.ndcg10} source={canary} format={f(3)} missing="not measured on this arm" />
            <Metric hideChip label="NDCG canary" value={arms?.canary?.ndcg10} source={canary} format={f(3)} missing="not measured on this arm" />
          </div>
          <p className="m-0 text-xs text-fg-muted">
            {canary.version ? <span className="font-mono">{canary.version}</span> : null} {guard ? `Guardrail (search-svc): ${guard.rule.replace("p95_ms_le", `${guard.p95_ms_le} ms`).replace("p95_rel_to_champion_le", `${guard.p95_rel_to_champion_le}`).replace("ndcg_drop_le", `${guard.ndcg_drop_le}`)}. Breach rolls back automatically (T3).` : "Guardrail thresholds unavailable: data/coverage.json not loaded."}
          </p>
        </>
      )}
    </Panel>
  );
}

function FinOpsPanel({ finops }: { finops: any }) {
  const t = useChartTheme();
  const c = finops?.cost_per_1k;
  const rows = c && Number.isFinite(c.all_claude) && Number.isFinite(c.routed) ? [{ path: "all Claude", usd: c.all_claude }, { path: "routed", usd: c.routed }] : [];
  return (
    <Panel title="FinOps · cost per 1k queries" icon={Coins} source={finops}>
      {!finops ? (
        <EmptyState icon={Coins}>Run 8c to route live queries and cost both paths.</EmptyState>
      ) : finops.blocked || finops.error ? (
        <ErrorState title="Router refused to cost the paths" fix={finops.service_unavailable?.fix}>
          {String(finops.error ?? "blocked")}
        </ErrorState>
      ) : (
        <>
          {rows.length > 0 && (
            <ChartFrame height="9rem" label={`Cost per 1k queries: all Claude ${c.all_claude}, routed ${c.routed}`}>
              <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -6 }}>
                <CartesianGrid {...t.grid} />
                <XAxis dataKey="path" {...t.axis} />
                <YAxis {...t.axis} />
                <Tooltip {...t.tooltip} formatter={(v: any) => `$${Number(v).toFixed(2)}`} />
                <Bar dataKey="usd" radius={[6, 6, 0, 0]} isAnimationActive={false}>
                  {rows.map((r) => (
                    <Cell key={r.path} fill={r.path === "routed" ? t.color.ok : t.color.accent} />
                  ))}
                </Bar>
              </BarChart>
            </ChartFrame>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Metric hideChip label="Routed / 1k" value={c?.routed} source={finops} format={(v) => `$${v.toFixed(2)}`} tone="ok" missing="not computed" />
            <Metric hideChip label="All Claude / 1k" value={c?.all_claude} source={finops} format={(v) => `$${v.toFixed(2)}`} missing="not computed" />
            <Metric hideChip label="Savings" value={c?.savings_pct} source={finops} suffix="%" missing="no baseline cost" />
            <Metric hideChip label="Claude share" value={finops.claude_share} source={finops} format={(v) => `${Math.round(v * 100)}%`} missing="not reported" />
          </div>
          {finops.fulfilment == null && finops.fulfilment_note && <p className="m-0 rounded-md bg-surface-sunken px-2.5 py-2 text-xs text-fg-muted">Cost per fulfilled task: {finops.fulfilment_note}</p>}
        </>
      )}
    </Panel>
  );
}

type RegistryVersion = { version: string; status?: string; config?: Record<string, any>; metrics?: Record<string, any>; note?: string };
type RegistryView = {
  champion: string | null;
  candidate: string | null;
  versions?: RegistryVersion[];
  backend?: { mlflow?: boolean; tracking_uri?: string | null; json_mirror?: string } | null;
  source?: string;
  live?: boolean;
  error?: string;
};

const cfgSummary = (c: Record<string, any> | undefined) =>
  c ? [`bm25 ${c.w_bm25 ?? "–"}`, `vec ${c.w_vector ?? "–"}`, `rrf_k ${c.rrf_k ?? "–"}`, `rerank ${c.reranker === false ? "off" : `top-${c.rerank_depth ?? "?"}`}`, `synonyms ${Object.keys(c.synonyms ?? {}).length}`].join(" · ") : "–";

/**
 * Registry & signature: reads the LIVE MLflow-backed registry through the BFF
 * (GET /api/ops/registry -> search-svc :8801 GET /models). When search-svc is down it shows the
 * registry last reported by ops-mcp in this session, labelled as not live.
 */
function RegistryPanel({ state }: { state: AgentState }) {
  const o = state.ops;
  const { data: reg, loading, error } = usePoll<RegistryView>("/api/ops/registry", 8000);
  const live = Boolean(reg?.live);
  const champion = (live ? reg?.champion : null) ?? o.registry?.champion ?? reg?.champion ?? null;
  const candidate = (live ? reg?.candidate : null) ?? o.candidate ?? o.registry?.candidate ?? reg?.candidate ?? null;
  const versions: RegistryVersion[] = (live ? reg?.versions : null) ?? o.registry?.versions ?? reg?.versions ?? [];
  const champCfg = versions.find((v) => v.version === champion)?.config;
  const regProv = live ? { service: "search-svc", endpoint: "GET /models via /api/ops/registry", timestamp: new Date().toISOString(), note: `${reg?.backend?.mlflow ? "MLflow registry" : "JSON mirror"}; re-read every 8s` } : null;
  const verified = o.mlbom ? Boolean(o.mlbom.signature?.verified) : null;

  return (
    <Panel
      title="Registry & signature"
      icon={GitBranch}
      source={regProv ? { provenance: regProv } : undefined}
      status={live ? <Badge size="sm" tone="ok">live</Badge> : reg ? <Badge size="sm" tone="warn">not live</Badge> : null}
      className="lg:col-span-2"
    >
      {loading && !reg ? (
        <PanelSkeleton rows={4} label="Loading registry" />
      ) : (
        <>
          {!live && (
            <ErrorState title="search-svc registry unreachable" fix="make dev">
              {reg?.error ?? error ?? "GET /api/ops/registry did not return a live registry"}.{" "}
              {o.registry ? "Showing the registry last reported by ops-mcp in this session, not a live read." : "No registry has been reported in this session either."}
            </ErrorState>
          )}
          <dl className="m-0 grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-fg-muted">Champion</dt>
            <dd className="m-0 min-w-0">
              <span className="font-mono">{champion ?? "none reported"}</span>
              {champCfg && <span className="block font-mono text-2xs text-fg-subtle">{cfgSummary(champCfg)}</span>}
            </dd>
            <dt className="text-fg-muted">Candidate</dt>
            <dd className="m-0 font-mono">{candidate ?? "none"}</dd>
            <dt className="text-fg-muted">Signature</dt>
            <dd className="m-0">
              {verified == null ? (
                <span className="text-fg-muted">No ML-BOM signed yet</span>
              ) : verified ? (
                <Badge tone="ok"><BadgeCheck /> verified</Badge>
              ) : (
                <Badge tone="bad"><BadgeX /> unverified</Badge>
              )}
            </dd>
          </dl>
          {versions.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>version</TableHead>
                  <TableHead>role</TableHead>
                  <TableHead>config</TableHead>
                  <TableHead className="text-right">test NDCG@10</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((v) => {
                  const role = v.version === champion ? "champion" : v.version === candidate ? "candidate" : ["champion", "candidate"].includes(String(v.status)) ? "superseded" : v.status ?? "–";
                  const nd = v.metrics?.test_ndcg10 ?? (v as any).ndcg10;
                  return (
                    <TableRow key={v.version}>
                      <TableCell className="font-mono text-xs">{v.version}</TableCell>
                      <TableCell>
                        <Badge size="sm" tone={role === "champion" ? "accent" : role === "candidate" ? "highlight" : "neutral"}>{role}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-2xs text-fg-muted">{cfgSummary(v.config)}</TableCell>
                      <TableCell className="tabular text-right">
                        {Number.isFinite(nd) && regProv ? (
                          <Stat inline hideChip label="NDCG@10" value={{ value: nd, provenance: regProv }} format={f(4)} size="sm" />
                        ) : Number.isFinite(nd) ? (
                          <span className="text-xs text-fg-muted" title="Not a live read: shown without a number">not live</span>
                        ) : (
                          <span className="text-xs text-fg-subtle">not measured</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {o.mlbom?.bom && (
            <details className="rounded-md border border-line px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">CycloneDX ML-BOM · {o.mlbom.version}</summary>
              <KeyValue className="mt-2" data={o.mlbom.bom} />
            </details>
          )}
        </>
      )}
    </Panel>
  );
}

function AuditPanel({ audit }: { audit: AgentState["ops"]["audit"] }) {
  return (
    <Panel title="Audit log" icon={ClipboardList} className="lg:col-span-2">
      {audit.length === 0 ? (
        <EmptyState icon={ClipboardList}>No actions yet. Every agent action and human approval is recorded here.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>time</TableHead>
              <TableHead>actor</TableHead>
              <TableHead>agent</TableHead>
              <TableHead>action</TableHead>
              <TableHead>approval</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {audit
              .slice(-12)
              .reverse()
              .map((e, i) => (
                <TableRow key={`${e.ts}${i}`}>
                  <TableCell className="tabular font-mono text-xs whitespace-nowrap">{String(e.ts).replace(/^.*T/, "").slice(0, 8)}</TableCell>
                  <TableCell className="text-xs">{e.actor}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {e.agent} <TierBadge tier={e.tier} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {e.action}
                    {e.detail ? <div className="text-xs text-fg-muted">{e.detail}</div> : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.approval ?? "—"}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

export function OpsDashboard({ state, worse, setWorse, running }: { state: AgentState; worse: boolean; setWorse: (v: boolean) => void; running: boolean }) {
  const o = state.ops;
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"loop" | "evals" | "tokens">("loop");
  const [injectError, setInjectError] = useState<string | null>(null);
  const [gating, setGating] = useState(false);
  const cov = useCoverage();
  const injectMs = cov.status === "ready" ? cov.data.demo_inputs?.inject_latency_ms ?? null : null;
  const gatePrereg = async () => {
    setGating(true);
    setInjectError(null);
    try {
      const res = await postJson<ActionResponse & { error?: string }>("/api/ops/gate-preregistered", { threadId: threadIdFor("ops"), candidate: "late_interaction" });
      if ((res as any).error && !res.state) setInjectError(String((res as any).error));
      applyServerState("ops", res.state ?? undefined);
      pushFeed("ops", res.surfaces);
      setView("loop");
    } catch {
      setInjectError("The BFF did not answer POST /api/ops/gate-preregistered (ops-http must be running)");
    } finally {
      setGating(false);
    }
  };
  const feed = useStore(opsFeed);
  const all = useStore(surfaces);
  const pending = o.approvals.filter((a) => a.status === "pending");

  const inject = async () => {
    setBusy(true);
    setInjectError(null);
    try {
      const res = await postJson<ActionResponse & { error?: string }>("/api/ops/inject-latency", { threadId: threadIdFor("ops"), ms: injectMs });
      if ((res as any).error && !res.state) setInjectError(String((res as any).error));
      applyServerState("ops", res.state ?? undefined);
      pushFeed("ops", res.surfaces);
    } catch {
      setInjectError("The BFF did not answer POST /api/ops/inject-latency");
    } finally {
      setBusy(false);
    }
  };
  const canInject = Boolean(o.canary) && o.canary?.status !== "rolled_back";

  return (
    <div className="grid content-start gap-4 p-3 sm:p-4" aria-label="Ops dashboard">
      <LifecycleStepper state={state} />

      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Presenter controls">
        <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={worse} onChange={(e) => setWorse(e.target.checked)} disabled={running} />
          Worse candidate (reranker off)
          <span className="text-xs text-fg-muted">gate should fail</span>
        </label>
        <Button variant="danger" onClick={inject} disabled={busy || running || !canInject || injectMs == null} title={injectMs == null ? "No demo_inputs.inject_latency_ms in data/coverage.json" : canInject ? `Add ${injectMs} ms to the canary arm (presenter input, evals/demo_inputs.json)` : "Start a canary in 8b first"}>
          <Zap />
          {injectMs != null ? `Inject latency +${injectMs} ms` : "Inject latency"}
        </Button>
        <Button variant="danger" onClick={gatePrereg} disabled={gating || running} title="Late interaction (M22), a real measured null, re-measured live through the release gate. Takes about a minute.">
          <FlaskConical />
          {gating ? "Gating late interaction… (live, ~1 min)" : "Gate a preregistered null (M22)"}
        </Button>
        <Link to="/ops/replay" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-sm font-medium text-fg no-underline hover:border-line-strong">
          <History className="size-4" aria-hidden /> Session replay
        </Link>
        <Link to="/ops/traces" data-testid="ops-nav-traces" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-sm font-medium text-fg no-underline hover:border-line-strong">
          <Activity className="size-4" aria-hidden /> Traces
        </Link>
        <Segmented<"loop" | "evals" | "tokens">
          className="ml-auto"
          label="Dashboard view"
          value={view}
          onValueChange={setView}
          items={[
            { value: "loop", label: <><Layers />Closed loop</> },
            { value: "evals", label: <><Activity />Offline evals</> },
            { value: "tokens", label: <><Coins />Cost & tokens</> },
          ]}
        />
      </div>

      {injectError && <ErrorState title="Latency injection failed">{injectError}</ErrorState>}

      {pending.length > 0 && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-highlight bg-highlight-soft px-3 py-2 text-sm">
          <PauseCircle className="size-4 text-warn" aria-hidden />
          <span className="font-semibold">Waiting for a human:</span>
          {pending.map((a) => (
            <Badge key={a.approval_id} tone="warn">
              {a.kind} approval
            </Badge>
          ))}
          <span className="text-fg-muted">Approve or reject on the card in the chat below.</span>
        </div>
      )}

      {feed.length > 0 && (
        <Card className="border-highlight/60">
          <CardHeader className="pb-1">
            <CardTitle className="text-base">Latest actions</CardTitle>
          </CardHeader>
          <CardContent>{feed.slice(0, 2).map((id) => (all[id] ? <SurfaceView key={id} entry={all[id]} messages={all[id].messages} /> : null))}</CardContent>
        </Card>
      )}

      {view === "loop" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <GatePanel gate={o.gate} />
          <DriftPanel drift={o.drift} />
          <CanaryPanel canary={o.canary} />
          <FinOpsPanel finops={o.finops} />
          <RegistryPanel state={state} />
          <AuditPanel audit={o.audit} />
          <RuntimePanel className="lg:col-span-2" />
        </div>
      ) : view === "evals" ? (
        <OpsEvals />
      ) : (
        <OpsTokens />
      )}
    </div>
  );
}
