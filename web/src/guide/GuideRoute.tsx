/**
 * /guide — an enterprise docs portal over GET /api/guide/features (docs/features.json) with
 * GET /api/coverage for evidence. A persistent sidebar groups every feature by area with counts;
 * area / maturity / plane chips and the search term all live in the URL, so any view is linkable.
 *
 * Routes (the existing /guide and /guide/:featureId entries carry all three views):
 *   /guide                    portal home — filters, tallies, the whole index
 *   /guide/:featureId         one feature (FeaturePage)
 *   /guide/area:<Area name>   area landing page (AreaPage); ?atlas=1 opens the area atlas
 */
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { BookOpen, Command, Map as MapIcon, Search, X } from "lucide-react";
import { usePoll } from "@/lib/usePoll";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, PanelSkeleton } from "@/components/states";
import { useShell } from "@/shell/context";
import type { CoverageBoardData } from "@/coverage/types";
import { AreaPage } from "./AreaPage";
import { AtlasView } from "./AtlasView";
import { FeaturePage } from "./FeaturePage";
import { MaturityBadge } from "./parts";
import { coverageByFile, evidenceFor, MATURITY_ORDER, matches, planeOf, PLANES, routeOf, type Evidence, type Feature, type Maturity, type Plane } from "./guideModel";
import "./guide.css";

const AREA_PREFIX = "area:";

function Chip({ active, children, onClick, testid, ...rest }: { active: boolean; children: React.ReactNode; onClick: () => void; testid: string } & Record<string, unknown>) {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-focus",
        active ? "border-transparent bg-accent-soft text-accent-soft-fg" : "border-line bg-surface text-fg-muted hover:bg-surface-hover",
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

function Sidebar({ features, visible, activeId, activeArea }: { features: Feature[]; visible: Feature[]; activeId?: string; activeArea?: string }) {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const nav = useRef<HTMLElement>(null);
  const { openPalette } = useShell();
  const setQ = (v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set("q", v);
        else n.delete("q");
        return n;
      },
      { replace: true },
    );

  const groups = useMemo(() => {
    const m = new Map<string, Feature[]>();
    for (const f of visible) m.set(f.area, [...(m.get(f.area) ?? []), f]);
    return [...m.entries()];
  }, [visible]);

  /** Roving focus: ↓/↑ from the box walks the results, Home/End jump, Enter opens (native link). */
  const move = (dir: 1 | -1 | "first" | "last") => {
    const links = [...(nav.current?.querySelectorAll<HTMLAnchorElement>('[data-testid="guide-feature"]') ?? [])];
    if (!links.length) return;
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    const i = dir === "first" ? 0 : dir === "last" ? links.length - 1 : at < 0 ? (dir === 1 ? 0 : links.length - 1) : Math.min(links.length - 1, Math.max(0, at + dir));
    links[i]?.focus();
    links[i]?.scrollIntoView({ block: "nearest" });
  };

  return (
    <nav
      ref={nav}
      aria-label="Features"
      data-guide-chrome
      className="flex min-h-0 flex-col border-line bg-surface lg:border-r"
      onKeyDown={(e) => {
        const k = e.key;
        if (k !== "ArrowDown" && k !== "ArrowUp" && k !== "Home" && k !== "End") return;
        if (k === "Home" || k === "End") {
          if (document.activeElement?.getAttribute("data-testid") !== "guide-feature") return;
          e.preventDefault();
          move(k === "Home" ? "first" : "last");
          return;
        }
        e.preventDefault();
        move(k === "ArrowDown" ? 1 : -1);
      }}
    >
      <div className="flex-none border-b border-line p-3">
        <label className="relative block">
          <span className="sr-only">Search features</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input
            type="search"
            data-testid="guide-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${features.length} features`}
            aria-describedby="guide-search-hint"
            className="h-9 w-full rounded-md border border-line bg-surface-sunken pr-2 pl-8 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-focus"
          />
        </label>
        <p id="guide-search-hint" className="m-0 pt-1.5 text-2xs text-fg-muted">
          Name, summary, stories and stack · <kbd>↓</kbd> to walk results
        </p>
        <button type="button" data-testid="guide-open-palette" onClick={openPalette} className="mt-1.5 flex h-7 w-full items-center gap-1.5 rounded-md border border-line bg-surface-sunken px-2 text-2xs text-fg-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus">
          <Command className="size-3" aria-hidden />
          Search every feature, story and stack entry
          <kbd className="ml-auto rounded-sm border border-line px-1">⌘K</kbd>
        </button>
        <p className="m-0 pt-1 text-2xs text-fg-muted" data-testid="guide-result-count">
          {visible.length} of {features.length} features
        </p>
      </div>
      <div data-guide-scroll className="max-h-[40vh] min-h-0 flex-1 overflow-y-auto p-2 lg:max-h-none">
        {!groups.length && <p className="m-0 p-2 text-sm text-fg-muted">No feature matches the current filters.</p>}
        {groups.map(([area, list]) => (
          <section key={area} data-testid="guide-area" aria-label={area} className="pb-2">
            <h2 className="m-0 px-2 pt-2 pb-1 text-2xs font-semibold tracking-[0.08em] text-fg-muted uppercase">
              <Link to={`/guide/${AREA_PREFIX}${encodeURIComponent(area)}`} data-testid="guide-area-link" aria-current={activeArea === area ? "page" : undefined} className="text-fg-muted no-underline hover:text-fg hover:underline">
                {area}
              </Link>{" "}
              <span className="tabular font-normal" data-testid="guide-area-count">
                · {list.length}
              </span>
            </h2>
            <ul className="m-0 grid list-none gap-0.5 p-0">
              {list.map((f) => {
                const active = f.id === activeId;
                return (
                  <li key={f.id}>
                    <Link
                      to={`/guide/${encodeURIComponent(f.id)}${params.toString() ? `?${params}` : ""}`}
                      data-testid="guide-feature"
                      data-feature-id={f.id}
                      aria-current={active ? "page" : undefined}
                      className={cn("block rounded-md px-2 py-1.5 text-sm no-underline focus-visible:outline-2 focus-visible:outline-focus", active ? "bg-accent-soft font-medium text-accent-soft-fg" : "text-fg hover:bg-surface-hover")}
                    >
                      {f.name}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}

function Filters({ areas, params, setParams }: { areas: string[]; params: URLSearchParams; setParams: (u: (p: URLSearchParams) => URLSearchParams, o?: any) => void }) {
  const toggle = (key: string, value: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (n.get(key) === value) n.delete(key);
        else n.set(key, value);
        return n;
      },
      { replace: true },
    );
  const any = ["area", "maturity", "plane", "q"].some((k) => params.get(k));
  return (
    <div data-guide-chrome className="grid gap-2" data-testid="guide-filters">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-2xs font-semibold tracking-[0.08em] text-fg-muted uppercase">Area</span>
        {areas.map((a) => (
          <Chip key={a} testid="guide-chip-area" data-value={a} active={params.get("area") === a} onClick={() => toggle("area", a)}>
            {a}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-2xs font-semibold tracking-[0.08em] text-fg-muted uppercase">Maturity</span>
        {MATURITY_ORDER.map((m) => (
          <Chip key={m} testid="guide-chip-maturity" data-value={m} active={params.get("maturity") === m} onClick={() => toggle("maturity", m)}>
            {m}
          </Chip>
        ))}
        <span className="ml-2 text-2xs font-semibold tracking-[0.08em] text-fg-muted uppercase">Plane</span>
        {PLANES.map((p) => (
          <Chip key={p} testid="guide-chip-plane" data-value={p} active={params.get("plane") === p} onClick={() => toggle("plane", p)}>
            {p}
          </Chip>
        ))}
        {any && (
          <Chip
            testid="guide-clear-filters"
            active={false}
            onClick={() =>
              setParams(() => new URLSearchParams(), { replace: true })
            }
          >
            <X className="size-3" aria-hidden /> Clear
          </Chip>
        )}
      </div>
    </div>
  );
}

export function Component() {
  const { featureId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data, loading, error, errorBody } = usePoll<{ features: Feature[] }>("/api/guide/features", 0);
  const cov = usePoll<CoverageBoardData>("/api/coverage", 0);
  const features = data?.features ?? [];
  const [atlasOpen, setAtlasOpen] = useState(false);

  const evidence = useMemo(() => {
    const byFile = coverageByFile(cov.data?.techniques ?? []);
    return new Map<string, Evidence>(features.map((f) => [f.id, evidenceFor(f, byFile)]));
  }, [features, cov.data]);

  const areas = useMemo(() => [...new Set(features.map((f) => f.area))], [features]);
  const q = params.get("q") ?? "";
  const fArea = params.get("area");
  const fMat = params.get("maturity") as Maturity | null;
  const fPlane = params.get("plane") as Plane | null;
  const visible = useMemo(
    () =>
      features.filter(
        (f) =>
          matches(f, q) &&
          (!fArea || f.area === fArea) &&
          (!fMat || evidence.get(f.id)?.maturity === fMat) &&
          (!fPlane || planeOf(routeOf(f)) === fPlane),
      ),
    [features, q, fArea, fMat, fPlane, evidence],
  );

  const areaParam = featureId?.startsWith(AREA_PREFIX) ? decodeURIComponent(featureId.slice(AREA_PREFIX.length)) : null;
  const current = !areaParam && featureId ? (features.find((f) => f.id === featureId) ?? null) : null;
  const atlasArea = areaParam ?? current?.area ?? null;
  const showAtlas = (atlasOpen || params.get("atlas") === "1") && Boolean(atlasArea);

  if (loading && !data) return <div className="p-6"><PanelSkeleton rows={8} label="Loading features" /></div>;
  if (error && !features.length)
    return (
      <div className="p-6">
        <ErrorState title="Guide unavailable" fix={errorBody?.fix ?? "make docs-check"}>{error}</ErrorState>
      </div>
    );

  const closeAtlas = () => {
    setAtlasOpen(false);
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete("atlas");
        return n;
      },
      { replace: true },
    );
  };
  const openAtlas = () => {
    setAtlasOpen(true);
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set("atlas", "1");
        return n;
      },
      { replace: true },
    );
  };

  return (
    <div data-testid="guide" className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[20rem_minmax(0,1fr)] lg:overflow-hidden">
      <Sidebar features={features} visible={visible} activeId={current?.id} activeArea={areaParam ?? undefined} />
      <main data-guide-scroll className="min-h-0 min-w-0 overflow-y-auto bg-canvas">
        {current ? (
          <FeaturePage key={current.id} f={current} all={features} ev={evidence.get(current.id)!} ordered={visible.length ? visible : features} />
        ) : areaParam && areas.includes(areaParam) ? (
          <AreaPage area={areaParam} features={features.filter((f) => f.area === areaParam)} evidence={evidence} onAtlas={openAtlas} />
        ) : (
          <div className="grid content-start gap-5 p-4 sm:p-6">
            <header className="grid gap-2">
              <h1 className="m-0 text-2xl font-semibold tracking-[-0.02em]">Guide</h1>
              <p className="m-0 max-w-[75ch] text-fg-muted">
                {features.length} features from docs/features.json: what each one does, the user stories and Playwright specs that prove it, the stack with two alternatives, a diagram, examples you can run, and the telemetry it emits.
                {cov.error && " Coverage is unavailable, so no feature is marked measured."}
              </p>
            </header>
            {featureId && !areaParam && <ErrorState title="Feature not found">No feature with id “{featureId}”.</ErrorState>}
            {featureId && areaParam && !areas.includes(areaParam) && <ErrorState title="Area not found">No area called “{areaParam}”.</ErrorState>}
            <Filters areas={areas} params={params} setParams={setParams} />
            {!visible.length ? (
              <EmptyState icon={BookOpen} action={<button type="button" className="text-sm text-accent-soft-fg underline-offset-4 hover:underline" onClick={() => setParams(() => new URLSearchParams(), { replace: true })}>Clear filters</button>}>
                Nothing matches these filters.
              </EmptyState>
            ) : (
              <div className="grid gap-4">
                {areas
                  .filter((a) => visible.some((f) => f.area === a))
                  .map((a) => {
                    const list = visible.filter((f) => f.area === a);
                    return (
                      <section key={a} data-testid="guide-index-area" className="grid gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="m-0 text-base font-semibold">
                            <Link to={`/guide/${AREA_PREFIX}${encodeURIComponent(a)}`} className="text-fg no-underline hover:underline">
                              {a}
                            </Link>
                          </h2>
                          <Badge size="sm">{list.length}</Badge>
                          <Link to={`/guide/${AREA_PREFIX}${encodeURIComponent(a)}?atlas=1`} data-testid="guide-index-atlas" className="inline-flex items-center gap-1 text-xs text-fg-muted no-underline hover:text-fg hover:underline">
                            <MapIcon className="size-3.5" aria-hidden /> atlas
                          </Link>
                        </div>
                        <ul className="m-0 grid list-none gap-1 p-0 sm:grid-cols-2">
                          {list.map((f) => (
                            <li key={f.id} className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5">
                              <Link to={`/guide/${encodeURIComponent(f.id)}`} data-testid="guide-index-feature" data-feature-id={f.id} className="min-w-0 flex-1 truncate text-sm text-fg no-underline hover:underline">
                                {f.name}
                              </Link>
                              <MaturityBadge m={evidence.get(f.id)!.maturity} />
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
              </div>
            )}
            <button type="button" className="w-fit text-sm text-accent-soft-fg underline-offset-4 hover:underline" onClick={() => visible[0] && navigate(`/guide/${encodeURIComponent(visible[0].id)}`)}>
              Start with {visible[0]?.name ?? features[0]?.name}
            </button>
          </div>
        )}
      </main>
      {showAtlas && atlasArea && <AtlasView area={atlasArea} features={features.filter((f) => f.area === atlasArea)} all={features} onClose={closeAtlas} />}
    </div>
  );
}
