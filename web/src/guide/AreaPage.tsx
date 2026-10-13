/** Area landing page: what the area covers, plus a maturity table of every feature in it. */
import { Link } from "react-router";
import { Map as MapIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Anchored, Breadcrumbs, MaturityBadge } from "./parts";
import { MATURITY_ORDER, type Evidence, type Feature, planeOf, routeOf } from "./guideModel";

export function AreaPage({ area, features, evidence, onAtlas }: { area: string; features: Feature[]; evidence: Map<string, Evidence>; onAtlas: () => void }) {
  const tally = MATURITY_ORDER.map((m) => [m, features.filter((f) => evidence.get(f.id)?.maturity === m).length] as const).filter(([, n]) => n > 0);
  const stories = features.reduce((n, f) => n + f.stories.length, 0);
  const proven = features.reduce((n, f) => n + f.stories.filter((s) => s.spec).length, 0);

  return (
    <article data-testid="guide-area-page" data-area={area} className="grid min-w-0 content-start gap-5 p-4 sm:p-6">
      <Breadcrumbs items={[{ label: "Guide", to: "/guide" }, { label: area }]} />
      <header className="grid gap-2">
        <h1 className="m-0 text-2xl font-semibold tracking-[-0.02em]">{area}</h1>
        <p className="m-0 max-w-[75ch] text-fg-muted">
          {features.length} feature{features.length === 1 ? "" : "s"} · {stories} user stor{stories === 1 ? "y" : "ies"}, {proven} of them proven by a Playwright spec.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {tally.map(([m, n]) => (
            <Badge key={m} size="sm" tone="neutral" data-testid="guide-area-tally" data-maturity={m}>
              {n} {m}
            </Badge>
          ))}
          <button
            type="button"
            data-guide-chrome
            data-testid="guide-atlas-toggle"
            onClick={onAtlas}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <MapIcon className="size-4" aria-hidden /> Atlas view
          </button>
        </div>
      </header>

      <Anchored id="maturity" title="Maturity">
        <div className="overflow-x-auto">
          <Table data-testid="guide-area-table">
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="text-fg-muted">Feature</TableHead>
                <TableHead scope="col" className="text-fg-muted">Maturity</TableHead>
                <TableHead scope="col" className="text-fg-muted">Stories</TableHead>
                <TableHead scope="col" className="text-fg-muted">Specs</TableHead>
                <TableHead scope="col" className="text-fg-muted">Surface</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {features.map((f) => {
                const ev = evidence.get(f.id)!;
                const route = routeOf(f);
                return (
                  <TableRow key={f.id} data-testid="guide-area-row" data-feature-id={f.id}>
                    <TableCell>
                      <Link to={`/guide/${encodeURIComponent(f.id)}`} className="text-accent-soft-fg no-underline hover:underline">
                        {f.name}
                      </Link>
                    </TableCell>
                    <TableCell><MaturityBadge m={ev.maturity} /></TableCell>
                    <TableCell className="tabular">
                      {f.stories.length - ev.unproven}/{f.stories.length} proven
                    </TableCell>
                    <TableCell className="text-xs text-fg-muted">{ev.specs.join(", ") || "—"}</TableCell>
                    <TableCell className="text-xs text-fg-muted">
                      {route} <span className="text-fg-muted">· {planeOf(route)}</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </Anchored>
    </article>
  );
}
