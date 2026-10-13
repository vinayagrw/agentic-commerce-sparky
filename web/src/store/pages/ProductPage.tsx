import { useState } from "react";
import { useParams } from "react-router";
import { AlertTriangle, BookmarkPlus, Check, Clock, Info, MapPin, ShieldCheck, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/states";
import { normaliseLists, shop } from "../session";
import { SYNTHETIC_LABEL } from "../types";
import { PriceBlock, ProductImage, Rating, StoreLink, SvcBadge, TIER_TEXT, TrustTier, money, useAsync, useSession } from "../ui";
import { AddToCart } from "./ProductCard";

function SaveToList({ pid }: { pid: string }) {
  const [name, setName] = useState("Weekly groceries");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const lists = useAsync(() => shop.lists(), []);
  const names = lists.data ? normaliseLists(lists.data).map((l) => l.name) : [];
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setMsg(null);
        try {
          if (!names.includes(name)) await shop.createList(name);
          await shop.addToList(name, pid);
          setMsg({ ok: true, text: `Saved to "${name}"` });
        } catch (err) {
          setMsg({ ok: false, text: (err as Error).message });
        }
      }}
    >
      <label className="grid gap-1 text-xs font-medium text-fg-muted">
        List
        <input
          list="list-names"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-focus"
        />
        <datalist id="list-names">
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </label>
      <Button type="submit" size="md">
        <BookmarkPlus aria-hidden />
        Save to list
      </Button>
      {msg && (
        <span role="status" className={msg.ok ? "text-xs text-ok" : "text-xs text-bad"}>
          {msg.text}
        </span>
      )}
    </form>
  );
}

export function Component() {
  const { pid = "" } = useParams();
  const s = useSession();
  const storeId = s?.store_id ?? "4108";
  const res = useAsync(() => shop.product(pid, storeId), [pid, storeId]);
  const d = res.data;

  if (res.loading && !d)
    return (
      <div className="grid gap-4 md:grid-cols-2" role="status" aria-busy="true" aria-label="Loading product">
        <Skeleton className="aspect-square" />
        <Skeleton className="h-96" />
      </div>
    );
  if (res.error || !d) return <ErrorState title="Product unavailable">{res.error ?? "No data"}</ErrorState>;

  const p = d.product ?? {};
  const q = d.quote;
  const price = q?.price;
  const inv = q?.inventory;
  const el = q?.eligibility;

  return (
    <div className="grid gap-6">
      <nav aria-label="Breadcrumb" className="text-xs text-fg-muted">
        <StoreLink to="/shop" className="text-fg-muted">
          Store
        </StoreLink>{" "}
        / <span>{String(p.category ?? "").replace(/_/g, " ")}</span>
      </nav>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <ProductImage image={p.image} category={p.category} size="lg" className="aspect-square w-full" />
        <div className="grid content-start gap-4">
          <div className="grid gap-1">
            {p.brand && <span className="text-sm font-medium text-accent-soft-fg">{p.brand}</span>}
            <h1 className="m-0 text-2xl leading-tight font-bold tracking-[-0.02em]">{p.title ?? pid}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <Rating value={p.rating ?? null} />
              <span className="font-mono text-2xs text-fg-muted">{pid}</span>
            </div>
          </div>

          <p className="m-0 inline-flex items-center gap-1.5 self-start rounded-md bg-surface-sunken px-2 py-1 text-xs text-fg-muted">
            <Info className="size-3.5" aria-hidden />
            {d.synthetic_label || SYNTHETIC_LABEL}
          </p>

          <section aria-label="Price" className="grid gap-2">
            <PriceBlock size="lg" price={price?.price ?? null} list={price?.list_price} promo={price?.promo} status={price?.status} />
            {price?.promo?.ends_at && <span className="text-xs text-fg-muted">Promo ends {new Date(price.promo.ends_at).toLocaleDateString()}</span>}
            <div className="flex flex-wrap gap-1">
              <SvcBadge name="price" status={price?.status} />
              {(price as any)?.promo_status && <SvcBadge name="promo" status={(price as any).promo_status} />}
              <SvcBadge name="inventory" status={inv?.status} />
              <SvcBadge name="eligibility" status={el?.status} />
            </div>
            {(price as any)?.promo_status === "unavailable" && (
              <p role="status" className="m-0 flex items-center gap-1.5 text-sm text-warn">
                <AlertTriangle className="size-4" aria-hidden />
                Promo service unavailable: showing list price.
              </p>
            )}
            {price?.status !== "ok" && (
              <p role="status" className="m-0 flex items-center gap-1.5 text-sm text-warn">
                <AlertTriangle className="size-4" aria-hidden />
                Price service is {price?.status ?? "unknown"}
                {price?.error ? `: ${price.error}` : ""}. {price?.status === "stale" ? "The price shown may be out of date." : "No price is shown rather than a guess."}
              </p>
            )}
          </section>

          <section aria-labelledby="stock-h" className="grid gap-1.5 rounded-xl border border-line bg-surface p-3">
            <h2 id="stock-h" className="m-0 flex items-center gap-1.5 text-sm font-semibold">
              <MapPin className="size-4 text-accent" aria-hidden />
              Pickup at store #{storeId}
            </h2>
            {inv?.status === "unavailable" ? (
              <p className="m-0 flex items-center gap-1.5 text-sm text-bad">
                <XCircle className="size-4" aria-hidden />
                Inventory service unavailable{inv.error ? `: ${inv.error}` : ""}. Stock is unknown.
              </p>
            ) : (
              <>
                {inv?.status === "stale" && (
                  <p className="m-0 flex items-center gap-1.5 text-sm text-warn">
                    <AlertTriangle className="size-4" aria-hidden />
                    Stock data is stale.
                  </p>
                )}
                <p className="m-0 flex items-center gap-1.5 text-sm">
                  {inv?.in_stock ? <Check className="size-4 text-ok" aria-hidden /> : <XCircle className="size-4 text-bad" aria-hidden />}
                  <span className="font-medium">{inv?.in_stock ? `In stock (${inv.qty})` : "Out of stock"}</span>
                  {inv?.pickup_eta_minutes != null && (
                    <span className="inline-flex items-center gap-1 text-fg-muted">
                      <Clock className="size-3.5" aria-hidden />
                      {inv.pickup_label ?? `ready in ${inv.pickup_eta_minutes} min`}
                    </span>
                  )}
                </p>
                {inv?.other_stores && Object.keys(inv.other_stores).length > 0 && (
                  <p className="m-0 text-xs text-fg-muted">
                    Other stores:{" "}
                    {Object.entries(inv.other_stores)
                      .map(([sid, n]) => `#${sid}: ${n}`)
                      .join(" · ")}
                  </p>
                )}
              </>
            )}
          </section>

          <div className="flex flex-wrap items-start gap-3">
            <AddToCart pid={pid} title={String(p.title ?? pid)} size="lg" disabled={inv?.in_stock === false} />
          </div>
          <SaveToList pid={pid} />

          <section aria-labelledby="elig-h" className="grid gap-1.5">
            <h2 id="elig-h" className="m-0 flex items-center gap-1.5 text-sm font-semibold">
              <ShieldCheck className="size-4 text-accent" aria-hidden />
              Eligibility {el?.region ? `(region ${el.region})` : ""}
            </h2>
            {el?.status === "unavailable" ? (
              <p className="m-0 text-sm text-bad">Eligibility service unavailable{el.error ? `: ${el.error}` : ""}.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={el?.snap_eligible ? "ok" : "neutral"}>{el?.snap_eligible ? "SNAP eligible" : "Not SNAP eligible"}</Badge>
                  {el?.age_restricted && <Badge tone="warn">Age {el.min_age ?? ""}+ required</Badge>}
                  {el?.region_blocked && <Badge tone="bad">Not sold in {el.region}</Badge>}
                </div>
                {el?.rules?.length ? (
                  <ul className="m-0 grid gap-0.5 pl-5 text-xs text-fg-muted">
                    {el.rules.map((r) => (
                      <li key={r.rule}>
                        <span className="font-mono">{r.rule}</span> ({r.applies ? "applies" : "does not apply"}): {r.text}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </section>
        </div>
      </div>

      <section aria-labelledby="attr-h" className="grid gap-2">
        <h2 id="attr-h" className="m-0 text-lg font-semibold">
          Product details
        </h2>
        <div className="flex flex-wrap gap-3 text-xs text-fg-muted" aria-label="Trust tier legend">
          {Object.entries(TIER_TEXT).map(([t, txt]) => (
            <span key={t} className="inline-flex items-center gap-1.5">
              <TrustTier tier={t} /> {txt.replace(/^T\d /, "")}
            </span>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-muted">
                <th className="py-1.5 pr-3 font-medium">Attribute</th>
                <th className="py-1.5 pr-3 font-medium">Value</th>
                <th className="py-1.5 pr-3 font-medium">Trust</th>
                <th className="py-1.5 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {d.attributes.map((a, i) => (
                <tr key={a.name + i} id={`attr-${a.name}`} data-testid="pdp-attr" className="border-b border-line align-top target:bg-accent-soft">
                  <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                    {a.name}
                  </th>
                  <td className="py-1.5 pr-3">
                    {a.tier === "T3" && <span className="mr-1 text-xs font-semibold text-warn">Unverified:</span>}
                    {Array.isArray(a.value) ? a.value.join(", ") : typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value)}
                  </td>
                  <td className="py-1.5 pr-3">
                    <TrustTier tier={a.tier} />
                  </td>
                  <td className="py-1.5 text-xs text-fg-muted">{a.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {d.substitutes?.length > 0 && (
        <section aria-labelledby="sub-h" className="grid gap-2">
          <h2 id="sub-h" className="m-0 text-lg font-semibold">
            Substitutes
          </h2>
          <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {d.substitutes.map((x) => (
              <li key={x.product_id} className="grid gap-1 rounded-lg border border-line bg-surface p-3 text-sm">
                <StoreLink to={`/shop/p/${encodeURIComponent(x.product_id)}`} className="line-clamp-2 font-medium text-fg">
                  {x.brand ? `${x.brand} ` : ""}
                  {x.title}
                </StoreLink>
                <span className="tabular">
                  {money(x.price)} · {x.in_stock == null ? "stock unknown" : x.in_stock ? "in stock" : "out of stock"} · match {x.sub_score.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
