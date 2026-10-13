/**
 * One feature page in the Guide portal: breadcrumbs, a header carrying the honestly-derived
 * maturity badge, owner surface + route, the specs that prove it, related features, prev/next,
 * and sub-tabs Overview · Stories · Stack & alternatives · Diagram · Try it · Telemetry.
 * Tab is kept in ?tab=; every section is a deep-linkable anchor with a copy-link button.
 */
import { lazy, Suspense } from "react";
import { Link, useSearchParams } from "react-router";
import { Activity, BookOpen, ChevronLeft, ChevronRight, ExternalLink, FlaskConical, Printer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, PanelSkeleton } from "@/components/states";
import { Anchored, Breadcrumbs, CopyLink, MaturityBadge } from "./parts";
import { MATURITY_WHY, NOT_BUILT, type Evidence, type Feature, planeOf, relatedTo, routeOf } from "./guideModel";
import { SPEC_LABEL, SPEC_TONE, useFeatureTelemetry, useSpecResults, type SpecRun, type SpecStatus } from "./liveData";

const MermaidView = lazy(() => import("./MermaidView").then((m) => ({ default: m.MermaidView })));

const TABS = [
  ["overview", "Overview"],
  ["stories", "Stories"],
  ["stack", "Stack & alternatives"],
  ["diagram", "Diagram"],
  ["try", "Try it"],
  ["telemetry", "Telemetry"],
] as const;
type Tab = (typeof TABS)[number][0];

function AltColumn({ title, sub, items, tradeoff, betterWhen, testid }: { title: string; sub: string; items: string[]; tradeoff?: string; betterWhen?: string; testid: string }) {
  const label = tradeoff?.includes(NOT_BUILT);
  return (
    <Card data-testid={testid} className="min-w-0">
      <CardHeader className="flex-col items-start gap-1">
        <CardTitle className="text-base">{title}</CardTitle>
        <span className="text-xs text-fg-muted">{sub}</span>
        {label && (
          <Badge size="sm" tone="warn" data-testid="not-built-label">
            {NOT_BUILT}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <ul className="m-0 grid gap-1 pl-4">
          {items.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        {tradeoff && (
          <p className="m-0 text-fg-muted">
            <span className="font-medium text-fg">Trade-off: </span>
            {tradeoff.replace(/\s*not built or measured here;[^.]*\.?/, "").trim()}
          </p>
        )}
        {betterWhen && (
          <p className="m-0 text-fg-muted">
            <span className="font-medium text-fg">Better when: </span>
            {betterWhen}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** The real result for one spec file. No row in the report means "not run" — never "passing". */
function SpecStatusBadge({ file, run }: { file: string; run: SpecRun }) {
  if (run.loading && !run.results && !run.error) return <Badge size="sm" tone="neutral" data-testid="guide-spec-status" data-status="loading">checking…</Badge>;
  if (!run.results)
    return (
      <Badge size="sm" tone="warn" data-testid="guide-spec-status" data-status="unknown" title={run.error ?? undefined}>
        no test run recorded
      </Badge>
    );
  const status: SpecStatus = run.statusOf(file);
  return (
    <Badge size="sm" tone={SPEC_TONE[status]} data-testid="guide-spec-status" data-status={status}>
      {SPEC_LABEL[status]}
    </Badge>
  );
}

/** Where the badges above come from: which report, when it ran, and what it covered. */
function SpecRunNote({ run }: { run: SpecRun }) {
  if (!run.results)
    return (
      <p className="m-0 text-xs text-warn" data-testid="guide-spec-run">
        No test run recorded — docs/recording/e2e-results.json is missing or unreadable{run.error ? ` (${run.error})` : ""}, so no spec here can be called passing. Run <code>make e2e</code> to record one.
      </p>
    );
  const { timestamp, tally, count } = run.results;
  const when = new Date(timestamp);
  const ageH = Math.max(0, Math.round((Date.now() - when.getTime()) / 36e5));
  return (
    <p className="m-0 text-xs text-fg-muted" data-testid="guide-spec-run" data-timestamp={timestamp}>
      From the last recorded Playwright run: <time dateTime={timestamp}>{when.toLocaleString()}</time> ({ageH >= 24 ? `${Math.round(ageH / 24)} day(s) old` : `${ageH}h old`}) · {count} spec files · {tally.passed} passed, {tally.failed} failed, {tally.flaky} flaky, {tally["not-run"]} not run.
      {run.ranTags.length > 0 && (
        <>
          {" "}That run covered {run.ranTags.map((t) => <code key={t}>{t}</code>).reduce((a, b) => <>{a}, {b}</>)} specs
          {run.skippedTags.length ? <> and skipped {run.skippedTags.join(", ")}</> : null}, so a spec outside that scope reads <strong>not run</strong> — expected, not a failure.
        </>
      )}
    </p>
  );
}

export function FeaturePage({ f, all, ev, ordered }: { f: Feature; all: Feature[]; ev: Evidence; ordered: Feature[] }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = TABS.some(([k]) => k === raw) ? (raw as Tab) : "overview";
  const setTab = (v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v === "overview") n.delete("tab");
        else n.set("tab", v);
        return n;
      },
      { replace: true },
    );
  const keep = params.toString() ? `?${new URLSearchParams([...params].filter(([k]) => k !== "tab")).toString()}` : "";
  const route = routeOf(f);
  const plane = planeOf(route);
  const related = relatedTo(f, all);
  const run = useSpecResults();
  const tele = useFeatureTelemetry(f);
  const i = ordered.findIndex((o) => o.id === f.id);
  const prev = i > 0 ? ordered[i - 1] : null;
  const next = i >= 0 && i < ordered.length - 1 ? ordered[i + 1] : null;

  return (
    <article data-testid="guide-detail" data-feature-id={f.id} data-maturity={ev.maturity} data-guide-print-all className="grid min-w-0 content-start gap-5 p-4 sm:p-6">
      <Breadcrumbs items={[{ label: "Guide", to: `/guide${keep}` }, { label: f.area, to: `/guide/area:${encodeURIComponent(f.area)}` }, { label: f.name }]} />

      <header className="grid gap-2">
        <h1 className="m-0 text-2xl font-semibold tracking-[-0.02em]">{f.name}</h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <MaturityBadge m={ev.maturity} size="md" />
          <Badge size="md" tone="neutral" data-testid="guide-plane">{plane} plane</Badge>
          <Link to={route} data-testid="guide-owner-route" className="inline-flex h-6 items-center gap-1 rounded-sm border border-line bg-surface-sunken px-2 text-xs font-medium text-fg-muted no-underline hover:text-fg">
            <ExternalLink className="size-3" aria-hidden />
            {route}
          </Link>
          <code className="rounded-sm bg-surface-sunken px-1.5 py-0.5 text-2xs text-fg-muted">{f.id}</code>
          <Button data-guide-chrome size="sm" variant="ghost" className="ml-auto" data-testid="guide-print" onClick={() => window.print()}>
            <Printer aria-hidden /> Print
          </Button>
        </div>
        <p className="m-0 text-xs text-fg-muted">
          <span className="font-medium text-fg">{ev.maturity}</span> because {MATURITY_WHY[ev.maturity]}.
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <div data-guide-chrome className="sticky top-0 z-10 -mx-4 overflow-x-auto bg-canvas/95 px-4 py-1 backdrop-blur sm:-mx-6 sm:px-6">
          <TabsList aria-label="Feature views" className="min-w-max">
            {TABS.map(([k, label]) => (
              <TabsTrigger key={k} value={k} data-testid={`guide-tab-${k}`}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview" data-testid="guide-panel-overview" className="grid gap-5 pt-4">
          <Anchored id="summary" title="Summary">
            <p className="m-0 max-w-[75ch] text-md leading-relaxed">{f.summary}</p>
            <div className="flex flex-wrap gap-1.5 text-xs">
              <Badge size="sm">{f.stories.length} stor{f.stories.length === 1 ? "y" : "ies"}</Badge>
              <Badge size="sm">{f.stack.length} stack components</Badge>
              <Badge size="sm">{f.examples.length} example{f.examples.length === 1 ? "" : "s"}</Badge>
              <Badge size="sm">{f.diagram ? "diagram" : "no diagram"}</Badge>
            </div>
          </Anchored>

          <Anchored id="proven-by" title="Proven by">
            {ev.specs.length ? (
              <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" data-testid="guide-proven-by">
                {ev.specs.map((s) => (
                  <li key={s} className="flex items-center gap-1.5">
                    <code className="rounded-sm bg-surface-sunken px-1.5 py-1 text-2xs" data-testid="guide-spec-link" data-spec={s}>
                      web/e2e/{s}
                    </code>
                    <SpecStatusBadge file={s} run={run} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-sm text-fg-muted" data-testid="guide-proven-by">No Playwright spec is linked to any story here — this feature is described, not proven.</p>
            )}
            <SpecRunNote run={run} />
            {ev.unproven > 0 && (
              <p className="m-0 text-sm text-warn" data-testid="guide-unproven-count">
                {ev.unproven} of {f.stories.length} stories are marked <strong>not proven</strong>.
              </p>
            )}
            {ev.coverage.length > 0 && (
              <ul className="m-0 grid list-none gap-1 p-0 text-sm" data-testid="guide-coverage-rows">
                {ev.coverage.map((c) => (
                  <li key={c.id}>
                    <Link to={`/coverage/${c.id}`} className="text-accent-soft-fg no-underline hover:underline">
                      coverage #{c.id} · {c.name}
                    </Link>{" "}
                    <Badge size="sm" tone={c.status === "real-measured" ? "ok" : "neutral"}>{c.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Anchored>

          <Anchored id="related" title="Related features">
            {related.length ? (
              <ul className="m-0 grid list-none gap-1 p-0 text-sm" data-testid="guide-related">
                {related.map((r) => (
                  <li key={r.feature.id} className="flex flex-wrap items-baseline gap-2">
                    <Link to={`/guide/${encodeURIComponent(r.feature.id)}`} data-testid="guide-related-link" className="text-accent-soft-fg no-underline hover:underline">
                      {r.feature.name}
                    </Link>
                    <span className="text-xs text-fg-muted">{r.why}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={BookOpen}>Nothing shares this feature's stack or surface.</EmptyState>
            )}
            <p className="m-0 text-2xs text-fg-muted">Dependencies are not declared in docs/features.json; these are derived from shared stack components and the same demo surface.</p>
          </Anchored>
        </TabsContent>

        <TabsContent value="stories" data-testid="guide-panel-stories" className="grid gap-3 pt-4">
          {!f.stories.length ? (
            <EmptyState icon={BookOpen}>No user story in docs/USER_STORIES.md is linked to this feature yet.</EmptyState>
          ) : (
            f.stories.map((s) => (
              <Card key={s.id} data-testid="guide-story" id={`story-${s.id}`} data-guide-print-section className="group scroll-mt-24">
                <CardContent className="grid gap-1.5 pt-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge size="sm" tone="accent">{s.id}</Badge>
                    <span className="text-xs text-fg-muted">{s.persona}</span>
                    {s.spec ? (
                      <span className="ml-auto flex items-center gap-1.5">
                        <code className="rounded-sm bg-surface-sunken px-1.5 py-0.5 text-2xs" data-testid="guide-story-spec" data-spec={s.spec}>{s.spec}</code>
                        <SpecStatusBadge file={s.spec} run={run} />
                      </span>
                    ) : (
                      <Badge size="sm" tone="warn" className="ml-auto" data-testid="guide-story-unproven">not proven</Badge>
                    )}
                    <CopyLink anchor={`story-${s.id}`} label={`story ${s.id}`} />
                  </div>
                  {s.given && <p className="m-0"><strong>Given</strong> {s.given}</p>}
                  {s.when && <p className="m-0"><strong>When</strong> {s.when}</p>}
                  <p className="m-0"><strong>Then</strong> {s.then}</p>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="stack" data-testid="guide-panel-stack" className="grid gap-3 pt-4">
          <div className="grid gap-3 md:grid-cols-3">
            <AltColumn testid="stack-current" title="Current" sub="What this demo runs" items={f.stack} />
            <AltColumn testid="stack-alt1" title="Alt 1 · open source" sub="Self-hosted alternative" items={f.alternatives.alt1.components} tradeoff={f.alternatives.alt1.tradeoff} betterWhen={f.alternatives.alt1.betterWhen} />
            <AltColumn testid="stack-alt2" title="Alt 2 · managed cloud" sub="Managed alternative" items={f.alternatives.alt2.components} tradeoff={f.alternatives.alt2.tradeoff} betterWhen={f.alternatives.alt2.betterWhen} />
          </div>
        </TabsContent>

        <TabsContent value="diagram" data-testid="guide-panel-diagram" className="pt-4">
          {f.diagram ? (
            <>
              <Suspense fallback={<PanelSkeleton rows={4} label="Loading diagram renderer" />}>
                <MermaidView source={f.diagram} label={f.name} />
              </Suspense>
              <Link data-guide-chrome to={`/guide/area:${encodeURIComponent(f.area)}?atlas=1`} data-testid="guide-open-atlas" className="mt-3 inline-block text-sm text-accent-soft-fg no-underline hover:underline">
                Open the {f.area} atlas
              </Link>
            </>
          ) : (
            <EmptyState icon={BookOpen}>This feature has no diagram in docs/FEATURE_CATALOGUE.md.</EmptyState>
          )}
        </TabsContent>

        <TabsContent value="try" data-testid="guide-panel-try" className="grid gap-3 pt-4 md:grid-cols-2">
          {!f.examples.length ? (
            <EmptyState icon={FlaskConical}>No runnable example is recorded for this feature.</EmptyState>
          ) : (
            f.examples.map((e, idx) => (
              <Card key={idx} data-testid="guide-example" data-guide-print-section className="min-w-0">
                <CardHeader>
                  <CardTitle className="text-base">{e.title}</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm">
                  <ol className="m-0 grid gap-1 pl-5">
                    {e.steps.map((st, j) => (
                      <li key={j}>{st}</li>
                    ))}
                  </ol>
                  <p className="m-0 rounded-md bg-surface-sunken px-3 py-2 text-fg-muted">
                    <span className="font-medium text-fg">Expected: </span>
                    {e.expected}
                  </p>
                  <Link
                    to={e.link}
                    data-testid="guide-run"
                    className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg no-underline hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    <ExternalLink className="size-4" aria-hidden />
                    Run this
                  </Link>
                  <code className="text-2xs break-all text-fg-muted">{decodeURIComponent(e.link)}</code>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="telemetry" data-testid="guide-panel-telemetry" className="grid gap-4 pt-4">
          <Anchored id="spans" title="Spans this feature produces">
            <p className="m-0 max-w-[75ch] text-sm text-fg-muted">
              Read live from <code>GET /api/traces</code> (the newest 50 traces in <code>data/traces/</code>), kept to the {tele.plane ?? "un-planed"} surface this feature runs on ({route}).
            </p>
            {tele.error ? (
              <p className="m-0 text-sm text-warn" data-testid="guide-span-kinds">Telemetry is unavailable: {tele.error}. Nothing is assumed about what this feature emits.</p>
            ) : !tele.kinds.length ? (
              <p className="m-0 text-sm text-fg-muted" data-testid="guide-span-kinds">
                {tele.loading ? "Reading data/traces…" : `This feature has produced no telemetry yet — none of the ${tele.traceTotal} recorded traces ran on the ${tele.plane ?? "this"} surface.`}
              </p>
            ) : (
              <>
                <ul className="m-0 grid list-none gap-1.5 p-0 text-sm" data-testid="guide-span-kinds">
                  {tele.kinds.map((k) => (
                    <li key={k.kind} data-testid="guide-span-kind" data-kind={k.kind} data-count={k.count} className="flex flex-wrap items-baseline gap-2">
                      <Badge size="sm" tone="info">{k.kind}</Badge>
                      <span className="text-xs text-fg-muted">
                        {k.count} span{k.count === 1 ? "" : "s"} across {tele.traceCount} trace{tele.traceCount === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="m-0 text-2xs text-fg-muted">Services seen: {tele.services.join(" · ") || "none recorded"}.</p>
              </>
            )}
          </Anchored>
          <Anchored id="ledger" title="Token ledger">
            {tele.error ? (
              <p className="m-0 text-sm text-warn" data-testid="guide-ledger">Token meter unavailable: {tele.error}.</p>
            ) : !tele.roles.length ? (
              <p className="m-0 max-w-[75ch] text-sm text-fg-muted" data-testid="guide-ledger">
                {tele.loading ? "Reading data/token_ledger.jsonl…" : `No token-ledger row has been written on the ${tele.plane ?? "unassigned"} plane yet, so this feature has produced no model-call telemetry.`}
              </p>
            ) : (
              <>
                <p className="m-0 max-w-[75ch] text-sm text-fg-muted" data-testid="guide-ledger">
                  {tele.ledgerCalls} model call{tele.ledgerCalls === 1 ? "" : "s"} on the {tele.plane} plane in data/token_ledger.jsonl, ${tele.ledgerCost.toFixed(4)} total.
                </p>
                <ul className="m-0 grid list-none gap-1 p-0 text-sm" data-testid="guide-ledger-roles">
                  {tele.roles.map((b) => (
                    <li key={b.key} data-testid="guide-ledger-role" data-role={b.key} className="flex flex-wrap items-baseline gap-2">
                      <Badge size="sm">{b.key}</Badge>
                      <span className="text-xs text-fg-muted">
                        {b.calls} call{b.calls === 1 ? "" : "s"} · {b.input_tokens.toLocaleString()} in / {b.output_tokens.toLocaleString()} out · ${b.cost_usd.toFixed(4)}
                        {b.errors ? ` · ${b.errors} error(s)` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Anchored>
          <div className="flex flex-wrap gap-2" data-guide-chrome>
            <Link to={tele.tracesHref} data-testid="guide-link-traces" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm font-medium text-fg no-underline hover:bg-surface-hover">
              <Activity className="size-4" aria-hidden /> {tele.newestTraceId ? `Newest ${tele.plane ?? ""} trace` : "/ops/traces"}
            </Link>
            <Link to={tele.tokensHref} data-testid="guide-link-tokens" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm font-medium text-fg no-underline hover:bg-surface-hover">
              <Activity className="size-4" aria-hidden /> /ops/tokens{tele.plane ? ` · plane=${tele.plane}` : ""}
            </Link>
          </div>
        </TabsContent>
      </Tabs>

      <nav data-guide-chrome aria-label="Previous and next feature" data-testid="guide-prevnext" className="mt-2 flex flex-wrap items-stretch justify-between gap-2 border-t border-line pt-4">
        {prev ? (
          <Link to={`/guide/${encodeURIComponent(prev.id)}${keep}`} data-testid="guide-prev" rel="prev" className="grid max-w-[48%] gap-0.5 rounded-md border border-line px-3 py-2 text-sm no-underline hover:bg-surface-hover">
            <span className="flex items-center gap-1 text-xs text-fg-muted"><ChevronLeft className="size-3.5" aria-hidden /> Previous</span>
            <span className="truncate text-fg">{prev.name}</span>
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link to={`/guide/${encodeURIComponent(next.id)}${keep}`} data-testid="guide-next" rel="next" className="grid max-w-[48%] gap-0.5 rounded-md border border-line px-3 py-2 text-right text-sm no-underline hover:bg-surface-hover">
            <span className="flex items-center justify-end gap-1 text-xs text-fg-muted">Next <ChevronRight className="size-3.5" aria-hidden /></span>
            <span className="truncate text-fg">{next.name}</span>
          </Link>
        )}
      </nav>
    </article>
  );
}
