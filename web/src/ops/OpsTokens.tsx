/**
 * OPS8 — the token meter. Two live sources, both over real model calls, nothing estimated:
 *  - `GET /api/tokens/summary` + `/api/tokens/ledger` (bff/src/tokens/query.ts) for the filterable
 *    meter: summary tiles, cost over time, a sortable breakdown with CSV export, and drill-through
 *    from a breakdown row to its ledger lines and on to the trace that produced them.
 *  - `GET /api/ops/tokens` (ops-mcp `token_cost_report`) for the robust-z cost anomaly list, kept
 *    from the previous version of this page.
 * Filters are reflected in the URL, so a view can be linked. A call whose line carries no cost is
 * counted as a call and reported as "cost not reported", never as $0.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AlertTriangle, Coins, Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, PanelSkeleton } from "@/components/states";
import { ProvenanceChip } from "@/components/Provenance";
import { api } from "@/store/session";
import { cn } from "@/lib/utils";
import { fetchTokenLedger, fetchTokenSummary, hoursAgo, toCsv, type Bucket, type LedgerRow, type TokenLedgerPage, type TokenSummary } from "@/lib/traceDetail";

interface Report {
  summary: string;
  facts: { label: string; value: string | number; cite?: string }[];
  table: { columns: string[]; rows: (string | number)[][] };
  chart?: { unit: string; series: { label: string; value: number }[] } | null;
  anomalies?: { ts: string; role: string; run_id: string | null; cost_usd: number; median_role_cost: number; robust_z: number }[];
  n: number;
}

const RANGES: { label: string; hours: number }[] = [
  { label: "24h", hours: 24 },
  { label: "7 days", hours: 168 },
  { label: "30 days", hours: 720 },
  { label: "All", hours: 0 },
];

const GROUPS = ["role", "model", "plane", "intent", "hour"] as const;
type Group = (typeof GROUPS)[number];

const usd = (v: number | null | undefined) => (v == null ? "—" : `$${v < 0.01 ? v.toFixed(5) : v.toFixed(4)}`);
const int = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString());
const msOf = (v: number | null | undefined) => (v == null ? "not reported" : `${v.toLocaleString()} ms`);

function Tile({ label, value, sub, testId, tone }: { label: string; value: string; sub?: string; testId?: string; tone?: "warn" | "bad" }) {
  return (
    <div className="grid gap-0.5 rounded-md border border-line bg-surface p-2.5" data-testid={testId}>
      <span className="text-2xs font-medium tracking-wide text-fg-muted uppercase">{label}</span>
      <span className={cn("tabular text-lg font-semibold tracking-[-0.02em]", tone === "warn" && "text-warn", tone === "bad" && "text-bad")}>{value}</span>
      {sub && <span className="text-2xs text-fg-muted">{sub}</span>}
    </div>
  );
}

/** Cost per hour, coloured by the chosen dimension is not possible from one series, so the bars are
 *  the hour totals and the legend states the dimension the breakdown below is grouped by. */
function CostChart({ buckets, unitLabel }: { buckets: Bucket[]; unitLabel: string }) {
  const max = Math.max(...buckets.map((b) => b.cost_usd), 1e-9);
  if (!buckets.length) return null;
  return (
    <figure className="m-0 grid gap-1" aria-label={`Cost per hour in USD, ${unitLabel}`} data-testid="token-chart">
      <div className="flex h-28 items-end gap-0.5 overflow-x-auto rounded-md border border-line bg-surface p-2">
        {buckets.map((b) => (
          <div
            key={b.key}
            className={cn("min-w-1 flex-1 rounded-t-sm", b.errors > 0 ? "bg-bad" : "bg-accent")}
            style={{ height: `${Math.max(2, (b.cost_usd / max) * 100)}%` }}
            title={`${b.key}: $${b.cost_usd.toFixed(4)} · ${b.calls} calls${b.errors ? ` · ${b.errors} error(s)` : ""}`}
          />
        ))}
      </div>
      <figcaption className="text-2xs text-fg-muted">
        $ per hour, {buckets[0].key} → {buckets[buckets.length - 1].key}. Red bars are hours with a failed call. Breakdown below is grouped by {unitLabel}.
      </figcaption>
    </figure>
  );
}

type SortKey = "key" | "calls" | "cost_usd" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "p50_ttft_ms" | "errors";

export function OpsTokens() {
  const [params, setParams] = useSearchParams();
  const [sum, setSum] = useState<TokenSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [drill, setDrill] = useState<{ key: string; page: TokenLedgerPage } | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "cost_usd", dir: -1 });
  const [nonce, setNonce] = useState(0);

  const hours = Number(params.get("hours") ?? 168);
  const group = (GROUPS.includes(params.get("group") as Group) ? params.get("group") : "role") as Group;
  const plane = params.get("plane") ?? "";
  const role = params.get("role") ?? "";
  const model = params.get("model") ?? "";
  const intent = params.get("intent") ?? "";
  const errorsOnly = params.get("errors") === "1";
  const minCost = params.get("min_cost") ?? "";

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (!v) next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
    setDrill(null);
  };

  const filters = useMemo(
    () => ({ from: hours ? hoursAgo(hours) : null, plane, role, model, intent, ok: errorsOnly ? "false" : null, min_cost: minCost || null }),
    [hours, plane, role, model, intent, errorsOnly, minCost],
  );

  useEffect(() => {
    setErr(null);
    fetchTokenSummary({ ...filters, group_by: group })
      .then((r) => (r?.ok ? setSum(r) : setErr("token summary unavailable")))
      .catch((e) => setErr(String(e?.message ?? e)));
  }, [filters, group, nonce]);

  useEffect(() => {
    api
      .get<Report>(`/api/ops/tokens?hours=${hours || 720}`)
      .then(setReport)
      .catch(() => setReport(null));
  }, [hours, nonce]);

  if (err && !sum) return <ErrorState title="Token meter unavailable" fix="make dev">{err}</ErrorState>;
  if (!sum) return <PanelSkeleton rows={4} chart label="Loading token meter" />;

  const t = sum.totals;
  const cacheShare = t.cache_read_share == null ? "not reported" : `${Math.round(t.cache_read_share * 100)}%`;
  const hourly = sum.by_hour ?? (group === "hour" ? sum.buckets : []);
  const sorted = [...sum.buckets].sort((a, b) => {
    const av = a[sort.key] as number | string;
    const bv = b[sort.key] as number | string;
    return (typeof av === "string" ? String(av).localeCompare(String(bv)) : (av as number) - (bv as number)) * sort.dir;
  });

  const COLS: { id: SortKey; label: string }[] = [
    { id: "key", label: group },
    { id: "calls", label: "calls" },
    { id: "cost_usd", label: "cost $" },
    { id: "input_tokens", label: "in" },
    { id: "output_tokens", label: "out" },
    { id: "cache_read_tokens", label: "cache read" },
    { id: "p50_ttft_ms", label: "p50 ttft" },
    { id: "errors", label: "errors" },
  ];

  const exportCsv = () => {
    const csv = toCsv(
      COLS.map((c) => c.label),
      sorted.map((b) => [b.key, b.calls, b.cost_usd, b.input_tokens, b.output_tokens, b.cache_read_tokens, b.p50_ttft_ms, b.errors]),
    );
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `token_meter_${group}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const openDrill = (b: Bucket) => {
    const extra = group === "hour" ? { from: `${b.key}:00.000Z`.replace("T", "T"), to: b.last_ts } : { [group]: b.key };
    fetchTokenLedger({ ...filters, ...extra, limit: 25 })
      .then((p) => setDrill({ key: b.key, page: p }))
      .catch((e) => setErr(String(e?.message ?? e)));
  };

  return (
    <div className="grid gap-4" data-testid="ops-tokens">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center gap-2 pb-2">
          <Coins className="size-4 text-accent" aria-hidden />
          <CardTitle className="text-base">Token meter</CardTitle>
          <Badge size="sm" tone={sum.budget.mode === "exhausted" ? "bad" : sum.budget.mode === "economy" ? "warn" : "ok"} data-testid="token-budget">
            ${t.cost_usd.toFixed(2)} in window · ${sum.budget.budget_usd.toFixed(2)} {sum.budget.env}
          </Badge>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setNonce((n) => n + 1)} aria-label="Refresh token meter">
            <RefreshCw aria-hidden />
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex flex-wrap items-end gap-2" data-testid="token-filters" role="group" aria-label="Token meter filters">
            <label className="grid gap-0.5 text-2xs text-fg-muted">
              Range
              <select data-testid="token-filter-range" aria-label="Time range" value={hours} onChange={(e) => set("hours", e.target.value)} className="h-7 rounded-md border border-line bg-surface px-1 text-xs text-fg">
                {RANGES.map((r) => (
                  <option key={r.hours} value={r.hours}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-0.5 text-2xs text-fg-muted">
              Group by
              <select data-testid="token-filter-group" aria-label="Group by" value={group} onChange={(e) => set("group", e.target.value)} className="h-7 rounded-md border border-line bg-surface px-1 text-xs text-fg">
                {GROUPS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            {([
              ["plane", plane, sum.facets.planes],
              ["role", role, sum.facets.roles],
              ["model", model, sum.facets.models],
              ["intent", intent, sum.facets.intents],
            ] as const).map(([name, value, options]) => (
              <label key={name} className="grid gap-0.5 text-2xs text-fg-muted capitalize">
                {name}
                <select data-testid={`token-filter-${name}`} aria-label={name} value={value} onChange={(e) => set(name, e.target.value)} className="h-7 rounded-md border border-line bg-surface px-1 text-xs text-fg">
                  <option value="">all</option>
                  {options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="grid gap-0.5 text-2xs text-fg-muted">
              Min cost $
              <input
                data-testid="token-filter-min-cost"
                aria-label="Minimum cost in dollars"
                inputMode="decimal"
                value={minCost}
                onChange={(e) => set("min_cost", e.target.value.replace(/[^0-9.]/g, ""))}
                className="h-7 w-20 rounded-md border border-line bg-surface px-1.5 text-xs text-fg"
                placeholder="0"
              />
            </label>
            <label className="flex items-center gap-1.5 pb-1 text-xs text-fg">
              <input data-testid="token-filter-errors" type="checkbox" checked={errorsOnly} onChange={(e) => set("errors", e.target.checked ? "1" : "")} className="size-3.5 accent-[var(--accent)]" />
              Errors only
            </label>
          </div>

          {t.calls === 0 ? (
            <EmptyState icon={Coins}>
              No model calls in data/token_ledger.jsonl match these filters ({sum.ledger_lines.toLocaleString()} lines in the file).
            </EmptyState>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="token-tiles">
                <Tile label="Cost" value={usd(t.cost_usd)} sub={t.cost_missing ? `${t.cost_missing} call(s) with no reported cost` : "as reported by the CLI"} testId="token-tile-cost" />
                <Tile label="Calls" value={int(t.calls)} sub={`${t.tool_calls.toLocaleString()} tool calls recorded`} testId="token-tile-calls" />
                <Tile label="Tokens in" value={int(t.input_tokens)} sub={`+${int(t.cache_read_tokens)} cache read`} testId="token-tile-in" />
                <Tile label="Tokens out" value={int(t.output_tokens)} testId="token-tile-out" />
                <Tile label="Cache-read share" value={cacheShare} sub="of all input tokens" testId="token-tile-cache" />
                <Tile label="p50 TTFT" value={msOf(t.p50_ttft_ms)} testId="token-tile-p50" />
                <Tile label="p95 TTFT" value={msOf(t.p95_ttft_ms)} testId="token-tile-p95" />
                <Tile label="Errors" value={int(t.errors)} tone={t.errors ? "bad" : undefined} testId="token-tile-errors" />
              </div>

              {sum.budget.message && (
                <p className="m-0 rounded-md bg-warn-soft px-2 py-1.5 text-xs text-fg" data-testid="token-budget-note" role="status">
                  {sum.budget.message}
                </p>
              )}
              <p className="m-0 text-2xs text-fg-muted">{sum.budget.note}.</p>

              <CostChart buckets={hourly} unitLabel={group} />

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold">Breakdown by {group}</span>
                <Button size="xs" variant="secondary" onClick={exportCsv} data-testid="token-export-csv">
                  <Download aria-hidden /> CSV
                </Button>
              </div>
              <div className="overflow-x-auto">
                <Table data-testid="token-table">
                  <TableHeader>
                    <TableRow>
                      {COLS.map((c) => (
                        <TableHead key={c.id}>
                          <button
                            type="button"
                            className="font-inherit inline-flex items-center gap-1 text-fg-muted hover:text-fg"
                            data-testid={`token-sort-${c.id}`}
                            aria-label={`Sort by ${c.label}`}
                            onClick={() => setSort((s) => ({ key: c.id, dir: s.key === c.id && s.dir === -1 ? 1 : -1 }))}
                          >
                            {c.label}
                            {sort.key === c.id && <span aria-hidden>{sort.dir === -1 ? "↓" : "↑"}</span>}
                          </button>
                        </TableHead>
                      ))}
                      <TableHead>
                        <span className="sr-only">drill through</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map((b) => (
                      <TableRow key={b.key} data-testid="token-row">
                        <TableCell className="font-mono text-xs">{b.key}</TableCell>
                        <TableCell className="tabular text-xs">{b.calls}</TableCell>
                        <TableCell className="tabular text-xs">{b.cost_usd.toFixed(4)}</TableCell>
                        <TableCell className="tabular text-xs">{b.input_tokens.toLocaleString()}</TableCell>
                        <TableCell className="tabular text-xs">{b.output_tokens.toLocaleString()}</TableCell>
                        <TableCell className="tabular text-xs">{b.cache_read_tokens.toLocaleString()}</TableCell>
                        <TableCell className="tabular text-xs">{b.p50_ttft_ms == null ? "—" : b.p50_ttft_ms.toLocaleString()}</TableCell>
                        <TableCell className={cn("tabular text-xs", b.errors && "text-bad")}>{b.errors}</TableCell>
                        <TableCell>
                          <Button size="xs" variant="ghost" data-testid="token-drill" onClick={() => openDrill(b)} aria-label={`Show ledger lines for ${b.key}`}>
                            Lines
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {drill && (
                <div className="grid gap-1.5 rounded-md border border-line p-2.5" data-testid="token-drill-panel">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold">
                      {drill.page.rows.length} of {drill.page.total} ledger line(s) · {drill.key}
                    </span>
                    <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setDrill(null)} aria-label="Close ledger lines">
                      Close
                    </Button>
                  </div>
                  <ul className="m-0 grid list-none gap-1 p-0">
                    {drill.page.rows.map((r: LedgerRow, i) => (
                      <li key={`${r.ts}${i}`} className="tabular flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-surface-sunken px-2 py-1 text-2xs" data-testid="token-ledger-line">
                        <span className="text-fg-muted">{r.ts.replace("T", " ").slice(0, 19)}</span>
                        <span className="font-semibold">{r.role}</span>
                        <span>{r.model}</span>
                        <span>in {r.input_tokens.toLocaleString()}</span>
                        <span>out {r.output_tokens.toLocaleString()}</span>
                        <span>{r.cost_usd == null ? "cost not reported" : `$${r.cost_usd.toFixed(5)}`}</span>
                        {!r.ok && <span className="text-bad">failed</span>}
                        {r.trace_id ? (
                          <Link to={`/ops/traces/${r.trace_id}`} className="font-medium text-accent underline-offset-4 hover:underline" data-testid="token-line-trace">
                            trace
                          </Link>
                        ) : (
                          <span className="text-fg-muted">no trace id on this line</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          <div>
            <ProvenanceChip provenance={{ service: sum.provenance.service, endpoint: sum.provenance.endpoint, timestamp: sum.provenance.timestamp, note: `source: ${sum.provenance.source ?? "data/token_ledger.jsonl"} · ${sum.ledger_lines.toLocaleString()} lines` }} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center gap-2 pb-2">
          <AlertTriangle className="size-4 text-warn" aria-hidden />
          <CardTitle className="text-base">Cost anomalies</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {!report ? (
            <p className="m-0 text-xs text-fg-muted">ops-mcp's cost report is not available right now.</p>
          ) : (
            <>
              <p className="m-0 text-sm font-medium" data-testid="ops-tokens-summary">
                {report.summary}
              </p>
              {report.anomalies?.length ? (
                <ul className="m-0 grid list-none gap-1 p-0" aria-label="Cost anomalies" data-testid="ops-tokens-anomalies">
                  {report.anomalies.map((a, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 rounded-md bg-warn-soft px-2 py-1 text-xs text-fg">
                      <AlertTriangle className="size-3.5 text-warn" aria-hidden />
                      {a.role} · ${a.cost_usd.toFixed(4)} vs median ${a.median_role_cost.toFixed(4)} · z {a.robust_z} · run {String(a.run_id ?? "n/a").slice(0, 8)} · {a.ts}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-xs text-fg-muted">No call in this window is a robust-z outlier against its role's median cost.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
