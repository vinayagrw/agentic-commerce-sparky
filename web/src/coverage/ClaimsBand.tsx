/**
 * B06: the six demo claims, each with the evidence it rests on and, always visible, what the claim
 * must NOT pretend. B04: the two relevance judges side by side, each labelled with what it is.
 * Every number is read from GET /api/coverage and rendered with its provenance.
 */
import type { Measured, Provenance } from "@sparky/shared";
import { Ban, Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ProvenanceChip, Stat } from "@/components/Provenance";
import { cn } from "@/lib/utils";
import { CiStrip } from "./CiStrip";
import { raw } from "./model";
import type { Claim, CoverageBoardData, JudgeRow, Measurement } from "./types";

export function boardProvenance(board: CoverageBoardData, source: string, note?: string): Provenance {
  return {
    service: "coverage",
    endpoint: source,
    timestamp: board.generated_at ?? board.provenance.generated_at ?? board.provenance.file_mtime,
    note: `${note ? `${note}\n` : ""}Served by ${board.provenance.endpoint}. ${board.provenance.note}`,
  };
}

function evidenceSource(e: Record<string, any>): string {
  if (e.technique) return `data/coverage.json technique ${e.technique}`;
  if (e.evidence) return `data/coverage.json evidence ${e.evidence}`;
  if (e.lifecycle) return "data/lifecycle_measured.json";
  if (e.slice_report) return "data/slice_report.json";
  if (e.tally) return "data/coverage.json tally";
  return "data/coverage.json";
}

function EvidenceStat({ e, board }: { e: Measurement & Record<string, any>; board: CoverageBoardData }) {
  if (typeof e.value !== "number") {
    if (e.value == null) return null;
    return (
      <div className="grid gap-0.5">
        <span className="text-2xs font-medium tracking-wide text-fg-subtle uppercase">{e.label ?? e.slice_report ?? "evidence"}</span>
        <span className="text-sm font-medium">{typeof e.value === "string" ? e.value : JSON.stringify(e.value)}</span>
      </div>
    );
  }
  const mv: Measured<number> = { value: e.value, provenance: boardProvenance(board, evidenceSource(e)) };
  return (
    <div className="grid min-w-[10rem] gap-1">
      <Stat size="sm" label={e.label ?? (e.tally ? `rows ${e.tally}` : "value")} value={mv} format={raw} suffix={e.unit ? ` ${e.unit}` : undefined} />
      <span className="flex flex-wrap gap-2 text-2xs text-fg-muted">
        {e.n != null && <span className="tabular">n = {e.n}</span>}
        {e.ci95 && <span className="tabular font-mono">CI95 [{raw(e.ci95[0])}, {raw(e.ci95[1])}]</span>}
      </span>
      {e.ci95 && <CiStrip compact value={e.value} ci={e.ci95} label={e.label ?? ""} className="max-w-[14rem]" />}
    </div>
  );
}

const BUILT: Record<Claim["built"], { tone: "ok" | "warn" | "bad"; label: string }> = {
  yes: { tone: "ok", label: "built" },
  partial: { tone: "warn", label: "partly built" },
  no: { tone: "bad", label: "not built" },
};

export function ClaimsBand({ board }: { board: CoverageBoardData }) {
  const claims = board.claims ?? [];
  if (!claims.length) return null;
  return (
    <section aria-labelledby="claims-h" className="grid gap-3">
      <div>
        <h2 id="claims-h" className="m-0 text-xl font-semibold tracking-[-0.02em]">
          What this demo claims, and what it must not pretend
        </h2>
        <p className="m-0 mt-1 max-w-[80ch] text-sm text-fg-muted">Six claims. Each shows the evidence it rests on and, always visible, the line it must not cross.</p>
      </div>
      <ol className="m-0 grid list-none gap-3 p-0 lg:grid-cols-2">
        {claims.map((c) => (
          <li key={c.id} className="grid content-start gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs" data-claim={c.id}>
            <div className="flex items-start gap-3">
              <span className="tabular grid size-7 flex-none place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent-soft-fg">{c.id}</span>
              <div className="grid min-w-0 gap-1">
                <h3 className="m-0 text-md font-semibold">{c.claim}</h3>
                <p className="m-0 text-sm text-fg-muted">{c.shown_by}</p>
              </div>
              <Badge size="sm" tone={BUILT[c.built].tone} className="ml-auto flex-none">
                {BUILT[c.built].label}
              </Badge>
            </div>
            {c.evidence.length > 0 && (
              <div className="flex flex-wrap gap-x-6 gap-y-3 pl-10">
                {c.evidence.map((e, i) => (
                  <EvidenceStat key={i} e={e} board={board} />
                ))}
              </div>
            )}
            <p className="m-0 flex items-start gap-2 rounded-lg border border-bad/30 bg-bad-soft/60 px-3 py-2 text-sm" data-caption="must-not-pretend">
              <Ban className="mt-0.5 size-4 flex-none text-bad" aria-hidden />
              <span>
                <span className="font-semibold text-bad">Must not pretend: </span>
                {c.must_not_pretend}
              </span>
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function JudgeCard({ j, board }: { j: JudgeRow; board: CoverageBoardData }) {
  const k = j.kappa;
  const src = j.provenance[0] ?? "data/coverage.json";
  return (
    <li className={cn("grid content-start gap-3 rounded-xl border bg-surface p-4 shadow-xs", j.judge === "lexical" ? "border-bad/40" : "border-warn/45")} data-judge={j.judge}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={j.judge === "lexical" ? "solidBad" : "warn"} className="uppercase">
          {j.judge === "lexical" ? "lexical judge" : "LLM judge"}
        </Badge>
        <Badge size="sm" tone={j.ran_in_this_repo ? "neutral" : "warn"}>
          {j.ran_in_this_repo ? "ran in this repo" : "NOT run in this repo"}
        </Badge>
        {j.fit_to_gate === false && <Badge size="sm" tone="bad">not fit to gate</Badge>}
      </div>
      <h3 className="m-0 text-md font-semibold">{j.label}</h3>
      {j.what_it_is && <p className="m-0 text-sm text-fg-muted">{j.what_it_is}</p>}
      {k && typeof k.value === "number" ? (
        <div className="grid gap-1">
          <Stat size="lg" label={k.label} value={{ value: k.value, provenance: boardProvenance(board, src) }} format={raw} tone={j.judge === "lexical" ? "bad" : "warn"} />
          <span className="flex flex-wrap gap-2 text-xs text-fg-muted">
            {k.n != null && <span className="tabular">n = {k.n}</span>}
            {k.ci95 && <span className="tabular font-mono">CI95 [{raw(k.ci95[0])}, {raw(k.ci95[1])}]</span>}
          </span>
          {k.ci95 && <CiStrip value={k.value} ci={k.ci95} label={k.label} className="max-w-sm" />}
        </div>
      ) : (
        <p className="m-0 text-sm text-fg-muted">No kappa on the board for this judge.</p>
      )}
      <p className="m-0 flex items-start gap-2 rounded-lg border border-bad/30 bg-bad-soft/60 px-3 py-2 text-sm">
        <Ban className="mt-0.5 size-4 flex-none text-bad" aria-hidden />
        <span>
          <span className="font-semibold text-bad">Must not pretend: </span>
          {j.must_not_pretend}
        </span>
      </p>
      <span className="flex flex-wrap gap-1.5">
        {j.provenance.map((p) => (
          <ProvenanceChip key={p} compact provenance={boardProvenance(board, p)} />
        ))}
      </span>
    </li>
  );
}

export function JudgesPanel({ board }: { board: CoverageBoardData }) {
  const judges = board.judges ?? [];
  const spike = board.evidence?.find((e) => e.key === "spike-llm-judge");
  if (!judges.length) return null;
  return (
    <section aria-labelledby="judges-h" className="grid gap-3">
      <div>
        <h2 id="judges-h" className="m-0 flex items-center gap-2 text-xl font-semibold tracking-[-0.02em]">
          <Scale className="size-5 text-fg-subtle" aria-hidden /> Relevance judges: two different things
        </h2>
        <p className="m-0 mt-1 max-w-[80ch] text-sm text-fg-muted">The demo's own online judge is lexical and fails. The LLM judge was measured by an independent spike, outside this repo. Neither number stands in for the other.</p>
      </div>
      <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2">
        {judges.map((j) => (
          <JudgeCard key={j.key} j={j} board={board} />
        ))}
      </ul>
      {spike?.measurements && (
        <div className="flex flex-wrap gap-x-6 gap-y-3 rounded-lg border border-line bg-surface-sunken/60 px-4 py-3">
          {spike.measurements
            .filter((m) => !/Cohen's kappa$/.test(m.label) || /itself/.test(m.label))
            .map((m) => (
              <EvidenceStat key={m.label} e={{ ...m, evidence: spike.key }} board={board} />
            ))}
        </div>
      )}
    </section>
  );
}
