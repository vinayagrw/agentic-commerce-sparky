/**
 * Ops work area: the dashboard is the primary content and scrolls on its own; the chat is a
 * secondary dock along the bottom that can be resized (drag or arrow keys on the handle) or
 * collapsed to its header. The chat stays mounted when collapsed, so beats still run into it,
 * and it opens itself when a run starts so an approval card is never hidden.
 * Below lg the page scrolls as one column and the dock is simply the section after the dashboard.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, GripHorizontal, Loader2, MessageSquare } from "lucide-react";
import { cn, safeStorage } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const KEY = "sparky.opsDock";
const MIN = 22;
const MAX = 78;

export function OpsWorkspace({ dashboard, chat, running, headerExtra }: { dashboard: React.ReactNode; chat: React.ReactNode; running: boolean; headerExtra?: React.ReactNode }) {
  const [pct, setPct] = useState(() => {
    const v = Number(safeStorage.get(`${KEY}.pct`));
    return Number.isFinite(v) && v >= MIN && v <= MAX ? v : 30;
  });
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).has("copilot") || safeStorage.get(`${KEY}.open`) !== "0");
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => safeStorage.set(`${KEY}.pct`, String(Math.round(pct))), [pct]);
  useEffect(() => safeStorage.set(`${KEY}.open`, open ? "1" : "0"), [open]);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  const clamp = (v: number) => Math.max(MIN, Math.min(MAX, v));
  const onMove = useCallback((e: PointerEvent) => {
    if (!dragging.current || !box.current) return;
    const r = box.current.getBoundingClientRect();
    setPct(clamp(((r.bottom - e.clientY) / r.height) * 100));
  }, []);
  const stop = useCallback(() => {
    dragging.current = false;
    document.body.style.removeProperty("user-select");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
  }, [onMove]);
  const start = (e: React.PointerEvent) => {
    if (!open) return;
    e.preventDefault();
    dragging.current = true;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
  };
  useEffect(() => stop, [stop]);

  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-canvas">{dashboard}</div>

      <section
        aria-label="Ops Copilot chat"
        className={cn("flex flex-none flex-col border-t border-line bg-surface shadow-[0_-8px_24px_-16px_var(--overlay)] max-lg:min-h-[70vh]", !open && "max-lg:min-h-0", open && "lg:h-[var(--dock)]")}
        style={open ? ({ "--dock": `${pct}%` } as React.CSSProperties) : undefined}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-10 flex-none items-center gap-2 border-b border-line px-3">
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize chat"
              aria-valuemin={MIN}
              aria-valuemax={MAX}
              aria-valuenow={Math.round(pct)}
              tabIndex={open ? 0 : -1}
              onPointerDown={start}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  e.stopPropagation();
                  setPct((p) => clamp(p + 4));
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  e.stopPropagation();
                  setPct((p) => clamp(p - 4));
                }
              }}
              className={cn("hidden h-7 w-10 place-items-center rounded-md text-fg-subtle focus-visible:outline-2 focus-visible:outline-focus lg:grid", open ? "cursor-row-resize hover:bg-surface-hover hover:text-fg" : "opacity-40")}
            >
              <GripHorizontal className="size-4" aria-hidden />
            </div>
            <MessageSquare className="size-4 text-fg-subtle" aria-hidden />
            <h2 className="m-0 text-sm font-semibold">Ops Copilot</h2>
            {running && (
              <span className="inline-flex items-center gap-1.5 text-xs text-accent" role="status">
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                Running
              </span>
            )}
            <span className="ml-auto" />
            {headerExtra}
            <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? <ChevronDown /> : <ChevronUp />}
              {open ? "Collapse" : "Open chat"}
            </Button>
          </div>
          <div className={cn("flex min-h-0 flex-1 flex-col", !open && "hidden")}>{chat}</div>
        </div>
      </section>
    </div>
  );
}
