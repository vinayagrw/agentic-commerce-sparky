import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { BookOpen, ChevronLeft, ChevronRight, Filter, SearchX } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/states";
import { useStore } from "../../store";
import { highlightStore, shop } from "../session";
import type { Filters, HelpAnswer, Sort } from "../types";
import { PageTitle, ServiceNotice, StoreLink, useAsync, useSession } from "../ui";
import { ProductCard } from "./ProductCard";

function readFilters(p: URLSearchParams): Filters {
  const f: Filters = {};
  const brands = p.getAll("brand");
  if (brands.length) f.brands = brands;
  const diet = p.getAll("diet");
  if (diet.length) f.dietary = diet;
  if (p.get("min")) f.min_price = Number(p.get("min"));
  if (p.get("max")) f.max_price = Number(p.get("max"));
  if (p.get("instock") === "1") f.in_stock = true;
  return f;
}

const DROP_PARAM: Record<string, string[]> = { in_stock: ["instock"], brands: ["brand"], price: ["min", "max"], dietary: ["diet"], exclude_terms: [] };

export function HelpAnswerView({ help }: { help: HelpAnswer }) {
  return (
    <section data-testid="help-answer" aria-labelledby="help-h" className="grid gap-2 rounded-xl border border-line bg-surface p-4 shadow-xs">
      <h2 id="help-h" className="m-0 flex items-center gap-2 text-lg font-semibold">
        <BookOpen className="size-5 text-accent" aria-hidden />
        Help answer
      </h2>
      {help.matched ? <p className="m-0 text-base whitespace-pre-line">{help.answer}</p> : <p className="m-0 text-base">No matching help article was found for this question.</p>}
      {help.citations?.length > 0 && (
        <div className="grid gap-1">
          <span className="text-xs font-semibold text-fg-muted">Sources</span>
          <ol className="m-0 grid gap-0.5 pl-5 text-sm">
            {help.citations.map((c) => (
              <li key={c.doc_id + c.section}>
                {c.title} · {c.section} <span className="font-mono text-2xs text-fg-muted">{c.doc_id}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="m-0 text-xs text-fg-muted">{help.corpus_note || "Demo help corpus written for this environment, not any real retailer's policy."}</p>
    </section>
  );
}

export function Component() {
  const [params, setParams] = useSearchParams();
  const session = useSession();
  const hl = useStore(highlightStore);
  const q = params.get("q") ?? "";
  const sort = (params.get("sort") as Sort) || "relevance";
  const page = Math.max(1, Number(params.get("page") ?? 1));
  const filters = useMemo(() => readFilters(params), [params]);
  const fkey = JSON.stringify(filters);
  const constraintKey = JSON.stringify(session?.constraints ?? []);
  const res = useAsync(() => shop.search({ query: q, filters, sort, page }), [q, fkey, sort, page, session?.store_id, constraintKey]);

  const update = (fn: (n: URLSearchParams) => void, resetPage = true) =>
    setParams(() => {
      // Read the live URL, not the render-time params: two quick edits (facet, then sort) must compose.
      const n = new URLSearchParams(window.location.search);
      fn(n);
      if (resetPage) n.delete("page");
      return n;
    });
  const toggleMulti = (key: string, v: string) =>
    update((n) => {
      const all = n.getAll(key);
      n.delete(key);
      (all.includes(v) ? all.filter((x) => x !== v) : [...all, v]).forEach((x) => n.append(key, x));
    });

  const data = res.data;
  const s = data?.search;
  const fromC = data?.from_constraints ?? [];
  const highlightIds = hl && hl.query === q ? new Set(hl.ids) : null;
  const byConstraint = (field: string) => fromC.filter((c) => c.field === field);

  return (
    <div className="grid gap-4">
      <PageTitle aside={s && s.kind === "products" ? <span className="tabular text-sm text-fg-muted">{s.total} results</span> : null}>{q ? <>Results for "{q}"</> : "Search"}</PageTitle>

      {s?.suggestions?.did_you_mean && (
        <p className="m-0 text-sm">
          Did you mean{" "}
          <StoreLink to={`/shop/search?q=${encodeURIComponent(s.suggestions.did_you_mean)}`} className="font-semibold text-accent">
            {s.suggestions.did_you_mean}
          </StoreLink>
          ?
        </p>
      )}

      {fromC.length > 0 && (
        <ul className="m-0 grid list-none gap-1 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 p-0 text-sm" aria-label="Filters applied from your constraints">
          {fromC.map((c) => (
            <li key={c.id + c.field} className="px-3 py-0.5">
              <Filter className="mr-1.5 inline size-3.5 text-accent" aria-hidden />
              Filtered by <strong>{c.field}</strong> = {Array.isArray(c.value) ? c.value.join(", ") : String(c.value)} because you said "{c.constraint}"
              {session?.constraints.find((x) => x.id === c.id)?.source === "chat" ? " in chat" : ""}.
            </li>
          ))}
        </ul>
      )}

      {res.error && <ErrorState title="Search failed">{res.error}</ErrorState>}
      {s?.error && <ErrorState title="Search service reported an error">{s.error}</ErrorState>}
      <ServiceNotice services={s?.services} />

      {s?.kind === "help" && s.help && <HelpAnswerView help={s.help} />}

      <div className="grid gap-4 md:grid-cols-[15rem_1fr]">
        <aside aria-label="Filters" className="grid content-start gap-4">
          {s && s.kind === "products" && (
            <>
              <p className="m-0 text-2xs text-fg-muted">Facet counts cover {s.facet_scope || `the top ${s.retrieved} retrieved results`}, not the whole catalogue.</p>
              <label className="grid gap-1 text-sm font-medium">
                Sort
                <select
                  value={sort}
                  onChange={(e) => update((n) => n.set("sort", e.target.value))}
                  className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <option value="relevance">Best match</option>
                  <option value="price_asc">Price: low to high</option>
                  <option value="price_desc">Price: high to low</option>
                  <option value="rating">Rating</option>
                </select>
              </label>
              <fieldset className="m-0 grid gap-1 border-0 p-0">
                <legend className="mb-1 text-sm font-semibold">Availability</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={filters.in_stock === true} onChange={() => update((n) => (n.get("instock") ? n.delete("instock") : n.set("instock", "1")))} />
                  In stock at my store <span className="tabular text-xs text-fg-muted">({s.facets.in_stock?.count ?? 0})</span>
                </label>
              </fieldset>
              {s.facets.price?.length > 0 && (
                <fieldset className="m-0 grid gap-1 border-0 p-0">
                  <legend className="mb-1 text-sm font-semibold">Price</legend>
                  {s.facets.price.map((b) => {
                    const on = String(filters.min_price ?? "") === String(b.min ?? "") && String(filters.max_price ?? "") === String(b.max ?? "") && (b.min != null || b.max != null);
                    return (
                      <label key={b.label} className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="price"
                          checked={on}
                          onChange={() =>
                            update((n) => {
                              n.delete("min");
                              n.delete("max");
                              if (b.min != null) n.set("min", String(b.min));
                              if (b.max != null) n.set("max", String(b.max));
                            })
                          }
                        />
                        {b.label} <span className="tabular text-xs text-fg-muted">({b.count})</span>
                      </label>
                    );
                  })}
                  {(filters.min_price != null || filters.max_price != null) && (
                    <Button variant="link" size="xs" className="justify-self-start" onClick={() => update((n) => (n.delete("min"), n.delete("max")))}>
                      Clear price
                    </Button>
                  )}
                  {byConstraint("max_price").map((c) => (
                    <span key={c.id} className="text-2xs text-accent-soft-fg">
                      Max ${String(c.value)} from your constraint "{c.constraint}"
                    </span>
                  ))}
                </fieldset>
              )}
              {s.facets.dietary?.length > 0 && (
                <fieldset className="m-0 grid gap-1 border-0 p-0">
                  <legend className="mb-1 text-sm font-semibold">Dietary</legend>
                  {s.facets.dietary.map((d) => {
                    const fromConstraint = byConstraint("dietary").some((c) => c.value === d.value);
                    return (
                      <label key={d.value} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={fromConstraint || (filters.dietary ?? []).includes(d.value)} disabled={fromConstraint} onChange={() => toggleMulti("diet", d.value)} />
                        {d.value} <span className="tabular text-xs text-fg-muted">({d.count})</span>
                        {fromConstraint && (
                          <Badge size="sm" tone="accent">
                            from constraint
                          </Badge>
                        )}
                      </label>
                    );
                  })}
                </fieldset>
              )}
              {s.facets.brands?.length > 0 && (
                <fieldset className="m-0 grid max-h-72 gap-1 overflow-auto border-0 p-0">
                  <legend className="mb-1 text-sm font-semibold">Brand</legend>
                  {s.facets.brands.slice(0, 20).map((b) => (
                    <label key={b.value} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={(filters.brands ?? []).includes(b.value)} onChange={() => toggleMulti("brand", b.value)} />
                      <span className="truncate">{b.value}</span> <span className="tabular text-xs text-fg-muted">({b.count})</span>
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          )}
        </aside>

        <div className="grid content-start gap-4">
          {res.loading && !s && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="status" aria-busy="true" aria-label="Loading results">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-80" />
              ))}
            </div>
          )}

          {s?.zero_result && (
            <section data-testid="zero-result" aria-labelledby="zr" className="grid gap-2 rounded-xl border border-line bg-surface p-4">
              <h2 id="zr" className="m-0 flex items-center gap-2 text-lg font-semibold">
                <SearchX className="size-5 text-fg-muted" aria-hidden />
                No results with these filters
              </h2>
              {s.zero_result.relaxation ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>
                    {s.zero_result.relaxation.label} <span className="text-fg-muted">(drop: {s.zero_result.relaxation.dropped.join(", ")}; <strong className="tabular text-fg">{s.zero_result.relaxation.count}</strong> results)</span>
                  </span>
                  <Button
                    data-testid="relaxation-apply"
                    variant="primary"
                    size="sm"
                    onClick={() =>
                      update((n) => {
                        for (const d of s.zero_result!.relaxation!.dropped) for (const k of DROP_PARAM[d] ?? [d]) n.delete(k);
                      })
                    }
                  >
                    Apply: show {s.zero_result.relaxation.count} results
                  </Button>
                  {s.zero_result.relaxation.dropped.some((d) => byConstraint(d === "price" ? "max_price" : d).length > 0) && (
                    <span className="text-xs text-fg-muted">Some of these filters come from your constraints; remove the chip above to relax them.</span>
                  )}
                </div>
              ) : (
                <p className="m-0 text-sm">Dropping any single filter still returns nothing.</p>
              )}
              <p className="m-0 text-xs text-fg-muted">
                A triage record was filed for the search team (<span className="font-mono">{s.zero_result.triage_id}</span>).
              </p>
            </section>
          )}

          {s && s.results.length > 0 && (
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-3 p-0">
              {s.results.map((p) => (
                <li key={p.product_id} className="flex">
                  <div className="flex w-full">
                    <ProductCard p={p} highlighted={Boolean(highlightIds?.has(p.product_id))} />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {s && s.pages > 1 && (
            <nav aria-label="Pagination" className="flex flex-wrap items-center justify-center gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => update((n) => n.set("page", String(page - 1)), false)} aria-label="Previous page">
                <ChevronLeft aria-hidden />
              </Button>
              {Array.from({ length: s.pages }, (_, i) => i + 1)
                .filter((n) => n === 1 || n === s.pages || Math.abs(n - page) <= 2)
                .map((n) => (
                  <Button
                    key={n}
                    size="sm"
                    variant={n === page ? "primary" : "ghost"}
                    aria-current={n === page ? "page" : undefined}
                    aria-label={`Page ${n}`}
                    onClick={() => update((x) => x.set("page", String(n)), false)}
                    className={cn("tabular min-w-8")}
                  >
                    {n}
                  </Button>
                ))}
              <Button size="sm" variant="ghost" disabled={page >= s.pages} onClick={() => update((n) => n.set("page", String(page + 1)), false)} aria-label="Next page">
                <ChevronRight aria-hidden />
              </Button>
            </nav>
          )}

          {s?.suggestions?.related?.length ? (
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="text-fg-muted">Related:</span>
              {s.suggestions.related.map((r) => (
                <StoreLink key={r} to={`/shop/search?q=${encodeURIComponent(r)}`} className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs text-fg no-underline hover:bg-surface-hover">
                  {r}
                </StoreLink>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
