/**
 * Shared shopper session: one id (persisted in localStorage "sparky.session") used by both the
 * storefront and the chat thread of agent "default". The storefront talks ONLY to the bff session
 * layer. State arrives over SSE (/api/session/:sid/events) and every mutation response carries the
 * fresh SessionView, which is applied too (whichever has the higher version wins).
 */
import { createStore } from "../store";
import { safeStorage } from "@/lib/utils";
import type { Filters, SessionView, Sort } from "./types";

const KEY = "sparky.session";

function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  }
}

let cachedId: string | null = null;
export function getSessionId(): string {
  if (cachedId) return cachedId;
  const existing = safeStorage.get(KEY);
  cachedId = existing && existing.length > 8 ? existing : newId();
  if (cachedId !== existing) safeStorage.set(KEY, cachedId);
  return cachedId;
}

/* ---------------- stores ---------------- */

export const sessionStore = createStore<SessionView | null>(null);
export type ConnState = "connecting" | "live" | "down";
export const connStore = createStore<{ state: ConnState; error?: string }>({
  state: "connecting",
});

export interface Toast {
  id: string;
  text: string;
}
export const toastStore = createStore<Toast[]>([]);
export function toast(text: string) {
  const id = newId();
  toastStore.set((p) => [...p.slice(-3), { id, text }]);
  setTimeout(() => toastStore.set((p) => p.filter((t) => t.id !== id)), 6000);
}

/** Product ids the agent found in its latest search, highlighted on the site. */
export const highlightStore = createStore<{
  query: string;
  ids: string[];
  at: string;
} | null>(null);
/** Pending agent-driven navigation for the site pane (consumed by StoreLayout). */
export const navRequest = createStore<{ to: string; nonce: number } | null>(
  null,
);

export function applySession(next: SessionView | undefined | null) {
  if (!next || typeof next !== "object" || !("session_id" in next)) return;
  sessionStore.set((prev) =>
    prev &&
    typeof prev.version === "number" &&
    typeof next.version === "number" &&
    next.version < prev.version
      ? prev
      : next,
  );
}

/* ---------------- delta application ---------------- */

type Op = { op: "add" | "replace" | "remove"; path: string; value?: unknown };

function applyOps(base: SessionView, ops: Op[]): SessionView {
  const out: any = { ...base };
  for (const o of ops) {
    const keys = o.path
      .split("/")
      .filter(Boolean)
      .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (!keys.length) continue;
    if (keys.length === 1) {
      if (o.op === "remove") delete out[keys[0]];
      else out[keys[0]] = o.value;
      continue;
    }
    // nested: clone along the path
    let cur = out;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      const v = cur[k];
      cur[k] = Array.isArray(v) ? [...v] : { ...(v ?? {}) };
      cur = cur[k];
    }
    const last = keys[keys.length - 1];
    if (Array.isArray(cur)) {
      if (o.op === "remove") cur.splice(Number(last), 1);
      else if (last === "-") cur.push(o.value);
      else if (o.op === "add") cur.splice(Number(last), 0, o.value);
      else cur[Number(last)] = o.value;
    } else if (o.op === "remove") delete cur[last];
    else cur[last] = o.value;
  }
  return out as SessionView;
}

interface DeltaEvent {
  type: "STATE_DELTA";
  version: number;
  actor: "site" | "agent" | "system";
  reason?: string;
  delta: Op[];
}

function onDelta(ev: DeltaEvent) {
  const prev = sessionStore.get();
  if (!prev) return;
  const next = applyOps(prev, ev.delta ?? []);
  if (typeof ev.version === "number") next.version = ev.version;
  sessionStore.set(next);
  if (ev.actor !== "agent") return;

  const ls = next.last_search;
  const prevLs = prev.last_search;
  if (
    ls &&
    ls.actor === "agent" &&
    (ls.at !== prevLs?.at || ls.query !== prevLs?.query)
  ) {
    highlightStore.set({
      query: ls.query,
      ids: ls.product_ids ?? [],
      at: ls.at,
    });
    navRequest.set({
      to: `/shop/search?q=${encodeURIComponent(ls.query)}`,
      nonce: Date.now(),
    });
    toast(`Compass searched for "${ls.query}"`);
  }
  const before = new Map(prev.cart.items.map((i) => [i.product_id, i.qty]));
  const added = next.cart.items.filter(
    (i) => (before.get(i.product_id) ?? 0) < i.qty,
  );
  if (added.length)
    toast(`Compass added ${added.map((a) => a.title).join(", ")} to your cart`);
}

/* ---------------- SSE subscriber ---------------- */

let es: EventSource | null = null;
let refs = 0;
let retry: ReturnType<typeof setTimeout> | null = null;

function open() {
  const sid = getSessionId();
  connStore.set({ state: "connecting" });
  // Also fetch a snapshot directly so the page has state even if SSE is slow to start.
  void api
    .get<SessionView>(`/api/session/${sid}`)
    .then((s) => applySession(s))
    .catch(() => undefined);
  try {
    es = new EventSource(`/api/session/${encodeURIComponent(sid)}/events`);
  } catch (e) {
    connStore.set({ state: "down", error: String(e) });
    return;
  }
  es.onopen = () => connStore.set({ state: "live" });
  es.onmessage = (m) => {
    let data: any;
    try {
      data = JSON.parse(m.data);
    } catch {
      return;
    }
    if (data?.type === "STATE_SNAPSHOT") {
      sessionStore.set(data.snapshot);
      connStore.set({ state: "live" });
    } else if (data?.type === "STATE_DELTA") onDelta(data);
  };
  es.onerror = () => {
    connStore.set({
      state: "down",
      error: "session event stream (bff /api/session/:sid/events) disconnected",
    });
    es?.close();
    es = null;
    if (refs > 0 && !retry)
      retry = setTimeout(() => {
        retry = null;
        if (refs > 0) open();
      }, 4000);
  };
}

export function subscribeSession() {
  refs++;
  if (refs === 1 && !es) open();
  return () => {
    refs--;
    if (refs === 0) {
      es?.close();
      es = null;
      if (retry) clearTimeout(retry);
      retry = null;
    }
  };
}

/* ---------------- HTTP ---------------- */

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: any,
  ) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      headers:
        body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(`bff unreachable (${url}): ${String(e)}`, 0, null);
  }
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!r.ok)
    throw new ApiError(
      data?.error ?? data?.detail ?? `${r.status} ${url}`,
      r.status,
      data,
    );
  if (data && typeof data === "object" && data.session)
    applySession(data.session);
  return data as T;
}

export const api = {
  get: <T>(url: string) => req<T>("GET", url),
  post: <T>(url: string, body: unknown = {}) => req<T>("POST", url, body),
  put: <T>(url: string, body: unknown = {}) => req<T>("PUT", url, body),
  del: <T>(url: string) => req<T>("DELETE", url),
};

const S = () => `/api/session/${encodeURIComponent(getSessionId())}`;
const enc = encodeURIComponent;

export const shop = {
  search: (body: {
    query: string;
    filters: Filters;
    sort: Sort;
    page: number;
  }) => api.post<import("./types").SearchResponse>(`${S()}/search`, body),
  addToCart: (product_id: string, qty = 1) =>
    api.post<{ ok: boolean; error?: string }>(`${S()}/cart/items`, {
      product_id,
      qty,
    }),
  setQty: (pid: string, qty: number) =>
    api.put<{ ok: boolean; error?: string }>(`${S()}/cart/items/${enc(pid)}`, {
      qty,
    }),
  remove: (pid: string) =>
    api.del<{ ok: boolean; error?: string }>(`${S()}/cart/items/${enc(pid)}`),
  setStore: (store_id: string) =>
    api.put<unknown>(`${S()}/store`, { store_id }),
  addConstraint: (key: string, value: string) =>
    api.post<unknown>(`${S()}/constraints`, { key, value }),
  removeConstraint: (id: string) =>
    api.del<unknown>(`${S()}/constraints/${enc(id)}`),
  revalidate: () =>
    api.post<{ revalidation: import("./types").Revalidation }>(
      `${S()}/checkout/revalidate`,
    ),
  /** `tender`/`tender_hash` come straight from the tender preview: authorize's tender_unchanged check compares them. */
  mandate: (
    spend_cap: number,
    extra?: {
      address_id?: string | null;
      tender?: { pm_id: string; amount: number }[];
      tender_hash?: string;
    },
  ) =>
    api.post<{ mandate: Record<string, any>; signature: any; status: string }>(
      `${S()}/checkout/mandate`,
      { spend_cap, ...(extra ?? {}) },
    ),
  decide: (mandate_id: string, approved: boolean) =>
    api.post<{ decision: any; order?: import("./types").Order }>(
      `${S()}/checkout/decision`,
      { mandate_id, approved },
    ),
  orders: () => api.get<{ orders: import("./types").Order[] }>(`${S()}/orders`),
  order: (orderId: string) =>
    api.get<{ order: import("./types").Order }>(
      `${S()}/orders/${enc(orderId)}`,
    ),
  advanceFulfilment: (orderId: string, stage?: string) =>
    api.post<{ order: import("./types").Order }>(
      `${S()}/orders/${enc(orderId)}/fulfilment`,
      stage ? { stage } : {},
    ),
  reorder: () => api.post<any>(`${S()}/reorder`),
  lists: () => api.get<any>(`${S()}/lists`),
  createList: (name: string) => api.post<any>(`${S()}/lists`, { name }),
  addToList: (name: string, product_id: string) =>
    api.post<any>(`${S()}/lists/${enc(name)}/items`, { product_id }),
  removeFromList: (name: string, pid: string) =>
    api.del<any>(`${S()}/lists/${enc(name)}/items/${enc(pid)}`),
  stores: () =>
    api.get<{ stores: import("./types").StoreInfo[] }>(`/api/store/stores`),
  product: (pid: string, store_id: string) =>
    api.get<import("./types").ProductDetail>(
      `/api/store/product/${enc(pid)}?store_id=${enc(store_id)}`,
    ),
  suggest: (q: string) =>
    api.get<{ q: string; completions: string[]; did_you_mean: string | null }>(
      `/api/store/suggest?q=${enc(q)}`,
    ),
  help: (q: string, lang = "en") =>
    api.get<import("./types").HelpAnswer>(
      `/api/store/help?q=${enc(q)}&lang=${enc(lang)}`,
    ),
  triage: (status?: string) =>
    api.get<{ items: import("./types").TriageItem[] }>(
      `/api/triage${status ? `?status=${enc(status)}` : ""}`,
    ),
  setTriage: (id: string, status: string, note = "") =>
    api.post<any>(`/api/triage/${enc(id)}`, { status, note }),
};

/**
 * B16 shopper accounts, wallet, addresses and the payment step.
 *
 * `addCard` posts a published test-card number. It is forwarded once and never stored, echoed or
 * logged by the bff, and this client never keeps it in component state beyond the form field.
 *
 * The working checkout order, verified against the live stack, is:
 *   tender -> mandate(tender + tender_hash) -> recordApproval -> authorize -> confirm
 * `authorize` needs an approved mandate, and the order is only created once a successful simulated
 * authorisation exists, so the human approval is recorded first (see `recordApproval`) and the same
 * decision route is called again by `confirm` to place the order.
 */
export const accounts = {
  list: () =>
    api.get<{
      accounts: import("./types").ShopperAccount[];
      guest: import("./types").ShopperAccount;
      synthetic_label: string;
    }>(`${S()}/accounts`),
  use: (account_id: string | null) =>
    api.put<{
      ok: boolean;
      account: import("./types").ShopperAccount | null;
      voided_mandate: string | null;
    }>(`${S()}/account`, { account_id }),

  wallet: () =>
    api.get<{
      account_id: string;
      payment_methods: import("./types").PaymentMethod[];
      synthetic_label: string;
    }>(`${S()}/wallet`),
  addCard: (b: {
    kind: import("./types").PmKind;
    number?: string;
    balance?: number;
    nickname?: string;
    is_default?: boolean;
  }) =>
    api.post<{
      payment_method: import("./types").PaymentMethod;
      payment_methods: import("./types").PaymentMethod[];
    }>(`${S()}/wallet`, b),
  updateCard: (
    pmId: string,
    b: { nickname?: string; balance?: number; is_default?: boolean },
  ) =>
    api.put<{
      payment_method: import("./types").PaymentMethod;
      payment_methods: import("./types").PaymentMethod[];
    }>(`${S()}/wallet/${enc(pmId)}`, b),
  removeCard: (pmId: string) =>
    api.del<{ payment_methods: import("./types").PaymentMethod[] }>(
      `${S()}/wallet/${enc(pmId)}`,
    ),
  defaultCard: (pmId: string) =>
    api.post<{ payment_methods: import("./types").PaymentMethod[] }>(
      `${S()}/wallet/${enc(pmId)}/default`,
    ),

  addresses: () =>
    api.get<{
      account_id: string;
      addresses: import("./types").Address[];
      synthetic_label: string;
    }>(`${S()}/addresses`),
  addAddress: (b: Partial<import("./types").Address>) =>
    api.post<{
      address: import("./types").Address;
      addresses: import("./types").Address[];
    }>(`${S()}/addresses`, b),
  updateAddress: (adrId: string, b: Partial<import("./types").Address>) =>
    api.put<{
      address: import("./types").Address;
      addresses: import("./types").Address[];
    }>(`${S()}/addresses/${enc(adrId)}`, b),
  removeAddress: (adrId: string) =>
    api.del<{ addresses: import("./types").Address[] }>(
      `${S()}/addresses/${enc(adrId)}`,
    ),
  defaultAddress: (adrId: string) =>
    api.post<{ addresses: import("./types").Address[] }>(
      `${S()}/addresses/${enc(adrId)}/default`,
    ),

  tender: (pm_ids: string[], store_id?: string) =>
    api.post<{ tender: import("./types").TenderPreview }>(
      `${S()}/checkout/tender`,
      { pm_ids, ...(store_id ? { store_id } : {}) },
    ),
  authorize: (mandate_id: string) =>
    api.post<import("./types").AuthResult>(`${S()}/checkout/authorize`, {
      mandate_id,
    }),
  stepUp: (step_up_id: string, code: string) =>
    api.post<import("./types").StepUpResult>(`${S()}/checkout/step-up`, {
      step_up_id,
      code,
    }),
  testCards: () =>
    api.get<import("./types").TestCardsResponse>(`/api/store/test-cards`),
};

/**
 * The shopper's human approval of a tender mandate. The live contract rejects the order until a
 * successful simulated authorisation exists, so this call records the approval and the expected
 * "authorize first" refusal is swallowed: `accounts.authorize` runs next, then `confirmOrder`.
 * Any OTHER error is a real failure and is rethrown.
 */
const NEEDS_AUTHORIZE =
  /authorize must\s+record a successful simulated authorisation/i;
export async function recordApproval(mandate_id: string): Promise<void> {
  try {
    await shop.decide(mandate_id, true);
  } catch (e) {
    if (
      e instanceof ApiError &&
      typeof e.message === "string" &&
      NEEDS_AUTHORIZE.test(e.message.replace(/\s+/g, " "))
    )
      return;
    throw e;
  }
}

/** Places the order for an already approved-and-authorised mandate. Returns the confirmed order. */
export async function confirmOrder(
  mandate_id: string,
): Promise<import("./types").Order> {
  const r = await shop.decide(mandate_id, true);
  if (!r.order)
    throw new ApiError(
      "The order was not created: the mandate has no completed simulated authorisation.",
      409,
      r,
    );
  return r.order;
}

/** Normalise GET /lists into [{name, items:[{product_id,title?}]}] whatever exact shape the bff returns. */
export function normaliseLists(
  raw: any,
): {
  name: string;
  items: { product_id: string; title?: string }[];
  kind?: string;
}[] {
  const src = raw?.lists ?? raw;
  if (Array.isArray(src))
    return src.map((l: any) => ({
      name: String(l.name),
      kind: l.kind,
      items: (l.items ?? []).map((i: any) =>
        typeof i === "string" ? { product_id: i } : i,
      ),
    }));
  if (src && typeof src === "object")
    return Object.entries(src).map(([name, v]: [string, any]) => ({
      name,
      items: (Array.isArray(v) ? v : (v?.items ?? [])).map((i: any) =>
        typeof i === "string" ? { product_id: i } : i,
      ),
    }));
  return [];
}
