import { Link, useLocation } from "react-router";
import { ArrowRight, BookOpen, FileCode2 } from "lucide-react";
import { ProvenanceChip } from "@/components/Provenance";
import { cn } from "@/lib/utils";
import type { CoverageBoardData, Technique } from "./types";
import { FlagChip, StatusChip } from "./chips";
import { flagOf, measuredOf, primaryMeasurement, raw, splitStage } from "./model";
import { BUILT_AS } from "./nameHonesty";

export function TechniqueList({ board, rows, stages }: { board: CoverageBoardData; rows: Technique[]; stages: string[] }) {
  const groups = stages.map((s) => ({ stage: s, items: rows.filter((r) => r.stage === s) })).filter((g) => g.items.length);
  if (!groups.length) {
    return (
      <div className="grid place-items-center gap-1 rounded-xl border border-dashed border-line-strong px-6 py-14 text-center">
        <div className="text-md font-medium">No technique matches these filters</div>
        <div className="text-sm text-fg-muted">Clear the search or pick another stage or status.</div>
      </div>
    );
  }
  return (
    <div className="grid gap-6">
      {groups.map((g) => {
        const { num, name } = splitStage(g.stage);
        const total = board.techniques.filter((t) => t.stage === g.stage).length;
        return (
          <section key={g.stage} aria-labelledby={`stage-${num}`} className="grid gap-2">
            <h3 id={`stage-${num}`} className="m-0 flex items-baseline gap-2 py-1 text-sm font-semibold">
              <span className="font-mono text-xs text-fg-subtle">Stage {num}</span>
              {name}
              <span className="tabular text-xs font-normal text-fg-subtle">
                {g.items.length === total ? total : `${g.items.length} of ${total}`}
              </span>
            </h3>
            <ul className="m-0 grid list-none overflow-hidden rounded-xl border border-line bg-surface p-0 shadow-xs">
              {g.items.map((t) => (
                <Row key={t.id} t={t} board={board} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Row({ t, board }: { t: Technique; board: CoverageBoardData }) {
  const { search } = useLocation();
  const flag = flagOf(t);
  const m = primaryMeasurement(t);
  const mv = m ? measuredOf(t, m, board) : null;
  const built = BUILT_AS[t.id];
  const first = t.code[0];
  return (
    <li
      className={cn(
        "relative grid gap-x-5 gap-y-2 border-b border-line px-4 py-3.5 last:border-b-0 md:grid-cols-[2.25rem_minmax(0,1.35fr)_minmax(0,1fr)_auto] md:items-start",
        flag === "open" && "bg-bad-soft",
        flag === "negative" && "bg-[linear-gradient(90deg,var(--bad-soft),transparent_45%)]",
        flag === "null" && "bg-[linear-gradient(90deg,var(--warn-soft),transparent_45%)]",
      )}
    >
      {flag && <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", flag === "null" ? "bg-warn" : "bg-bad")} />}
      <span className="font-mono text-xs text-fg-subtle tabular md:pt-0.5">#{t.id}</span>

      <div className="grid min-w-0 gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/coverage/${t.id}${search}`} className="text-base font-semibold text-fg no-underline hover:underline focus-visible:outline-2 focus-visible:outline-focus">
            {t.name}
          </Link>
          <StatusChip status={t.status} size="sm" />
          {flag && <FlagChip flag={flag} size="sm" />}
        </div>
        {built && (
          <div className="text-xs text-fg-muted">
            <span className="font-semibold text-fg">Built as:</span> {built.builtAs}. <span className="text-warn">{built.notBuilt}.</span>
          </div>
        )}
        {first && (
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted" title={t.code.map((c) => `${c.file}:${c.symbol}`).join("\n")}>
            <FileCode2 className="size-3.5 flex-none text-fg-subtle" aria-hidden />
            <code className="truncate font-mono">
              {first.file.split("/").pop()}:<span className="text-fg">{first.symbol}</span>
            </code>
            {t.code.length > 1 && <span className="flex-none text-fg-subtle">+{t.code.length - 1}</span>}
          </div>
        )}
      </div>

      <div className="grid min-w-0 gap-1">
        {mv && m ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn("tabular text-xl font-semibold tracking-[-0.02em]", flag === "null" && "text-warn", (flag === "negative" || flag === "open") && "text-bad")}>
                {raw(mv.value)}
                {m.unit ? <span className="ml-1 text-xs font-medium text-fg-muted">{m.unit}</span> : null}
              </span>
              {m.ci95 && <span className="font-mono text-xs text-fg-muted tabular">[{raw(m.ci95[0])}, {raw(m.ci95[1])}]</span>}
              {m.n != null && <span className="text-xs text-fg-subtle tabular">n={m.n}</span>}
            </div>
            <div className="truncate text-xs text-fg-muted" title={m.label}>
              {m.label}
            </div>
            <div>
              <ProvenanceChip compact provenance={mv.provenance} />
            </div>
          </>
        ) : (
          <div className="text-xs text-fg-muted">
            <span className="font-medium text-fg">No number claimed.</span> <span className="line-clamp-2">{t.no_metric_reason}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 md:flex-col md:items-end md:gap-1.5">
        <span className="inline-flex items-center gap-1 font-mono text-xs text-fg-muted" title={t.playbook_link}>
          <BookOpen className="size-3.5 text-fg-subtle" aria-hidden />
          {t.playbook_section}
        </span>
        <Link to={`/coverage/${t.id}${search}`} className="inline-flex items-center gap-1 text-xs font-medium text-accent no-underline hover:underline" aria-label={`Open detail for technique ${t.id}, ${t.name}`}>
          Detail <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </li>
  );
}
