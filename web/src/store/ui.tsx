/** Storefront building blocks: product tile image, price hierarchy, constraint chips, could-not-do, activity. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { AlertTriangle, CheckCircle2, CircleDashed, Info, ShoppingCart, Star, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useStore } from "../store";
import { ApiError, connStore, sessionStore, shop } from "./session";
import type { Constraint, SvcStatus } from "./types";
import { SYNTHETIC_LABEL } from "./types";

/* ---------------- hooks ---------------- */

export const useSession = () => useStore(sessionStore);
export const useConn = () => useStore(connStore);

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => n === seq.current && setState({ data, error: null, loading: false }),
      (e) => n === seq.current && setState({ data: null, error: e instanceof ApiError || e instanceof Error ? e.message : String(e), loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    run();
  }, [run]);
  return { ...state, reload: run };
}

/** Link target that keeps the ?view param across store navigation. */
export function useViewHref() {
  const [params] = useSearchParams();
  const view = params.get("view");
  return (to: string) => {
    if (!view) return to;
    return to + (to.includes("?") ? "&" : "?") + `view=${view}`;
  };
}

export function StoreLink({ to, ...props }: React.ComponentProps<typeof Link> & { to: string }) {
  const href = useViewHref();
  return <Link to={href(to)} {...props} />;
}

export const money = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "—" : `$${Number(v).toFixed(2)}`);

/* ---------------- product image placeholder ---------------- */

const TONE: Record<string, string> = {
  grocery: "bg-ok-soft",
  pet: "bg-warn-soft",
  home_kitchen: "bg-surface-sunken",
  baby: "bg-info-soft",
  health_household: "bg-bad-soft",
  electronics_accessories: "bg-accent-soft",
};

/** "placeholder:category:emoji:color" -> large emoji on a token tile (the colour in the string is ignored). */
export function ProductImage({ image, category, className, size = "md" }: { image?: string; category?: string; className?: string; size?: "sm" | "md" | "lg" }) {
  const parts = (image ?? "").split(":");
  const cat = parts[0] === "placeholder" ? parts[1] || category : category;
  const emoji = parts[0] === "placeholder" && parts[2] ? parts[2] : "🛒";
  return (
    <div aria-hidden className={cn("grid place-items-center rounded-lg", TONE[cat ?? ""] ?? "bg-surface-sunken", className)}>
      <span className={cn("leading-none select-none", size === "sm" ? "text-[40px]" : size === "lg" ? "text-[120px]" : "text-[72px]")}>{emoji}</span>
    </div>
  );
}

/* ---------------- price / rating ---------------- */

export function PriceBlock({ price, list, promo, status, size = "md" }: { price: number | null; list?: number | null; promo?: { label: string; pct_off?: number } | null; status?: SvcStatus; size?: "md" | "lg" }) {
  if (status && status !== "ok" && price == null)
    return (
      <div className="flex items-center gap-1.5 text-sm font-medium text-warn">
        <AlertTriangle className="size-4" aria-hidden />
        Price {status === "stale" ? "stale" : "unavailable"}
      </div>
    );
  const struck = list != null && price != null && list > price;
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={cn("tabular font-bold tracking-[-0.02em]", size === "lg" ? "text-3xl" : "text-xl", struck && "text-ok")}>
          {struck && <span className="sr-only">Now </span>}
          {money(price)}
        </span>
        {struck && (
          <span className="tabular text-sm text-fg-muted line-through">
            <span className="sr-only">Was </span>
            {money(list)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {promo && (
          <Badge tone="highlight" size="sm">
            {promo.label}
          </Badge>
        )}
        {status === "stale" && (
          <Badge tone="warn" size="sm">
            <AlertTriangle aria-hidden />
            Price may be stale
          </Badge>
        )}
      </div>
    </div>
  );
}

export function Rating({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-xs text-fg-muted">No rating</span>;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-fg-muted" aria-label={`Rated ${value.toFixed(1)} out of 5 (synthetic)`}>
      <Star className="size-3.5 fill-current text-warn" aria-hidden />
      <span className="tabular font-medium text-fg">{value.toFixed(1)}</span>
    </span>
  );
}

export function SvcBadge({ name, status }: { name: string; status: SvcStatus | undefined }) {
  const s = status ?? "unknown";
  const tone = s === "ok" ? "ok" : s === "stale" ? "warn" : s === "unavailable" ? "bad" : "neutral";
  const Icon = s === "ok" ? CheckCircle2 : s === "unavailable" ? XCircle : s === "stale" ? AlertTriangle : CircleDashed;
  return (
    <Badge size="sm" tone={tone as any} className={s === "ok" ? "text-fg" : undefined}>
      <Icon aria-hidden />
      {name}: {s}
    </Badge>
  );
}

/** Honest service status line: shown whenever any service is not ok. */
export function ServiceNotice({ services }: { services?: Record<string, SvcStatus> }) {
  if (!services) return null;
  const bad = Object.entries(services).filter(([, v]) => v !== "ok");
  if (!bad.length) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm">
      <AlertTriangle className="size-4 text-warn" aria-hidden />
      <span className="font-medium">Some commerce services are degraded; affected values are marked, not hidden.</span>
      {bad.map(([k, v]) => (
        <SvcBadge key={k} name={k} status={v} />
      ))}
    </div>
  );
}

/* ---------------- trust tiers ---------------- */

export const TIER_TEXT: Record<string, string> = {
  T1: "T1 catalogue: published ESCI field (title, brand, category, bullets)",
  T2: "T2 synthetic/derived: structured data generated for this demo (dietary, rating, price, stock, eligibility)",
  T3: "T3 unverified/inferred: keyword-inferred or seller text; never shown as fact",
};

export function TrustTier({ tier }: { tier: string }) {
  const tone = tier === "T1" ? "ok" : tier === "T2" ? "info" : "warn";
  return (
    <Badge size="sm" tone={tone as any} data-testid="pdp-trust-tier" title={TIER_TEXT[tier]} className="font-mono">
      {tier}
    </Badge>
  );
}

/* ---------------- constraints (B11) ---------------- */

function appliesText(c: Constraint) {
  const a = c.applies_as;
  if (!a) return "Not applied as a search filter; checked by the verifier against the cart.";
  if (a.filter === "dietary") return `Applied as filter dietary = "${a.value}" on every search.`;
  if (a.filter === "exclude_terms") return `Applied as filter: exclude results mentioning ${a.value.map((v) => `"${v}"`).join(", ")}.`;
  if (a.filter === "max_price") return `Applied as filter: max price $${a.value}.`;
  if (a.filter === "store") return `Applied as store ${a.value} for price and stock.`;
  return "Applied as a filter.";
}

const STATUS_META = {
  ok: { icon: CheckCircle2, label: "met", cls: "text-ok" },
  violated: { icon: XCircle, label: "violated", cls: "text-bad" },
  unknown: { icon: CircleDashed, label: "unverified", cls: "text-fg-muted" },
} as const;

export function ConstraintChip({ c, compact }: { c: Constraint; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const meta = STATUS_META[c.status] ?? STATUS_META.unknown;
  const Icon = meta.icon;
  return (
    <span
      data-testid="constraint-chip"
      className={cn(
        "inline-flex h-7 max-w-full items-center rounded-full border text-xs",
        c.status === "violated" ? "border-bad/50 bg-bad-soft" : c.status === "ok" ? "border-line-strong bg-surface" : "border-dashed border-line-strong bg-surface",
      )}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="inline-flex h-full min-w-0 items-center gap-1.5 rounded-l-full pr-1 pl-2.5 focus-visible:outline-2 focus-visible:outline-focus" aria-label={`Constraint ${c.key}: ${c.value}, ${meta.label}, from ${c.source}. Show provenance`}>
            <Icon className={cn("size-3.5 flex-none", meta.cls)} aria-hidden />
            {!compact && <span className="text-fg-muted">{c.key}</span>}
            <span className="truncate font-medium text-fg">{c.value}</span>
            <span className={cn("text-2xs", meta.cls)}>{meta.label}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="grid gap-2 text-sm">
          <div className="flex items-center gap-2 font-semibold">
            <Icon className={cn("size-4", meta.cls)} aria-hidden />
            {c.key}: {c.value}
            <Badge size="sm" tone={c.status === "ok" ? "ok" : c.status === "violated" ? "bad" : "neutral"}>
              {meta.label}
            </Badge>
          </div>
          <dl className="m-0 grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-xs">
            <dt className="text-fg-muted">Source</dt>
            <dd className="m-0">{c.source === "chat" ? "You said it in chat" : c.source === "site" ? "Set on the site" : "Inferred by the planner"}</dd>
            {c.source_text && (
              <>
                <dt className="text-fg-muted">Quote</dt>
                <dd className="m-0 italic">"{c.source_text}"</dd>
              </>
            )}
            <dt className="text-fg-muted">How it applies</dt>
            <dd className="m-0">{appliesText(c)}</dd>
            {c.note && (
              <>
                <dt className="text-fg-muted">Note</dt>
                <dd className="m-0">{c.note}</dd>
              </>
            )}
          </dl>
          {err && (
            <p role="alert" className="m-0 text-xs text-bad">
              {err}
            </p>
          )}
        </PopoverContent>
      </Popover>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await shop.removeConstraint(c.id ?? c.key);
          } catch (e) {
            setErr(String((e as Error).message));
          } finally {
            setBusy(false);
          }
        }}
        aria-label={`Remove constraint ${c.key}: ${c.value}`}
        className="mr-0.5 grid size-6 flex-none place-items-center rounded-full text-fg-muted hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </span>
  );
}

export function ConstraintChips({ className, compact, label = "Your constraints" }: { className?: string; compact?: boolean; label?: string }) {
  const s = useSession();
  const cs = s?.constraints ?? [];
  if (!cs.length) return null;
  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <span className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">{label}</span>
      {cs.map((c) => (
        <ConstraintChip key={c.id ?? c.key} c={c} compact={compact} />
      ))}
    </div>
  );
}

/* ---------------- B09 could not do ---------------- */

export function CouldNotDo({ className }: { className?: string }) {
  const s = useSession();
  const items = s?.could_not ?? [];
  if (!items.length) return null;
  return (
    <section data-testid="could-not-do" aria-labelledby="cnd-title" className={cn("grid gap-1.5 rounded-lg border border-warn/40 border-l-4 border-l-warn bg-warn-soft px-3 py-2.5 text-sm", className)}>
      <h2 id="cnd-title" className="m-0 flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="size-4 text-warn" aria-hidden />
        What I could not do
      </h2>
      <ul className="m-0 grid gap-1 pl-5">
        {items.map((c, i) => (
          <li key={i}>
            <span className="font-medium">{c.constraint}</span>: {c.reason}
            {c.product_ids?.length ? <span className="text-xs text-fg-muted"> ({c.product_ids.length} product(s) affected)</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------- activity from the site, shown in chat ---------------- */

export function SiteActivity({ className }: { className?: string }) {
  const s = useSession();
  const items = (s?.activity ?? []).filter((a) => a.actor === "site").slice(-4);
  if (!items.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", className)} aria-label="Recent actions on the site" role="group" data-testid="site-activity">
      <span className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">Activity</span>
      {items.map((a) => (
        <span key={a.id} className="inline-flex h-6 max-w-[18rem] items-center gap-1 truncate rounded-full border border-line bg-surface-sunken px-2 text-fg-muted" title={`${a.kind} at ${a.at}`}>
          <span className="font-medium text-fg">Site</span> {a.summary}
        </span>
      ))}
    </div>
  );
}

export function MiniCart({ className }: { className?: string }) {
  const s = useSession();
  const cart = s?.cart;
  return (
    <div className={cn("flex flex-wrap items-center gap-3 text-sm", className)}>
      <StoreLink to="/shop/cart" className="inline-flex items-center gap-1.5 rounded-md font-medium text-fg no-underline hover:underline focus-visible:outline-2 focus-visible:outline-focus">
        <ShoppingCart className="size-4" aria-hidden />
        {cart?.item_count ?? 0} items · <span className="tabular">{money(cart?.total ?? 0)}</span>
      </StoreLink>
      {s?.budget != null && (
        <span className={cn("text-xs", (cart?.total ?? 0) > s.budget ? "font-semibold text-bad" : "text-fg-muted")}>
          budget {money(s.budget)}
          {(cart?.total ?? 0) > s.budget ? " (over budget)" : ""}
        </span>
      )}
    </div>
  );
}

/* ---------------- footer ---------------- */

export function StoreFooter() {
  return (
    <footer className="mt-auto border-t border-line bg-surface px-4 py-4 text-xs text-fg-muted">
      <div className="mx-auto flex max-w-[90rem] flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-fg">
          <Info className="size-3.5" aria-hidden />
          {SYNTHETIC_LABEL}
        </span>
        <span>
          Products and queries: Amazon ESCI Shopping Queries Dataset (Reddy et al., 2022, Apache-2.0). Prices, promos, stock, eligibility and stores are synthetic. Help answers come from a demo corpus written for
          this environment, not any real retailer's policy. No payment is taken.
        </span>
      </div>
    </footer>
  );
}

export function useIsNarrow(px = 768) {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(`(max-width: ${px - 1}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${px - 1}px)`);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [px]);
  return narrow;
}

export function PageTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <h1 className="m-0 text-2xl font-bold tracking-[-0.02em]">{children}</h1>
      {aside}
    </div>
  );
}

export function useStoreLocation() {
  return useLocation();
}
