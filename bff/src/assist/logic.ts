/**
 * Wave 0b assistant capabilities: pure logic (no I/O), unit-tested in logic.test.ts.
 *
 * Every fact these functions work with is passed in by the caller from a live service
 * (search-svc, shop-http catalogue services, the orders table). Nothing here invents a price,
 * a stock level or a product: missing inputs produce "unknown", never a guess.
 */
import { randomUUID } from "node:crypto";

export const SYNTHETIC_LABEL = "synthetic commerce data (ESCI has no price or stock)";
const now = () => new Date().toISOString();
const id = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------- reply language

const ES_WORDS = /\b(hola|quiero|necesito|para|comprar|con|sin|por favor|gracias|busca|buscar|agrega|agregar|añade|carrito|leche|pan|huevos|barato|más|qué|cómo|dónde|mi|mis|una|unos|unas|los|las|del|el|la)\b/gi;
const EN_WORDS = /\b(the|and|for|with|without|please|find|add|cart|my|want|need|buy|cheap|what|how|where|is|are|to|of|a|an)\b/gi;

/** Reply-language auto-detect (EN/ES only). Deterministic, so the agent is told which to use. */
export function detectLang(text: string): "es" | "en" {
  const t = String(text ?? "");
  if (/[ñ¿¡áéíóú]/i.test(t) && !/^[\x00-\x7F]*$/.test(t)) {
    const es = (t.match(ES_WORDS) ?? []).length + 2;
    const en = (t.match(EN_WORDS) ?? []).length;
    return es >= en ? "es" : "en";
  }
  const es = (t.match(ES_WORDS) ?? []).length;
  const en = (t.match(EN_WORDS) ?? []).length;
  return es > en && es >= 2 ? "es" : "en";
}

export function languageInstruction(lang: "es" | "en"): string {
  return lang === "es"
    ? "Reply language (auto-detected from the shopper's message): Spanish. Write your whole answer in Spanish; keep product titles as they appear in the catalogue."
    : "Reply language (auto-detected from the shopper's message): English.";
}

// ---------------------------------------------------------------- memory

export type MemoryKey = "dietary" | "brands" | "store" | "household_size";
export const MEMORY_KEYS: MemoryKey[] = ["dietary", "brands", "store", "household_size"];

export interface MemoryItem {
  id: string;
  key: MemoryKey;
  value: string;
  /** stated = the shopper typed it into the memory panel; inferred = derived from chat, quarantined until confirmed. */
  origin: "stated" | "inferred";
  status: "confirmed" | "quarantined";
  source: string;
  source_text?: string;
  created_at: string;
  updated_at: string;
}

export function validMemory(key: string, value: string): string | null {
  if (!MEMORY_KEYS.includes(key as MemoryKey)) return `key must be one of ${MEMORY_KEYS.join(", ")}`;
  const v = String(value ?? "").trim();
  if (!v || v.length > 80) return "value must be 1-80 characters";
  if (key === "household_size" && !/^\d{1,2}$/.test(v)) return "household_size must be a whole number";
  if (key === "store" && !/^\d{4}$/.test(v)) return "store must be a 4-digit store id";
  return null;
}

const sameMem = (a: { key: string; value: string }, b: { key: string; value: string }) => a.key === b.key && a.value.toLowerCase() === b.value.toLowerCase();

/** The shopper adds a memory explicitly: confirmed on creation (the act of saving is the confirmation). */
export function addStated(list: MemoryItem[], key: MemoryKey, value: string, source = "memory panel"): MemoryItem[] {
  const hit = list.find((m) => sameMem(m, { key, value }));
  if (hit) return list.map((m) => (m === hit ? { ...m, status: "confirmed", origin: "stated", source, updated_at: now() } : m));
  const t = now();
  return [...list, { id: id("mem"), key, value: value.trim(), origin: "stated", status: "confirmed", source, created_at: t, updated_at: t }];
}

/** Something inferred from chat: quarantined, never used by the agent until the shopper confirms. */
export function addInferred(list: MemoryItem[], key: MemoryKey, value: string, sourceText: string): MemoryItem[] {
  if (list.some((m) => sameMem(m, { key, value }))) return list;
  const t = now();
  return [...list, { id: id("mem"), key, value: value.trim(), origin: "inferred", status: "quarantined", source: "inferred from chat", source_text: sourceText.slice(0, 200), created_at: t, updated_at: t }];
}

export const confirmMemory = (list: MemoryItem[], mid: string) => list.map((m) => (m.id === mid ? { ...m, status: "confirmed" as const, updated_at: now() } : m));
export const editMemory = (list: MemoryItem[], mid: string, value: string) => list.map((m) => (m.id === mid ? { ...m, value: value.trim(), status: "confirmed" as const, updated_at: now() } : m));
export const deleteMemory = (list: MemoryItem[], mid: string) => list.filter((m) => m.id !== mid);

/** Only confirmed memory reaches the agent prompt. */
export function memoryPromptLines(list: MemoryItem[]): string[] {
  const ok = list.filter((m) => m.status === "confirmed");
  if (!ok.length) return [];
  return [`Shopper memory (confirmed by the shopper; honour it): ${ok.map((m) => `${m.key}=${m.value}`).join("; ")}.`];
}

/** Map chat constraints to memory candidates (dietary only; budget is per-mission, not memory). */
export function inferFromConstraints(constraints: { key: string; value: string }[]): { key: MemoryKey; value: string }[] {
  const out: { key: MemoryKey; value: string }[] = [];
  for (const c of constraints) {
    if (/diet|allerg/i.test(c.key)) out.push({ key: "dietary", value: c.value.replace(/ option required$/, "") });
    const n = /headcount/i.test(c.key) ? /(\d{1,2})/.exec(c.value)?.[1] : undefined;
    if (n) out.push({ key: "household_size", value: n });
  }
  return out;
}

// ---------------------------------------------------------------- HITL pending actions + audit

export interface PendingAction {
  id: string;
  kind: "cart_add" | "cart_remove" | "reorder_add";
  product_id: string;
  title: string;
  qty: number;
  price: number | null;
  proposed_by: "agent" | "reorder";
  reason: string;
  status: "pending" | "approved" | "rejected" | "undone" | "failed";
  created_at: string;
  decided_at?: string;
  note?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action_id: string;
  event: "proposed" | "approved" | "rejected" | "undone" | "failed";
  actor: "agent" | "shopper" | "system";
  summary: string;
}

export function propose(list: PendingAction[], p: Omit<PendingAction, "id" | "status" | "created_at">): { list: PendingAction[]; action: PendingAction } {
  // The same pending proposal twice (agent retry) collapses into one.
  const dup = list.find((a) => a.status === "pending" && a.kind === p.kind && a.product_id === p.product_id);
  if (dup) return { list: list.map((a) => (a === dup ? { ...a, qty: p.qty } : a)), action: { ...dup, qty: p.qty } };
  const action: PendingAction = { ...p, id: id("act"), status: "pending", created_at: now() };
  return { list: [...list, action], action };
}

export function transition(a: PendingAction, to: PendingAction["status"]): string | null {
  const ok: Record<string, string[]> = { pending: ["approved", "rejected", "failed"], approved: ["undone"], rejected: [], undone: [], failed: [] };
  return ok[a.status]?.includes(to) ? null : `cannot move ${a.status} action to ${to}`;
}

export function audit(actionId: string, event: AuditEntry["event"], actor: AuditEntry["actor"], summary: string): AuditEntry {
  return { id: id("aud"), at: now(), action_id: actionId, event, actor, summary };
}

// ---------------------------------------------------------------- units + compare

/** Parse a pack size from an ESCI title, e.g. "16 Ounce (Pack of 2)" -> {amount: 32, unit: "oz"}. */
export function parseSize(title: string): { amount: number; unit: string; label: string } | null {
  const t = String(title ?? "");
  const pack = Number(/pack of (\d+)/i.exec(t)?.[1] ?? /(\d+)\s*-?\s*(?:pack|pk|count|ct)\b/i.exec(t)?.[1] ?? 1) || 1;
  const m = /(\d+(?:\.\d+)?)\s*-?\s*(fl\.?\s*oz|ounces?|oz|lbs?|pounds?|grams?|g|kg|ml|l|liters?|litres?)\b/i.exec(t);
  if (!m) return null;
  let amount = Number(m[1]);
  let unit = m[2].toLowerCase().replace(/\s|\./g, "");
  if (/^(ounces?|oz)$/.test(unit)) unit = "oz";
  else if (/^floz$/.test(unit)) unit = "fl oz";
  else if (/^(lbs?|pounds?)$/.test(unit)) {
    amount *= 16;
    unit = "oz";
  } else if (/^(grams?|g)$/.test(unit)) unit = "g";
  else if (unit === "kg") {
    amount *= 1000;
    unit = "g";
  } else if (/^(l|liters?|litres?)$/.test(unit)) {
    amount *= 1000;
    unit = "ml";
  }
  const total = Math.round(amount * pack * 100) / 100;
  return { amount: total, unit, label: `${total} ${unit}${pack > 1 ? ` (${pack} pack)` : ""}` };
}

export interface CompareInput {
  product_id: string;
  title: string;
  brand?: string;
  rating?: number | null;
  dietary?: string[] | null;
  price: number | null;
  in_stock: boolean | null;
}

export interface CompareRow extends CompareInput {
  size_label: string;
  unit_price: number | null;
  unit_price_label: string;
}

export function compareProducts(items: CompareInput[], wantDietary: string[] = []) {
  const rows: CompareRow[] = items.map((p) => {
    const size = parseSize(p.title);
    const unit = size && p.price != null && size.amount > 0 ? Math.round((p.price / size.amount) * 1000) / 1000 : null;
    return { ...p, size_label: size?.label ?? "size not stated", unit_price: unit, unit_price_label: unit != null && size ? `$${unit.toFixed(3)}/${size.unit}` : "n/a" };
  });
  const eligible = rows.filter((r) => r.in_stock === true && r.price != null && wantDietary.every((d) => (r.dietary ?? []).includes(d)));
  let recommendation: { product_id: string; reason: string } | null = null;
  if (eligible.length) {
    const units = new Set(eligible.map((r) => parseSize(r.title)?.unit ?? "?"));
    const comparableUnits = eligible.every((r) => r.unit_price != null) && units.size === 1;
    const best = [...eligible].sort((a, b) => (comparableUnits ? a.unit_price! - b.unit_price! : a.price! - b.price!) || (b.rating ?? 0) - (a.rating ?? 0))[0];
    const why = comparableUnits ? `lowest unit price (${best.unit_price_label})` : `lowest shelf price ($${best.price!.toFixed(2)}; unit prices not comparable)`;
    recommendation = {
      product_id: best.product_id,
      reason: `${best.title.slice(0, 60)}: ${why}, in stock${wantDietary.length ? `, tagged ${wantDietary.join(", ")}` : ""}${best.rating ? `, rated ${best.rating}` : ""}.`,
    };
  }
  const excluded = rows.filter((r) => !eligible.includes(r)).map((r) => ({ product_id: r.product_id, why: r.in_stock !== true ? (r.in_stock === false ? "out of stock" : "stock unknown") : r.price == null ? "price unavailable" : `not tagged ${wantDietary.join(", ")}` }));
  return { rows, recommendation, excluded, synthetic_label: SYNTHETIC_LABEL };
}

// ---------------------------------------------------------------- watches

export interface Watch {
  id: string;
  kind: "price_drop" | "back_in_stock";
  product_id: string;
  title: string;
  store_id: string;
  baseline_price: number | null;
  target_price: number | null;
  last_price: number | null;
  last_in_stock: boolean | null;
  last_checked_at: string | null;
  status: "active" | "triggered";
  created_at: string;
}

export interface Notification {
  id: string;
  at: string;
  watch_id: string;
  text: string;
  read: boolean;
}

export function newWatch(kind: Watch["kind"], product_id: string, title: string, store_id: string, price: number | null, in_stock: boolean | null, target?: number | null): Watch {
  return { id: id("w"), kind, product_id, title, store_id, baseline_price: price, target_price: target ?? null, last_price: price, last_in_stock: in_stock, last_checked_at: now(), status: "active", created_at: now() };
}

/** Evaluate one watch against a fresh quote. Returns the updated watch and a notification if it fired. */
export function evaluateWatch(w: Watch, quote: { price: number | null; in_stock: boolean | null }): { watch: Watch; note: Notification | null } {
  const next: Watch = { ...w, last_checked_at: now(), last_price: quote.price ?? w.last_price, last_in_stock: quote.in_stock ?? w.last_in_stock };
  if (w.status !== "active") return { watch: next, note: null };
  let text: string | null = null;
  if (w.kind === "price_drop" && quote.price != null) {
    const threshold = w.target_price ?? w.baseline_price;
    if (threshold != null && quote.price < threshold) text = `Price drop: ${w.title.slice(0, 60)} is now $${quote.price.toFixed(2)} (was $${(w.baseline_price ?? threshold).toFixed(2)}) at store ${w.store_id}.`;
  } else if (w.kind === "back_in_stock" && quote.in_stock === true && w.last_in_stock !== true) {
    text = `Back in stock: ${w.title.slice(0, 60)} at store ${w.store_id}.`;
  }
  if (!text) return { watch: next, note: null };
  return { watch: { ...next, status: "triggered" }, note: { id: id("n"), at: now(), watch_id: w.id, text: `${text} (${SYNTHETIC_LABEL})`, read: false } };
}

// ---------------------------------------------------------------- reorder

export interface OrderLike {
  order_id?: string;
  created_at?: string;
  lines?: { product_id: string; title?: string; qty?: number; price?: number }[];
  items?: { product_id: string; title?: string; qty?: number; price?: number }[];
}

/** "My usual": products bought in the most orders, with their typical quantity. */
export function usualBasket(orders: OrderLike[], max = 8) {
  const agg = new Map<string, { product_id: string; title: string; orders: number; qty: number[] }>();
  for (const o of orders) {
    const seen = new Set<string>();
    for (const l of o.lines ?? o.items ?? []) {
      if (!l?.product_id || seen.has(l.product_id)) continue;
      seen.add(l.product_id);
      const a = agg.get(l.product_id) ?? { product_id: l.product_id, title: l.title ?? l.product_id, orders: 0, qty: [] };
      a.orders += 1;
      a.qty.push(Number(l.qty ?? 1));
      agg.set(l.product_id, a);
    }
  }
  return [...agg.values()]
    .sort((a, b) => b.orders - a.orders || a.title.localeCompare(b.title))
    .slice(0, max)
    .map((a) => {
      const q = [...a.qty].sort((x, y) => x - y);
      return { product_id: a.product_id, title: a.title, qty: q[Math.floor((q.length - 1) / 2)], in_orders: a.orders };
    });
}

// ---------------------------------------------------------------- mission plan

export interface PlanLine {
  id: string;
  ingredient: string;
  product_id: string;
  title: string;
  price: number | null;
  qty: number;
}

export interface MissionPlan {
  id: string;
  goal: string;
  source: string;
  lines: PlanLine[];
  omissions: { ingredient: string; reason: string }[];
  status: "draft" | "added_to_cart";
  verifier: { checked_at: string | null; verdict: "pass" | "fail" | "unknown"; could_not: { constraint: string; reason: string }[] };
  edits: number;
  updated_at: string;
}

export function planFromMealTool(data: any): MissionPlan | null {
  if (!data || !Array.isArray(data.items)) return null;
  return {
    id: id("plan"),
    goal: String(data.goal ?? data.recipe ?? "mission"),
    source: `plan_meal (${data.recipe ?? "recipe"}) via policy-mcp`,
    lines: data.items.map((i: any) => ({ id: id("pl"), ingredient: String(i.ingredient ?? ""), product_id: String(i.product_id), title: String(i.title ?? i.product_id), price: typeof i.price === "number" ? i.price : null, qty: Math.max(1, Number(i.qty ?? 1)) })),
    omissions: Array.isArray(data.omissions) ? data.omissions : [],
    status: "draft",
    verifier: { checked_at: null, verdict: "unknown", could_not: [] },
    edits: 0,
    updated_at: now(),
  };
}

export function editPlan(plan: MissionPlan, op: { type: "qty"; line_id: string; qty: number } | { type: "remove"; line_id: string } | { type: "swap"; line_id: string; product_id: string; title: string; price: number | null }): MissionPlan | string {
  const line = plan.lines.find((l) => l.id === op.line_id);
  if (!line) return `no plan line ${op.line_id}`;
  let lines = plan.lines;
  if (op.type === "qty") {
    if (!Number.isInteger(op.qty) || op.qty < 1 || op.qty > 5) return "qty must be an integer 1-5 (policy max 5)";
    lines = lines.map((l) => (l === line ? { ...l, qty: op.qty } : l));
  } else if (op.type === "remove") lines = lines.filter((l) => l !== line);
  else lines = lines.map((l) => (l === line ? { ...l, product_id: op.product_id, title: op.title, price: op.price } : l));
  return { ...plan, lines, edits: plan.edits + 1, updated_at: now() };
}

// ---------------------------------------------------------------- citations

export type Tier = "T1" | "T2" | "T3";
export interface Attribute {
  name: string;
  value: unknown;
  tier: Tier;
  source: string;
}

/** A grounded claim chip: the attribute it rests on, its tier, and wording that is uncertain for T3. */
export function citeClaims(productId: string, attrs: Attribute[], names: string[] = ["dietary", "price", "stock_qty", "rating", "snap_eligible", "may_contain_nuts", "bullets"]) {
  return attrs
    .filter((a) => names.includes(a.name) && a.value != null && !(Array.isArray(a.value) && !a.value.length))
    .map((a) => {
      const val = Array.isArray(a.value) ? a.value.slice(0, 2).join(", ").replace(/_/g, " ") : String(a.value);
      const base = `${a.name.replace(/_/g, " ")}: ${val}`;
      return {
        product_id: productId,
        attribute: a.name,
        tier: a.tier,
        source: a.source,
        text: a.tier === "T3" ? `Possibly ${base} (unverified, ${a.source})` : base,
        uncertain: a.tier === "T3",
        href: `/shop/p/${encodeURIComponent(productId)}#attr-${a.name}`,
      };
    });
}

// ---------------------------------------------------------------- clarify / follow-ups

export interface FollowUps {
  clarify: { question: string; options: string[] } | null;
  followups: string[];
}

/** Validate the cheap model's JSON: at most ONE clarifying question with 2-4 short options, max 3 follow-ups. */
export function normaliseFollowUps(raw: any): FollowUps {
  const s = (x: unknown, n: number) => String(x ?? "").trim().slice(0, n);
  const followups = (Array.isArray(raw?.followups) ? raw.followups : []).map((x: unknown) => s(x, 80)).filter(Boolean).slice(0, 3);
  const q = raw?.clarify;
  const opts = (Array.isArray(q?.options) ? q.options : []).map((x: unknown) => s(x, 40)).filter(Boolean).slice(0, 4);
  const clarify = q && s(q.question, 160) && opts.length >= 2 ? { question: s(q.question, 160), options: opts } : null;
  return { clarify, followups };
}

// ---------------------------------------------------------------- photo extraction

export interface PhotoItem {
  name: string;
  attributes: string[];
  query: string;
}

export function normalisePhotoItems(raw: any): PhotoItem[] {
  const arr = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
  return arr
    .map((x: any) => {
      const name = String(x?.name ?? "").trim().slice(0, 60);
      const attributes = (Array.isArray(x?.attributes) ? x.attributes : []).map((a: unknown) => String(a).trim().slice(0, 30)).filter(Boolean).slice(0, 5);
      const query = String(x?.query ?? [...attributes, name].join(" ")).trim().slice(0, 80);
      return { name, attributes, query };
    })
    .filter((x: PhotoItem) => x.name && x.query)
    .slice(0, 5);
}

// ---------------------------------------------------------------- feedback (technique 29 online-eval sample)

export function feedbackSample(input: { session_id: string; message_id: string; rating: string; reason?: string; comment?: string; question?: string; answer?: string; run_id?: string }) {
  if (input.rating !== "up" && input.rating !== "down") return { error: "rating must be up or down" };
  if (!input.message_id) return { error: "message_id required" };
  return {
    sample: {
      id: id("fb"),
      technique: 29,
      kind: "online_eval_feedback",
      at: now(),
      session_id: input.session_id,
      run_id: input.run_id ?? null,
      message_id: input.message_id,
      label: input.rating === "up" ? 1 : 0,
      reason: String(input.reason ?? "").slice(0, 60),
      comment: String(input.comment ?? "").slice(0, 500),
      question: String(input.question ?? "").slice(0, 1000),
      answer: String(input.answer ?? "").slice(0, 4000),
    },
  };
}
