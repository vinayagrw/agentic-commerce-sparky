import { useState } from "react";
import { Minus, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/states";
import { shop } from "../session";
import type { CartItem } from "../types";
import { CouldNotDo, PageTitle, ProductImage, StoreLink, money, useSession } from "../ui";

function Line({ it }: { it: CartItem }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<{ ok?: boolean; error?: string } | unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const r: any = await fn();
      if (r && r.ok === false) setErr(r.error ?? "failed");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-3 border-b border-line py-3">
      <ProductImage size="sm" className="size-18" />
      <div className="grid min-w-0 gap-1">
        <StoreLink to={`/shop/p/${encodeURIComponent(it.product_id)}`} className="line-clamp-2 text-sm font-medium text-fg">
          {it.title}
        </StoreLink>
        <span className="tabular text-xs text-fg-muted">{money(it.price)} each</span>
        <div className="flex items-center gap-2">
          <div role="group" aria-label={`Quantity for ${it.title}`} className="inline-flex items-center rounded-full border border-line-strong">
            <Button variant="ghost" size="icon-sm" className="rounded-full" disabled={busy} aria-label="Decrease quantity" onClick={() => act(() => shop.setQty(it.product_id, it.qty - 1))}>
              <Minus aria-hidden />
            </Button>
            <span className="tabular min-w-6 text-center text-sm font-semibold" aria-live="polite">
              {it.qty}
            </span>
            <Button variant="ghost" size="icon-sm" className="rounded-full" disabled={busy} aria-label="Increase quantity" onClick={() => act(() => shop.setQty(it.product_id, it.qty + 1))}>
              <Plus aria-hidden />
            </Button>
          </div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => shop.remove(it.product_id))} aria-label={`Remove ${it.title}`}>
            <Trash2 aria-hidden />
            Remove
          </Button>
        </div>
        {err && (
          <p role="alert" className="m-0 text-xs text-bad">
            {err}
          </p>
        )}
      </div>
      <span className="tabular text-md font-semibold">{money(it.line_total)}</span>
    </li>
  );
}

export function BudgetMeter({ total, budget }: { total: number; budget: number | null }) {
  if (budget == null) return <p className="m-0 text-xs text-fg-muted">No budget set. Tell Compass one in chat (for example "under $50").</p>;
  const over = total > budget;
  return (
    <div className="grid gap-1">
      <div className="flex justify-between text-sm">
        <span>Budget</span>
        <span className={cn("tabular font-medium", over && "text-bad")}>
          {money(total)} of {money(budget)} {over ? `(over by ${money(total - budget)})` : `(${money(budget - total)} left)`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" role="meter" aria-label="Cart total against budget" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={total}>
        <div className={cn("h-full rounded-full", over ? "bg-bad" : "bg-ok")} style={{ width: `${Math.min(100, (total / Math.max(budget, 0.01)) * 100)}%` }} />
      </div>
    </div>
  );
}

export function Component() {
  const s = useSession();
  const items = s?.cart.items ?? [];
  return (
    <div className="grid gap-4">
      <PageTitle>Cart</PageTitle>
      <CouldNotDo />
      {items.length === 0 ? (
        <EmptyState icon={ShoppingCart} action={<StoreLink to="/shop" className="text-sm text-accent-soft-fg">Continue shopping</StoreLink>}>
          {s ? "Your cart is empty." : "Loading your session…"}
        </EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <ul className="m-0 list-none p-0">
            {items.map((it) => (
              <Line key={it.product_id} it={it} />
            ))}
          </ul>
          <aside aria-label="Order summary" className="grid content-start gap-3 rounded-xl border border-line bg-surface p-4">
            <div className="flex justify-between text-md font-semibold">
              <span>Subtotal ({s?.cart.item_count} items)</span>
              <span className="tabular">{money(s?.cart.total)}</span>
            </div>
            <BudgetMeter total={s?.cart.total ?? 0} budget={s?.budget ?? null} />
            <Button asChild variant="primary" size="lg" className="rounded-full">
              <StoreLink to="/shop/checkout">Continue to checkout</StoreLink>
            </Button>
            <p className="m-0 text-xs text-fg-muted">No payment is taken in this environment.</p>
          </aside>
        </div>
      )}
    </div>
  );
}
