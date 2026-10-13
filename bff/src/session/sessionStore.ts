/**
 * One shared shopping session per chat thread (Wave 0).
 *
 * The site and the chat agent are two channels onto the SAME session:
 *   - cart and mandates live in shop-http's SQLite (commerce.db), keyed by the session id;
 *     the agent's MCP tools (via policy-mcp -> shop_mcp.tools) and the site's clicks (via the
 *     bff -> shop-http) write the same rows.
 *   - query, filters, store, constraints, could-not-do and the activity log live here, next to
 *     the agent's ThreadCtx, so the agent's next prompt sees what the site did.
 * Every change publishes a STATE_DELTA (JSON-Patch "add" on changed top-level keys) to the
 * site's SSE subscribers, tagged with the actor that caused it.
 */
import { randomUUID } from "node:crypto";
import type { AccountRef, AddressSummary, ConstraintEntry, TenderView, WalletSummary } from "@sparky/shared";
import { config } from "../config.js";
import { jfetch } from "../lib/http.js";
import { getThread, type ThreadCtx } from "../agui/threadStore.js";
import { applyCart } from "../agui/stateReducer.js";
import { appliesAs, constraintId, type ConstraintMeta, type SiteFilters } from "./constraints.js";
import { verifySession, type CouldNot, type LineFacts } from "./verifier.js";
import { assistView } from "../assist/store.js";

export type Actor = "site" | "agent" | "system";

export interface Activity {
  id: string;
  at: string;
  actor: Actor;
  kind: string;
  summary: string;
}

export interface SessionEvent {
  type: "STATE_SNAPSHOT" | "STATE_DELTA";
  snapshot?: SessionView;
  delta?: { op: "add"; path: string; value: unknown }[];
  version: number;
  actor?: Actor;
  reason?: string;
}

interface SiteSession {
  sid: string;
  version: number;
  store_id: string;
  query: string;
  filters: SiteFilters;
  sort: string;
  last_search: { query: string; filters: Record<string, unknown>; actor: Actor; at: string; product_ids: string[] } | null;
  activity: Activity[];
  /** Site actions since the agent's last turn: fed into the next prompt. */
  pendingForAgent: Activity[];
  meta: Map<string, ConstraintMeta>;
  /** B16: the shop-http account object for the persona this session is signed in as (null = guest). */
  account: any | null;
  /** The last tender-preview result: the payment step signs the mandate with its tender_hash. */
  tender: TenderView | null;
  could_not: CouldNot[];
  verifier: { checked_at: string | null; verdict: "pass" | "fail" | "unknown" };
  subs: Set<(e: SessionEvent) => void>;
  lastSent: Record<string, string>;
  hydrated: boolean;
}

export type SessionView = ReturnType<typeof buildView>;

const sessions = new Map<string, SiteSession>();
const now = () => new Date().toISOString();

export function getSession(sid: string): SiteSession {
  let s = sessions.get(sid);
  if (!s) {
    s = {
      sid,
      version: 0,
      store_id: "4108",
      query: "",
      filters: {},
      sort: "relevance",
      last_search: null,
      activity: [],
      pendingForAgent: [],
      meta: new Map(),
      account: null,
      tender: null,
      could_not: [],
      verifier: { checked_at: null, verdict: "unknown" },
      subs: new Set(),
      lastSent: {},
      hydrated: false,
    };
    sessions.set(sid, s);
  }
  return s;
}

/** First touch after a bff restart: the cart and store survive in shop-http, so read them back. */
export async function hydrate(sid: string) {
  const s = getSession(sid);
  if (s.hydrated) return;
  const ctx = getThread(sid);
  const [cart, store, account] = await Promise.all([
    jfetch(`${config.shopHttpUrl}/cart/${encodeURIComponent(sid)}`, { timeoutMs: 5000 }),
    jfetch(`${config.shopHttpUrl}/sessions/${encodeURIComponent(sid)}/store`, { timeoutMs: 5000 }),
    // The persona lives in shop-http, so a bff restart restores it instead of dropping to guest.
    jfetch(`${config.shopHttpUrl}/sessions/${encodeURIComponent(sid)}/account`, { timeoutMs: 5000 }),
  ]);
  if (cart.ok && cart.data?.cart) applyCart(ctx, cart.data.cart);
  if (store.ok && store.data?.store_id) s.store_id = String(store.data.store_id);
  if (account.ok) s.account = account.data?.account_id ? account.data.account : null;
  if (cart.ok) s.hydrated = true;
}

/** The persona badge: id, name and the persona's purpose line. Synthetic demo shopper, always. */
export function accountRef(account: any | null): AccountRef | null {
  if (!account || !account.account_id) return null;
  return { account_id: String(account.account_id), name: String(account.name ?? account.account_id), tagline: String(account.label ?? account.tagline ?? ""), synthetic: true };
}

export function walletSummary(account: any | null): WalletSummary {
  const pms: any[] = Array.isArray(account?.payment_methods) ? account.payment_methods : [];
  const d = pms.find((p) => p.is_default) ?? null;
  return {
    count: pms.length,
    default: d ? { pm_id: String(d.pm_id), kind: String(d.kind), brand: d.brand ?? null, last4: d.last4 ?? null, outcome: d.outcome ?? null } : null,
  };
}

export function addressSummary(account: any | null): AddressSummary {
  const adrs: any[] = Array.isArray(account?.addresses) ? account.addresses : [];
  const d = adrs.find((a) => a.is_default) ?? null;
  return {
    count: adrs.length,
    default: d ? { address_id: String(d.address_id), label: String(d.display ?? d.line1 ?? d.address_id), city: d.city ?? null, region: d.region ?? null } : null,
  };
}

/** Map a shop-http tender-preview response into the SessionView.tender shape. Refusals are kept. */
export function tenderView(data: any): TenderView | null {
  if (!data || typeof data !== "object") return null;
  const plan: any[] = Array.isArray(data.plan) ? data.plan : [];
  return {
    plan: plan.map((p) => ({
      pm_id: String(p.pm_id),
      amount: Number(p.amount ?? 0),
      kind: p.kind ?? null,
      brand: p.brand ?? null,
      last4: p.last4 ?? null,
      display: p.display ?? null,
      covers: p.covers ?? null,
      label: p.label ?? null,
    })),
    tender_hash: data.tender_hash ?? null,
    refusals: Array.isArray(data.refusals) ? data.refusals : [],
    total: data.total ?? null,
    covered_total: data.covered_total ?? null,
    uncovered: data.uncovered ?? null,
    split_tender: Boolean(data.split_tender),
    ok: data.ok !== false,
  };
}

/** Record the persona (shop-http is the source of truth; this mirrors it into the shared view). */
export function setAccount(sid: string, account: any | null) {
  getSession(sid).account = account && account.account_id ? account : null;
}

export function setTender(sid: string, data: any | null) {
  getSession(sid).tender = data === null ? null : tenderView(data);
}

export function buildView(s: SiteSession, ctx: ThreadCtx) {
  const st = ctx.state;
  return {
    session_id: s.sid,
    version: s.version,
    store_id: s.store_id,
    query: s.query,
    filters: s.filters,
    sort: s.sort,
    last_search: s.last_search,
    cart: {
      items: st.cart.map((l) => ({ product_id: l.product_id, title: l.title, price: l.price, qty: l.qty, line_total: Math.round(l.price * l.qty * 100) / 100 })),
      total: st.cart_total,
      item_count: st.cart.reduce((a, l) => a + l.qty, 0),
    },
    budget: st.budget ?? null,
    constraints: st.constraints.map((c) => {
      const id = constraintId(c);
      const m = s.meta.get(id);
      return { ...c, id, source: m?.source ?? "chat", source_text: m?.source_text, applies_as: appliesAs(c) };
    }),
    could_not: s.could_not,
    activity: s.activity.slice(-30),
    mandate: st.mandate ?? null,
    verifier: s.verifier,
    // B16 (additive top-level keys: publish() diffs top-level keys, so STATE_DELTA is unchanged)
    account: accountRef(s.account),
    wallet: walletSummary(s.account),
    addresses: addressSummary(s.account),
    tender: s.tender,
    // Wave 0b (additive): memory, HITL actions + audit, watches, notifications, mission plan
    ...assistView(s.sid),
  };
}

export function view(sid: string) {
  return buildView(getSession(sid), getThread(sid));
}

export function subscribe(sid: string, fn: (e: SessionEvent) => void) {
  const s = getSession(sid);
  s.subs.add(fn);
  const snap = buildView(s, getThread(sid));
  fn({ type: "STATE_SNAPSHOT", snapshot: snap, version: s.version });
  return () => s.subs.delete(fn);
}

/** Diff against what subscribers last saw and publish the changed keys. */
export function publish(sid: string, actor: Actor, reason: string) {
  const s = sessions.get(sid);
  if (!s) return;
  const v = buildView(s, getThread(sid));
  const delta: { op: "add"; path: string; value: unknown }[] = [];
  for (const [k, val] of Object.entries(v)) {
    if (k === "version") continue;
    const j = JSON.stringify(val);
    if (s.lastSent[k] !== j) {
      delta.push({ op: "add", path: `/${k}`, value: val });
      s.lastSent[k] = j;
    }
  }
  if (!delta.length) return;
  s.version += 1;
  delta.push({ op: "add", path: "/version", value: s.version });
  const e: SessionEvent = { type: "STATE_DELTA", delta, version: s.version, actor, reason };
  for (const fn of s.subs) {
    try {
      fn(e);
    } catch {
      /* a dead subscriber is removed on close */
    }
  }
}

export function log(sid: string, actor: Actor, kind: string, summary: string) {
  const s = getSession(sid);
  const a = { id: randomUUID().slice(0, 8), at: now(), actor, kind, summary };
  s.activity.push(a);
  if (s.activity.length > 100) s.activity.splice(0, s.activity.length - 100);
  if (actor === "site") s.pendingForAgent.push(a);
  return a;
}

/** Called when the agent builds its prompt: what the shopper did on the site since the last turn. */
export function takeSiteActivity(sid: string): string[] {
  const s = sessions.get(sid);
  if (!s) return [];
  const out = s.pendingForAgent.map((a) => `${a.at} ${a.summary}`);
  s.pendingForAgent = [];
  return out;
}

export function noteConstraints(sid: string, before: ConstraintEntry[], after: ConstraintEntry[], source: ConstraintMeta["source"], text?: string) {
  const s = getSession(sid);
  const had = new Set(before.map(constraintId));
  for (const c of after) {
    const id = constraintId(c);
    if (!had.has(id) && !s.meta.has(id)) s.meta.set(id, { source, source_text: text?.slice(0, 240), at: now() });
  }
}

// ---------------------------------------------------------------- verifier facts

const dietCache = new Map<string, string[]>();

async function factsFor(ctx: ThreadCtx, storeId: string): Promise<LineFacts[]> {
  return factsForLines(ctx.state.cart, storeId);
}

/** Catalogue facts for any set of lines (cart or a draft mission plan). */
export async function factsForLines(lines: { product_id: string; title: string; qty: number; price: number }[], storeId: string): Promise<LineFacts[]> {
  if (!lines.length) return [];
  const ids = lines.map((l) => l.product_id);
  const missing = ids.filter((id) => !dietCache.has(id));
  await Promise.all(
    missing.map(async (id) => {
      const r = await jfetch(`${config.searchSvcUrl}/product/${encodeURIComponent(id)}`, { timeoutMs: 8000 });
      if (r.ok && Array.isArray(r.data?.dietary)) dietCache.set(id, r.data.dietary.map(String));
    }),
  );
  const q = await jfetch(`${config.shopHttpUrl}/catalog-services/quotes`, { method: "POST", body: JSON.stringify({ product_ids: ids, store_id: storeId }), timeoutMs: 8000 });
  const quotes: Record<string, any> = (q.ok && q.data?.quotes) || {};
  return lines.map((l) => {
    const qt = quotes[l.product_id];
    const invOk = qt?.inventory && qt.inventory.status !== "unavailable";
    const eligOk = qt?.eligibility && qt.eligibility.status !== "unavailable";
    return {
      product_id: l.product_id,
      title: l.title,
      qty: l.qty,
      price: l.price,
      dietary: dietCache.get(l.product_id) ?? null,
      in_stock: invOk ? Boolean(qt.inventory.in_stock) : null,
      snap_eligible: eligOk ? Boolean(qt.eligibility.snap_eligible) : null,
      age_restricted: eligOk ? Boolean(qt.eligibility.age_restricted) : null,
    };
  });
}

/** B09 on a draft mission plan: same verifier, plan lines instead of the cart (nothing is written to the cart). */
export async function verifyPlan(sid: string, lines: { product_id: string; title: string; qty: number; price: number }[]) {
  const s = getSession(sid);
  const ctx = getThread(sid);
  const facts = await factsForLines(lines, s.store_id);
  const total = Math.round(lines.reduce((a, l) => a + l.price * l.qty, 0) * 100) / 100;
  return verifySession({ constraints: ctx.state.constraints, lines: facts, budget: ctx.state.budget ?? null, cart_total: total, store_id: s.store_id });
}

/** Run the B09 verifier against the real cart and write the result into the shared state. */
export async function runVerifier(sid: string) {
  const s = getSession(sid);
  const ctx = getThread(sid);
  const lines = await factsFor(ctx, s.store_id);
  const r = verifySession({ constraints: ctx.state.constraints, lines, budget: ctx.state.budget ?? null, cart_total: ctx.state.cart_total, store_id: s.store_id });
  ctx.state.constraints = r.constraints;
  s.could_not = r.could_not;
  s.verifier = { checked_at: now(), verdict: r.verdict };
  return r;
}

// ---------------------------------------------------------------- agent hooks (called from agui/bridge.ts)

/** A shopper-plane tool result: mirror agent searches and cart changes into the session. */
export function onAgentTool(sid: string, tool: string, input: any, data: any) {
  if (!data || typeof data !== "object" || data.error || data.blocked) return;
  const s = getSession(sid);
  if (tool === "search_products" && Array.isArray(data.results)) {
    const query = String(input?.query ?? data.query ?? "");
    const filters: Record<string, unknown> = {};
    if (Array.isArray(input?.dietary) && input.dietary.length) filters.dietary = input.dietary;
    if (input?.max_price != null) filters.max_price = Number(input.max_price);
    s.query = query;
    s.last_search = { query, filters, actor: "agent", at: now(), product_ids: data.results.map((r: any) => String(r.product_id)) };
    log(sid, "agent", "search", `Compass searched for “${query}” (${data.results.length} results)`);
  } else if (data.cart && /add_to_cart|remove_from_cart/.test(tool)) {
    const pid = String(input?.product_id ?? "");
    const title = getThread(sid).state.cart.find((l) => l.product_id === pid)?.title ?? pid;
    log(sid, "agent", tool === "add_to_cart" ? "cart_add" : "cart_remove", tool === "add_to_cart" ? `Compass added ${title} to the cart` : `Compass removed ${pid} from the cart`);
  } else if (tool === "create_checkout_mandate" && data.mandate) {
    log(sid, "agent", "mandate", `Compass created a checkout mandate (cap $${Number(data.mandate.spend_cap).toFixed(2)}) awaiting your approval`);
  }
}
