/**
 * B16 persona switcher: the synthetic shopper account the session is bound to, beside the store
 * picker in the store header.
 *
 * Switching a persona re-applies that persona's preferences (as the SAME memory items and B11
 * constraint chips the chat uses) and keeps the cart. Every row renders the API's own
 * `synthetic_label` / `label` text, never a competing wording of our own.
 */
import { useState } from "react";
import { UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { accounts } from "../session";
import { StoreLink, useAsync, useSession } from "../ui";

export function PersonaSwitcher() {
  const s = useSession();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const res = useAsync(() => accounts.list(), []);
  const list = res.data?.accounts ?? [];
  const guest = res.data?.guest ?? null;
  const cur = s?.account ?? null;
  const items = s?.cart.item_count ?? 0;

  const choose = async (id: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      await accounts.use(id);
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const who = cur ? cur.name : "a guest";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="persona-switcher"
          className="inline-flex h-9 min-w-0 flex-none items-center gap-1.5 rounded-full px-2.5 text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
          aria-label={`Shopping as ${who}, a synthetic demo shopper who is not a real person. Change shopper`}
        >
          <UserRound className="size-4 flex-none text-accent" aria-hidden />
          <span className="hidden min-w-0 flex-col items-start leading-tight lg:flex">
            <span className="text-2xs text-fg-muted">Shopping as</span>
            <span className="max-w-[9rem] truncate font-medium">
              {cur ? cur.name : "Guest"}
            </span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid max-w-[22rem] gap-1 p-1.5">
        <div className="px-2 py-1 text-xs text-fg-muted">
          {res.data?.synthetic_label ?? "Synthetic demo shoppers."}
        </div>
        <p
          className="m-0 px-2 pb-1 text-xs text-fg-muted"
          data-testid="persona-cart-note"
        >
          Your cart ({items} item{items === 1 ? "" : "s"}) is kept when you
          switch shopper: the cart belongs to this session, not to the account.
        </p>
        {res.error && (
          <div role="alert" className="px-2 text-xs text-bad">
            shopper accounts unavailable: {res.error}
          </div>
        )}
        {err && (
          <div role="alert" className="px-2 text-xs text-bad">
            {err}
          </div>
        )}
        {list.map((a) => {
          const sel = cur?.account_id === a.account_id;
          return (
            <button
              key={a.account_id}
              type="button"
              disabled={busy}
              aria-pressed={sel}
              data-testid="persona-option"
              onClick={() => choose(a.account_id)}
              className={cn(
                "grid gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50",
                sel && "bg-accent-soft",
              )}
            >
              <span className="font-medium">
                {a.name}{" "}
                {sel && (
                  <span className="text-xs text-accent-soft-fg">(current)</span>
                )}
              </span>
              <span className="text-xs text-fg-muted">{a.label}</span>
              <span className="flex flex-wrap gap-1">
                <Badge size="sm">
                  {a.payment_methods.length} instrument
                  {a.payment_methods.length === 1 ? "" : "s"}
                </Badge>
                <Badge size="sm">
                  {a.addresses.length} address
                  {a.addresses.length === 1 ? "" : "es"}
                </Badge>
              </span>
            </button>
          );
        })}
        <button
          type="button"
          disabled={busy}
          aria-pressed={!cur}
          data-testid="persona-guest"
          onClick={() => choose(null)}
          className={cn(
            "grid gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50",
            !cur && "bg-accent-soft",
          )}
        >
          <span className="font-medium">
            Shop as a guest{" "}
            {!cur && (
              <span className="text-xs text-accent-soft-fg">(current)</span>
            )}
          </span>
          <span className="text-xs text-fg-muted">
            {guest?.note ??
              "Guest sessions have no account, no stored wallet and no saved address."}
          </span>
        </button>
        <StoreLink
          to="/shop/account"
          onClick={() => setOpen(false)}
          className="px-2 py-1 text-xs text-accent"
        >
          Account, wallet and addresses
        </StoreLink>
      </PopoverContent>
    </Popover>
  );
}
