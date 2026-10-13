/**
 * /shop layout: sticky store header (search + typeahead, store picker, Site/Chat/Split toggle, cart),
 * category rail, constraint chips, the three views, sync toasts and the footer.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useSearchParams } from "react-router";
import { Columns2, LayoutGrid, MapPin, MessageSquare, MessagesSquare, Search, ShoppingCart, Sparkles, Store as StoreIcon } from "lucide-react";
import { cn, safeStorage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatPane } from "@/components/ChatPane";
import { CHAT_REGION_LABEL, CHAT_SHEET_LABEL } from "@sparky/shared";
import { useStore } from "../store";
import { navRequest, shop, subscribeSession, toastStore } from "./session";
import type { StoreInfo } from "./types";
import { CATEGORIES } from "./types";
import { ConstraintChips, CouldNotDo, MiniCart, SiteActivity, StoreFooter, StoreLink, useConn, useIsNarrow, useSession } from "./ui";
import { PersonaSwitcher } from "./components/PersonaSwitcher";

export type View = "site" | "chat" | "split";
const VIEWS: { v: View; label: string; icon: typeof LayoutGrid; key: string }[] = [
  { v: "site", label: "Site", icon: LayoutGrid, key: "1" },
  { v: "chat", label: "Chat", icon: MessagesSquare, key: "2" },
  { v: "split", label: "Split", icon: Columns2, key: "3" },
];

function useView(): [View, (v: View) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("view") ?? params.get("layout");
  const view: View = raw === "chat" || raw === "split" ? raw : "site";
  const set = (v: View) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set("view", v);
        return n;
      },
      { replace: true },
    );
  return [view, set];
}

/* ---------------- search with typeahead ---------------- */

function SearchBox() {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const initial = pathname === "/shop/search" ? (params.get("q") ?? "") : "";
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<string[]>([]);
  const [dym, setDym] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const view = params.get("view");

  useEffect(() => setQ(initial), [initial]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setItems([]);
      setDym(null);
      return;
    }
    const t = setTimeout(() => {
      shop.suggest(term).then(
        (r) => {
          setItems((r.completions ?? []).slice(0, 8));
          setDym(r.did_you_mean ?? null);
        },
        () => {
          setItems([]);
          setDym(null);
        },
      );
    }, 160);
    return () => clearTimeout(t);
  }, [q]);

  const go = (term: string) => {
    const t = term.trim();
    if (!t) return;
    setOpen(false);
    navigate(`/shop/search?q=${encodeURIComponent(t)}${view ? `&view=${view}` : ""}`);
  };
  const options = [...(dym && dym !== q ? [dym] : []), ...items.filter((i) => i !== dym)];

  return (
    <form
      role="search"
      className="relative min-w-0 flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        go(active >= 0 && options[active] ? options[active] : q);
      }}
    >
      <label htmlFor="store-search" className="sr-only">
        Search products and help
      </label>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-muted" aria-hidden />
      <input
        id="store-search"
        data-testid="search-input"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={q}
        placeholder="Search everything at Compass Store"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(options.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(-1, a - 1));
          } else if (e.key === "Escape") setOpen(false);
        }}
        className="h-10 w-full rounded-full border-2 border-line-strong bg-surface pr-24 pl-9 text-base text-fg placeholder:text-fg-muted focus-visible:border-accent focus-visible:outline-none"
      />
      <Button type="submit" variant="primary" size="sm" className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-full">
        Search
      </Button>
      {open && options.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Suggestions" className="absolute top-full right-0 left-0 z-40 m-0 mt-1 list-none overflow-hidden rounded-lg border border-line bg-surface-raised p-1 shadow-lg">
          {options.map((o, i) => (
            <li
              key={o + i}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                go(o);
              }}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm", i === active ? "bg-accent-soft text-accent-soft-fg" : "hover:bg-surface-hover")}
            >
              <Search className="size-3.5 text-fg-muted" aria-hidden />
              {dym && o === dym && i === 0 ? (
                <span>
                  Did you mean <strong>{o}</strong>?
                </span>
              ) : (
                o
              )}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/* ---------------- store picker ---------------- */

let storesCache: Promise<StoreInfo[]> | null = null;
export function loadStores() {
  storesCache ??= shop.stores().then(
    (r) => r.stores ?? [],
    (e) => {
      storesCache = null;
      throw e;
    },
  );
  return storesCache;
}

export function StorePicker() {
  const s = useSession();
  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    loadStores().then(setStores, (e) => setErr(String(e.message ?? e)));
  }, []);
  const cur = stores.find((x) => x.store_id === s?.store_id);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="store-picker"
          className="inline-flex h-9 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
          aria-label={`Pickup store: ${cur ? cur.name : (s?.store_id ?? "not set")}. Change store`}
        >
          <MapPin className="size-4 flex-none text-accent" aria-hidden />
          <span className="hidden min-w-0 flex-col items-start leading-tight lg:flex">
            <span className="text-2xs text-fg-muted">Pickup at</span>
            <span className="max-w-[11rem] truncate font-medium">{cur?.name ?? s?.store_id ?? "…"}</span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid gap-1 p-1.5">
        <div className="px-2 py-1 text-xs text-fg-muted">Synthetic stores. Price and stock follow the selected store.</div>
        {err && <div className="px-2 text-xs text-bad">store list unavailable: {err}</div>}
        {stores.map((st) => (
          <button
            key={st.store_id}
            type="button"
            aria-pressed={st.store_id === s?.store_id}
            onClick={async () => {
              await shop.setStore(st.store_id).catch((e) => setErr(String(e.message)));
              setOpen(false);
            }}
            className={cn("grid rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus", st.store_id === s?.store_id && "bg-accent-soft")}
          >
            <span className="font-medium">
              {st.name} {st.store_id === s?.store_id && <span className="text-xs text-accent-soft-fg">(selected)</span>}
            </span>
            <span className="text-xs text-fg-muted">
              #{st.store_id} · {st.city}, {st.region} · {st.hours}
            </span>
          </button>
        ))}
        <StoreLink to="/shop/stores" onClick={() => setOpen(false)} className="px-2 py-1 text-xs text-accent">
          All stores
        </StoreLink>
      </PopoverContent>
    </Popover>
  );
}

/* ---------------- view toggle ---------------- */

function ViewToggle({ view, setView }: { view: View; setView: (v: View) => void }) {
  return (
    <div role="radiogroup" aria-label="Layout" className="inline-flex flex-none items-center gap-0.5 rounded-full border border-line bg-surface-sunken p-0.5">
      {VIEWS.map(({ v, label, icon: Icon, key }) => (
        <Tooltip
          key={v}
          content={
            <span className="inline-flex items-center gap-1.5">
              {label} view <Kbd className="border-transparent bg-canvas/20 text-canvas">Alt</Kbd>
              <Kbd className="border-transparent bg-canvas/20 text-canvas">{key}</Kbd>
            </span>
          }
        >
          <button
            type="button"
            role="radio"
            aria-checked={view === v}
            // Below sm: the text label is hidden, so the icon-only button needs its own name.
            aria-label={`${label} view`}
            aria-keyshortcuts={`Alt+${key}`}
            data-testid={`view-toggle-${v}`}
            onClick={() => setView(v)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
              view === v ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
            )}
          >
            <Icon className="size-4" aria-hidden />
            <span className="hidden sm:inline">{label}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

/* ---------------- header ---------------- */

function StoreHeader({ view, setView }: { view: View; setView: (v: View) => void }) {
  const s = useSession();
  const conn = useConn();
  const count = s?.cart.item_count ?? 0;
  return (
    <div className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-[90rem] flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:gap-3 sm:px-4">
        <StoreLink to="/shop" className="flex flex-none items-center gap-1.5 rounded-md text-fg no-underline focus-visible:outline-2 focus-visible:outline-focus" aria-label="Compass Store home">
          <span aria-hidden className="grid size-8 place-items-center rounded-full bg-accent text-accent-fg">
            <StoreIcon className="size-4" />
          </span>
          <span className="hidden text-md font-bold tracking-[-0.02em] md:inline">Compass Store</span>
        </StoreLink>
        <StorePicker />
        <PersonaSwitcher />
        <div className="order-last flex w-full min-w-0 sm:order-none sm:w-auto sm:flex-1">
          <SearchBox />
        </div>
        <ViewToggle view={view} setView={setView} />
        <StoreLink
          to="/shop/cart"
          className="relative inline-flex h-10 flex-none items-center gap-1.5 rounded-full px-2.5 text-sm font-medium text-fg no-underline hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
          aria-label={`Cart, ${count} item${count === 1 ? "" : "s"}, total $${(s?.cart.total ?? 0).toFixed(2)}`}
        >
          <ShoppingCart className="size-5" aria-hidden />
          <span data-testid="cart-count" className="tabular grid h-5 min-w-5 place-items-center rounded-full bg-highlight px-1 text-2xs font-bold text-highlight-fg">
            {count}
          </span>
          <span className="tabular hidden lg:inline">${(s?.cart.total ?? 0).toFixed(2)}</span>
        </StoreLink>
      </div>
      <nav aria-label="Store" className="mx-auto flex max-w-[90rem] items-center gap-1 overflow-x-auto px-3 pb-1.5 sm:px-4">
        {CATEGORIES.map((c) => (
          <StoreLink
            key={c.id}
            to={`/shop/search?q=${encodeURIComponent(c.query)}`}
            className="inline-flex h-7 flex-none items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap text-fg-muted no-underline hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
          >
            {c.label}
          </StoreLink>
        ))}
        <span aria-hidden className="mx-1 h-4 w-px flex-none bg-line" />
        {[
          ["/shop/account", "Account"],
          ["/shop/lists", "Lists"],
          ["/shop/orders", "Orders"],
          ["/shop/help", "Help"],
          ["/shop/stores", "Stores"],
        ].map(([to, l]) => (
          <StoreLink key={to} to={to} className="inline-flex h-7 flex-none items-center rounded-full px-2.5 text-xs font-medium text-fg-muted no-underline hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
            {l}
          </StoreLink>
        ))}
        {conn.state !== "live" && (
          <span role="status" className={cn("ml-auto flex-none text-2xs", conn.state === "down" ? "text-bad" : "text-fg-muted")}>
            {conn.state === "down" ? "Session sync offline (bff events); retrying" : "Connecting session…"}
          </span>
        )}
      </nav>
      <ConstraintChips className="mx-auto max-w-[90rem] px-3 pb-2 sm:px-4" />
    </div>
  );
}

/* ---------------- chat panel ---------------- */

/** Wave 0b: agent cart changes are proposals the shopper approves (policy-mcp POLICY_HITL=propose). */
const HITL = { hitl: true };

function ChatPanel({ full }: { full?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <div className={cn("grid flex-none gap-2 border-b border-line bg-surface px-3 py-2", full && "px-4")}>
        {full && <MiniCart />}
        <ConstraintChips compact label="Constraints" />
        <CouldNotDo />
      </div>
      <ChatPane agentId="default" beat={1} extra={HITL} />
      <SiteActivity className="flex-none border-t border-line bg-surface px-3 py-1.5" />
    </div>
  );
}

/* ---------------- toasts ---------------- */

function Toasts() {
  const toasts = useStore(toastStore);
  return (
    <div aria-live="polite" role="status" className="pointer-events-none fixed bottom-20 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm shadow-lg">
          <Sparkles className="size-4 flex-none text-accent" aria-hidden />
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* ---------------- split ---------------- */

function SplitView({ site }: { site: React.ReactNode }) {
  const [pct, setPct] = useState(() => {
    const v = Number(safeStorage.get("sparky.split"));
    return v >= 30 && v <= 80 ? v : 60;
  });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const narrow = useIsNarrow(768);
  useEffect(() => safeStorage.set("sparky.split", String(Math.round(pct))), [pct]);
  const clamp = (n: number) => Math.max(30, Math.min(80, n));

  if (narrow)
    return (
      <Tabs defaultValue="store" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="flex w-full flex-none bg-surface px-2">
          <TabsTrigger value="store" className="flex-1 justify-center">
            Store
          </TabsTrigger>
          <TabsTrigger value="chat" className="flex-1 justify-center">
            Chat
          </TabsTrigger>
        </TabsList>
        <TabsContent value="store" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden" forceMount>
          {site}
        </TabsContent>
        <TabsContent value="chat" className="flex min-h-[70vh] flex-1 flex-col data-[state=inactive]:hidden">
          <aside aria-label={CHAT_REGION_LABEL} className="flex min-h-0 flex-1 flex-col">
            <ChatPanel />
          </aside>
        </TabsContent>
      </Tabs>
    );

  return (
    <div
      ref={box}
      className="flex min-h-0 flex-1"
      onPointerMove={(e) => {
        if (!drag.current || !box.current) return;
        const r = box.current.getBoundingClientRect();
        setPct(clamp(((e.clientX - r.left) / r.width) * 100));
      }}
      onPointerUp={() => (drag.current = false)}
      onPointerLeave={() => (drag.current = false)}
    >
      <div className="flex min-h-0 min-w-0 flex-col overflow-auto" style={{ width: `${pct}%` }}>
        {site}
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize store and chat"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={30}
        aria-valuemax={80}
        onPointerDown={(e) => {
          drag.current = true;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerUp={() => (drag.current = false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setPct((p) => clamp(p - 2));
          else if (e.key === "ArrowRight") setPct((p) => clamp(p + 2));
          else if (e.key === "Home") setPct(30);
          else if (e.key === "End") setPct(80);
          else return;
          e.preventDefault();
        }}
        className="group relative w-1.5 flex-none cursor-col-resize bg-line hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span aria-hidden className="absolute top-1/2 left-1/2 h-10 w-1 -translate-1/2 rounded-full bg-fg-subtle group-hover:bg-accent-fg" />
      </div>
      <aside aria-label={CHAT_REGION_LABEL} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatPanel />
      </aside>
    </div>
  );
}

/* ---------------- layout ---------------- */

export function Component() {
  const [view, setView] = useView();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const req = useStore(navRequest);
  // ?chat=<prompt> on the site view opens the Ask Compass sheet with the prompt prefilled (not sent).
  const [askOpen, setAskOpen] = useState(() => view === "site" && params.has("chat"));
  const scroller = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  useEffect(() => subscribeSession(), []);

  // Keyboard: Alt+1/2/3 (code-based so macOS Option characters still work).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const i = ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
      if (i < 0) return;
      e.preventDefault();
      setView(VIEWS[i].v);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  });

  // Agent-driven navigation: the site follows Compass's searches (keeps ?view).
  useEffect(() => {
    if (!req) return;
    const v = params.get("view");
    navigate(req.to + (v ? `&view=${v}` : ""));
    navRequest.set(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  useEffect(() => {
    scroller.current?.scrollTo?.({ top: 0 });
  }, [pathname]);

  const site = useMemo(
    () => (
      <main ref={scroller} id="store-main" tabIndex={0} aria-label="Storefront" className="flex min-h-0 flex-1 flex-col overflow-auto bg-canvas">
        <div className="mx-auto w-full max-w-[90rem] flex-1 px-3 py-4 sm:px-4">
          <Outlet />
        </div>
        <StoreFooter />
      </main>
    ),
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
      <StoreHeader view={view} setView={setView} />
      {view === "site" && (
        <>
          {site}
          <Button variant="primary" size="lg" className="fixed right-5 bottom-5 z-30 rounded-full shadow-lg" onClick={() => setAskOpen(true)} aria-haspopup="dialog">
            <MessageSquare aria-hidden />
            {CHAT_SHEET_LABEL}
          </Button>
          <Sheet open={askOpen} onOpenChange={setAskOpen}>
            <SheetContent className="sm:w-[min(34rem,92vw)]" aria-describedby="ask-desc">
              <div className="flex flex-none items-center gap-2 border-b border-line px-4 py-3 pr-12">
                <SheetTitle className="text-md font-semibold">{CHAT_SHEET_LABEL}</SheetTitle>
                <SheetDescription id="ask-desc" className="text-xs text-fg-muted">
                  Same session as the store: cart and constraints stay in sync.
                </SheetDescription>
              </div>
              <ChatPanel />
            </SheetContent>
          </Sheet>
        </>
      )}
      {view === "chat" && (
        <main aria-label={CHAT_REGION_LABEL} className="flex min-h-[70vh] flex-1 flex-col">
          <h1 className="sr-only">Chat with Compass</h1>
          <ChatPanel full />
        </main>
      )}
      {view === "split" && <SplitView site={site} />}
      <Toasts />
    </div>
  );
}
