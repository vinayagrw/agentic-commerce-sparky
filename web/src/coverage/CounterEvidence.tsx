import { Link, useLocation } from "react-router";
import { ArrowUpRight } from "lucide-react";
import { ProvenanceChip } from "@/components/Provenance";
import { cn } from "@/lib/utils";
import type { CoverageBoardData, Technique } from "./types";
import { CiStrip } from "./CiStrip";
import { FlagChip } from "./chips";
import { flagOf, measuredOf, primaryMeasurement, raw, type ResultFlag } from "./model";

const RANK: Record<ResultFlag, number> = { open: 0, negative: 1, null: 2 };

/**
 * "What did not work." The null and negative results, above the fold, before the list.
 * Membership comes from board.null_or_negative; each card's flag from the row itself.
 */
export function CounterEvidence({ board }: { board: CoverageBoardData }) {
  const rows = board.null_or_negative
    .map((id) => board.techniques.find((t) => t.id === id))
    .filter((t): t is Technique => Boolean(t))
    .sort((a, b) => RANK[flagOf(a) ?? "null"] - RANK[flagOf(b) ?? "null"] || a.id - b.id);
  const missingFlag = rows.filter((t) => !flagOf(t)).map((t) => t.id);
  return (
    <section aria-labelledby="ce-h" className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="ce-h" className="m-0 text-xl font-semibold tracking-[-0.02em]">
            What did not work <span className="tabular text-fg-subtle">({rows.length})</span>
          </h2>
          <p className="m-0 mt-1 max-w-[70ch] text-sm text-fg-muted">
            Null results, negative results and an open security bypass. They stay on the board at full weight: a technique that did not help here is a finding, not an omission.
          </p>
        </div>
      </div>
      {missingFlag.length > 0 && (
        <p role="alert" className="m-0 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
          Rows {missingFlag.join(", ")} are listed in null_or_negative but carry neither null_result nor negative_result. The data disagrees with itself.
        </p>
      )}
      <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2 2xl:grid-cols-3">
        {rows.map((t) => (
          <CounterCard key={t.id} t={t} board={board} />
        ))}
      </ul>
    </section>
  );
}

function CounterCard({ t, board }: { t: Technique; board: CoverageBoardData }) {
  const flag = flagOf(t) ?? "null";
  const { search } = useLocation();
  const m = primaryMeasurement(t);
  // Numbers only render through Measured<>: value and provenance travel together.
  const mv = m ? measuredOf(t, m, board) : null;
  const open = flag === "open";
  return (
    <li
      className={cn(
        "relative grid content-start gap-3 overflow-hidden rounded-xl border bg-surface p-4 pl-5 shadow-xs",
        open ? "border-bad md:col-span-2 2xl:col-span-3" : flag === "negative" ? "border-bad/40" : "border-warn/45",
      )}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1.5", open ? "bg-bad" : flag === "negative" ? "bg-bad" : "bg-warn")} />
      {open && <span aria-hidden className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(135deg,var(--bad-soft)_0_10px,transparent_10px_20px)] opacity-50" />}
      <div className="relative flex flex-wrap items-center gap-2">
        <FlagChip flag={flag} size={open ? "lg" : "md"} />
        <span className="font-mono text-xs text-fg-subtle">#{t.id}</span>
        <span className="text-xs text-fg-subtle">{t.stage}</span>
        {open && <span className="ml-auto text-xs font-semibold text-bad uppercase">Unresolved · still exploitable</span>}
      </div>
      <div className="relative">
        <h3 className={cn("m-0 font-semibold tracking-[-0.01em]", open ? "text-xl" : "text-md")}>
          <Link to={`/coverage/${t.id}${search}`} className="text-fg no-underline hover:underline focus-visible:outline-2 focus-visible:outline-focus">
            {t.name}
          </Link>
        </h3>
        {t.verdict && <p className={cn("m-0 mt-0.5 text-sm font-medium", flag === "null" ? "text-warn" : "text-bad")}>{t.verdict}</p>}
      </div>
      {m && mv && (
        <div className={cn("relative grid gap-2", open && "md:grid-cols-[auto_1fr] md:items-center md:gap-6")}>
          <div className="grid gap-1">
            <span className="text-2xs font-medium tracking-wide text-fg-subtle uppercase">{m.label}</span>
            <span className={cn("tabular font-semibold tracking-[-0.03em]", open ? "text-display text-bad" : "text-2xl")}>
              {raw(mv.value)}
              {m.unit ? <span className="ml-1 text-sm font-medium text-fg-muted">{m.unit}</span> : null}
            </span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              {m.n != null && <span className="tabular">n = {m.n}</span>}
              {m.ci95 && <span className="tabular font-mono">CI95 [{raw(m.ci95[0])}, {raw(m.ci95[1])}]</span>}
              <ProvenanceChip compact provenance={mv.provenance} />
            </span>
          </div>
          {m.ci95 && <CiStrip value={mv.value} ci={m.ci95} label={m.label} className="max-w-md" />}
        </div>
      )}
      <p className={cn("relative m-0 text-sm text-fg-muted", !open && "line-clamp-3")}>{t.headline}</p>
      <Link to={`/coverage/${t.id}${search}`} className="relative inline-flex w-fit items-center gap-1 text-sm font-medium text-accent no-underline hover:underline">
        Evidence, caveats and every measurement <ArrowUpRight className="size-3.5" aria-hidden />
      </Link>
    </li>
  );
}
