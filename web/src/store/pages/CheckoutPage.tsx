import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, SectionLabel } from "@/components/states";
import {
  ApiError,
  accounts,
  confirmOrder,
  recordApproval,
  shop,
} from "../session";
import type {
  Address,
  AuthResult,
  Order,
  PaymentMethod,
  Revalidation,
  StepUp,
  TenderPreview,
} from "../types";
import { OUTCOME_BADGE, PM_KIND_LABEL } from "../types";
import {
  CouldNotDo,
  PageTitle,
  ServiceNotice,
  StoreLink,
  money,
  useAsync,
  useSession,
  useViewHref,
} from "../ui";
import { OutcomeBadge } from "./AccountPages";
import { BudgetMeter } from "./CartPage";

/* ---------------- B16 payment step ---------------- */

/** One instrument row in the multi-select list. Picking two instruments IS a split tender. */
function PmChoice({
  pm,
  checked,
  onToggle,
  disabled,
}: {
  pm: PaymentMethod;
  checked: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  return (
    <li>
      <label
        data-testid="tender-pm"
        data-pm={pm.pm_id}
        className={cn(
          "flex cursor-pointer flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm",
          checked
            ? "border-accent bg-accent-soft"
            : "border-line bg-surface hover:bg-surface-hover",
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          className="size-4 flex-none"
          // The visible text sits in sibling spans, not in a <label for>, so without this a screen
          // reader announces every instrument as just "checkbox, on" — indistinguishable from the
          // next one. Name it after the card itself, and say what the card deliberately does, so the
          // outcome badge is not sighted-only information.
          aria-label={`Pay with ${pm.display}${pm.outcome && pm.outcome !== "approved" ? ` — ${OUTCOME_BADGE[pm.outcome]?.text ?? pm.outcome}` : ""}`}
          aria-describedby={`pmlbl-${pm.pm_id}`}
        />
        <span className="font-medium">{pm.display}</span>
        <Badge size="sm">{PM_KIND_LABEL[pm.kind] ?? pm.kind}</Badge>
        <OutcomeBadge pm={pm} />
        {pm.is_default && (
          <Badge size="sm" tone="accent">
            Default
          </Badge>
        )}
        {pm.balance != null && (
          <span className="tabular text-xs text-fg-muted">
            balance {money(pm.balance)}
          </span>
        )}
        <span id={`pmlbl-${pm.pm_id}`} className="w-full text-xs text-fg-muted">
          {pm.label}
        </span>
      </label>
    </li>
  );
}

function TenderPlanTable({ t }: { t: TenderPreview }) {
  return (
    <div className="grid gap-1.5" data-testid="tender-plan">
      <SectionLabel
        aside={
          <Badge size="sm" tone={t.split_tender ? "info" : "neutral"}>
            {t.split_tender ? "split tender" : "single instrument"}
          </Badge>
        }
      >
        Tender plan
      </SectionLabel>
      {t.plan.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">
          No instrument covers this basket yet.
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {t.plan.map((leg) => (
            <li
              key={leg.pm_id}
              data-testid="tender-plan-row"
              className="flex flex-wrap items-baseline gap-2 border-b border-line py-1.5 text-sm last:border-b-0"
            >
              <span className="font-medium">{leg.display ?? leg.pm_id}</span>
              {leg.kind && (
                <Badge size="sm">{PM_KIND_LABEL[leg.kind] ?? leg.kind}</Badge>
              )}
              <span className="text-xs text-fg-muted">covers {leg.covers}</span>
              <span className="tabular ml-auto font-semibold">
                {money(leg.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
        <dt className="text-fg-muted">Basket total</dt>
        <dd className="tabular m-0">{money(t.total)}</dd>
        <dt className="text-fg-muted">SNAP-eligible subtotal</dt>
        <dd className="tabular m-0">{money(t.snap_subtotal)}</dd>
        <dt className="text-fg-muted">Covered</dt>
        <dd className="tabular m-0">{money(t.covered_total)}</dd>
        <dt className="text-fg-muted">Not covered</dt>
        <dd
          className={cn(
            "tabular m-0",
            t.uncovered > 0.004 && "font-semibold text-bad",
          )}
        >
          {money(t.uncovered)}
        </dd>
      </dl>
      <p className="m-0 flex items-start gap-1.5 text-xs text-fg-muted">
        <Info className="mt-0.5 size-3.5 flex-none" aria-hidden />
        <span>{t.label}</span>
      </p>
      <p className="m-0 text-xs text-fg-muted">
        SNAP rule text: {t.eligibility_rule_source}
      </p>
    </div>
  );
}

function PaymentStep({
  addressId,
  setAddressId,
  pmIds,
  setPmIds,
  tender,
  setTender,
  disabled,
}: {
  addressId: string | null;
  setAddressId: (v: string) => void;
  pmIds: string[];
  setPmIds: (v: string[]) => void;
  tender: TenderPreview | null;
  setTender: (t: TenderPreview | null) => void;
  disabled: boolean;
}) {
  const s = useSession();
  const hasAccount = Boolean(s?.account);
  const wallet = useAsync(
    () => (hasAccount ? accounts.wallet() : Promise.resolve(null)),
    [s?.account?.account_id, hasAccount],
  );
  const adrs = useAsync(
    () => (hasAccount ? accounts.addresses() : Promise.resolve(null)),
    [s?.account?.account_id, hasAccount],
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pms: PaymentMethod[] = wallet.data?.payment_methods ?? [];
  const list: Address[] = adrs.data?.addresses ?? [];

  // Defaults: the account's default address and default instrument, so one click reaches a plan.
  // Seeded ONCE per wallet load: clearing the selection must not silently re-add the default.
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!addressId && list.length)
      setAddressId((list.find((a) => a.is_default) ?? list[0]).address_id);
  }, [list, addressId, setAddressId]);
  useEffect(() => {
    const key = pms.map((p) => p.pm_id).join(",");
    if (!pms.length || seeded.current === key) return;
    seeded.current = key;
    if (!pmIds.length)
      setPmIds([(pms.find((p) => p.is_default) ?? pms[0]).pm_id]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pms]);

  const preview = useCallback(
    async (ids: string[]) => {
      setTender(null);
      setErr(null);
      if (!ids.length) return;
      setBusy(true);
      try {
        const r = await accounts.tender(ids);
        setTender(r.tender);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [setTender],
  );

  // Re-price whenever the chosen instruments or the cart change: a stale plan cannot be signed.
  useEffect(() => {
    void preview(pmIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pmIds.join(","), s?.cart.total, s?.store_id]);

  const toggle = (id: string) =>
    setPmIds(
      pmIds.includes(id) ? pmIds.filter((x) => x !== id) : [...pmIds, id],
    );
  const blocking = (tender?.refusals ?? []).filter((r) => r.blocking);
  const advisory = (tender?.refusals ?? []).filter((r) => !r.blocking);

  return (
    <section
      data-testid="checkout-payment"
      aria-labelledby="pay-h"
      className="grid gap-3 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="pay-h" className="m-0 text-lg font-semibold">
          Payment
        </h2>
        {s?.account ? (
          <Badge tone="accent">{s.account.name}</Badge>
        ) : (
          <Badge>guest</Badge>
        )}
        {busy && (
          <Loader2
            className="size-4 animate-spin text-fg-muted"
            aria-label="Working out the tender split"
          />
        )}
      </div>

      {!hasAccount ? (
        <EmptyState icon={ShieldCheck}>
          This is a guest session: there is no wallet and no saved address, so
          no tender is named. You can still sign a mandate and place a demo
          order. Pick a synthetic shopper from “Shopping as” in the header to
          use the payment step.
        </EmptyState>
      ) : (
        <>
          {wallet.error && (
            <ErrorState title="Wallet unavailable">{wallet.error}</ErrorState>
          )}
          {adrs.error && (
            <ErrorState title="Addresses unavailable">{adrs.error}</ErrorState>
          )}

          <label className="grid max-w-prose gap-1 text-sm font-medium">
            Pickup address
            <select
              value={addressId ?? ""}
              disabled={disabled || !list.length}
              onChange={(e) => setAddressId(e.target.value)}
              data-testid="tender-address"
              className="h-9 rounded-md border border-line bg-surface px-2 text-fg focus-visible:outline-2 focus-visible:outline-focus"
            >
              {list.map((a) => (
                <option key={a.address_id} value={a.address_id}>
                  {a.display}
                  {a.is_default ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <StoreLink
            to="/shop/account/addresses"
            className="text-xs text-accent"
          >
            Manage addresses
          </StoreLink>

          <div className="grid gap-1.5">
            <SectionLabel>Pay with (pick two to split the basket)</SectionLabel>
            {pms.length === 0 ? (
              <EmptyState icon={ShieldCheck}>
                This wallet has no instrument yet. Add one of the published test
                cards on the wallet page.
              </EmptyState>
            ) : (
              <ul className="m-0 grid list-none gap-1.5 p-0">
                {pms.map((pm) => (
                  <PmChoice
                    key={pm.pm_id}
                    pm={pm}
                    checked={pmIds.includes(pm.pm_id)}
                    disabled={disabled}
                    onToggle={() => toggle(pm.pm_id)}
                  />
                ))}
              </ul>
            )}
            <StoreLink
              to="/shop/account/wallet"
              className="text-xs text-accent"
            >
              Manage wallet
            </StoreLink>
          </div>

          {err && (
            <ErrorState title="The tender split could not be worked out">
              {err}
            </ErrorState>
          )}
          {blocking.map((r, i) => (
            <p
              key={`b${i}`}
              data-testid="tender-refusal"
              data-blocking="true"
              role="alert"
              className="m-0 flex items-start gap-1.5 rounded-lg border border-bad/40 border-l-4 border-l-bad bg-bad-soft px-3 py-2 text-sm text-bad"
            >
              <AlertTriangle className="mt-0.5 size-4 flex-none" aria-hidden />
              <span>
                <span className="font-semibold">Blocking:</span> {r.message}
              </span>
            </p>
          ))}
          {advisory.map((r, i) => (
            <p
              key={`a${i}`}
              data-testid="tender-refusal"
              data-blocking="false"
              className="m-0 flex items-start gap-1.5 rounded-lg border border-warn/40 border-l-4 border-l-warn bg-warn-soft px-3 py-2 text-sm text-warn"
            >
              <AlertTriangle className="mt-0.5 size-4 flex-none" aria-hidden />
              <span>
                <span className="font-semibold">Note:</span> {r.message}
              </span>
            </p>
          ))}
          <ServiceNotice services={tender?.services} />
          {tender && <TenderPlanTable t={tender} />}
        </>
      )}
    </section>
  );
}

function AuthChecks({ checks }: { checks: Record<string, boolean> }) {
  return (
    <ul className="m-0 flex flex-wrap gap-1.5 p-0">
      {Object.entries(checks).map(([k, v]) => (
        <li key={k} className="list-none">
          <Badge size="sm" tone={v ? "ok" : "bad"}>
            {v ? <CheckCircle2 aria-hidden /> : <XCircle aria-hidden />}
            {k.replace(/_/g, " ")}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export function Component() {
  const s = useSession();
  const [reval, setReval] = useState<Revalidation | null>(null);
  const [revalErr, setRevalErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [cap, setCap] = useState<string>("");
  const [mandate, setMandate] = useState<{
    mandate: Record<string, any>;
    signature: string | { alg?: string; kid?: string; value?: string };
    status: string;
  } | null>(null);
  const [mErr, setMErr] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [decided, setDecided] = useState<"approved" | "rejected" | null>(null);
  const [busy, setBusy] = useState(false);
  /* B16 payment step */
  const navigate = useNavigate();
  const href = useViewHref();
  const [addressId, setAddressId] = useState<string | null>(null);
  const [pmIds, setPmIds] = useState<string[]>([]);
  const [tender, setTender] = useState<TenderPreview | null>(null);
  const [auth, setAuth] = useState<AuthResult | null>(null);
  const [stepUp, setStepUp] = useState<StepUp | null>(null);
  const [stepUpMsg, setStepUpMsg] = useState<string | null>(null);
  const [stepUpLeft, setStepUpLeft] = useState<number | null>(null);
  const [code, setCode] = useState("");

  const revalidate = async () => {
    setChecking(true);
    setRevalErr(null);
    try {
      const r = await shop.revalidate();
      setReval(r.revalidation);
    } catch (e) {
      setRevalErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void revalidate();
  }, []);
  useEffect(() => {
    if (!cap && s) setCap(String(Math.ceil(s.budget ?? s.cart.total)));
  }, [s, cap]);

  // Resume a pending mandate already on the session (e.g. created by Compass in chat or before a
  // reload). The session view carries only the signature VALUE, so a mandate this page created must
  // never be replaced by it: that would drop the alg and kid the shopper is shown.
  const createdHere = useRef<string | null>(null);
  useEffect(() => {
    const m = s?.mandate;
    if (mandate || createdHere.current || !m) return;
    if (
      m.status === "pending_approval" ||
      m.status === "pending_human_approval"
    )
      setMandate({
        mandate: m,
        signature: m.signature ?? "",
        status: m.status,
      });
  }, [s?.mandate, mandate]);

  const swap = async (from: string, to: string, qty: number) => {
    setBusy(true);
    try {
      await shop.remove(from);
      await shop.addToCart(to, qty);
      await revalidate();
    } catch (e) {
      setRevalErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const total = s?.cart.total ?? 0;
  const capN = Number(cap);
  const mid = mandate?.mandate?.mandate_id as string | undefined;
  const hasAccount = Boolean(s?.account);
  const blockingRefusals = (tender?.refusals ?? []).filter((r) => r.blocking);
  // With an account the payment step must reach a complete, unrefused plan before a mandate is signed.
  // A guest keeps today's behaviour: no tender, no address, mandate straight from the cart.
  const tenderReady =
    !hasAccount ||
    Boolean(
      tender && tender.ok && tender.plan.length > 0 && !blockingRefusals.length,
    );
  const namesTender = hasAccount && Boolean(tender && tender.plan.length);

  /** Reset every payment artefact: a dead mandate must not leave a stale result on screen. */
  const resetAuth = () => {
    setAuth(null);
    setStepUp(null);
    setStepUpMsg(null);
    setStepUpLeft(null);
    setCode("");
  };

  const goToOrder = (o: Order) => {
    setOrder(o);
    navigate(href(`/shop/order/${encodeURIComponent(o.order_id)}`));
  };

  /**
   * Approve, then record a simulated authorisation, then confirm.
   *
   * The live contract refuses the order until a successful simulated authorisation exists for the
   * mandate, and refuses the authorisation until the shopper has approved it, so the approval is
   * recorded first (`recordApproval`) and the order is confirmed afterwards.
   */
  const approve = async () => {
    if (!mid) return;
    setBusy(true);
    setMErr(null);
    resetAuth();
    try {
      if (!namesTender) {
        const r = await shop.decide(mid, true);
        setDecided("approved");
        if (r.order) goToOrder(r.order);
        return;
      }
      await recordApproval(mid);
      setDecided("approved");
      const a = await accounts.authorize(mid);
      setAuth(a);
      if (a.decision === "approved") {
        goToOrder(await confirmOrder(mid));
      } else if (a.decision === "step_up_required" && a.step_up) {
        setStepUp(a.step_up);
        setStepUpLeft(a.step_up.max_attempts);
      }
    } catch (e) {
      setMErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verifyStepUp = async () => {
    if (!stepUp || !mid) return;
    setBusy(true);
    setStepUpMsg(null);
    try {
      const r = await accounts.stepUp(stepUp.step_up_id, code.trim());
      setStepUpMsg(r.message ?? null);
      setStepUpLeft(r.attempts_remaining);
      if (r.verified && r.authorisation) {
        setAuth({
          ...r.authorisation,
          checks: r.authorisation.checks ?? auth?.checks ?? {},
        });
        setStepUp(null);
        goToOrder(await confirmOrder(mid));
      }
    } catch (e) {
      setStepUpMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** A declined or refused authorisation kills the mandate: the shopper signs a new one. */
  const startOver = () => {
    setMandate(null);
    setDecided(null);
    setOrder(null);
    setMErr(null);
    resetAuth();
  };

  return (
    <div className="grid gap-4">
      <PageTitle>Review and approve</PageTitle>
      <p
        data-testid="no-payment-note"
        role="note"
        className="m-0 flex items-center gap-2 rounded-lg border-2 border-accent bg-accent-soft px-4 py-3 text-md font-semibold text-accent-soft-fg"
      >
        <ShieldCheck className="size-5" aria-hidden />
        No payment is taken in this environment.
      </p>
      <CouldNotDo />

      <section
        data-testid="checkout-revalidate"
        aria-labelledby="rv-h"
        className="grid gap-2 rounded-xl border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="rv-h" className="m-0 text-lg font-semibold">
            Cart check
          </h2>
          {reval && (
            <Badge tone={reval.ok ? "ok" : "bad"}>
              {reval.ok ? (
                <CheckCircle2 aria-hidden />
              ) : (
                <XCircle aria-hidden />
              )}
              {reval.ok ? "Ready" : "Needs attention"}
            </Badge>
          )}
          <Button
            size="sm"
            className="ml-auto"
            onClick={revalidate}
            disabled={checking}
          >
            {checking ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw aria-hidden />
            )}
            Re-check
          </Button>
        </div>
        {reval && (
          <p className="m-0 text-xs text-fg-muted">
            Fresh read of price and stock at{" "}
            {new Date(reval.checked_at).toLocaleTimeString()} (caches bypassed).
          </p>
        )}
        {revalErr && (
          <ErrorState title="Revalidation failed">{revalErr}</ErrorState>
        )}
        <ServiceNotice services={reval?.services} />
        {reval && (
          <ul className="m-0 grid list-none gap-2 p-0">
            {reval.lines.map((l) => (
              <li
                key={l.product_id}
                className="grid gap-1 border-b border-line py-2 text-sm"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{l.title}</span>
                  <span className="text-fg-muted">× {l.qty}</span>
                  <span className="tabular ml-auto">
                    {l.price_changed ? (
                      <>
                        <span className="text-fg-muted line-through">
                          {money(l.cart_price)}
                        </span>{" "}
                        <strong>{money(l.current_price)}</strong>
                      </>
                    ) : (
                      money(l.current_price ?? l.cart_price)
                    )}
                  </span>
                </div>
                {l.issues.map((i, k) => (
                  <p
                    key={k}
                    className={
                      i.blocking
                        ? "m-0 flex items-center gap-1.5 text-bad"
                        : "m-0 flex items-center gap-1.5 text-warn"
                    }
                  >
                    <AlertTriangle className="size-4" aria-hidden />
                    <span className="font-semibold">
                      {i.blocking ? "Blocking" : "Note"}:
                    </span>{" "}
                    {i.message}
                  </p>
                ))}
                {l.issues.some(
                  (i) =>
                    i.kind === "out_of_stock" || i.kind === "insufficient_qty",
                ) &&
                  l.substitutes?.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-fg-muted">Swap for:</span>
                      {l.substitutes.slice(0, 3).map((sub) => (
                        <Button
                          key={sub.product_id}
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            swap(l.product_id, sub.product_id, l.qty)
                          }
                        >
                          {sub.title.slice(0, 40)} ({money(sub.price)})
                        </Button>
                      ))}
                    </div>
                  )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <PaymentStep
        addressId={addressId}
        setAddressId={setAddressId}
        pmIds={pmIds}
        setPmIds={setPmIds}
        tender={tender}
        setTender={setTender}
        disabled={Boolean(mandate && !decided) || busy}
      />

      <section
        aria-labelledby="m-h"
        className="grid gap-3 rounded-xl border border-line bg-surface p-4"
      >
        <h2 id="m-h" className="m-0 text-lg font-semibold">
          Spending mandate
        </h2>
        <BudgetMeter total={total} budget={s?.budget ?? null} />
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm font-medium">
            Spend cap (USD)
            <input
              type="number"
              min={0}
              step="0.01"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className="tabular h-9 w-36 rounded-md border border-line bg-surface px-2 text-fg focus-visible:outline-2 focus-visible:outline-focus"
            />
          </label>
          <span className="text-sm">
            Cart total <strong className="tabular">{money(total)}</strong>
          </span>
          {capN < total && (
            <span className="text-sm font-medium text-bad">
              Cap is below the cart total.
            </span>
          )}
          {!tenderReady && (
            <span
              className="text-sm font-medium text-bad"
              data-testid="tender-not-ready"
            >
              Resolve the payment step first: the mandate names the instruments
              that would be authorised.
            </span>
          )}
          <Button
            variant="primary"
            disabled={
              busy ||
              !s?.cart.items.length ||
              !(capN > 0) ||
              !tenderReady ||
              Boolean(mandate && !decided)
            }
            onClick={async () => {
              setBusy(true);
              setMErr(null);
              resetAuth();
              try {
                // The tender rows and the tender_hash come straight from the preview: authorize
                // recomputes the hash and refuses a mandate signed over a different plan.
                const signed = await shop.mandate(
                  capN,
                  namesTender && tender
                    ? {
                        address_id: addressId,
                        tender: tender.plan.map((l) => ({
                          pm_id: l.pm_id,
                          amount: l.amount,
                        })),
                        tender_hash: tender.tender_hash,
                      }
                    : undefined,
                );
                createdHere.current = String(signed.mandate?.mandate_id ?? "");
                setMandate(signed);
                setDecided(null);
                setOrder(null);
              } catch (e) {
                if (e instanceof ApiError && e.body?.revalidation)
                  setReval(e.body.revalidation);
                setMErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create signed mandate
          </Button>
        </div>
        {mErr && <ErrorState title="Mandate not created">{mErr}</ErrorState>}
        {mandate && (
          <div className="grid gap-2 rounded-lg border border-line bg-surface-sunken p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{mid}</span>
              <Badge
                tone={
                  decided === "approved"
                    ? "ok"
                    : decided === "rejected"
                      ? "bad"
                      : "warn"
                }
              >
                {decided ?? mandate.status}
              </Badge>
              <span className="tabular ml-auto text-xs text-fg-muted">
                cap {money(Number(mandate.mandate.spend_cap ?? capN))}
              </span>
            </div>
            <div className="grid gap-1">
              <span className="text-xs font-semibold text-fg-muted">
                Signature
              </span>
              <code
                data-testid="mandate-signature"
                className="block rounded-md bg-code-bg px-2 py-1.5 text-xs break-all text-code-fg"
              >
                {typeof mandate.signature === "string"
                  ? mandate.signature
                  : `${mandate.signature?.alg ?? ""} kid=${mandate.signature?.kid ?? ""} ${mandate.signature?.value ?? ""}`}
              </code>
            </div>
            {namesTender && tender && (
              <div className="grid gap-1">
                <span className="text-xs font-semibold text-fg-muted">
                  Tender signed into this mandate
                </span>
                <ul className="m-0 grid list-none gap-0.5 p-0 text-xs">
                  {tender.plan.map((l) => (
                    <li key={l.pm_id} className="flex gap-2">
                      <span className="font-medium">
                        {l.display ?? l.pm_id}
                      </span>
                      <span className="tabular ml-auto">{money(l.amount)}</span>
                    </li>
                  ))}
                </ul>
                <p className="m-0 text-xs text-fg-muted">
                  Approving names these instruments for a simulated
                  authorisation. No payment is executed at any point.
                </p>
              </div>
            )}
            {!decided && (
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={busy} onClick={approve}>
                  <CheckCircle2 aria-hidden />
                  Approve and place order
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await shop.decide(mid!, false);
                      setDecided("rejected");
                    } catch (e) {
                      setMErr((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <XCircle aria-hidden />
                  Reject
                </Button>
              </div>
            )}
          </div>
        )}
        {stepUp && (
          <div
            data-testid="step-up-challenge"
            role="group"
            aria-labelledby="su-h"
            className="grid gap-2 rounded-lg border-2 border-warn bg-warn-soft px-3 py-2.5 text-sm"
          >
            <h3
              id="su-h"
              className="m-0 flex items-center gap-2 text-md font-semibold text-warn"
            >
              <AlertTriangle className="size-4" aria-hidden />
              Verification needed before the simulated authorisation
            </h3>
            <p className="m-0 text-fg-muted">
              {auth?.message ??
                "The demo issuer asked for a verification step."}
            </p>
            {stepUp.prompt && <p className="m-0">{stepUp.prompt}</p>}
            {stepUp.demo_code_note && (
              <p className="m-0 text-xs text-fg-muted">
                {stepUp.demo_code_note}
              </p>
            )}
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void verifyStepUp();
              }}
            >
              <label className="grid gap-1 font-medium">
                Verification code
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  data-testid="step-up-code"
                  className="tabular h-9 w-28 rounded-md border border-line bg-surface px-2 text-fg focus-visible:outline-2 focus-visible:outline-focus"
                />
              </label>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !code.trim()}
                data-testid="step-up-submit"
              >
                Verify and continue
              </Button>
              {stepUpLeft != null && (
                <span
                  className="text-xs text-fg-muted"
                  data-testid="step-up-attempts"
                >
                  {stepUpLeft} attempt(s) remaining
                </span>
              )}
            </form>
            {stepUpMsg && (
              <p
                role="status"
                className="m-0 font-medium"
                data-testid="step-up-message"
              >
                {stepUpMsg}
              </p>
            )}
          </div>
        )}

        {auth && !order && (
          <div
            data-testid="auth-result"
            data-decision={auth.decision}
            role="status"
            className={cn(
              "grid gap-2 rounded-lg border px-3 py-2.5 text-sm",
              auth.decision === "approved"
                ? "border-ok/40 bg-ok-soft"
                : auth.decision === "step_up_required"
                  ? "border-warn/40 bg-warn-soft"
                  : "border-bad/40 bg-bad-soft",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Simulated authorisation</span>
              <Badge
                tone={
                  auth.decision === "approved"
                    ? "ok"
                    : auth.decision === "step_up_required"
                      ? "warn"
                      : "bad"
                }
              >
                {auth.decision.replace(/_/g, " ")}
              </Badge>
              <Badge>payment executed: no</Badge>
              {auth.reason && (
                <span className="text-xs text-fg-muted">
                  reason: {auth.reason}
                </span>
              )}
            </div>
            {auth.message && <p className="m-0">{auth.message}</p>}
            {auth.auth_ref && (
              <code
                data-testid="auth-ref"
                className="block rounded-md bg-code-bg px-2 py-1.5 text-xs break-all text-code-fg"
              >
                {auth.auth_ref}
              </code>
            )}
            <AuthChecks checks={auth.checks ?? {}} />
            {(auth.decision === "declined" || auth.decision === "refused") && (
              <>
                <p
                  className="m-0 font-semibold text-bad"
                  data-testid="auth-declined-note"
                >
                  No order was created, and this mandate is dead. Pick another
                  payment instrument and sign a new mandate.
                </p>
                <Button
                  className="justify-self-start"
                  data-testid="auth-start-over"
                  onClick={startOver}
                >
                  Pick another instrument and sign again
                </Button>
              </>
            )}
            {auth.synthetic_label && (
              <p className="m-0 flex items-start gap-1.5 text-xs text-fg-muted">
                <Info className="mt-0.5 size-3.5 flex-none" aria-hidden />
                <span>{auth.synthetic_label}</span>
              </p>
            )}
          </div>
        )}

        {order && (
          <div
            role="status"
            className="grid gap-1 rounded-lg border border-ok/40 bg-ok-soft px-3 py-2 text-sm"
          >
            <span className="flex items-center gap-2 font-semibold text-ok">
              <CheckCircle2 className="size-4" aria-hidden />
              Order {order.order_id} placed ({money(order.total)}). Payment
              executed: no.
            </span>
            <StoreLink
              to={`/shop/order/${encodeURIComponent(order.order_id)}`}
              className="text-accent"
            >
              View this order
            </StoreLink>
            <StoreLink to="/shop/orders" className="text-accent">
              View orders
            </StoreLink>
          </div>
        )}
      </section>
    </div>
  );
}
