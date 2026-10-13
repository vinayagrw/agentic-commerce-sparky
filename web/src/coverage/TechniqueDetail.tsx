import { AlertTriangle, BookOpen, CheckCircle2, CircleSlash, Cloud, FileCode2, Info, Server, XCircle } from "lucide-react";
import { ProvenanceChip, Stat } from "@/components/Provenance";
import { Badge } from "@/components/ui/badge";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { CoverageBoardData, Technique } from "./types";
import { CiStrip } from "./CiStrip";
import { FlagChip, StatusChip } from "./chips";
import { flagOf, measuredOf, primaryMeasurement, raw, rawCi } from "./model";
import { BUILT_AS } from "./nameHonesty";

function Section({ title, icon: Icon, children, className }: { title: string; icon: typeof Info; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("grid gap-2.5", className)}>
      <h3 className="m-0 flex items-center gap-1.5 text-2xs font-semibold tracking-[0.08em] text-fg-subtle uppercase">
        <Icon className="size-3.5" aria-hidden />
        {title}
      </h3>
      {children}
    </section>
  );
}

export function TechniqueDetail({ t, board }: { t: Technique; board: CoverageBoardData }) {
  const flag = flagOf(t);
  const built = BUILT_AS[t.id];
  const primary = primaryMeasurement(t);
  const scriptReady = t.status === "script-ready-not-executed";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        className={cn(
          "grid gap-2 border-b border-line px-5 pt-5 pb-4 pr-14 sm:px-7",
          flag === "open" && "bg-bad-soft",
          flag === "negative" && "bg-bad-soft/60",
          flag === "null" && "bg-warn-soft/70",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-fg-subtle">Technique #{t.id}</span>
          <span className="text-xs text-fg-subtle">· {t.stage}</span>
          <StatusChip status={t.status} />
          {flag && <FlagChip flag={flag} size="lg" />}
        </div>
        <SheetTitle className="text-2xl font-semibold tracking-[-0.02em]">{t.name}</SheetTitle>
        <SheetDescription className="sr-only">Evidence, measurements and caveats for technique {t.id}</SheetDescription>
        {t.verdict && (
          <p className={cn("m-0 text-md font-semibold", flag === "null" ? "text-warn" : flag ? "text-bad" : "text-fg")}>
            Verdict: {t.verdict}
          </p>
        )}
        {built && (
          <div className="mt-1 grid gap-1 rounded-lg border border-warn/40 bg-surface px-3 py-2.5 text-sm">
            <div className="grid gap-x-3 sm:grid-cols-[8.5rem_1fr]">
              <span className="text-xs font-medium text-fg-subtle">Playbook name</span>
              <span>{t.name}</span>
              <span className="text-xs font-medium text-fg-subtle">What was built</span>
              <span className="font-medium">{built.builtAs}</span>
              <span className="text-xs font-medium text-fg-subtle">Not built</span>
              <span className="text-warn">{built.notBuilt}</span>
            </div>
            <div className="text-xs text-fg-subtle">From the row's own evidence: {built.evidence}</div>
          </div>
        )}
      </header>

      <div className="grid min-h-0 flex-1 content-start gap-7 overflow-y-auto px-5 py-6 sm:px-7">
        {t.headline && !scriptReady && <p className="m-0 max-w-[75ch] text-md leading-relaxed">{t.headline}</p>}

        {scriptReady && t.not_run && (
          <section className="grid gap-4 rounded-xl border-2 border-dashed border-warn/60 bg-warn-soft/50 p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="warn" size="lg" className="font-semibold">
                <CircleSlash aria-hidden />
                Script ready — not executed on this machine
              </Badge>
            </div>
            {t.no_metric_reason && <p className="m-0 text-sm font-medium">{t.no_metric_reason}</p>}
            <dl className="m-0 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
              <dt className="text-fg-muted">Entrypoint</dt>
              <dd className="m-0 font-mono break-all">{t.not_run.entrypoint}</dd>
              <dt className="text-fg-muted">GPU</dt>
              <dd className="m-0">{t.not_run.gpu_sku}</dd>
              <dt className="text-fg-muted">Estimated cost</dt>
              <dd className="m-0">
                <div className="font-mono text-sm break-words">{t.not_run.est_cost_usd}</div>
                <div className="mt-0.5 text-xs text-fg-subtle">Arithmetic, copied verbatim. Not a measurement: nobody ran it.</div>
              </dd>
            </dl>
            {t.not_run.cloud && (
              <Section title="Cloud path" icon={Cloud}>
                <div className="grid gap-2">
                  {Object.entries(t.not_run.cloud).map(([cloud, cmd]) => (
                    <div key={cloud} className="grid gap-1">
                      <span className="text-xs font-medium text-fg-muted uppercase">{cloud}</span>
                      <pre className="m-0 overflow-x-auto rounded-md bg-code-bg px-3 py-2 text-xs text-code-fg">{cmd}</pre>
                    </div>
                  ))}
                </div>
              </Section>
            )}
            {t.not_run.expected_result && (
              <Section title="Expected result (a prediction from the literature, not an observation)" icon={Info}>
                <p className="m-0 text-sm text-fg-muted">{t.not_run.expected_result}</p>
              </Section>
            )}
            {t.not_run.citation && <p className="m-0 text-xs text-fg-subtle">{t.not_run.citation}</p>}
          </section>
        )}

        {!scriptReady && t.no_metric_reason && (
          <Section title="Why no number is claimed" icon={Info}>
            <p className="m-0 rounded-lg border border-line bg-surface-sunken px-3 py-2.5 text-sm">{t.no_metric_reason}</p>
          </Section>
        )}

        {primary && (
          <div className="flex flex-wrap items-end gap-8">
            <Stat label={primary.label} value={measuredOf(t, primary, board)} format={raw} suffix={primary.unit} size="lg" tone={flag === "null" ? "warn" : flag ? "bad" : "default"} />
            {primary.ci95 && <CiStrip value={primary.value} ci={primary.ci95} label={primary.label} className="min-w-[14rem] flex-1" />}
          </div>
        )}

        {t.measurements.length > 0 && (
          <Section title={`Measurements (${t.measurements.length})`} icon={Server}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Measurement</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">n</TableHead>
                  <TableHead>95% CI</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {t.measurements.map((m, i) => {
                  const hasValue = typeof m.value === "number" || typeof m.value === "string";
                  const mv = hasValue ? measuredOf(t, m as typeof m & { value: number | string }, board) : null;
                  return (
                    <TableRow key={`${m.label}${i}`}>
                      <TableCell className="min-w-[12rem]">{m.label}</TableCell>
                      <TableCell className="text-right font-mono whitespace-nowrap tabular">
                        {mv ? (
                          <>
                            {raw(mv.value)}
                            {m.unit ? <span className="ml-1 text-fg-muted">{m.unit}</span> : null}
                          </>
                        ) : (
                          <span className="font-sans text-fg-muted">no value</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular text-fg-muted">{m.n ?? "—"}</TableCell>
                      <TableCell className="min-w-[10rem]">
                        {m.ci95 && mv && typeof mv.value === "number" ? (
                          <div className="grid gap-1">
                            <span className="font-mono text-xs tabular">{rawCi(m.ci95)}</span>
                            <CiStrip compact value={mv.value as number} ci={m.ci95} label={m.label} />
                          </div>
                        ) : m.how ? (
                          <span className="text-xs text-fg-muted">{m.how}</span>
                        ) : (
                          <span className="text-xs text-fg-subtle">none reported</span>
                        )}
                      </TableCell>
                      <TableCell>{mv ? <ProvenanceChip compact provenance={mv.provenance} /> : null}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Section>
        )}

        {t.caveats.length > 0 && (
          <Section title={`Caveats (${t.caveats.length})`} icon={AlertTriangle}>
            <ul className="m-0 grid list-none gap-2 p-0">
              {t.caveats.map((c, i) => (
                <li key={i} className="flex gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 flex-none text-warn" aria-hidden />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title={`Evidence in code (${t.code.length})`} icon={FileCode2}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>file:function</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Resolved</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {t.code.map((c) => (
                <TableRow key={`${c.file}:${c.symbol}`}>
                  <TableCell className="font-mono text-xs break-all">
                    {c.file}:<span className="font-semibold text-fg">{c.symbol}</span>
                  </TableCell>
                  <TableCell className="text-xs text-fg-muted">{c.note ?? "—"}</TableCell>
                  <TableCell>
                    {c.resolved === true ? (
                      <span className="inline-flex items-center gap-1 text-xs text-ok">
                        <CheckCircle2 className="size-3.5" aria-hidden /> defined
                      </span>
                    ) : c.resolved === false ? (
                      <span className="inline-flex items-center gap-1 text-xs text-bad">
                        <XCircle className="size-3.5" aria-hidden /> not found
                      </span>
                    ) : (
                      <span className="text-xs text-fg-subtle">not checked</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>

        <Section title="Provenance" icon={Server}>
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {t.provenance.map((p) => (
              <li key={p} className="rounded-md bg-surface-sunken px-2.5 py-1.5 font-mono text-xs break-words">
                {p}
              </li>
            ))}
          </ul>
          <div className="text-xs text-fg-subtle">
            Served by {board.provenance.endpoint} from {board.provenance.source}. {board.provenance.note}
          </div>
        </Section>

        <Section title="Playbook" icon={BookOpen}>
          <div className="text-sm">
            <span className="font-medium">{t.playbook_section}</span>
            <span className="ml-2 font-mono text-xs break-all text-fg-muted">{t.playbook_link}</span>
          </div>
          <div className="text-xs text-fg-subtle">The playbook is a Markdown file outside this app; the path is relative to the repo.</div>
        </Section>
      </div>
    </div>
  );
}
