import { useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { FileWarning, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { CoverageStatus } from "./types";
import { loadCoverage, useCoverage } from "./useCoverage";
import { SummaryBand } from "./SummaryBand";
import { CounterEvidence } from "./CounterEvidence";
import { ClaimsBand, JudgesPanel } from "./ClaimsBand";
import { BypassGate, SliceReport } from "./SliceAndBypass";
import { TechniqueList } from "./TechniqueList";
import { TechniqueDetail } from "./TechniqueDetail";
import { flagOf, STATUS_LABEL, STATUS_ORDER, splitStage, stagesOf } from "./model";
import { BUILT_AS } from "./nameHonesty";

type StatusFilter = "all" | CoverageStatus;

/** /coverage and /coverage/:techniqueId. Filters live in the query string so every view is a link. */
export function Component() {
  const state = useCoverage();
  const { techniqueId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = params.get("q") ?? "";
  const stage = params.get("stage") ?? "all";
  const status = (params.get("status") ?? "all") as StatusFilter;
  const flagged = params.get("results") === "null-negative";

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v == null || v === "" || v === "all" ? next.delete(k) : next.set(k, v));
    setParams(next, { replace: true });
  };

  const board = state.status === "ready" ? state.data : null;
  const stages = useMemo(() => (board ? stagesOf(board) : []), [board]);
  const rows = useMemo(() => {
    if (!board) return [];
    const needle = q.trim().toLowerCase();
    return board.techniques.filter((t) => {
      if (stage !== "all" && t.stage !== stage) return false;
      if (status !== "all" && t.status !== status) return false;
      if (flagged && !board.null_or_negative.includes(t.id)) return false;
      if (!needle) return true;
      const hay = [String(t.id), t.name, t.stage, t.status, t.headline, t.verdict, t.no_metric_reason, BUILT_AS[t.id]?.builtAs, ...t.code.map((c) => `${c.file}:${c.symbol}`), ...t.caveats].join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [board, q, stage, status, flagged]);

  const detail = board && techniqueId ? board.techniques.find((t) => String(t.id) === techniqueId) : undefined;
  const closeDetail = () => navigate({ pathname: "/coverage", search: params.toString() ? `?${params}` : "" });
  const anyFilter = q || stage !== "all" || status !== "all" || flagged;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-[90rem] gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <header className="grid gap-2">
          <div className="text-2xs font-semibold tracking-[0.1em] text-fg-subtle uppercase">SOTA technique playbook · as built on this machine</div>
          <h1 className="m-0 text-3xl font-semibold tracking-[-0.03em]">Technique coverage</h1>
          <p className="m-0 max-w-[80ch] text-base text-fg-muted">
            Every technique in the playbook, what was actually built here, the file and function that implement it, and the number it measured or the reason there is none. Results that did not work are shown first.
          </p>
        </header>

        {state.status === "refused" && (
          <section role="alert" aria-live="assertive" className="grid gap-3 rounded-xl border border-bad/40 bg-surface p-5 shadow-md">
            <div className="flex items-center gap-2 text-bad">
              <FileWarning className="size-5" aria-hidden />
              <h2 className="m-0 text-lg font-semibold">The coverage board is not available</h2>
            </div>
            <p className="m-0 text-sm">{state.refusal.error}</p>
            <p className="m-0 text-sm text-fg-muted">Nothing is shown in its place. No cached or bundled board exists.</p>
            <div className="flex flex-wrap items-center gap-3">
              {state.refusal.fix && (
                <code className="rounded-md bg-code-bg px-2.5 py-1.5 font-mono text-sm text-code-fg">$ {state.refusal.fix}</code>
              )}
              <Button variant="primary" onClick={() => void loadCoverage(true)}>
                <RefreshCw /> Try again
              </Button>
              {state.httpStatus != null && <span className="text-xs text-fg-subtle">HTTP {state.httpStatus} from {state.refusal.endpoint ?? "GET /api/coverage"}</span>}
            </div>
          </section>
        )}

        {(state.status === "loading" || state.status === "idle") && (
          <div className="grid gap-4" aria-busy="true" aria-label="Loading coverage board">
            <Skeleton className="h-56 w-full rounded-xl" />
            <div className="grid gap-3 md:grid-cols-2">
              <Skeleton className="h-44 rounded-xl" />
              <Skeleton className="h-44 rounded-xl" />
            </div>
            <Skeleton className="h-96 w-full rounded-xl" />
          </div>
        )}

        {board && (
          <>
            <SummaryBand board={board} onStatus={(s) => update({ status: s, results: null })} onFlagged={() => update({ results: "null-negative", status: null })} />
            <ClaimsBand board={board} />
            <CounterEvidence board={board} />
            <JudgesPanel board={board} />
            <SliceReport board={board} />
            <BypassGate board={board} />

            <section aria-labelledby="all-h" className="grid gap-4">
              <h2 id="all-h" className="m-0 text-xl font-semibold tracking-[-0.02em]">
                All techniques by lifecycle stage
              </h2>
              <div className="sticky top-0 z-20 -mx-4 grid gap-2 border-b border-line bg-canvas/95 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="relative flex min-w-[14rem] flex-1 items-center">
                    <span className="sr-only">Search techniques</span>
                    <Search className="pointer-events-none absolute left-2.5 size-4 text-fg-subtle" aria-hidden />
                    <input
                      type="search"
                      value={q}
                      onChange={(e) => update({ q: e.target.value })}
                      placeholder="Search name, file, function, caveat…"
                      className="h-8 w-full rounded-md border border-line bg-surface pr-2 pl-8 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-accent-soft"
                    />
                  </label>
                  <Segmented<StatusFilter>
                    label="Filter by status"
                    value={status}
                    onValueChange={(v) => update({ status: v })}
                    className="max-w-full overflow-x-auto"
                    items={[{ value: "all", label: "All" }, ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
                  />
                  <button
                    type="button"
                    aria-pressed={flagged}
                    onClick={() => update({ results: flagged ? null : "null-negative" })}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
                      flagged ? "border-bad bg-bad text-bad-fg" : "border-bad/40 bg-bad-soft text-bad hover:border-bad",
                    )}
                  >
                    Null &amp; negative only
                  </button>
                  {anyFilter && (
                    <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                      <X /> Clear
                    </Button>
                  )}
                </div>
                <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="Filter by lifecycle stage">
                  {["all", ...stages].map((s) => {
                    const active = stage === s;
                    const count = s === "all" ? board.techniques.length : board.techniques.filter((t) => t.stage === s).length;
                    const nn = s === "all" ? board.null_or_negative.length : board.techniques.filter((t) => t.stage === s && flagOf(t)).length;
                    return (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={active}
                        onClick={() => update({ stage: s })}
                        className={cn(
                          "inline-flex h-7 flex-none items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-focus",
                          active ? "border-fg bg-fg text-canvas" : "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg",
                        )}
                      >
                        {s === "all" ? "All stages" : splitStage(s).name}
                        <span className="tabular opacity-70">{count}</span>
                        {nn > 0 && (
                          <span className={cn("tabular rounded-sm px-1 text-2xs", active ? "bg-bad text-bad-fg" : "bg-bad-soft text-bad")} title={`${nn} null or negative`}>
                            {nn}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="text-xs text-fg-subtle" aria-live="polite">
                  Showing <span className="tabular">{rows.length}</span> of <span className="tabular">{board.techniques.length}</span>
                </div>
              </div>
              <TechniqueList board={board} rows={rows} stages={stages} />
            </section>
          </>
        )}
      </div>

      <Sheet open={Boolean(techniqueId)} onOpenChange={(o) => !o && closeDetail()}>
        <SheetContent>
          {detail && board ? (
            <TechniqueDetail t={detail} board={board} />
          ) : (
            <div className="grid gap-3 p-7">
              <SheetTitle className="text-xl font-semibold">{board ? `No technique #${techniqueId}` : "Loading technique"}</SheetTitle>
              <SheetDescription className="text-sm text-fg-muted">
                {board ? `The board has techniques 1 to ${board.total}.` : state.status === "refused" ? state.refusal.error : "Reading GET /api/coverage…"}
              </SheetDescription>
              {!board && state.status !== "refused" && <Skeleton className="h-64 w-full" />}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
