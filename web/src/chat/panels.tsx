/** Memory, watches/notifications and reorder panels (Wave 0b). Opened as sheets from the chat toolbar. */
import { useState } from "react";
import { Bell, Brain, Check, Pencil, RefreshCw, Repeat, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { api, getSessionId } from "@/store/session";
import type { MemoryItem, SessionView } from "@/store/types";
import { money } from "@/store/ui";
import { announce, SYNTHETIC } from "./cards";
import { MEMORY_DIALOG_LABEL } from "@sparky/shared";

const S = () => `/api/session/${encodeURIComponent(getSessionId())}`;
const KEYS: { key: MemoryItem["key"]; label: string; hint: string }[] = [
  { key: "dietary", label: "Dietary need", hint: "e.g. gluten-free" },
  { key: "brands", label: "Preferred brand", hint: "e.g. Great Value" },
  { key: "store", label: "Home store", hint: "4-digit store id" },
  { key: "household_size", label: "Household size", hint: "number of people" },
];

function useAct() {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      announce(msg);
      return true;
    } catch (e: any) {
      setErr(String(e.message ?? e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { err, busy, run };
}

function MemoryRow({ m }: { m: MemoryItem }) {
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState(m.value);
  const { err, busy, run } = useAct();
  const label = KEYS.find((k) => k.key === m.key)?.label ?? m.key;
  return (
    <li data-testid="memory-item" data-status={m.status} className="grid gap-1 rounded-lg border border-line p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-muted">{label}</span>
        {edit ? (
          <input aria-label={`Edit ${label}`} value={val} onChange={(e) => setVal(e.target.value)} className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface-raised px-2 text-fg" />
        ) : (
          <strong className="flex-1">{m.value}</strong>
        )}
        {m.status === "quarantined" && <span className="rounded bg-warn-soft px-1.5 text-2xs font-semibold text-fg">Not saved: needs your confirmation</span>}
      </div>
      <span className="text-2xs text-fg-muted">
        {m.source}
        {m.source_text ? `: “${m.source_text.slice(0, 80)}”` : ""} · {new Date(m.updated_at).toLocaleString()}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {m.status === "quarantined" && (
          <Button size="xs" variant="primary" disabled={busy} aria-label={`Confirm memory ${label} ${m.value}`} onClick={() => run(() => api.post(`${S()}/memory/${m.id}/confirm`), `Remembered ${label}`)}>
            <Check aria-hidden />
            Confirm
          </Button>
        )}
        {edit ? (
          <Button size="xs" disabled={busy} onClick={async () => (await run(() => api.put(`${S()}/memory/${m.id}`, { value: val }), `Updated ${label}`)) && setEdit(false)}>
            Save
          </Button>
        ) : (
          <Button size="xs" aria-label={`Edit memory ${label}`} onClick={() => setEdit(true)}>
            <Pencil aria-hidden />
            Edit
          </Button>
        )}
        <Button size="xs" variant="ghost" disabled={busy} aria-label={`Delete memory ${label} ${m.value}`} onClick={() => run(() => api.del(`${S()}/memory/${m.id}`), `Forgot ${label}`)}>
          <Trash2 aria-hidden />
          Delete
        </Button>
      </div>
      {err && <p role="alert" className="m-0 text-xs text-bad">{err}</p>}
    </li>
  );
}

export function MemoryPanel({ open, onOpenChange, session }: { open: boolean; onOpenChange: (o: boolean) => void; session: SessionView | null }) {
  const [key, setKey] = useState<MemoryItem["key"]>("dietary");
  const [value, setValue] = useState("");
  const { err, busy, run } = useAct();
  const mem = session?.memory ?? [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:w-[min(30rem,92vw)]" aria-describedby="mem-desc">
        <div className="grid gap-1 border-b border-line px-4 py-3 pr-12">
          <SheetTitle className="flex items-center gap-2 text-md font-semibold">
            <Brain className="size-4" aria-hidden />
            {MEMORY_DIALOG_LABEL}
          </SheetTitle>
          <SheetDescription id="mem-desc" className="text-xs text-fg-muted">
            You control this. Nothing is remembered without your confirmation; things Compass infers from chat wait here until you confirm them.
          </SheetDescription>
        </div>
        <div className="grid gap-3 overflow-auto p-4">
          <form
            className="grid gap-2 rounded-lg border border-line p-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run(() => api.post(`${S()}/memory`, { key, value }), `Remembered ${value}`)) setValue("");
            }}
          >
            <div className="flex flex-wrap gap-2">
              <label className="grid gap-1 text-xs">
                Type
                <select value={key} onChange={(e) => setKey(e.target.value as MemoryItem["key"])} className="h-8 rounded-md border border-line bg-surface-raised px-2 text-sm text-fg">
                  {KEYS.map((k) => (
                    <option key={k.key} value={k.key}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid min-w-0 flex-1 gap-1 text-xs">
                Value
                <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={KEYS.find((k) => k.key === key)?.hint} className="h-8 rounded-md border border-line bg-surface-raised px-2 text-sm text-fg placeholder:text-fg-muted" />
              </label>
            </div>
            <Button type="submit" size="sm" variant="primary" disabled={busy || !value.trim()} className="w-fit">
              Remember this
            </Button>
            {err && <p role="alert" className="m-0 text-xs text-bad">{err}</p>}
          </form>
          {mem.length === 0 ? <p className="m-0 text-sm text-fg-muted">Nothing remembered yet.</p> : <ul className="m-0 grid list-none gap-2 p-0">{mem.map((m) => <MemoryRow key={m.id + m.updated_at} m={m} />)}</ul>}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function WatchesPanel({ open, onOpenChange, session }: { open: boolean; onOpenChange: (o: boolean) => void; session: SessionView | null }) {
  const [pid, setPid] = useState("");
  const [kind, setKind] = useState<"price_drop" | "back_in_stock">("price_drop");
  const [usual, setUsual] = useState<{ orders: number; usual: { product_id: string; title: string; qty: number; in_orders: number }[] } | null>(null);
  const { err, busy, run } = useAct();
  const watches = session?.watches ?? [];
  const notes = [...(session?.notifications ?? [])].reverse();
  const choices = session?.cart.items ?? [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:w-[min(32rem,92vw)]" aria-describedby="watch-desc">
        <div className="grid gap-1 border-b border-line px-4 py-3 pr-12">
          <SheetTitle className="flex items-center gap-2 text-md font-semibold">
            <Bell className="size-4" aria-hidden />
            Watches, alerts and reorder
          </SheetTitle>
          <SheetDescription id="watch-desc" className="text-xs text-fg-muted">
            Watches are checked on a timer against the live catalogue services. {SYNTHETIC}.
          </SheetDescription>
        </div>
        <div className="grid gap-4 overflow-auto p-4">
          <section className="grid gap-2" aria-labelledby="notif-h">
            <h3 id="notif-h" className="m-0 text-sm font-semibold">
              Notifications
            </h3>
            {notes.length === 0 ? (
              <p className="m-0 text-sm text-fg-muted">No alerts yet.</p>
            ) : (
              <ul className="m-0 grid list-none gap-1 p-0">
                {notes.map((n) => (
                  <li key={n.id} data-testid="notification" className="rounded-md bg-info-soft px-2 py-1.5 text-sm">
                    {n.text} <span className="text-2xs text-fg-muted">{new Date(n.at).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="grid gap-2" aria-labelledby="watch-h">
            <h3 id="watch-h" className="m-0 text-sm font-semibold">
              Watches
            </h3>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await run(() => api.post(`${S()}/watches`, { kind, product_id: pid }), "Watch started")) setPid("");
              }}
            >
              <label className="grid gap-1 text-xs">
                Alert me on
                <select value={kind} onChange={(e) => setKind(e.target.value as any)} className="h-8 rounded-md border border-line bg-surface-raised px-2 text-sm text-fg">
                  <option value="price_drop">Price drop</option>
                  <option value="back_in_stock">Back in stock</option>
                </select>
              </label>
              <label className="grid min-w-0 flex-1 gap-1 text-xs">
                Product
                <select value={pid} onChange={(e) => setPid(e.target.value)} className="h-8 rounded-md border border-line bg-surface-raised px-2 text-sm text-fg">
                  <option value="">Choose a cart item…</option>
                  {choices.map((c) => (
                    <option key={c.product_id} value={c.product_id}>
                      {c.title.slice(0, 50)}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" size="sm" variant="primary" disabled={busy || !pid}>
                Watch
              </Button>
            </form>
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {watches.map((w) => (
                <li key={w.id} data-testid="watch-item" data-status={w.status} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {w.kind === "price_drop" ? "Price drop" : "Back in stock"}: {w.title}
                  </span>
                  <span className="text-xs text-fg-muted">
                    {money(w.last_price)} · {w.last_in_stock == null ? "stock ?" : w.last_in_stock ? "in stock" : "out of stock"} · {w.status}
                  </span>
                  <Button size="xs" variant="ghost" aria-label={`Stop watching ${w.title.slice(0, 40)}`} onClick={() => run(() => api.del(`${S()}/watches/${w.id}`), "Watch removed")}>
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
            {watches.length > 0 && (
              <Button size="xs" className="w-fit" disabled={busy} onClick={() => run(() => api.post(`${S()}/watches/evaluate`), "Watches checked")}>
                <RefreshCw aria-hidden />
                Check now
              </Button>
            )}
          </section>
          <section className="grid gap-2" aria-labelledby="reorder-h">
            <h3 id="reorder-h" className="m-0 text-sm font-semibold">
              Reorder my usual
            </h3>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => run(async () => setUsual(await api.get(`${S()}/reorder`)), "Usual basket loaded")}>
                <Repeat aria-hidden />
                Show my usual
              </Button>
              {usual && usual.usual.length > 0 && (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => api.post(`${S()}/reorder`), "Reorder proposed: approve each item in the chat")}>
                  Propose reorder for approval
                </Button>
              )}
            </div>
            {usual && (
              <p className="m-0 text-xs text-fg-muted" data-testid="usual-basket">
                {usual.orders === 0 ? "No past orders in this session yet." : `From ${usual.orders} past order(s): ${usual.usual.map((u) => `${u.title.slice(0, 30)} × ${u.qty}`).join("; ")}`}
              </p>
            )}
          </section>
          {err && <p role="alert" className="m-0 text-xs text-bad">{err}</p>}
        </div>
      </SheetContent>
    </Sheet>
  );
}
