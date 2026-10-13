/**
 * Derivations for the Guide portal. Everything here is computed from data the repo already has —
 * `GET /api/guide/features` (docs/features.json) and `GET /api/coverage` (data/coverage.json).
 * Nothing is invented: when the data does not support a claim the derivation returns the honest
 * "unknown"/"proposal" value instead of guessing.
 */
import type { Technique } from "@/coverage/types";

export interface Alt {
  components: string[];
  tradeoff: string;
  betterWhen: string;
}
export interface Story {
  id: string;
  persona: string;
  given: string;
  when: string;
  then: string;
  /** Playwright spec that proves this story, or "" — rendered as "not proven". */
  spec: string;
}
export interface Example {
  title: string;
  steps: string[];
  link: string;
  expected: string;
}
export interface Feature {
  id: string;
  area: string;
  name: string;
  summary: string;
  stories: Story[];
  stack: string[];
  alternatives: { alt1: Alt; alt2: Alt };
  examples: Example[];
  diagram: string | null;
  /** Coverage rows (data/coverage.json ids) declared for this feature in the catalogue. */
  coverage_ids?: (number | string)[];
  /** `<feature id>#<mermaid node id>` entries this feature owns in the atlas, declared in
   * docs/FEATURE_CATALOGUE.md and validated by `make docs-check`. */
  atlas_nodes?: string[];
}

export const NOT_BUILT = "not built or measured here";

/* ---------------------------------------------------------------- maturity */

export type Maturity = "measured" | "built" | "synthetic" | "proposal";

export const MATURITY_TONE: Record<Maturity, "ok" | "accent" | "warn" | "neutral"> = {
  measured: "ok",
  built: "accent",
  synthetic: "warn",
  proposal: "neutral",
};

export const MATURITY_WHY: Record<Maturity, string> = {
  measured: "a data/coverage.json row with status real-measured names a source file this feature runs on",
  built: "at least one user story names a Playwright spec that proves it",
  synthetic: "no story is spec-proven, and this feature's own text labels its data or output synthetic",
  proposal: "no spec proves a story and no coverage row measures it — described, not demonstrated",
};

export const MATURITY_ORDER: Maturity[] = ["measured", "built", "synthetic", "proposal"];

export interface Evidence {
  maturity: Maturity;
  /** Specs named by this feature's stories, de-duplicated. */
  specs: string[];
  /** Stories with no spec — shown as "not proven". */
  unproven: number;
  /** Coverage rows whose `code[].file` appears verbatim in this feature's data. */
  coverage: Technique[];
  synthetic: boolean;
}

/** Index coverage rows by the source files they cite; the only defensible feature↔coverage link. */
export function coverageByFile(techniques: Technique[]): Map<string, Technique[]> {
  const m = new Map<string, Technique[]>();
  for (const t of techniques) for (const c of t.code ?? []) m.set(c.file, [...(m.get(c.file) ?? []), t]);
  return m;
}

export function evidenceFor(f: Feature, byFile: Map<string, Technique[]>): Evidence {
  const blob = JSON.stringify(f);
  const specs = [...new Set(f.stories.map((s) => s.spec).filter(Boolean))];
  const unproven = f.stories.filter((s) => !s.spec).length;
  const seen = new Map<number, Technique>();
  for (const [file, rows] of byFile) if (blob.includes(file)) for (const r of rows) seen.set(r.id, r);
  const coverage = [...seen.values()].sort((a, b) => a.id - b.id);
  const synthetic = /synthetic/i.test(blob);
  const maturity: Maturity = coverage.some((c) => c.status === "real-measured")
    ? "measured"
    : specs.length
      ? "built"
      : synthetic
        ? "synthetic"
        : "proposal";
  return { maturity, specs, unproven, coverage, synthetic };
}

/* ------------------------------------------------------------ plane + route */

export type Plane = "Shopper" | "Ops" | "Presenter";
export const PLANES: Plane[] = ["Shopper", "Ops", "Presenter"];

export function planeOf(route: string): Plane {
  if (route.startsWith("/ops")) return "Ops";
  if (route.startsWith("/shop")) return "Shopper";
  return "Presenter";
}

/** The surface this feature is demonstrated on: the most common path across its examples. */
export function routeOf(f: Feature): string {
  const counts = new Map<string, number>();
  for (const e of f.examples) {
    const p = e.link.split("?")[0] || "/";
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best?.[0] ?? "/guide";
}

/* ------------------------------------------------------------ related */

/** Dependencies are not declared in the data, so relatedness is derived from shared stack and route. */
export function relatedTo(f: Feature, all: Feature[], limit = 5): { feature: Feature; why: string }[] {
  const mine = new Set(f.stack);
  const route = routeOf(f);
  return all
    .filter((o) => o.id !== f.id)
    .map((o) => {
      const shared = o.stack.filter((s) => mine.has(s));
      const sameRoute = routeOf(o) === route;
      const score = shared.length * 2 + (sameRoute ? 2 : 0) + (o.area === f.area ? 1 : 0);
      const why = [shared.length ? `${shared.length} shared stack component${shared.length === 1 ? "" : "s"}` : "", sameRoute ? `same surface (${route})` : "", o.area === f.area ? `same area` : ""].filter(Boolean).join(" · ");
      return { feature: o, why, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.feature.id.localeCompare(b.feature.id))
    .slice(0, limit);
}

/* ------------------------------------------------------------ search */

export function matches(f: Feature, term: string): boolean {
  if (!term) return true;
  const t = term.toLowerCase();
  return [f.name, f.area, f.id, f.summary, ...f.stack, ...f.stories.map((s) => `${s.id} ${s.persona} ${s.given} ${s.when} ${s.then} ${s.spec}`)]
    .join(" ")
    .toLowerCase()
    .includes(t);
}

/* ------------------------------------------------------------ atlas nodes */

/** Mermaid node ids declared in a diagram (`id[label]`, `id(label)`, `id{label}`). */
export function nodeIdsIn(diagram: string | null | undefined): string[] {
  const re = /(\b[A-Za-z][\w-]*)\s*[[({]+\s*"?([^"\]})]{2,120})"?\s*[\])}]+/g;
  const out: string[] = [];
  for (const m of (diagram ?? "").matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * The declared node -> feature mapping for one diagram. The mapping lives in the data
 * (`atlas_nodes`, written in docs/FEATURE_CATALOGUE.md and checked by `make docs-check`), so the
 * atlas never guesses from a label: a node either has a declared owner or stays inert.
 */
export function atlasNodeMap(source: Feature, all: Feature[]): Map<string, Feature> {
  const out = new Map<string, Feature>();
  const prefix = `${source.id}#`;
  for (const f of all)
    for (const entry of f.atlas_nodes ?? [])
      if (entry.startsWith(prefix)) out.set(entry.slice(prefix.length), f);
  return out;
}
