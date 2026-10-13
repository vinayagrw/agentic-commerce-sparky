import type { AgentState, LifecycleStage } from "@sparky/shared";
import { LIFECYCLE } from "@sparky/shared";
import { Bot, Check, Database, FlaskConical, MoonStar, Radar, RefreshCcw, Rocket } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { TierBadge } from "@/components/TierBadge";

const STAGE_ICON: Record<LifecycleStage, LucideIcon> = { Data: Database, Validate: FlaskConical, Deploy: Rocket, Monitor: Radar, Retrain: RefreshCcw };
export const AGENT_STAGE: Record<string, LifecycleStage> = { "Data Quality": "Data", Labeling: "Data", Eval: "Validate", "Drift Monitor": "Monitor", Remediation: "Retrain", Release: "Deploy", "FinOps Router": "Monitor" };

const DOT: Record<string, string> = { running: "bg-highlight animate-pulse motion-reduce:animate-none", done: "bg-ok", blocked: "bg-bad", idle: "bg-line-strong", skipped: "bg-line-strong" };

/** The ML lifecycle as a stepper: which stage the loop is in, which agents acted where. */
export function LifecycleStepper({ state }: { state: AgentState }) {
  const o = state.ops;
  const activeIdx = o.stage ? LIFECYCLE.indexOf(o.stage) : -1;
  return (
    <section aria-label="ML lifecycle" className="grid gap-3 rounded-xl border border-line bg-surface p-3 shadow-xs sm:p-4 xl:grid-cols-[minmax(0,1fr)_minmax(15rem,20rem)] xl:items-center">
      <ol className="m-0 grid list-none grid-cols-5 gap-0 p-0">
        {LIFECYCLE.map((st, i) => {
          const Icon = STAGE_ICON[st];
          const active = i === activeIdx;
          const agents = state.agents.filter((a) => AGENT_STAGE[a.name] === st);
          const visited = !active && agents.some((a) => a.status === "done");
          // B08: a failed release gate turns the Validate stage red, whatever else is running.
          const red = st === "Validate" && (o.gate as any)?.passed === false;
          return (
            <li key={st} aria-current={active ? "step" : undefined} className="relative flex min-w-0 flex-col items-center gap-1.5 text-center">
              {i < LIFECYCLE.length - 1 && (
                <span aria-hidden className={cn("absolute top-5 left-[calc(50%+1.5rem)] h-0.5 w-[calc(100%-3rem)] rounded-full", i < activeIdx ? "bg-accent" : "bg-line")} />
              )}
              <span
                className={cn(
                  "relative grid size-10 place-items-center rounded-full border-2 transition-colors",
                  red ? "border-bad bg-bad text-bad-fg shadow-[0_0_0_4px_var(--bad-soft)]" : active ? "border-accent bg-accent text-accent-fg shadow-[0_0_0_4px_var(--accent-soft)]" : visited ? "border-ok bg-ok-soft text-ok" : "border-line bg-surface-sunken text-fg-subtle",
                )}
              >
                <Icon className="size-5" aria-hidden />
                {visited && !red && (
                  <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-ok text-surface">
                    <Check className="size-3" aria-hidden />
                  </span>
                )}
              </span>
              <span className={cn("text-sm font-semibold", red ? "text-bad" : active ? "text-fg" : "text-fg-muted")}>{st}{red ? " · gate red" : ""}</span>
              <span className="flex min-h-4 flex-wrap justify-center gap-1">
                {agents.map((a) => (
                  <span key={a.name} title={`${a.name} · ${a.tier} · ${a.status}`} className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-1.5 text-2xs text-fg-muted">
                    <span aria-hidden className={cn("size-1.5 rounded-full", DOT[a.status] ?? DOT.idle)} />
                    <span className="hidden max-w-[9rem] truncate sm:inline">{a.name}</span>
                    <span className="sr-only">{`${a.name}, ${a.status}`}</span>
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-sunken/60 px-3 py-2.5" aria-live="polite">
        <span aria-hidden className={cn("grid size-10 flex-none place-items-center rounded-lg", o.active_agent ? "bg-accent-soft text-accent-soft-fg" : "bg-surface text-fg-subtle")}>
          {o.active_agent ? <Bot className="size-5" /> : <MoonStar className="size-5" />}
        </span>
        <div className="min-w-0">
          <div className="text-2xs font-medium tracking-wide text-fg-subtle uppercase">Active agent</div>
          <div className="truncate text-md font-semibold">{o.active_agent ?? "None"}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {o.tier && <TierBadge tier={o.tier} />}
            {state.mode === "refused" ? <Badge size="sm" tone="bad">refused · {state.refusal?.reason ?? "unknown"}</Badge> : <span className="text-xs text-fg-muted">{o.active_agent ? `${o.stage ?? ""} stage` : "Run a beat to start the loop"}</span>}
          </div>
        </div>
      </div>
    </section>
  );
}
