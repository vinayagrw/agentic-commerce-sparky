/**
 * Mermaid diagram with zoom / pan / fullscreen. `mermaid` is imported lazily (its own chunk) the first
 * time a diagram tab is opened. Zoom: wheel (with Ctrl/⌘ or inside fullscreen), +/− buttons or keys;
 * pan: drag, or arrow keys when the viewport is focused; 0 resets. Theme follows the app's light/dark.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Maximize2, Minimize2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState, PanelSkeleton } from "@/components/states";

const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
};
let seq = 0;

export function MermaidView({ source, label, fill }: { source: string; label: string; /** Grow to fill a flex parent instead of a fixed 70vh box (the atlas). */ fill?: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [full, setFull] = useState(false);
  const [dark, setDark] = useState(isDark);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const hint = useId();

  useEffect(() => {
    const mo = new MutationObserver(() => setDark(isDark()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    setSvg(null);
    setErr(null);
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
        const { svg } = await mermaid.render(`guide-mmd-${++seq}`, source);
        if (alive) setSvg(svg);
      })
      .catch((e) => alive && setErr(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [source, dark]);

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const zoom = useCallback((f: number) => setView((v) => ({ ...v, k: Math.min(8, Math.max(0.2, v.k * f)) })), []);
  const reset = () => setView({ k: 1, x: 0, y: 0 });

  // Non-passive wheel so Ctrl/⌘+wheel (and any wheel in fullscreen) zooms instead of scrolling the page.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey || document.fullscreenElement === el)) return;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, [zoom, svg]);

  const toggleFull = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await box.current?.requestFullscreen();
    } catch {
      setFull((f) => !f); // fullscreen API blocked: fall back to a fixed overlay
    }
  };

  if (err) return <ErrorState title="Diagram could not be rendered">{err}</ErrorState>;

  return (
    <div
      ref={box}
      data-testid="guide-diagram"
      className={full ? "fixed inset-0 z-50 flex flex-col bg-canvas" : `flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface${fill ? " h-full" : ""}`}
    >
      <div className="flex flex-none flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
        <Button size="icon" variant="ghost" aria-label="Zoom in" onClick={() => zoom(1.25)} data-testid="diagram-zoom-in"><ZoomIn /></Button>
        <Button size="icon" variant="ghost" aria-label="Zoom out" onClick={() => zoom(0.8)} data-testid="diagram-zoom-out"><ZoomOut /></Button>
        <Button size="icon" variant="ghost" aria-label="Reset zoom" onClick={reset}><RotateCcw /></Button>
        <span className="tabular px-1 text-xs text-fg-muted" data-testid="diagram-zoom">{Math.round(view.k * 100)}%</span>
        <span id={hint} className="hidden text-2xs text-fg-muted sm:inline">drag to pan · Ctrl/⌘ + wheel to zoom</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void toggleFull()} data-testid="diagram-fullscreen" aria-pressed={full}>
          {full ? <Minimize2 /> : <Maximize2 />}
          {full ? "Exit fullscreen" : "Fullscreen"}
        </Button>
      </div>
      <div
        role="img"
        aria-label={`Diagram: ${label}`}
        aria-describedby={hint}
        tabIndex={0}
        className={`relative cursor-grab touch-none overflow-hidden bg-surface focus-visible:outline-2 focus-visible:outline-focus active:cursor-grabbing ${full || fill ? "min-h-0 flex-1" : "h-[min(70vh,36rem)]"}`}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={(e) => {
          const step = 40;
          const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
          if (moves[e.key]) {
            e.preventDefault();
            setView((v) => ({ ...v, x: v.x + moves[e.key][0], y: v.y + moves[e.key][1] }));
          } else if (e.key === "+" || e.key === "=") zoom(1.25);
          else if (e.key === "-") zoom(0.8);
          else if (e.key === "0") reset();
        }}
      >
        {svg ? (
          <div
            data-testid="guide-diagram-svg"
            className="origin-top-left p-4"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="p-4"><PanelSkeleton rows={4} label="Rendering diagram" /></div>
        )}
      </div>
    </div>
  );
}
