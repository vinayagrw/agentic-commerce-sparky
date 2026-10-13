/**
 * Atlas: a full-screen, per-area view of an area's diagram (rendered by MermaidView, so zoom/pan
 * and fullscreen come for free). The node -> feature mapping is DECLARED in the data
 * (`atlas_nodes` in docs/features.json, authored in docs/FEATURE_CATALOGUE.md and validated by
 * `make docs-check`), never guessed from a label. A declared node is clickable; every other node
 * is dimmed and marked inert so a dead node looks dead. A list of the mapped jumps sits under the
 * diagram so the mapping is reachable by keyboard too.
 */
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router";
import { Map as MapIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PanelSkeleton } from "@/components/states";
import { atlasNodeMap, nodeIdsIn, type Feature } from "./guideModel";

const MermaidView = lazy(() => import("./MermaidView").then((m) => ({ default: m.MermaidView })));

export function AtlasView({ area, features, all, onClose }: { area: string; features: Feature[]; all: Feature[]; onClose: () => void }) {
  const navigate = useNavigate();
  // The area's atlas is the diagram with the most declared node -> feature links (a sequence
  // diagram of one call path declares none); ties go to the diagram that draws the most.
  const picked = useMemo(() => {
    const scored = features.filter((f) => f.diagram).map((f) => ({ f, map: atlasNodeMap(f, all) }));
    scored.sort((a, b) => new Set([...b.map.values()].map((x) => x.id)).size - new Set([...a.map.values()].map((x) => x.id)).size || b.f.diagram!.length - a.f.diagram!.length);
    return scored[0] ?? null;
  }, [features, all]);
  const source = picked?.f ?? null;
  const nodes = picked?.map ?? new Map<string, Feature>();
  const totalNodes = useMemo(() => nodeIdsIn(source?.diagram).length, [source]);
  const inert = Math.max(0, totalNodes - nodes.size);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);

  // Mermaid ids the rendered node as `flowchart-<id>-<n>` (and similar per diagram type), so match
  // on the id fragment rather than assuming one shape.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const find = (t: EventTarget | null): Feature | null => {
      let n = t as Element | null;
      while (n && n !== el) {
        const id = n.getAttribute?.("id") ?? "";
        for (const [key, f] of nodes) if (id === key || id.split("-").includes(key)) return f;
        n = n.parentElement;
      }
      return null;
    };
    const mark = () => {
      for (const g of el.querySelectorAll<SVGGElement>("g.node, g.nodes > g")) {
        const f = find(g);
        // A node with no declared feature must look dead, not merely be dead.
        g.style.cursor = f ? "pointer" : "not-allowed";
        g.style.opacity = f ? "" : "0.45";
        g.setAttribute("data-atlas-node", f ? "mapped" : "inert");
        const t = g.querySelector("title") ?? g.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "title");
        t.textContent = f ? `Open ${f.name}` : "No feature declares this node (atlas_nodes in docs/features.json)";
        if (!t.parentNode) g.prepend(t);
      }
    };
    const click = (e: MouseEvent) => {
      const f = find(e.target);
      if (f) navigate(`/guide/${encodeURIComponent(f.id)}`);
    };
    const t = setTimeout(mark, 300);
    const t2 = setTimeout(mark, 1200);
    el.addEventListener("click", click);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
      el.removeEventListener("click", click);
    };
  }, [nodes, navigate, source]);

  return (
    <section
      data-testid="guide-atlas"
      data-area={area}
      data-mapped-nodes={nodes.size}
      data-inert-nodes={inert}
      aria-label={`${area} atlas`}
      className="fixed inset-0 z-40 flex flex-col gap-3 overflow-hidden bg-canvas p-4 sm:p-6"
    >
      <header className="flex flex-none flex-wrap items-center gap-2">
        <MapIcon className="size-5 text-fg-muted" aria-hidden />
        <h1 className="m-0 text-xl font-semibold tracking-[-0.02em]">{area} atlas</h1>
        <span className="text-xs text-fg-muted" data-testid="guide-atlas-mapping">
          {nodes.size
            ? `${nodes.size} of ${totalNodes} nodes link to a feature; ${inert} declare none and are not clickable`
            : `no node in this diagram declares a feature (atlas_nodes), so all ${totalNodes} are inert`}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" data-testid="guide-atlas-close" onClick={onClose}>
          <X aria-hidden /> Close atlas
        </Button>
      </header>
      <div ref={box} className="min-h-0 flex-1">
        {source?.diagram ? (
          <Suspense fallback={<PanelSkeleton rows={6} label="Loading atlas" />}>
            <MermaidView source={source.diagram} label={`${area} atlas`} fill />
          </Suspense>
        ) : (
          <EmptyState icon={MapIcon}>No feature in {area} carries a diagram, so there is no atlas to draw.</EmptyState>
        )}
      </div>
      {nodes.size > 0 && (
        <nav aria-label="Atlas jumps" className="flex-none">
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {[...new Map([...nodes.values()].map((f) => [f.id, f])).values()].map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  data-testid="guide-atlas-jump"
                  data-feature-id={f.id}
                  onClick={() => navigate(`/guide/${encodeURIComponent(f.id)}`)}
                  className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
                >
                  {f.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </section>
  );
}
