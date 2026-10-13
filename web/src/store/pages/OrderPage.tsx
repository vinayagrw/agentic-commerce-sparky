/**
 * B16 order confirmation: /shop/order/:orderId
 *
 * Shows what the demo actually recorded: a simulated authorisation reference, the tender legs that
 * covered the basket, the chosen address and a simulated fulfilment stepper. `payment_executed: no`
 * is stated on the page, and every label the API returns is rendered verbatim.
 */
import { useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  Info,
  Package,
  ShieldCheck,
} from "lucide-react";
import { useParams } from "react-router";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  ErrorState,
  PanelSkeleton,
  SectionLabel,
} from "@/components/states";
import { accounts, shop } from "../session";
import type { Order, PaymentMethod, TenderLeg } from "../types";
import { FULFILMENT_LABEL, PM_KIND_LABEL } from "../types";
import { PageTitle, StoreLink, money, useAsync, useSession } from "../ui";

/** The tender legs the order recorded, filled out from the wallet where the order row left nulls. */
export function TenderRows({
  legs,
  wallet,
  testid = "order-tender",
}: {
  legs: TenderLeg[];
  wallet: PaymentMethod[];
  testid?: string;
}) {
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0" data-testid={testid}>
      {legs.map((t, i) => {
        const pm = wallet.find((w) => w.pm_id === t.pm_id);
        const kind = t.kind ?? pm?.kind ?? null;
        const brand = t.brand ?? pm?.brand ?? null;
        const last4 = t.last4 ?? pm?.last4 ?? null;
        const covers = t.covers ?? (legs.length > 1 ? null : "whole basket");
        return (
          <li
            key={`${t.pm_id}-${i}`}
            data-testid="order-tender-row"
            className="flex flex-wrap items-baseline gap-2 border-b border-line py-1.5 text-sm last:border-b-0"
          >
            <span className="font-medium">
              {brand
                ? brand.toUpperCase()
                : (PM_KIND_LABEL[kind ?? ""] ?? t.pm_id)}
              {last4 ? ` ending ${last4}` : ""}
            </span>
            {kind && <Badge size="sm">{PM_KIND_LABEL[kind] ?? kind}</Badge>}
            {covers && (
              <span className="text-xs text-fg-muted">covers {covers}</span>
            )}
            <span className="tabular ml-auto font-semibold">
              {money(t.amount)}
            </span>
            {(t.label ?? pm?.label) && (
              <span className="w-full text-xs text-fg-muted">
                {t.label ?? pm?.label}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Stepper({
  order,
  onAdvance,
  busy,
}: {
  order: Order;
  onAdvance: () => void;
  busy: boolean;
}) {
  const f = order.fulfilment;
  if (!f) return null;
  const done = f.stage_index;
  return (
    <section
      data-testid="order-fulfilment"
      aria-labelledby="ff-h"
      className="grid gap-2 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="ff-h" className="m-0 text-lg font-semibold">
          Fulfilment
        </h2>
        <Badge
          tone={f.stage === "picked_up" ? "ok" : "info"}
          data-testid="order-fulfilment-stage"
        >
          {FULFILMENT_LABEL[f.stage] ?? f.stage}
        </Badge>
        <Button
          size="sm"
          className="ml-auto"
          disabled={busy || !f.next_stage}
          data-testid="advance-fulfilment"
          onClick={onAdvance}
        >
          <ArrowRight aria-hidden />
          Advance fulfilment (demo control)
        </Button>
      </div>
      <ol
        className="m-0 flex list-none flex-wrap gap-2 p-0"
        aria-label="Fulfilment stages"
      >
        {f.stages.map((st, i) => (
          <li
            key={st}
            aria-current={i === done ? "step" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
              i < done
                ? "border-ok/40 bg-ok-soft text-ok"
                : i === done
                  ? "border-accent bg-accent-soft text-accent-soft-fg"
                  : "border-dashed border-line-strong text-fg-muted",
            )}
          >
            {i <= done ? (
              <CheckCircle2 className="size-3.5" aria-hidden />
            ) : (
              <CircleDashed className="size-3.5" aria-hidden />
            )}
            {FULFILMENT_LABEL[st] ?? st}
          </li>
        ))}
      </ol>
      <p className="m-0 flex items-start gap-1.5 text-xs text-fg-muted">
        <Info className="mt-0.5 size-3.5 flex-none" aria-hidden />
        <span>
          {f.label} Derived from {f.derived_from}.
        </span>
      </p>
    </section>
  );
}

export function Component() {
  const { orderId = "" } = useParams();
  const s = useSession();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const res = useAsync(() => shop.order(orderId), [orderId, tick]);
  // The order row records pm_id + amount; brand and last4 are read back from the wallet it belongs to.
  const wallet = useAsync(
    () => (s?.account ? accounts.wallet() : Promise.resolve(null)),
    [s?.account?.account_id],
  );
  const order = res.data?.order ?? null;
  const pms = wallet.data?.payment_methods ?? [];

  const advance = async () => {
    setBusy(true);
    setErr(null);
    try {
      await shop.advanceFulfilment(orderId);
      setTick((t) => t + 1);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (res.error)
    return (
      <div className="grid gap-4">
        <PageTitle>Order</PageTitle>
        <ErrorState title="That order could not be read">
          {res.error}
        </ErrorState>
        <StoreLink to="/shop/orders" className="text-accent">
          All orders
        </StoreLink>
      </div>
    );
  if (!order) return <PanelSkeleton rows={5} label="Loading order" />;

  const pay = order.payment ?? null;
  return (
    <div className="grid gap-4">
      <PageTitle
        aside={
          <Badge tone={order.status === "picked_up" ? "ok" : "info"}>
            {FULFILMENT_LABEL[order.status] ?? order.status}
          </Badge>
        }
      >
        Order confirmed
      </PageTitle>
      <p
        data-testid="order-no-payment"
        role="note"
        className="m-0 flex items-center gap-2 rounded-lg border-2 border-accent bg-accent-soft px-4 py-3 text-md font-semibold text-accent-soft-fg"
      >
        <ShieldCheck className="size-5" aria-hidden />
        payment_executed: no — nothing was executed and no funds moved.
      </p>

      <section
        data-testid="order-summary"
        aria-labelledby="os-h"
        className="grid gap-2 rounded-xl border border-line bg-surface p-4"
      >
        <h2 id="os-h" className="m-0 text-lg font-semibold">
          <span className="font-mono" data-testid="order-id">
            {order.order_id}
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <span>{new Date(order.created_at).toLocaleString()}</span>
          <span>· store #{order.store_id}</span>
          {order.account_id && <Badge size="sm">{order.account_id}</Badge>}
          <span className="font-mono">mandate {order.mandate_id}</span>
        </div>
        <ul className="m-0 grid list-none gap-1 p-0 text-sm">
          {order.lines.map((l) => (
            <li
              key={l.product_id}
              className="flex flex-wrap items-baseline gap-2 border-b border-line py-1 last:border-b-0"
            >
              <StoreLink
                to={`/shop/p/${encodeURIComponent(l.product_id)}`}
                className="min-w-0 flex-1 text-fg"
              >
                {l.title}
              </StoreLink>
              <span className="text-fg-muted">× {l.qty}</span>
              <span className="tabular font-medium">
                {money(l.line_total ?? l.price * l.qty)}
              </span>
            </li>
          ))}
        </ul>
        <div className="tabular text-right font-semibold">
          Total {money(order.total)}
        </div>
        {order.note && (
          <p className="m-0 text-xs text-fg-muted">{order.note}</p>
        )}
        {order.synthetic_label && (
          <p
            className="m-0 flex items-start gap-1.5 text-xs text-fg-muted"
            data-testid="order-synthetic-label"
          >
            <Info className="mt-0.5 size-3.5 flex-none" aria-hidden />
            <span>{order.synthetic_label}</span>
          </p>
        )}
      </section>

      <section
        data-testid="order-payment"
        aria-labelledby="op-h"
        className="grid gap-2 rounded-xl border border-line bg-surface p-4"
      >
        <h2 id="op-h" className="m-0 text-lg font-semibold">
          Simulated authorisation
        </h2>
        {pay ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="ok">{pay.status}</Badge>
              <Badge>payment executed: no</Badge>
              {pay.split_tender && <Badge tone="info">split tender</Badge>}
              {pay.authorised_at && (
                <span className="text-xs text-fg-muted">
                  {new Date(pay.authorised_at).toLocaleString()}
                </span>
              )}
            </div>
            <div className="grid gap-1">
              <SectionLabel>Authorisation reference</SectionLabel>
              <code
                data-testid="order-auth-ref"
                className="block rounded-md bg-code-bg px-2 py-1.5 text-xs break-all text-code-fg"
              >
                {pay.auth_ref ?? order.auth_ref ?? "—"}
              </code>
              <p
                className="m-0 text-xs text-fg-muted"
                data-testid="order-auth-note"
              >
                {pay.note}
              </p>
            </div>
            <div className="grid gap-1">
              <SectionLabel>Tender</SectionLabel>
              <TenderRows legs={pay.tender} wallet={pms} />
              <div className="tabular text-right text-sm font-semibold">
                {money(pay.amount)} {pay.currency}
              </div>
            </div>
            <p className="m-0 flex items-start gap-1.5 text-xs text-fg-muted">
              <Info className="mt-0.5 size-3.5 flex-none" aria-hidden />
              <span>{pay.synthetic_label}</span>
            </p>
          </>
        ) : (
          <EmptyState icon={ShieldCheck}>
            This order named no payment instrument, so there was nothing to
            authorise. Guest checkout records no tender.
          </EmptyState>
        )}
      </section>

      <section
        data-testid="order-address"
        aria-labelledby="oa-h"
        className="grid gap-1.5 rounded-xl border border-line bg-surface p-4"
      >
        <h2 id="oa-h" className="m-0 text-lg font-semibold">
          Pickup address
        </h2>
        {order.address ? (
          <>
            <span className="text-sm font-medium">{order.address.name}</span>
            <span className="text-sm">{order.address.display}</span>
            {order.address.instructions && (
              <span className="text-sm text-fg-muted">
                “{order.address.instructions}”
              </span>
            )}
            <p className="m-0 flex items-start gap-1.5 text-xs text-fg-muted">
              <Info className="mt-0.5 size-3.5 flex-none" aria-hidden />
              <span>{order.address.label}</span>
            </p>
          </>
        ) : (
          <p className="m-0 text-sm text-fg-muted">
            No address was chosen for this order, so none is shown. The demo
            never infers one.
          </p>
        )}
      </section>

      {err && (
        <ErrorState title="Fulfilment was not advanced">{err}</ErrorState>
      )}
      <Stepper order={order} onAdvance={advance} busy={busy} />

      {/* A button, not a bare accent link: on the page background an accent link fails AA contrast. */}
      <Button asChild variant="secondary" className="justify-self-start">
        <StoreLink to="/shop/orders" data-testid="order-back">
          <Package aria-hidden />
          All orders
        </StoreLink>
      </Button>
    </div>
  );
}
