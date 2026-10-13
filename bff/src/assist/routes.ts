/**
 * Wave 0b assistant HTTP API. Every route reads live services (search-svc, shop-http catalogue
 * services, the Claude CLI). A service that is down is reported, never substituted.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { completedObjects, completedStrings } from "../lib/partialJson.js";
import { openSse, wantsStream } from "../lib/sse.js";
import { hashKey, TtlCache } from "../lib/ttlCache.js";

/** Phase 2 response caches (input hash + TTL). A hit is labelled cached with its age. */
export const responseCaches = { followups: new TtlCache<any>(10 * 60_000), starters: new TtlCache<any>(5 * 60_000), compare: new TtlCache<any>(60_000) };
import { config } from "../config.js";
import { jfetch } from "../lib/http.js";
import { runClaudeCode } from "../llm/claudeCode.js";
import * as metrics from "../metrics.js";
import { getThread } from "../agui/threadStore.js";
import { applyCart, applyToolResult } from "../agui/stateReducer.js";
import { saveUpload } from "../agui/bridge.js";
import { buildA2ui } from "../agui/a2ui.js";
import { getSession, hydrate, log, publish, runVerifier, verifyPlan, view } from "../session/sessionStore.js";
import {
  addStated,
  audit,
  citeClaims,
  compareProducts,
  confirmMemory,
  deleteMemory,
  editMemory,
  editPlan,
  evaluateWatch,
  feedbackSample,
  newWatch,
  normaliseFollowUps,
  normalisePhotoItems,
  propose,
  SYNTHETIC_LABEL,
  transition,
  usualBasket,
  validMemory,
  type MemoryKey,
  type PendingAction,
} from "./logic.js";
import { allSessions, appendFeedback, assistFor, saveSoon } from "./store.js";
import { endSpan, markSpan, otelContext, redact, startKindSpan } from "../otel.js";
import { noteHitlDecided, parentOf, traceForRun } from "../trace/store.js";

const enc = encodeURIComponent;
const shop = (path: string, init: RequestInit & { timeoutMs?: number } = {}) => jfetch(`${config.shopHttpUrl}${path}`, { timeoutMs: 15_000, ...init });
const post = (x: unknown) => ({ method: "POST", body: JSON.stringify(x ?? {}) });

function down(reply: FastifyReply, r: { status: number; data: any; error?: string }, what: string, service = "shop-http") {
  if (r.status === 0) return reply.code(503).send({ ok: false, error: `${service} is not reachable: ${what} did not run.`, service_unavailable: { service, detail: r.error } });
  return reply.code(r.status >= 400 ? r.status : 502).send({ ok: false, error: r.data?.detail ?? r.data?.error ?? `${service} ${r.status}` });
}

function changed(sid: string, actor: "site" | "agent" | "system", reason: string) {
  saveSoon();
  publish(sid, actor, reason);
}

/** One tool-less single-turn CLI call that must return JSON. Returns parsed JSON, cost and latency. */
export async function jsonCall(prompt: string, opts: { model?: string; tools?: string; systemPrompt: string; label: string; timeoutMs?: number; onText?: (soFar: string, delta: string) => void; signal?: AbortSignal; runId?: string; thinking?: boolean }) {
  const ac = new AbortController();
  const hard = setTimeout(() => ac.abort(), opts.timeoutMs ?? 120_000);
  opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
  let soFar = "";
  const t0 = Date.now();
  let text = "";
  let cost: number | null = null;
  let tokens = { input: 0, output: 0 };
  const res = await runClaudeCode({
    prompt,
    systemPrompt: opts.systemPrompt,
    model: opts.model ?? config.models.critic,
    maxTurns: opts.tools ? 3 : 1,
    role: opts.label,
    runId: opts.runId,
    thinking: opts.thinking,
    streamPartial: Boolean(opts.onText),
    tools: opts.tools ?? "",
    allowedTools: opts.tools ? opts.tools.split(",") : undefined,
    signal: ac.signal,
    idleTimeoutMs: 90_000,
    sink: (e) => {
      if (e.type === "token") {
        soFar += e.text;
        opts.onText?.(soFar, e.text);
      } else if (e.type === "usage") {
        text = e.resultText;
        cost = e.costUsd;
        tokens = { input: e.input, output: e.output };
      }
    },
  });
  clearTimeout(hard);
  const ms = Date.now() - t0;
  metrics.record("claude", { ms, costUsd: cost ?? 0, inputTokens: tokens.input, outputTokens: tokens.output, label: opts.label });
  let data: any = null;
  const m = /\{[\s\S]*\}/.exec(text ?? "");
  try {
    data = m ? JSON.parse(m[0]) : null;
  } catch {
    data = null;
  }
  return { ok: Boolean(res.ok || text), data, cost_usd: cost, latency_ms: ms, tokens, model: opts.model ?? config.models.critic, reason: res.reason };
}

async function quote(pid: string, store: string) {
  const r = await shop(`/catalog-services/quote/${enc(pid)}?store_id=${enc(store)}&fresh=true`);
  if (!r.ok) return null;
  const pr = r.data?.price;
  const inv = r.data?.inventory;
  return {
    price: pr && pr.status !== "unavailable" && typeof pr.price === "number" ? pr.price : null,
    in_stock: inv && inv.status !== "unavailable" ? Boolean(inv.in_stock) : null,
  };
}

/** Evaluate every active watch against the catalogue services. Called on a timer and on demand. */
export async function evaluateWatches(only?: string) {
  let fired = 0;
  for (const [sid, a] of allSessions()) {
    if (only && sid !== only) continue;
    if (!a.watches.some((w) => w.status === "active")) continue;
    let any = false;
    for (let i = 0; i < a.watches.length; i++) {
      const w = a.watches[i];
      if (w.status !== "active") continue;
      const q = await quote(w.product_id, w.store_id);
      if (!q) continue; // service down: the watch is left untouched, never "evaluated" on a guess
      const r = evaluateWatch(w, q);
      a.watches[i] = r.watch;
      any = true;
      if (r.note) {
        a.notifications.push(r.note);
        fired++;
      }
    }
    if (any) changed(sid, "system", "watch_eval");
  }
  return fired;
}

export function startWatchTimer() {
  const ms = Number(process.env.WATCH_INTERVAL_MS ?? 60_000);
  const t = setInterval(() => void evaluateWatches().catch(() => undefined), ms);
  t.unref?.();
}

/** HITL: the agent's cart change becomes a pending proposal (called from the bridge on a policy-mcp hitl refusal). */
export function recordProposal(sid: string, p: Omit<PendingAction, "id" | "status" | "created_at">) {
  const a = assistFor(sid);
  const r = propose(a.pending_actions, p);
  a.pending_actions = r.list;
  a.audit.push(audit(r.action.id, "proposed", p.proposed_by === "agent" ? "agent" : "system", `${p.kind === "cart_remove" ? "Remove" : "Add"} ${p.title} × ${p.qty}: ${p.reason}`));
  log(sid, "agent", "proposal", `Compass proposed: ${p.kind === "cart_remove" ? "remove" : "add"} ${p.title} × ${p.qty} (awaiting your approval)`);
  changed(sid, "agent", "proposal");
  return r.action;
}

async function execute(sid: string, act: PendingAction, inverse = false) {
  const add = (act.kind !== "cart_remove") !== inverse;
  if (add) {
    const r = await shop(`/cart/${enc(sid)}/items`, post({ product_id: act.product_id, qty: act.qty }));
    if (r.ok) applyToolResult(getThread(sid), "add_to_cart", r.data);
    return r;
  }
  const cur = getThread(sid).state.cart.find((l) => l.product_id === act.product_id)?.qty ?? 0;
  const left = Math.max(0, cur - act.qty);
  const r = left > 0 ? await shop(`/cart/${enc(sid)}/items/${enc(act.product_id)}`, { method: "PUT", body: JSON.stringify({ qty: left }) }) : await shop(`/cart/${enc(sid)}/items/${enc(act.product_id)}`, { method: "DELETE" });
  const c = await shop(`/cart/${enc(sid)}`);
  if (c.ok && c.data?.cart) applyCart(getThread(sid), c.data.cart);
  return r;
}

const STARTER_CATS = /grocery|household|health|baby|pet|beauty|kitchen/i;

export function registerAssistRoutes(app: FastifyInstance) {
  // ---------------- empty-state prompt starters (real ESCI queries) ----------------
  app.get("/api/assist/starters", async (req, reply) => {
    const sh = config.optimise.cache ? responseCaches.starters.get("starters") : null;
    if (sh) return { ...sh.value, cached: true, cache_age_ms: sh.ageMs };
    const r = await jfetch(`${config.searchSvcUrl}/queries/sample?n=60`, { timeoutMs: 10_000 });
    if (!r.ok || !Array.isArray(r.data)) return down(reply, r as any, "query sample", "search-svc");
    const picks = (r.data as any[]).filter((q) => STARTER_CATS.test(q.category) && q.query.split(" ").length >= 2 && q.query.length <= 48);
    const seen = new Set<string>();
    const out = [];
    for (const q of picks) {
      if (seen.has(q.category)) continue;
      seen.add(q.category);
      out.push({ query: q.query, category: q.category, query_id: q.query_id });
      if (out.length === 4) break;
    }
    const body = { starters: out, provenance: { service: "search-svc", endpoint: "GET /queries/sample", note: "real Amazon ESCI shopper queries" } };
    if (config.optimise.cache && out.length) responseCaches.starters.set("starters", body);
    return body;
  });

  // ---------------- memory ----------------
  app.post("/api/session/:sid/memory", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const { key, value } = (req.body ?? {}) as { key?: string; value?: string };
    const bad = validMemory(String(key), String(value));
    if (bad) return reply.code(400).send({ ok: false, error: bad });
    const a = assistFor(sid);
    a.memory = addStated(a.memory, key as MemoryKey, String(value));
    changed(sid, "site", "memory_add");
    return { ok: true, session: view(sid) };
  });
  app.put("/api/session/:sid/memory/:mid", async (req, reply) => {
    const { sid, mid } = req.params as { sid: string; mid: string };
    const a = assistFor(sid);
    const m = a.memory.find((x) => x.id === mid);
    if (!m) return reply.code(404).send({ ok: false, error: `no memory ${mid}` });
    const value = String(((req.body ?? {}) as any).value ?? "");
    const bad = validMemory(m.key, value);
    if (bad) return reply.code(400).send({ ok: false, error: bad });
    a.memory = editMemory(a.memory, mid, value);
    changed(sid, "site", "memory_edit");
    return { ok: true, session: view(sid) };
  });
  app.post("/api/session/:sid/memory/:mid/confirm", async (req, reply) => {
    const { sid, mid } = req.params as { sid: string; mid: string };
    const a = assistFor(sid);
    if (!a.memory.some((x) => x.id === mid)) return reply.code(404).send({ ok: false, error: `no memory ${mid}` });
    a.memory = confirmMemory(a.memory, mid);
    changed(sid, "site", "memory_confirm");
    return { ok: true, session: view(sid) };
  });
  app.delete("/api/session/:sid/memory/:mid", async (req) => {
    const { sid, mid } = req.params as { sid: string; mid: string };
    const a = assistFor(sid);
    a.memory = deleteMemory(a.memory, mid);
    changed(sid, "site", "memory_delete");
    return { ok: true, session: view(sid) };
  });

  // ---------------- HITL actions ----------------
  app.post("/api/session/:sid/actions/:aid/:decision", async (req, reply) => {
    const { sid, aid, decision } = req.params as { sid: string; aid: string; decision: string };
    await hydrate(sid);
    const a = assistFor(sid);
    const act = a.pending_actions.find((x) => x.id === aid);
    if (!act) return reply.code(404).send({ ok: false, error: `no action ${aid}` });
    const to = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : decision === "undo" ? "undone" : null;
    if (!to) return reply.code(400).send({ ok: false, error: "decision must be approve, reject or undo" });
    const bad = transition(act, to);
    if (bad) return reply.code(409).send({ ok: false, error: bad, session: view(sid) });
    if (to === "rejected") {
      act.status = "rejected";
      act.decided_at = new Date().toISOString();
      a.audit.push(audit(act.id, "rejected", "shopper", `Rejected: ${act.title} × ${act.qty}`));
      log(sid, "site", "proposal_rejected", `Shopper rejected Compass's proposal for ${act.title}`);
    } else {
      const r = await execute(sid, act, to === "undone");
      if (!r.ok) {
        if (to === "approved") {
          act.status = "failed";
          act.note = String(r.data?.detail ?? r.data?.error ?? r.error ?? `shop-http ${r.status}`);
          a.audit.push(audit(act.id, "failed", "system", `Could not apply ${act.title}: ${act.note}`));
          changed(sid, "system", "action_failed");
        }
        return down(reply, r as any, to === "approved" ? "apply approved action" : "undo");
      }
      act.status = to;
      act.decided_at = new Date().toISOString();
      a.audit.push(audit(act.id, to, "shopper", `${to === "approved" ? "Approved" : "Undid"}: ${act.kind === "cart_remove" ? "remove" : "add"} ${act.title} × ${act.qty}`));
      if (to === "approved") log(sid, "agent", act.kind === "cart_remove" ? "cart_remove" : "cart_add", act.kind === "cart_remove" ? `Compass removed ${act.title} from the cart (you approved)` : `Compass added ${act.title} to the cart (you approved)`);
      else log(sid, "site", "undo", `Shopper undid ${act.title} × ${act.qty}`);
      await runVerifier(sid).catch(() => undefined);
    }
    changed(sid, to === "approved" ? "agent" : "site", `action_${to}`);
    const traceId = noteHitlDecided(`action:${act.id}`, decision, { "sparky.hitl.outcome": act.status, "sparky.session": sid });
    return { ok: true, action: act, session: view(sid), trace_id: traceId };
  });

  // ---------------- compare ----------------
  app.post("/api/session/:sid/compare", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const ids = ((req.body ?? {}) as any).product_ids;
    if (!Array.isArray(ids) || ids.length < 2) return reply.code(400).send({ ok: false, error: "product_ids needs 2-4 ids" });
    const key = hashKey("compare", getSession(sid).store_id, ids.slice(0, 4).map(String), getThread(sid).state.constraints.map((c) => c.value));
    const ch = config.optimise.cache ? responseCaches.compare.get(key) : null;
    let r: any = ch ? { ...ch.value, cached: true, cache_age_ms: ch.ageMs } : await compareFor(sid, ids.slice(0, 4).map(String), reply);
    if (!r?.ok) return r;
    if (!ch && config.optimise.cache) responseCaches.compare.set(key, r);
    const surfaceId = `compare_table-${Math.random().toString(36).slice(2, 10)}`;
    return { ...r, surface: { surfaceId, hint: "compare_table", messages: buildA2ui("compare_table", r, surfaceId) } };
  });

  // ---------------- citations ----------------
  app.get("/api/session/:sid/citations/:pid", async (req, reply) => {
    const { sid, pid } = req.params as { sid: string; pid: string };
    const r = await shop(`/catalog-services/product/${enc(pid)}?store_id=${enc(getSession(sid).store_id)}`);
    if (!r.ok) return down(reply, r as any, "product attributes");
    return { product_id: pid, title: r.data?.product?.title, claims: citeClaims(pid, r.data?.attributes ?? []), synthetic_label: SYNTHETIC_LABEL };
  });

  // ---------------- watches + reorder ----------------
  app.post("/api/session/:sid/watches", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const { kind, product_id, target_price } = (req.body ?? {}) as { kind?: string; product_id?: string; target_price?: number };
    if (kind !== "price_drop" && kind !== "back_in_stock") return reply.code(400).send({ ok: false, error: "kind must be price_drop or back_in_stock" });
    if (!product_id) return reply.code(400).send({ ok: false, error: "product_id required" });
    await hydrate(sid);
    const store = getSession(sid).store_id;
    const p = await shop(`/catalog-services/product/${enc(product_id)}?store_id=${enc(store)}`);
    if (!p.ok) return down(reply, p as any, "watch product lookup");
    const q = await quote(product_id, store);
    if (!q) return reply.code(503).send({ ok: false, error: "catalogue services unavailable: cannot record a baseline, watch not created" });
    const a = assistFor(sid);
    const w = newWatch(kind, product_id, String(p.data?.product?.title ?? product_id), store, q.price, q.in_stock, target_price ?? null);
    a.watches.push(w);
    log(sid, "site", "watch", `Shopper started a ${kind === "price_drop" ? "price-drop" : "back-in-stock"} watch on ${w.title.slice(0, 50)}`);
    changed(sid, "site", "watch_add");
    return { ok: true, watch: w, synthetic_label: SYNTHETIC_LABEL, session: view(sid) };
  });
  app.delete("/api/session/:sid/watches/:wid", async (req) => {
    const { sid, wid } = req.params as { sid: string; wid: string };
    const a = assistFor(sid);
    a.watches = a.watches.filter((w) => w.id !== wid);
    changed(sid, "site", "watch_remove");
    return { ok: true, session: view(sid) };
  });
  app.post("/api/session/:sid/watches/evaluate", async (req) => {
    const { sid } = req.params as { sid: string };
    const fired = await evaluateWatches(sid);
    return { ok: true, fired, session: view(sid) };
  });
  app.post("/api/session/:sid/notifications/read", async (req) => {
    const { sid } = req.params as { sid: string };
    const a = assistFor(sid);
    a.notifications = a.notifications.map((n) => ({ ...n, read: true }));
    changed(sid, "site", "notifications_read");
    return { ok: true, session: view(sid) };
  });
  app.get("/api/session/:sid/reorder", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const r = await shop(`/sessions/${enc(sid)}/orders`);
    if (!r.ok) return down(reply, r as any, "orders");
    const orders = r.data?.orders ?? [];
    return { orders: orders.length, usual: usualBasket(orders), synthetic_label: SYNTHETIC_LABEL };
  });
  app.post("/api/session/:sid/reorder", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    await hydrate(sid);
    const r = await shop(`/sessions/${enc(sid)}/orders`);
    if (!r.ok) return down(reply, r as any, "orders");
    const usual = usualBasket(r.data?.orders ?? []);
    if (!usual.length) return reply.code(404).send({ ok: false, error: "No past orders in this session to reorder from." });
    const store = getSession(sid).store_id;
    const actions = [];
    for (const u of usual) {
      const q = await quote(u.product_id, store);
      actions.push(recordProposal(sid, { kind: "reorder_add", product_id: u.product_id, title: u.title, qty: u.qty, price: q?.price ?? null, proposed_by: "reorder", reason: `in ${u.in_orders} past order(s)${q?.in_stock === false ? "; currently OUT OF STOCK" : q ? "" : "; stock unverified"}` }));
    }
    return { ok: true, actions, session: view(sid) };
  });

  // ---------------- mission plan edits (B09 re-runs on each) ----------------
  const planEdit = async (sid: string, reply: FastifyReply, op: Parameters<typeof editPlan>[1]) => {
    const a = assistFor(sid);
    if (!a.plan) return reply.code(404).send({ ok: false, error: "no mission plan in this session" });
    const next = editPlan(a.plan, op);
    if (typeof next === "string") return reply.code(400).send({ ok: false, error: next });
    a.plan = await verifyPlanInto(sid, next);
    changed(sid, "site", "plan_edit");
    return { ok: true, plan: a.plan, session: view(sid) };
  };
  app.put("/api/session/:sid/plan/lines/:lid", async (req, reply) => {
    const { sid, lid } = req.params as { sid: string; lid: string };
    const b = (req.body ?? {}) as { qty?: number; product_id?: string };
    if (b.product_id) {
      const p = await shop(`/catalog-services/product/${enc(b.product_id)}?store_id=${enc(getSession(sid).store_id)}`);
      if (!p.ok) return down(reply, p as any, "swap product lookup");
      const pr = p.data?.quote?.price;
      return planEdit(sid, reply, { type: "swap", line_id: lid, product_id: b.product_id, title: String(p.data?.product?.title ?? b.product_id), price: pr && pr.status !== "unavailable" ? pr.price : null });
    }
    return planEdit(sid, reply, { type: "qty", line_id: lid, qty: Number(b.qty) });
  });
  app.delete("/api/session/:sid/plan/lines/:lid", async (req, reply) => {
    const { sid, lid } = req.params as { sid: string; lid: string };
    return planEdit(sid, reply, { type: "remove", line_id: lid });
  });
  app.get("/api/session/:sid/plan/lines/:lid/alternatives", async (req, reply) => {
    const { sid, lid } = req.params as { sid: string; lid: string };
    const line = assistFor(sid).plan?.lines.find((l) => l.id === lid);
    if (!line) return reply.code(404).send({ ok: false, error: "no such plan line" });
    const r = await jfetch(`${config.searchSvcUrl}/substitutes`, { ...post({ product_id: line.product_id, store_id: getSession(sid).store_id, k: 4 }), timeoutMs: 15_000 });
    if (!r.ok) return down(reply, r as any, "substitutes", "search-svc");
    const subs = Array.isArray(r.data) ? r.data : (r.data?.substitutes ?? r.data?.results ?? []);
    return { alternatives: subs.slice(0, 4).map((s: any) => ({ product_id: String(s.product_id), title: String(s.title ?? s.product_id), price: typeof s.price === "number" ? s.price : null })) };
  });
  app.post("/api/session/:sid/plan/verify", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const a = assistFor(sid);
    if (!a.plan) return reply.code(404).send({ ok: false, error: "no mission plan" });
    a.plan = await verifyPlanInto(sid, a.plan);
    changed(sid, "system", "plan_verify");
    return { ok: true, plan: a.plan };
  });
  app.post("/api/session/:sid/plan/add-to-cart", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    await hydrate(sid);
    const a = assistFor(sid);
    if (!a.plan?.lines.length) return reply.code(404).send({ ok: false, error: "no plan lines" });
    for (const l of a.plan.lines) {
      const r = await shop(`/cart/${enc(sid)}/items`, post({ product_id: l.product_id, qty: l.qty }));
      if (!r.ok) return down(reply, r as any, `add ${l.title}`);
      applyToolResult(getThread(sid), "add_to_cart", r.data);
    }
    a.plan = { ...a.plan, status: "added_to_cart" };
    log(sid, "site", "cart_add", `Shopper added the reviewed plan (${a.plan.lines.length} lines) to the cart`);
    await runVerifier(sid).catch(() => undefined);
    changed(sid, "site", "plan_to_cart");
    return { ok: true, session: view(sid) };
  });

  // ---------------- photo -> products (Claude vision + search-svc; text-based matching) ----------------
  app.post("/api/session/:sid/photo", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const { dataUrl } = (req.body ?? {}) as { dataUrl?: string };
    let path: string;
    try {
      path = saveUpload(String(dataUrl), "photo");
    } catch (e) {
      return reply.code(400).send({ ok: false, error: String((e as Error).message) });
    }
    // Streaming variant (?stream=1): items arrive one by one as Claude writes them, each matched as soon as it is complete.
    const sse = wantsStream(req) ? openSse(req, reply) : null;
    const store = getSession(sid).store_id;
    const matchItem = async (it: ReturnType<typeof normalisePhotoItems>[number]) => {
      const s = await shop(`/storefront/search`, post({ session_id: sid, query: it.query, store_id: store, page_size: 3 }));
      if (!s.ok) return { error: s };
      return { item: { ...it, results: (s.data?.results ?? []).slice(0, 3).map((x: any) => ({ product_id: x.product_id, title: x.title, price: x.price, in_stock: x.in_stock })) } };
    };
    const matched: any[] = [];
    const inflight = new Map<string, Promise<void>>();
    let searchDown: any = null;
    const onItem = (it: ReturnType<typeof normalisePhotoItems>[number]) => {
      const key = `${it.name}|${it.query}`;
      if (inflight.has(key)) return;
      inflight.set(
        key,
        matchItem(it).then((m) => {
          if (m.error) searchDown ??= m.error;
          else {
            matched.push(m.item);
            sse?.send({ type: "item", item: m.item });
          }
        }),
      );
    };
    const r = await jsonCall(
      `Look at the image file at ${path} using the Read tool. List up to 5 distinct shoppable grocery/household products you can see. ` +
        `For each give a generic product name, up to 4 visible attributes (brand only if legible, flavour, size, colour, pack) and a short search query. ` +
        `Reply with ONLY JSON: {"items":[{"name":"...","attributes":["..."],"query":"..."}]}. If nothing shoppable is visible reply {"items":[]}.`,
      {
        systemPrompt: "You extract shoppable products from a photo. Output JSON only. Never invent a brand you cannot read.",
        model: config.models.shopper,
        tools: "Read",
        label: "photo extract",
        signal: sse?.signal,
        onText: sse
          ? (soFar, delta) => {
              sse.send({ type: "delta", delta });
              for (const it of normalisePhotoItems({ items: completedObjects(soFar, "items") })) onItem(it);
            }
          : undefined,
      },
    );
    const fail = (code: number, body: Record<string, unknown>) => {
      if (!sse) return reply.code(code).send(body);
      sse.send({ type: "error", status: code, ...body });
      sse.end();
    };
    if (!r.ok || !r.data) return fail(502, { ok: false, error: `Claude vision run did not complete (${r.reason ?? "no JSON"}); nothing substituted.`, cost_usd: r.cost_usd });
    const items = normalisePhotoItems(r.data);
    for (const it of items) onItem(it);
    await Promise.all(inflight.values());
    if (searchDown) {
      if (!sse) return down(reply, searchDown, "search for photo item");
      return fail(searchDown.status === 0 ? 503 : 502, { ok: false, error: "shop-http search for a photo item did not run; nothing substituted." });
    }
    // Keep the model's order, not the order searches happened to finish in.
    const order = (x: any) => items.findIndex((it) => it.name === x.name && it.query === x.query);
    matched.sort((a, b) => order(a) - order(b));
    log(sid, "site", "photo", `Shopper uploaded a photo; Claude extracted ${items.length} item(s)`);
    publish(sid, "site", "photo");
    const body = {
      ok: true,
      items: matched,
      matching: "text-based: Claude describes the photo, then search-svc matches that text (ESCI has no product images)",
      synthetic_label: SYNTHETIC_LABEL,
      model: r.model,
      cost_usd: r.cost_usd,
      latency_ms: r.latency_ms,
    };
    if (!sse) return body;
    sse.send({ type: "done", ...body });
    sse.end();
  });

  // ---------------- smart follow-ups + one clarifying question ----------------
  app.post("/api/session/:sid/followups", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const { question, answer, plane, run_id } = (req.body ?? {}) as { question?: string; answer?: string; plane?: string; run_id?: string };
    if (!question) return reply.code(400).send({ ok: false, error: "question required" });
    const ops = plane === "ops";
    const s = ops ? null : view(sid);
    const cacheKey = hashKey("followups", ops, question, String(answer ?? "").slice(-1500), s?.cart.item_count ?? null, s?.constraints.map((c) => c.value) ?? null);
    const hit = config.optimise.cache ? responseCaches.followups.get(cacheKey) : null;
    const turn = traceForRun(run_id);
    if (turn) markSpan("budget followups cache", "budget", { "sparky.cache.response_cache": "followups", "sparky.cache.response_hit": Boolean(hit), "sparky.cache.age_ms": hit?.ageMs ?? null, "sparky.cache.enabled": config.optimise.cache, "sparky.run_id": run_id }, parentOf(turn));
    if (hit) {
      const body = { ...hit.value, cached: true, cache_age_ms: hit.ageMs, cost_usd: 0 };
      if (!wantsStream(req)) return body;
      const ch = openSse(req, reply);
      ch.send({ type: "done", ...body });
      return ch.end();
    }
    const sse = wantsStream(req) ? openSse(req, reply) : null;
    let shown = 0;
    const r = await otelContext.with(turn ? parentOf(turn) : otelContext.active(), () => jsonCall(
      ops
        ? `MLOps operator message: ${JSON.stringify(question)}\nOps Copilot answer so far: ${JSON.stringify(String(answer ?? "").slice(-1500))}\n` +
            `Suggest up to 3 short plain-English questions the operator could ask the Ops Copilot next (incident triage, a metric, drift slices, eval failure clusters, compare versions, release notes, costs, what went wrong in a run, watch alerts). Plain questions only: never tool names, CLI commands or flags, and never suggest approving anything. clarify=null unless the request is ambiguous. ` +
            `Reply with ONLY JSON: {"clarify":{"question":"...","options":["..."]}|null,"followups":["..."]}`
        : `Shopper message: ${JSON.stringify(question)}\nAssistant answer so far: ${JSON.stringify(String(answer ?? "").slice(-1500))}\n` +
        `Cart items: ${s!.cart.item_count}. Constraints: ${JSON.stringify(s!.constraints.map((c) => c.value))}.\n` +
        `If the shopper's GOAL is ambiguous in a way that changes what to buy (e.g. size, quantity, dietary need, occasion) and the answer did not resolve it, ` +
        `produce exactly ONE clarifying question with 2-4 short option chips. Otherwise clarify=null. Also suggest up to 3 short next-step follow-ups the shopper might send. ` +
        `Use the shopper's language. Reply with ONLY JSON: {"clarify":{"question":"...","options":["..."]}|null,"followups":["..."]}`,
      {
        systemPrompt: ops ? "You write concise MLOps follow-up suggestions. Output JSON only." : "You write concise shopping follow-up suggestions. Output JSON only.",
        label: "followups",
        runId: run_id,
        thinking: false,
        signal: sse?.signal,
        onText: sse
          ? (soFar) => {
              const f = completedStrings(soFar, "followups").slice(0, 3);
              if (f.length > shown) {
                shown = f.length;
                sse.send({ type: "partial", followups: f });
              }
            }
          : undefined,
      },
    ));
    if (!r.ok || !r.data) {
      const body = { ok: false, error: `follow-up run did not complete (${r.reason ?? "no JSON"})`, cost_usd: r.cost_usd };
      if (!sse) return reply.code(502).send(body);
      sse.send({ type: "error", status: 502, ...body });
      return sse.end();
    }
    const body = { ok: true, ...normaliseFollowUps(r.data), model: r.model, cost_usd: r.cost_usd, latency_ms: r.latency_ms };
    if (config.optimise.cache) responseCaches.followups.set(cacheKey, body);
    if (!sse) return body;
    sse.send({ type: "done", ...body });
    sse.end();
  });

  // ---------------- feedback -> online-eval sample (technique 29) ----------------
  app.post("/api/session/:sid/feedback", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const r = feedbackSample({ ...((req.body ?? {}) as any), session_id: sid });
    if ("error" in r) return reply.code(400).send({ ok: false, error: r.error });
    // Resolve the turn's trace BEFORE writing, so the row carries trace_id at capture time
    // instead of only being reachable through the run_id -> trace lookup (bff/src/trace/store.ts).
    // Rows written before this field simply lack the key; every reader still has the run_id join.
    const turn = traceForRun((r.sample as any).run_id);
    const sample = { ...r.sample, trace_id: turn?.traceId ?? null };
    appendFeedback(sample);
    // Feedback lands on the turn trace it rates, as a zero-duration `feedback` span with a `feedback` event.
    if (turn) {
      const fb = sample as any;
      const span = startKindSpan("feedback", "feedback", { "sparky.feedback.label": fb.label, "sparky.feedback.reason": fb.reason || null, "sparky.feedback.sample_id": fb.id, "sparky.feedback.source": "thumbs", "sparky.run_id": turn.runId, ...redact(fb.comment) }, { parent: parentOf(turn) });
      span?.addEvent("feedback", { label: fb.label, sample_id: fb.id });
      endSpan(span);
    }
    return { ok: true, sample_id: r.sample.id, technique: 29, trace_id: turn?.traceId ?? null };
  });
}

async function verifyPlanInto(sid: string, plan: NonNullable<ReturnType<typeof assistFor>["plan"]>) {
  try {
    const v = await verifyPlan(sid, plan.lines.map((l) => ({ product_id: l.product_id, title: l.title, qty: l.qty, price: l.price ?? 0 })));
    return { ...plan, verifier: { checked_at: new Date().toISOString(), verdict: v.verdict, could_not: v.could_not.map((c) => ({ constraint: c.constraint, reason: c.reason })) } };
  } catch {
    return { ...plan, verifier: { checked_at: new Date().toISOString(), verdict: "unknown" as const, could_not: [{ constraint: "verifier", reason: "catalogue facts unavailable" }] } };
  }
}

export async function onPlanTool(sid: string, plan: NonNullable<ReturnType<typeof assistFor>["plan"]>) {
  const a = assistFor(sid);
  a.plan = await verifyPlanInto(sid, plan);
  saveSoon();
  publish(sid, "agent", "plan");
}

export async function compareFor(sid: string, ids: string[], reply?: FastifyReply) {
  const store = getSession(sid).store_id;
  const r = await shop(`/catalog-services/quotes`, post({ product_ids: ids, store_id: store }));
  if (!r.ok) return reply ? down(reply, r as any, "quotes") : { error: "quotes unavailable" };
  const items = [];
  for (const pid of ids) {
    const p = await jfetch(`${config.searchSvcUrl}/product/${enc(pid)}`, { timeoutMs: 8000 });
    const q = r.data?.quotes?.[pid];
    items.push({
      product_id: pid,
      title: String(p.data?.title ?? pid),
      brand: p.data?.brand,
      rating: typeof p.data?.rating === "number" ? p.data.rating : null,
      dietary: Array.isArray(p.data?.dietary) ? p.data.dietary : null,
      price: q?.price && q.price.status !== "unavailable" ? q.price.price : null,
      in_stock: q?.inventory && q.inventory.status !== "unavailable" ? Boolean(q.inventory.in_stock) : null,
    });
  }
  const want = getThread(sid).state.constraints.map((c) => (/gluten/i.test(c.value) ? "gluten_free" : /vegan/i.test(c.value) ? "vegan" : /organic/i.test(c.value) ? "organic" : "")).filter(Boolean);
  return { ok: true, store_id: store, ...compareProducts(items, want), provenance: { service: "shop-http catalogue services + search-svc", endpoint: "POST /catalog-services/quotes, GET /product" } };
}
