/**
 * B07: per-query-type slice report. B10: per-language bypass-class release gate.
 * Both read from GET /api/coverage (slice_report, bypass_gate blocks) and show n and CI on every number.
 */
import { ShieldAlert, SplitSquareHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProvenanceChip } from "@/components/Provenance";
import { cn } from "@/lib/utils";
import { CiStrip } from "./CiStrip";
import { boardProvenance } from "./ClaimsBand";
import { raw } from "./model";
import type { CoverageBoardData } from "./types";

type Cell = { n: number; mean: number; ci95: [number, number] };
type Rate = { k: number; n: number; rate: number; ci95_wilson: [number, number] };

function Absent({ block }: { block: Record<string, any> }) {
  return (
    <p className="m-0 rounded-md bg-surface-sunken px-3 py-2 text-sm text-fg-muted">
      Not generated: {block.reason}. <code className="rounded-sm bg-code-bg px-1 text-xs text-code-fg">{block.fix}</code>
    </p>
  );
}

const ci = (c?: [number, number]) => (c ? `[${raw(c[0])}, ${raw(c[1])}]` : "");

export function SliceReport({ board }: { board: CoverageBoardData }) {
  const sr = board.slice_report;
  if (!sr) return null;
  const prov = boardProvenance(board, "data/slice_report.json", sr.generated_at ? `generated ${sr.generated_at} by ${sr.script}` : undefined);
  const modes: string[] = Array.isArray(sr.modes) ? sr.modes : sr.modes && typeof sr.modes === "object" ? Object.keys(sr.modes) : [];
  const modeLabel = (m: string) => (sr.modes && !Array.isArray(sr.modes) ? sr.modes[m] : undefined);
  const slices = sr.per_slice ? Object.keys(sr.per_slice).sort((a, b) => (a === "ALL" ? 1 : b === "ALL" ? -1 : (sr.per_slice[a].rrf_rerank?.mean ?? 0) - (sr.per_slice[b].rrf_rerank?.mean ?? 0))) : [];
  const worst = sr.worst_slice?.slice;
  const fix = sr.fix;
  return (
    <section aria-labelledby="slice-h" className="grid gap-3" data-section="slice-report">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="slice-h" className="m-0 flex items-center gap-2 text-xl font-semibold tracking-[-0.02em]">
            <SplitSquareHorizontal className="size-5 text-fg-subtle" aria-hidden /> Query types, slice by slice
          </h2>
          <p className="m-0 mt-1 max-w-[80ch] text-sm text-fg-muted">
            NDCG@10 per rules-based query class on {sr.n_total ?? "?"} held-out ESCI test queries ({sr.split}), each with a {sr.bootstrap?.resamples}-resample bootstrap CI. Worst slice first.
          </p>
        </div>
        <ProvenanceChip provenance={prov} />
      </div>
      {sr.status === "absent" ? (
        <Absent block={sr} />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>query class</TableHead>
                  <TableHead>n</TableHead>
                  {modes.map((m) => (
                    <TableHead key={m} title={modeLabel(m)}>{m}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {slices.map((sl) => (
                  <TableRow key={sl} className={cn(sl === worst && "bg-bad-soft/50", sl === "ALL" && "font-semibold")}>
                    <TableCell className="font-mono text-sm whitespace-nowrap">
                      {sl}
                      {sl === worst && <Badge size="sm" tone="solidBad" className="ml-2">worst</Badge>}
                    </TableCell>
                    <TableCell className="tabular text-sm">{(sr.per_slice[sl][modes[0]] as Cell)?.n}</TableCell>
                    {modes.map((m) => {
                      const c = sr.per_slice[sl][m] as Cell | undefined;
                      return (
                        <TableCell key={m} className="min-w-[9rem]">
                          {c ? (
                            <div className="grid gap-0.5">
                              <span className="tabular text-sm">{raw(c.mean)}</span>
                              <span className="tabular font-mono text-2xs text-fg-subtle">{ci(c.ci95)}</span>
                            </div>
                          ) : (
                            "–"
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {fix && (
            <div className={cn("grid gap-2 rounded-xl border bg-surface p-4", fix.ci95 && fix.ci95[0] <= 0 && fix.ci95[1] >= 0 ? "border-warn/50" : "border-line")} data-slice-fix>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="warn">targeted fix · {fix.slice}</Badge>
                <span className="text-sm font-medium">{fix.verdict}</span>
              </div>
              <p className="m-0 text-sm text-fg-muted">{fix.description}</p>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="tabular">before {raw(fix.before?.mean)} {ci(fix.before?.ci95)}</span>
                <span className="tabular">after {raw(fix.after?.mean)} {ci(fix.after?.ci95)}</span>
                <span className="tabular font-semibold">paired Δ {raw(fix.delta)} CI95 {ci(fix.ci95)} · n = {fix.n}</span>
              </div>
              {typeof fix.delta === "number" && fix.ci95 && <CiStrip value={fix.delta} ci={fix.ci95} label="paired delta" className="max-w-md" />}
              {sr.regression_check?.all_queries?.paired && (
                <p className="m-0 text-xs text-fg-muted tabular">
                  All queries: Δ {raw(sr.regression_check.all_queries.paired.mean_delta)} {ci(sr.regression_check.all_queries.paired.ci95)}, n = {sr.regression_check.all_queries.paired.n}. Variant chosen on the dev split (n = {fix.tuning?.n}).
                </p>
              )}
            </div>
          )}
          {Array.isArray(sr.caveats) && (
            <ul className="m-0 grid gap-1 pl-5 text-xs text-fg-muted">
              {sr.caveats.map((c: string) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function RateCell({ r }: { r?: Rate }) {
  if (!r) return <span className="text-fg-subtle">–</span>;
  return (
    <span className="tabular text-sm">
      {r.k}/{r.n} = {raw(r.rate)} <span className="font-mono text-2xs text-fg-subtle">{ci(r.ci95_wilson)}</span>
    </span>
  );
}

export function BypassGate({ board }: { board: CoverageBoardData }) {
  const bg = board.bypass_gate;
  if (!bg) return null;
  const prov = boardProvenance(board, "data/bypass_gate.json", bg.generated_at ? `generated ${bg.generated_at} by ${bg.script}` : undefined);
  const phases = [
    ["before", bg.before],
    ["after", bg.after],
  ] as const;
  const langs = ["en", "es", "code_switched"];
  return (
    <section aria-labelledby="bypass-h" className="grid gap-3" data-section="bypass-gate">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="bypass-h" className="m-0 flex items-center gap-2 text-xl font-semibold tracking-[-0.02em]">
            <ShieldAlert className="size-5 text-fg-subtle" aria-hidden /> Bypass classes by language: the release gate
          </h2>
          <p className="m-0 mt-1 max-w-[80ch] text-sm text-fg-muted">An open class (language × attack family with a finding that still gets through) blocks the release. Shipping over one needs a named, unexpired override.</p>
        </div>
        <ProvenanceChip provenance={prov} />
      </div>
      {bg.status === "absent" ? (
        <Absent block={bg} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge size="lg" tone={bg.release_blocked_before ? "solidBad" : "ok"}>before: release {bg.release_blocked_before ? "BLOCKED" : "allowed"}</Badge>
            <Badge size="lg" tone={bg.release_blocked_after ? "solidBad" : "ok"}>after: release {bg.release_blocked_after ? "BLOCKED" : "allowed"}</Badge>
            <Badge size="lg" tone="neutral">overrides applied: {bg.overrides?.applied_after?.length ?? 0}</Badge>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {(["classes_before", "classes_after"] as const).map((key) => (
              <div key={key} className="overflow-x-auto rounded-xl border border-line bg-surface">
                <div className="px-3 pt-2 text-2xs font-semibold tracking-wide text-fg-subtle uppercase">{key === "classes_before" ? "classes before" : "classes after"}</div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>class</TableHead>
                      <TableHead>findings</TableHead>
                      <TableHead>still bypassing</TableHead>
                      <TableHead>status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(bg[key] ?? []).map((c: any) => (
                      <TableRow key={c.class}>
                        <TableCell className="font-mono text-sm">{c.class}</TableCell>
                        <TableCell className="tabular text-sm">{c.n}</TableCell>
                        <TableCell className="tabular text-sm">{c.bypassing}</TableCell>
                        <TableCell>
                          <Badge size="sm" tone={c.status === "open" ? "solidBad" : c.status === "overridden" ? "warn" : "ok"}>{c.status}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>measure</TableHead>
                  <TableHead>before</TableHead>
                  <TableHead>after</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="text-sm">Recorded findings still bypassing (in-sample)</TableCell>
                  {phases.map(([k, p]) => (
                    <TableCell key={k}><RateCell r={p?.findings_replay?.bypass_rate} /></TableCell>
                  ))}
                </TableRow>
                <TableRow>
                  <TableCell className="text-sm">Adaptive attacker ASR, same seeds</TableCell>
                  {phases.map(([k, p]) => (
                    <TableCell key={k}><RateCell r={p?.adaptive_same_seeds?.pooled_asr} /></TableCell>
                  ))}
                </TableRow>
                <TableRow>
                  <TableCell className="text-sm">Adaptive attacker ASR, unseen seeds</TableCell>
                  {phases.map(([k, p]) => (
                    <TableCell key={k}><RateCell r={p?.adaptive_unseen_seeds?.pooled_asr} /></TableCell>
                  ))}
                </TableRow>
                {langs.map((l) => (
                  <TableRow key={l}>
                    <TableCell className="text-sm">Over-refusal on benign {l} (self-authored set)</TableCell>
                    <TableCell><RateCell r={bg.benign?.before?.[l]} /></TableCell>
                    <TableCell><RateCell r={bg.benign?.after?.[l]} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {Array.isArray(bg.caveats) && (
            <ul className="m-0 grid gap-1 pl-5 text-xs text-fg-muted">
              {bg.caveats.map((c: string) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
