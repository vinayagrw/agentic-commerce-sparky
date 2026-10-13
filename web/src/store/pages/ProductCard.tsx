import { useState } from "react";
import { Check, Loader2, Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { shop } from "../session";
import type { ResultItem } from "../types";
import { PriceBlock, ProductImage, Rating, StoreLink } from "../ui";

export function AddToCart({ pid, title, size = "sm", className, disabled }: { pid: string; title: string; size?: "sm" | "lg"; className?: string; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className={cn("grid gap-1", className)}>
      <Button
        data-testid="add-to-cart"
        variant="primary"
        size={size === "lg" ? "lg" : "sm"}
        className="rounded-full"
        disabled={disabled || state === "busy"}
        aria-label={`Add ${title} to cart`}
        onClick={async () => {
          setState("busy");
          setErr(null);
          try {
            const r = await shop.addToCart(pid, 1);
            if (r && r.ok === false) throw new Error(r.error ?? "not added");
            setState("done");
            setTimeout(() => setState("idle"), 1600);
          } catch (e) {
            setErr((e as Error).message);
            setState("idle");
          }
        }}
      >
        {state === "busy" ? <Loader2 className="animate-spin" aria-hidden /> : state === "done" ? <Check aria-hidden /> : <Plus aria-hidden />}
        {state === "done" ? "Added" : "Add"}
      </Button>
      {err && (
        <p role="alert" className="m-0 text-xs text-bad">
          Not added: {err}
        </p>
      )}
    </div>
  );
}

export function ProductCard({ p, highlighted, constraintNote }: { p: ResultItem; highlighted?: boolean; constraintNote?: string }) {
  return (
    <article
      data-testid="result-card"
      aria-labelledby={`t-${p.product_id}`}
      className={cn("relative flex flex-col gap-2 rounded-xl border bg-surface p-3 shadow-xs transition-shadow hover:shadow-md", highlighted ? "border-accent ring-2 ring-accent" : "border-line")}
    >
      {highlighted && (
        <span data-testid="highlight-found-by-sparky" className="absolute top-2 left-2 z-10">
          <Badge tone="accent" size="sm">
            <Sparkles aria-hidden />
            Found by Compass
          </Badge>
        </span>
      )}
      {p.sponsored && (
        <span className="absolute top-2 right-2 z-10">
          <Badge size="sm">Sponsored</Badge>
        </span>
      )}
      <StoreLink to={`/shop/p/${encodeURIComponent(p.product_id)}`} tabIndex={-1} aria-hidden>
        <ProductImage image={p.image} category={p.category} className="aspect-square w-full" />
      </StoreLink>
      <PriceBlock price={p.price} list={p.list_price} promo={p.promo} status={p.price == null ? "unavailable" : "ok"} />
      <h3 id={`t-${p.product_id}`} className="m-0 text-sm leading-snug font-normal">
        <StoreLink to={`/shop/p/${encodeURIComponent(p.product_id)}`} className="line-clamp-3 text-fg no-underline hover:underline focus-visible:outline-2 focus-visible:outline-focus">
          {p.brand && <span className="font-semibold">{p.brand} </span>}
          {p.title}
        </StoreLink>
      </h3>
      <div className="flex flex-wrap items-center gap-1.5">
        <Rating value={p.rating} />
        {p.dietary?.slice(0, 2).map((d) => (
          <Badge key={d} size="sm" tone="ok">
            {d}
          </Badge>
        ))}
        {p.snap_eligible && <Badge size="sm">SNAP</Badge>}
        {p.age_restricted && (
          <Badge size="sm" tone="warn">
            Age check
          </Badge>
        )}
      </div>
      <div className="text-xs">
        {p.in_stock == null ? (
          <span className="font-medium text-warn">Stock unavailable</span>
        ) : p.in_stock ? (
          <span className="font-medium text-ok">
            <Check className="mr-1 inline size-3.5" aria-hidden />
            {p.pickup_label ?? "Pickup available"}
          </span>
        ) : (
          <span className="font-medium text-bad">Out of stock at this store</span>
        )}
      </div>
      {constraintNote && <p className="m-0 text-2xs text-fg-muted">{constraintNote}</p>}
      <AddToCart pid={p.product_id} title={p.title} className="mt-auto" disabled={p.in_stock === false} />
    </article>
  );
}
