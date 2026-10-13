import type { BeatDef } from "@sparky/shared";
import { ArrowRight, Keyboard, Lock, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

interface Props {
  title: string;
  beats: BeatDef[];
  current: BeatDef;
  /** Beats cannot run: a run is streaming, or the health gate is closed. */
  running: boolean;
  locked: boolean;
  onSelect: (b: BeatDef) => void;
  onRun: (b: BeatDef) => void;
}

/** Beat list for a plane. Replaces BeatRail; same select / run / next contract. */
export function SideNav({ title, beats, current, running, locked, onSelect, onRun }: Props) {
  const idx = beats.findIndex((b) => b.id === current.id);
  const next = beats[idx + 1];
  const disabled = running || locked;
  return (
    <nav aria-label={`${title} beats`} className="flex min-h-0 flex-col border-line bg-surface lg:border-r">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="m-0 text-2xs font-medium tracking-[0.08em] text-fg-subtle uppercase">{title}</h2>
        <span className="tabular text-2xs text-fg-subtle">
          {idx + 1} / {beats.length}
        </span>
      </div>
      <ol className="m-0 flex list-none gap-1.5 overflow-x-auto px-2 pb-2 lg:flex-1 lg:flex-col lg:gap-0.5 lg:overflow-y-auto">
        {beats.map((b) => {
          const active = b.id === current.id;
          return (
            <li key={b.id} className="min-w-[13rem] lg:min-w-0">
              <button
                type="button"
                onClick={() => onSelect(b)}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "group relative flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-focus",
                  active ? "bg-accent-soft" : "hover:bg-surface-hover",
                )}
              >
                <span
                  className={cn(
                    "tabular mt-0.5 grid h-5 min-w-5 flex-none place-items-center rounded-sm px-1 font-mono text-2xs font-semibold",
                    active ? "bg-accent text-accent-fg" : "bg-surface-sunken text-fg-muted group-hover:text-fg",
                  )}
                >
                  {b.label}
                </span>
                <span className="min-w-0">
                  <span className={cn("block text-sm font-medium", active ? "text-accent-soft-fg" : "text-fg")}>{b.title}</span>
                  <span className="block text-xs text-fg-muted">{b.blurb}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="grid gap-2 border-t border-line p-3">
        <div className="rounded-md bg-surface-sunken px-2.5 py-2 text-xs text-fg-muted">
          <span className="mb-0.5 block text-2xs font-medium tracking-wide text-fg-subtle uppercase">Prompt</span>
          {current.prompt}
        </div>
        <div className="flex gap-2">
          <Button variant="primary" className="flex-1" disabled={disabled} onClick={() => onRun(current)}>
            {locked ? <Lock /> : <Play />}
            {locked ? "Locked" : running ? "Running" : `Run beat ${current.label}`}
          </Button>
          <Button variant="highlight" disabled={disabled || !next} onClick={() => next && onRun(next)} aria-label={next ? `Run next beat ${next.label}` : "No next beat"}>
            Next
            <ArrowRight />
          </Button>
        </div>
        <div className="hidden items-center gap-1.5 text-2xs text-fg-subtle lg:flex">
          <Keyboard className="size-3.5" aria-hidden />
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> select
          <Kbd>↵</Kbd> run
          <Kbd>⌘K</Kbd> jump
        </div>
      </div>
    </nav>
  );
}
