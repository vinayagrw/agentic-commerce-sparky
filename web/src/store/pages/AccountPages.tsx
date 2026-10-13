/**
 * B16 shopper account surfaces: profile, wallet and addresses.
 *
 * Every payment instrument here is a demo instrument whose outcome is DELIBERATE and is shown as a
 * badge on its row, so nothing a shopper picks at checkout can surprise them. The card form accepts
 * only the networks' published test numbers: the number is forwarded once, never stored and never
 * echoed back, and a rejection renders the API's own error plus the accepted list.
 *
 * Preferences are not re-implemented here: the profile renders the SAME B11 constraint chips and the
 * same `session.memory` rows the chat's memory panel writes.
 */
import { useState } from "react";
import {
  CreditCard,
  Home,
  Info,
  Package,
  ShieldAlert,
  Star,
  Trash2,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  ErrorState,
  PanelSkeleton,
  SectionLabel,
} from "@/components/states";
import { ApiError, accounts } from "../session";
import type {
  Address,
  MemoryItem,
  PaymentMethod,
  PmKind,
  TestCard,
} from "../types";
import { OUTCOME_BADGE, PM_KIND_LABEL } from "../types";
import {
  ConstraintChips,
  PageTitle,
  StoreLink,
  money,
  useAsync,
  useSession,
} from "../ui";

/* ---------------- shared ---------------- */

/** The API's own synthetic wording for a payload. Always rendered verbatim, never paraphrased. */
function ApiLabel({
  text,
  testid,
}: {
  text: string | null | undefined;
  testid?: string;
}) {
  if (!text) return null;
  return (
    <p
      data-testid={testid ?? "synthetic-label"}
      className="m-0 flex items-start gap-1.5 text-xs text-fg-muted"
    >
      <Info className="mt-0.5 size-3.5 flex-none" aria-hidden />
      <span>{text}</span>
    </p>
  );
}

/** A guest session has no account: every account surface says so and offers the switcher. */
function GuestNotice() {
  return (
    <EmptyState icon={Wallet}>
      This is a guest session: there is no account, no stored wallet and no
      saved address. Pick a synthetic shopper from “Shopping as” in the header
      to see them.
    </EmptyState>
  );
}

/** The deliberate outcome baked into a demo instrument, so it is never a surprise at checkout. */
export function OutcomeBadge({ pm }: { pm: PaymentMethod }) {
  const meta = OUTCOME_BADGE[pm.outcome];
  if (!meta) return null;
  const text =
    pm.kind === "ebt_snap" || pm.kind === "gift"
      ? `demo balance: ${pm.outcome === "approved" ? "approves" : pm.outcome}`
      : meta.text;
  return (
    <Badge tone={meta.tone} size="sm" data-testid="pm-outcome">
      {text}
    </Badge>
  );
}

function expiry(pm: PaymentMethod) {
  if (!pm.exp_month || !pm.exp_year) return null;
  return `${String(pm.exp_month).padStart(2, "0")}/${pm.exp_year}`;
}

/* ---------------- /shop/account ---------------- */

const MEM_LABEL: Record<string, string> = {
  dietary: "Dietary",
  brands: "Brands",
  store: "Home store",
  household_size: "Household size",
};

export function AccountPage() {
  const s = useSession();
  const acct = s?.account ?? null;
  const res = useAsync(() => accounts.list(), []);
  const persona =
    res.data?.accounts.find((a) => a.account_id === acct?.account_id) ?? null;
  const mem: MemoryItem[] = (s?.memory ?? []).filter(
    (m) => m.status === "confirmed",
  );

  return (
    <div className="grid gap-4">
      <PageTitle>Account</PageTitle>
      <ApiLabel
        text={res.data?.synthetic_label}
        testid="account-synthetic-label"
      />
      {res.error && (
        <ErrorState title="Shopper accounts unavailable">
          {res.error}
        </ErrorState>
      )}
      {!acct ? (
        <GuestNotice />
      ) : (
        <section
          data-testid="account-identity"
          aria-labelledby="ai-h"
          className="grid gap-2 rounded-xl border border-line bg-surface p-4"
        >
          <h2 id="ai-h" className="m-0 text-lg font-semibold">
            {acct.name}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">{acct.account_id}</Badge>
            <Badge>synthetic shopper</Badge>
            {persona?.email && (
              <span className="text-sm text-fg-muted">{persona.email}</span>
            )}
          </div>
          {(acct.tagline || persona?.label) && (
            <p className="m-0 text-sm text-fg-muted">
              {acct.tagline ?? persona?.label}
            </p>
          )}
          <ApiLabel text={persona?.synthetic_label} />
        </section>
      )}

      <section
        aria-labelledby="ap-h"
        className="grid gap-3 rounded-xl border border-line bg-surface p-4"
      >
        <h2 id="ap-h" className="m-0 text-lg font-semibold">
          Preferences
        </h2>
        <p className="m-0 text-sm text-fg-muted">
          Choosing a shopper applies that shopper's stored preferences as the
          same constraint chips and the same remembered facts the assistant
          uses. There is no second preference store.
        </p>
        <ConstraintChips label="Constraints from these preferences" />
        {mem.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">Nothing remembered yet.</p>
        ) : (
          <div className="grid gap-1" data-testid="account-memory">
            <SectionLabel>What Compass remembers</SectionLabel>
            <ul className="m-0 grid list-none gap-1 p-0">
              {mem.map((m) => (
                <li
                  key={m.id}
                  data-testid="account-memory-item"
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <span className="text-fg-muted">
                    {MEM_LABEL[m.key] ?? m.key}
                  </span>
                  <span className="font-medium">{m.value}</span>
                  <Badge size="sm" tone={m.origin === "stated" ? "ok" : "warn"}>
                    {m.origin}
                  </Badge>
                  <span className="text-xs text-fg-muted">from {m.source}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <nav aria-label="Account sections" className="grid gap-3 sm:grid-cols-3">
        {[
          {
            to: "/shop/account/wallet",
            label: "Wallet",
            icon: CreditCard,
            note: "Demo payment instruments and their deliberate outcomes",
          },
          {
            to: "/shop/account/addresses",
            label: "Addresses",
            icon: Home,
            note: "Synthetic pickup addresses",
          },
          {
            to: "/shop/orders",
            label: "Orders",
            icon: Package,
            note: "Past demo orders and fulfilment progress",
          },
        ].map(({ to, label, icon: Icon, note }) => (
          <StoreLink
            key={to}
            to={to}
            className="grid gap-1 rounded-xl border border-line bg-surface p-4 text-fg no-underline hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span className="flex items-center gap-2 font-semibold">
              <Icon className="size-4 text-accent" aria-hidden />
              {label}
            </span>
            <span className="text-sm text-fg-muted">{note}</span>
          </StoreLink>
        ))}
      </nav>
    </div>
  );
}

/* ---------------- /shop/account/wallet ---------------- */

const TEST_CARD_WARNING =
  "Never enter a real card number. This demo accepts only the card networks' published test numbers, listed below; anything else is refused. No payment is ever taken.";

function AddCardForm({ onDone }: { onDone: () => void }) {
  const cards = useAsync(() => accounts.testCards(), []);
  const [kind, setKind] = useState<PmKind>("credit");
  const [number, setNumber] = useState("");
  const [nickname, setNickname] = useState("");
  const [balance, setBalance] = useState("25");
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{
    error: string;
    accepted: TestCard[];
  } | null>(null);
  const isTender = kind === "ebt_snap" || kind === "gift";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await accounts.addCard({
        kind,
        ...(isTender
          ? { balance: Number(balance) }
          : { number: number.replace(/\s+/g, "") }),
        nickname: nickname.trim() || undefined,
        is_default: isDefault,
      });
      setNumber("");
      setNickname("");
      onDone();
    } catch (x) {
      if (x instanceof ApiError && x.status === 422)
        setErr({
          error: String(x.body?.error ?? x.message),
          accepted: (x.body?.accepted ?? []) as TestCard[],
        });
      else setErr({ error: (x as Error).message, accepted: [] });
    } finally {
      setBusy(false);
    }
  };

  const accepted = err?.accepted.length
    ? err.accepted
    : (cards.data?.cards ?? []);
  const forKind = accepted.filter((c) => c.kind === kind);

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 rounded-xl border border-line bg-surface p-4"
      aria-labelledby="add-pm-h"
      data-testid="add-card-form"
    >
      <h2 id="add-pm-h" className="m-0 text-lg font-semibold">
        Add a demo payment instrument
      </h2>
      <p
        role="note"
        data-testid="test-card-warning"
        className="m-0 flex items-start gap-2 rounded-lg border-2 border-warn bg-warn-soft px-3 py-2.5 text-sm font-semibold text-warn"
      >
        <ShieldAlert className="mt-0.5 size-5 flex-none" aria-hidden />
        <span>{TEST_CARD_WARNING}</span>
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm font-medium">
          Kind
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as PmKind)}
            className="h-9 rounded-md border border-line bg-surface px-2 text-fg focus-visible:outline-2 focus-visible:outline-focus"
            data-testid="add-card-kind"
          >
            {(["credit", "debit", "ebt_snap", "gift"] as PmKind[]).map((k) => (
              <option key={k} value={k}>
                {PM_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        {isTender ? (
          <label className="grid gap-1 text-sm font-medium">
            Demo balance (USD)
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              autoComplete="off"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              data-testid="add-card-balance"
              className="tabular h-9 w-32 rounded-md border border-line bg-surface px-2 text-fg focus-visible:outline-2 focus-visible:outline-focus"
            />
          </label>
        ) : (
          <label className="grid gap-1 text-sm font-medium">
            Published test card number
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              name="test-card-number"
              placeholder="4242424242424242"
              aria-describedby="test-card-warning-desc"
              data-testid="add-card-number"
              className="tabular h-9 w-56 rounded-md border border-line bg-surface px-2 text-fg focus-visible:outline-2 focus-visible:outline-focus"
            />
          </label>
        )}
        <label className="grid gap-1 text-sm font-medium">
          Label
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            autoComplete="off"
            data-testid="add-card-nickname"
            className="h-9 w-40 rounded-md border border-line bg-surface px-2 text-fg focus-visible:outline-2 focus-visible:outline-focus"
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm font-medium">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="size-4"
          />
          Make it the default
        </label>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || (!isTender && !number.trim())}
        >
          Add to wallet
        </Button>
      </div>
      <p id="test-card-warning-desc" className="sr-only">
        Only the published test numbers listed on this page are accepted. Never
        type a real card number.
      </p>
      {err && (
        <ErrorState title="That instrument was not added">
          <p className="m-0" data-testid="add-card-error">
            {err.error}
          </p>
          {err.accepted.length > 0 && (
            <ul
              className="m-0 mt-1 grid list-none gap-0.5 p-0"
              data-testid="add-card-accepted"
            >
              {err.accepted.map((c) => (
                <li key={c.number} className="tabular text-xs">
                  {c.number} — {c.brand} {c.kind}, outcome {c.outcome}
                </li>
              ))}
            </ul>
          )}
        </ErrorState>
      )}
      {cards.error && (
        <ErrorState title="Test-card list unavailable">
          {cards.error}
        </ErrorState>
      )}
      {!isTender && forKind.length > 0 && (
        <div className="grid gap-1.5">
          <SectionLabel>Accepted test cards (click to fill)</SectionLabel>
          <ul
            className="m-0 grid list-none gap-1.5 p-0"
            data-testid="test-card-list"
          >
            {forKind.map((c) => (
              <li
                key={c.number}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <Button
                  size="xs"
                  type="button"
                  data-testid="test-card-fill"
                  aria-label={`Use test card ${c.number}, ${c.brand} ${c.kind}, which ${c.outcome}`}
                  onClick={() => setNumber(c.number)}
                >
                  <span className="tabular">{c.number}</span>
                </Button>
                <span className="text-fg-muted">
                  {c.brand} {c.kind}
                </span>
                <Badge
                  size="sm"
                  tone={
                    c.outcome === "approved"
                      ? "ok"
                      : c.outcome === "step_up"
                        ? "warn"
                        : "bad"
                  }
                >
                  {c.outcome}
                </Badge>
                {c.balance != null && (
                  <span className="tabular text-xs text-fg-muted">
                    balance {money(c.balance)}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <ApiLabel text={forKind[0]?.label} />
          <ApiLabel text={cards.data?.note} />
        </div>
      )}
      {isTender && (
        <ApiLabel
          text={cards.data?.tenders.find((t) => t.kind === kind)?.label}
        />
      )}
    </form>
  );
}

function WalletRow({
  pm,
  count,
  reload,
}: {
  pm: PaymentMethod;
  count: number;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [nickname, setNickname] = useState("");
  const [balance, setBalance] = useState(String(pm.balance ?? ""));
  const isTender = pm.kind === "ebt_snap" || pm.kind === "gift";

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      reload();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      data-testid="wallet-row"
      data-pm={pm.pm_id}
      className="grid gap-2 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{pm.display}</span>
        <Badge size="sm">{PM_KIND_LABEL[pm.kind] ?? pm.kind}</Badge>
        <OutcomeBadge pm={pm} />
        {pm.is_default && (
          <Badge tone="accent" size="sm" data-testid="wallet-default">
            <Star aria-hidden />
            Default
          </Badge>
        )}
        {expiry(pm) && (
          <span className="tabular text-xs text-fg-muted">
            expires {expiry(pm)}
          </span>
        )}
        {pm.balance != null && (
          <span className="tabular text-xs text-fg-muted">
            balance {money(pm.balance)}
          </span>
        )}
      </div>
      <ApiLabel text={pm.label} />
      <ApiLabel text={pm.synthetic_label} />
      {edit ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await run(() =>
                accounts.updateCard(pm.pm_id, {
                  nickname: nickname.trim(),
                  ...(isTender && balance !== ""
                    ? { balance: Number(balance) }
                    : {}),
                }),
              )
            )
              setEdit(false);
          }}
        >
          <label className="grid gap-1 text-sm font-medium">
            Label
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              autoComplete="off"
              data-testid="wallet-edit-nickname"
              className="h-8 w-44 rounded-md border border-line bg-surface px-2 text-fg focus-visible:outline-2 focus-visible:outline-focus"
            />
          </label>
          {isTender && (
            <label className="grid gap-1 text-sm font-medium">
              Demo balance (USD)
              <input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                autoComplete="off"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                data-testid="wallet-edit-balance"
                className="tabular h-8 w-28 rounded-md border border-line bg-surface px-2 text-fg focus-visible:outline-2 focus-visible:outline-focus"
              />
            </label>
          )}
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            Save
          </Button>
          <Button type="button" size="sm" onClick={() => setEdit(false)}>
            Cancel
          </Button>
          <p className="m-0 w-full text-xs text-fg-muted">
            A stored instrument has no number to edit: this demo never holds
            one. The expiry comes from the published test card and cannot be
            changed.
          </p>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy}
            data-testid="wallet-edit"
            aria-label={`Edit ${pm.display}`}
            onClick={() => setEdit(true)}
          >
            Edit label
          </Button>
          {!pm.is_default && (
            <Button
              size="sm"
              disabled={busy}
              data-testid="wallet-make-default"
              aria-label={`Make ${pm.display} the default`}
              onClick={() => run(() => accounts.defaultCard(pm.pm_id))}
            >
              Make default
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || count <= 1}
            data-testid="wallet-remove"
            aria-label={`Remove ${pm.display} from the wallet`}
            title={
              count <= 1
                ? "The wallet keeps at least one instrument."
                : undefined
            }
            onClick={() => run(() => accounts.removeCard(pm.pm_id))}
          >
            <Trash2 aria-hidden />
            Remove
          </Button>
        </div>
      )}
      {err && (
        <ErrorState title="That change was not applied">{err}</ErrorState>
      )}
    </li>
  );
}

export function WalletPage() {
  const s = useSession();
  const [tick, setTick] = useState(0);
  const res = useAsync(() => accounts.wallet(), [tick, s?.account?.account_id]);
  const pms = res.data?.payment_methods ?? [];
  const reload = () => setTick((t) => t + 1);

  if (!s?.account)
    return (
      <div className="grid gap-4">
        <PageTitle>Wallet</PageTitle>
        <GuestNotice />
      </div>
    );

  return (
    <div className="grid gap-4">
      <PageTitle aside={<Badge tone="accent">{s.account.name}</Badge>}>
        Wallet
      </PageTitle>
      <ApiLabel
        text={res.data?.synthetic_label}
        testid="wallet-synthetic-label"
      />
      <p className="m-0 text-sm text-fg-muted">
        Each instrument's outcome is deliberate and shown on its row, so
        checkout never surprises you. Exactly one instrument is the default.
      </p>
      {res.error && (
        <ErrorState title="Wallet unavailable">{res.error}</ErrorState>
      )}
      {res.loading && pms.length === 0 && (
        <PanelSkeleton rows={3} label="Loading wallet" />
      )}
      {!res.loading && !res.error && pms.length === 0 && (
        <EmptyState icon={CreditCard}>
          No payment instruments yet. Add one of the published test cards below.
        </EmptyState>
      )}
      <ul className="m-0 grid list-none gap-3 p-0">
        {pms.map((pm) => (
          <WalletRow
            key={pm.pm_id}
            pm={pm}
            count={pms.length}
            reload={reload}
          />
        ))}
      </ul>
      <AddCardForm onDone={reload} />
    </div>
  );
}

/* ---------------- /shop/account/addresses ---------------- */

const FIELDS: { k: keyof Address; label: string; required?: boolean }[] = [
  { k: "name", label: "Name", required: true },
  { k: "line1", label: "Address line 1", required: true },
  { k: "line2", label: "Address line 2" },
  { k: "city", label: "City", required: true },
  { k: "region", label: "State or region", required: true },
  { k: "postal_code", label: "Postal code", required: true },
  { k: "instructions", label: "Pickup instructions" },
];

function AddressForm({
  initial,
  onSubmit,
  onCancel,
  busy,
  testid,
}: {
  initial?: Partial<Address>;
  onSubmit: (v: Partial<Address>) => void;
  onCancel?: () => void;
  busy: boolean;
  testid: string;
}) {
  const [v, setV] = useState<Partial<Address>>(() => ({ ...initial }));
  return (
    <form
      data-testid={testid}
      className="grid gap-2 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
    >
      {FIELDS.map(({ k, label, required }) => (
        <label key={k} className="grid gap-1 text-sm font-medium">
          {label}
          <input
            value={(v[k] as string) ?? ""}
            required={required}
            autoComplete="off"
            data-testid={`address-${k}`}
            onChange={(e) => setV((p) => ({ ...p, [k]: e.target.value }))}
            className="h-9 rounded-md border border-line bg-surface px-2 text-fg focus-visible:outline-2 focus-visible:outline-focus"
          />
        </label>
      ))}
      <div className="flex items-end gap-2 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={busy}>
          Save address
        </Button>
        {onCancel && (
          <Button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function AddressRow({
  a,
  count,
  reload,
}: {
  a: Address;
  count: number;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      reload();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      data-testid="address-row"
      data-address={a.address_id}
      className="grid gap-2 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{a.name}</span>
        {a.is_default && (
          <Badge tone="accent" size="sm" data-testid="address-default">
            <Star aria-hidden />
            Default
          </Badge>
        )}
        {a.store_id && <Badge size="sm">store #{a.store_id}</Badge>}
      </div>
      <span className="text-sm">{a.display}</span>
      {a.instructions && (
        <span className="text-sm text-fg-muted">“{a.instructions}”</span>
      )}
      <ApiLabel text={a.label} />
      {edit ? (
        <AddressForm
          testid="address-edit-form"
          initial={a}
          busy={busy}
          onCancel={() => setEdit(false)}
          onSubmit={async (v) => {
            if (await run(() => accounts.updateAddress(a.address_id, v)))
              setEdit(false);
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy}
            data-testid="address-edit"
            aria-label={`Edit address ${a.display}`}
            onClick={() => setEdit(true)}
          >
            Edit
          </Button>
          {!a.is_default && (
            <Button
              size="sm"
              disabled={busy}
              data-testid="address-make-default"
              aria-label={`Make ${a.display} the default address`}
              onClick={() => run(() => accounts.defaultAddress(a.address_id))}
            >
              Make default
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || count <= 1}
            data-testid="address-remove"
            aria-label={`Remove address ${a.display}`}
            title={
              count <= 1 ? "The account keeps at least one address." : undefined
            }
            onClick={() => run(() => accounts.removeAddress(a.address_id))}
          >
            <Trash2 aria-hidden />
            Remove
          </Button>
        </div>
      )}
      {err && (
        <ErrorState title="That change was not applied">{err}</ErrorState>
      )}
    </li>
  );
}

export function AddressesPage() {
  const s = useSession();
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const res = useAsync(
    () => accounts.addresses(),
    [tick, s?.account?.account_id],
  );
  const list = res.data?.addresses ?? [];
  const reload = () => setTick((t) => t + 1);

  if (!s?.account)
    return (
      <div className="grid gap-4">
        <PageTitle>Addresses</PageTitle>
        <GuestNotice />
      </div>
    );

  return (
    <div className="grid gap-4">
      <PageTitle aside={<Badge tone="accent">{s.account.name}</Badge>}>
        Addresses
      </PageTitle>
      <ApiLabel
        text={res.data?.synthetic_label}
        testid="addresses-synthetic-label"
      />
      <p className="m-0 text-sm text-fg-muted">
        Synthetic pickup addresses. Exactly one is the default; the one you pick
        at checkout is signed into the mandate.
      </p>
      {res.error && (
        <ErrorState title="Addresses unavailable">{res.error}</ErrorState>
      )}
      {err && <ErrorState title="That address was not saved">{err}</ErrorState>}
      {res.loading && list.length === 0 && (
        <PanelSkeleton rows={2} label="Loading addresses" />
      )}
      {!res.loading && !res.error && list.length === 0 && (
        <EmptyState icon={Home}>No addresses yet.</EmptyState>
      )}
      <ul className="m-0 grid list-none gap-3 p-0">
        {list.map((a) => (
          <AddressRow
            key={a.address_id}
            a={a}
            count={list.length}
            reload={reload}
          />
        ))}
      </ul>
      {adding ? (
        <section
          aria-labelledby="aa-h"
          className="grid gap-2 rounded-xl border border-line bg-surface p-4"
        >
          <h2 id="aa-h" className="m-0 text-lg font-semibold">
            Add an address
          </h2>
          <AddressForm
            testid="address-add-form"
            busy={busy}
            onCancel={() => setAdding(false)}
            onSubmit={async (v) => {
              setBusy(true);
              setErr(null);
              try {
                await accounts.addAddress(v);
                setAdding(false);
                reload();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
        </section>
      ) : (
        <Button
          variant="primary"
          className="justify-self-start"
          data-testid="address-add"
          onClick={() => setAdding(true)}
        >
          Add an address
        </Button>
      )}
    </div>
  );
}

export const Component = AccountPage;
