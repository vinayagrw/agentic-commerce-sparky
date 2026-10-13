/** Orders, stores, lists and help pages (small; one module, exported as separate lazy routes). */
import { useState } from "react";
import { useSearchParams } from "react-router";
import { ListChecks, Package, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/states";
import { accounts, normaliseLists, shop } from "../session";
import { FULFILMENT_LABEL } from "../types";
import { PageTitle, StoreLink, money, useAsync, useSession } from "../ui";
import { TenderRows } from "./OrderPage";
import { HelpAnswerView } from "./SearchPage";

/**
 * B16: rows link to the confirmation route and carry a tender summary and a fulfilment badge. The
 * scope filter uses the account_id each order records; the bff exposes orders per SESSION, so
 * "All of this shopper's orders" means every order in this session filed under the bound persona.
 */
export function OrdersPage() {
  const s = useSession();
  const [scope, setScope] = useState<"session" | "account">("session");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const res = useAsync(() => shop.orders(), [s?.session_id, s?.version]);
  const wallet = useAsync(
    () => (s?.account ? accounts.wallet() : Promise.resolve(null)),
    [s?.account?.account_id],
  );
  const all = res.data?.orders ?? [];
  const aid = s?.account?.account_id ?? null;
  const orders =
    scope === "account" && aid ? all.filter((o) => o.account_id === aid) : all;
  const pms = wallet.data?.payment_methods ?? [];

  const reorder = async (orderId: string) => {
    setBusy(orderId);
    setErr(null);
    setNote(null);
    try {
      await shop.reorder();
      setNote(
        "Your usual items are proposed in chat: approve each one to add it to the cart.",
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4">
      <PageTitle
        aside={
          <div
            role="radiogroup"
            aria-label="Which orders to show"
            data-testid="orders-scope"
            className="inline-flex items-center gap-0.5 rounded-full border border-line bg-surface-sunken p-0.5"
          >
            {(
              [
                ["session", "This session"],
                [
                  "account",
                  aid ? `All of ${s?.account?.name}'s orders` : "This shopper",
                ],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={scope === v}
                disabled={v === "account" && !aid}
                data-testid={`orders-scope-${v}`}
                onClick={() => setScope(v)}
                className={cn(
                  "inline-flex h-7 items-center rounded-full px-2.5 text-sm font-medium disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-focus",
                  scope === v
                    ? "bg-surface text-fg shadow-sm"
                    : "text-fg-muted hover:text-fg",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        Orders
      </PageTitle>
      <p className="m-0 text-xs text-fg-muted">
        Demo orders. No payment is taken, so there is nothing to settle or
        refund. Order history is kept per session: switching shopper does not
        hide the orders this session already placed.
      </p>
      {res.error && (
        <ErrorState title="Orders unavailable">{res.error}</ErrorState>
      )}
      {err && <ErrorState title="Reorder failed">{err}</ErrorState>}
      {note && (
        <p
          role="status"
          className="m-0 rounded-lg border border-ok/40 bg-ok-soft px-3 py-2 text-sm"
          data-testid="reorder-note"
        >
          {note}
        </p>
      )}
      {!res.error && orders.length === 0 && (
        <EmptyState icon={Package}>
          {res.loading
            ? "Loading orders…"
            : scope === "account" && aid
              ? `No orders in this session for ${s?.account?.name}.`
              : "No orders yet. Approve a mandate at checkout to create one."}
        </EmptyState>
      )}
      <ul className="m-0 grid list-none gap-3 p-0">
        {orders.map((o) => (
          <li
            key={o.order_id}
            data-testid="order-row"
            className="grid gap-2 rounded-xl border border-line bg-surface p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <StoreLink
                to={`/shop/order/${encodeURIComponent(o.order_id)}`}
                className="font-mono text-sm font-semibold text-fg"
                data-testid="order-link"
              >
                {o.order_id}
              </StoreLink>
              <Badge
                tone={o.status === "picked_up" ? "ok" : "info"}
                data-testid="order-fulfilment-badge"
              >
                {FULFILMENT_LABEL[o.status] ?? o.status}
              </Badge>
              <Badge>
                payment executed: {o.payment_executed ? "yes" : "no"}
              </Badge>
              {o.account_id && <Badge size="sm">{o.account_id}</Badge>}
              <span className="ml-auto text-xs text-fg-muted">
                {new Date(o.created_at).toLocaleString()} · store #{o.store_id}
              </span>
            </div>
            <ul className="m-0 grid gap-0.5 pl-5 text-sm">
              {o.lines.map((l) => (
                <li key={l.product_id}>
                  {l.title} × {l.qty}{" "}
                  <span className="tabular text-fg-muted">
                    {money(l.line_total ?? l.price * l.qty)}
                  </span>
                </li>
              ))}
            </ul>
            {o.payment?.tender?.length ? (
              <div className="grid gap-0.5" data-testid="order-tender-summary">
                <span className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">
                  Tender{o.payment.split_tender ? " (split)" : ""}
                </span>
                <TenderRows
                  legs={o.payment.tender}
                  wallet={pms}
                  testid="order-row-tender"
                />
              </div>
            ) : (
              <span
                className="text-xs text-fg-muted"
                data-testid="order-tender-summary"
              >
                No tender was named on this order (guest checkout).
              </span>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular font-semibold">
                Total {money(o.total)}
              </span>
              {o.auth_ref && (
                <code className="rounded-sm bg-code-bg px-1.5 py-0.5 text-xs text-code-fg">
                  {o.auth_ref}
                </code>
              )}
              <Button
                size="sm"
                className="ml-auto"
                disabled={busy === o.order_id}
                data-testid="order-reorder"
                aria-label={`Reorder my usual items, from order ${o.order_id}`}
                onClick={() => reorder(o.order_id)}
              >
                <RotateCcw aria-hidden />
                Reorder
              </Button>
              <StoreLink
                to={`/shop/order/${encodeURIComponent(o.order_id)}`}
                className="text-sm text-accent"
              >
                Confirmation
              </StoreLink>
            </div>
            <span className="text-xs text-fg-muted">
              Mandate {o.mandate_id}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StoresPage() {
  const s = useSession();
  const res = useAsync(() => shop.stores(), []);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      <PageTitle>Stores</PageTitle>
      <p className="m-0 text-sm text-fg-muted">
        Synthetic stores. The selected store drives price, stock and pickup ETA.
      </p>
      {(res.error || err) && (
        <ErrorState title="Store service error">{res.error ?? err}</ErrorState>
      )}
      <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-3">
        {(res.data?.stores ?? []).map((st) => {
          const sel = st.store_id === s?.store_id;
          return (
            <li
              key={st.store_id}
              className={
                sel
                  ? "grid gap-1 rounded-xl border-2 border-accent bg-surface p-4"
                  : "grid gap-1 rounded-xl border border-line bg-surface p-4"
              }
            >
              <span className="font-semibold">{st.name}</span>
              <span className="text-sm text-fg-muted">
                #{st.store_id} · {st.city}, {st.region}
              </span>
              <span className="text-xs text-fg-muted">{st.hours}</span>
              {sel ? (
                <Badge tone="accent" className="justify-self-start">
                  Selected store
                </Badge>
              ) : (
                <Button
                  size="sm"
                  className="justify-self-start"
                  onClick={() =>
                    shop.setStore(st.store_id).catch((e) => setErr(e.message))
                  }
                >
                  Make this my store
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ListsPage() {
  const s = useSession();
  const [tick, setTick] = useState(0);
  const res = useAsync(() => shop.lists(), [tick, s?.session_id]);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const lists = res.data ? normaliseLists(res.data) : [];
  const missions = lists.filter((l) => l.kind === "mission");
  const saved = lists.filter((l) => l.kind !== "mission");
  const render = (ls: typeof lists) =>
    ls.map((l) => (
      <li
        key={l.name}
        className="grid gap-2 rounded-xl border border-line bg-surface p-4"
      >
        <h3 className="m-0 text-md font-semibold">
          {l.name}{" "}
          <span className="tabular text-xs font-normal text-fg-muted">
            {l.items.length} items
          </span>
        </h3>
        {l.items.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">Empty.</p>
        ) : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {l.items.map((it) => (
              <li
                key={it.product_id}
                className="flex items-center gap-2 text-sm"
              >
                <StoreLink
                  to={`/shop/p/${encodeURIComponent(it.product_id)}`}
                  className="min-w-0 flex-1 truncate text-fg"
                >
                  {it.title ?? it.product_id}
                </StoreLink>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Add ${it.title ?? it.product_id} to cart`}
                  onClick={() =>
                    shop
                      .addToCart(it.product_id)
                      .catch((e) => setErr(e.message))
                  }
                >
                  Add to cart
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${it.title ?? it.product_id} from ${l.name}`}
                  onClick={() =>
                    shop
                      .removeFromList(l.name, it.product_id)
                      .then(() => setTick((t) => t + 1))
                      .catch((e) => setErr(e.message))
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </li>
    ));
  return (
    <div className="grid gap-4">
      <PageTitle>Lists and missions</PageTitle>
      {(res.error || err) && (
        <ErrorState title="Lists error">{res.error ?? err}</ErrorState>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          try {
            await shop.createList(name.trim());
            setName("");
            setTick((t) => t + 1);
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      >
        <label className="grid gap-1 text-sm font-medium">
          New list name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 rounded-md border border-line bg-surface px-2 text-fg focus-visible:outline-2 focus-visible:outline-focus"
          />
        </label>
        <Button type="submit">Create list</Button>
      </form>
      {lists.length === 0 && !res.loading && (
        <EmptyState icon={ListChecks}>No lists yet.</EmptyState>
      )}
      {missions.length > 0 && (
        <section aria-labelledby="mis-h" className="grid gap-2">
          <h2 id="mis-h" className="m-0 text-lg font-semibold">
            Missions
          </h2>
          <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2">
            {render(missions)}
          </ul>
        </section>
      )}
      {saved.length > 0 && (
        <section aria-labelledby="sav-h" className="grid gap-2">
          <h2 id="sav-h" className="m-0 text-lg font-semibold">
            Saved lists
          </h2>
          <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2">
            {render(saved)}
          </ul>
        </section>
      )}
    </div>
  );
}

export function HelpPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const lang = params.get("lang") ?? "en";
  const [draft, setDraft] = useState(q);
  const res = useAsync(
    () => (q ? shop.help(q, lang) : Promise.resolve(null)),
    [q, lang],
  );
  return (
    <div className="grid gap-4">
      <PageTitle>Help</PageTitle>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setParams((p) => {
            const n = new URLSearchParams(p);
            n.set("q", draft);
            return n;
          });
        }}
      >
        <label className="grid min-w-64 flex-1 gap-1 text-sm font-medium">
          Ask a question (returns, pickup, SNAP, store hours…)
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-9 rounded-md border border-line bg-surface px-2 text-fg focus-visible:outline-2 focus-visible:outline-focus"
          />
        </label>
        <Button type="submit" variant="primary">
          Get answer
        </Button>
      </form>
      {res.error && (
        <ErrorState title="Help service unavailable">{res.error}</ErrorState>
      )}
      {res.data && <HelpAnswerView help={res.data} />}
      <p className="m-0 text-xs text-fg-muted">
        Help answers come from a demo corpus written for this environment, not
        any real retailer's policy.
      </p>
    </div>
  );
}

export const Component = OrdersPage;
