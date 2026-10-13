/**
 * B16 shopper accounts, wallet, addresses, the payment step and order confirmation.
 *
 * Every route is a thin proxy onto shop-http (the same SQLite the agent's MCP tools write),
 * following the house convention: shop call -> log() -> afterChange() -> { ..., session: view(sid) }
 * so the web client's req() auto-applies the fresh session. A service that is down is reported
 * as such; nothing is substituted, and no authorisation here ever moves money.
 *
 * Card numbers: the wallet POST forwards `number` to shop-http, which looks it up in a frozen
 * allowlist and discards it. This file never logs a request body and never puts a body into an
 * error, so a number cannot reach the bff log or a client error. A 422 from shop-http (a number
 * outside the allowlist) is passed through as 422 with its {error, accepted} body intact.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ConstraintEntry } from "@sparky/shared";
import { getThread } from "../agui/threadStore.js";
import { addStated, audit, deleteMemory, type MemoryItem, type MemoryKey } from "../assist/logic.js";
import { assistFor, saveSoon } from "../assist/store.js";
import { constraintId } from "./constraints.js";
import { getSession, hydrate, log, setAccount, setTender, view } from "./sessionStore.js";
import { addConstraint, afterChange, body, enc, fail, refreshCart, removeConstraints, shopCall, type Res } from "./shopProxy.js";

// ---------------------------------------------------------------- persona prefs (pure)

/** Memory and constraints a persona contributes are tagged with this, so a switch can undo them. */
export const personaSource = (accountId: string) => `persona:${accountId}`;
export const isPersonaSourced = (s: string | undefined) => Boolean(s && s.startsWith("persona:"));

export interface AccountPrefs {
  dietary?: string[];
  brands?: string[];
  store_id?: string | null;
  household_size?: number | string | null;
}

/** A persona's stored preferences as memory items. Choosing the persona IS the confirmation. */
export function personaMemory(prefs: AccountPrefs | null | undefined): { key: MemoryKey; value: string }[] {
  const out: { key: MemoryKey; value: string }[] = [];
  for (const d of prefs?.dietary ?? []) if (String(d).trim()) out.push({ key: "dietary", value: String(d).trim() });
  for (const b of prefs?.brands ?? []) if (String(b).trim()) out.push({ key: "brands", value: String(b).trim() });
  if (prefs?.store_id && /^\d{4}$/.test(String(prefs.store_id))) out.push({ key: "store", value: String(prefs.store_id) });
  const hh = prefs?.household_size;
  if (hh != null && /^\d{1,2}$/.test(String(hh))) out.push({ key: "household_size", value: String(hh) });
  return out;
}

/** The same prefs as B11 chips: dietary becomes a real dietary constraint the verifier can check. */
export function personaConstraints(prefs: AccountPrefs | null | undefined): ConstraintEntry[] {
  const out: ConstraintEntry[] = [];
  for (const d of prefs?.dietary ?? []) {
    const v = String(d).trim().replace(/_/g, "-");
    if (v) out.push({ key: "dietary", value: `${v} option required`, status: "unknown" });
  }
  return out;
}

/**
 * Replace persona-sourced memory only: anything the shopper stated or the agent inferred survives
 * a persona switch untouched.
 */
export function replacePersonaMemory(list: MemoryItem[], items: { key: MemoryKey; value: string }[], accountId: string | null): MemoryItem[] {
  // Uses the existing deleteMemory so removal stays one code path.
  let next = list;
  for (const m of list) if (isPersonaSourced(m.source)) next = deleteMemory(next, m.id);
  if (!accountId) return next;
  const src = personaSource(accountId);
  for (const it of items) next = addStated(next, it.key, it.value, src);
  return next;
}

// ---------------------------------------------------------------- routes

export function registerAccountRoutes(app: FastifyInstance) {
  /** Never include a request body in an error: a wallet write carries a test-card number. */
  const pass = (reply: FastifyReply, r: Res, what: string) => (r.ok ? r.data : fail(reply, r, what));

  async function requireAccount(sid: string, reply: FastifyReply): Promise<string | null> {
    await hydrate(sid);
    const aid = getSession(sid).account?.account_id;
    if (!aid) {
      reply.code(409).send({ ok: false, error: "This session is a guest session: pick a shopper account first.", session: view(sid) });
      return null;
    }
    return String(aid);
  }

  /** Re-read the persona from shop-http after any wallet/address write, so the view stays true. */
  async function reloadAccount(sid: string, aid: string) {
    const a = await shopCall(`/accounts/${enc(aid)}`);
    if (a.ok && a.data?.account_id) setAccount(sid, a.data);
    return a;
  }

  // ---------------- accounts ----------------
  app.get("/api/session/:sid/accounts", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    await hydrate(sid);
    const r = await shopCall(`/accounts`);
    if (!r.ok) return fail(reply, r, "list shopper accounts");
    return { ...r.data, session: view(sid) };
  });

  app.put("/api/session/:sid/account", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const raw = ((req.body ?? {}) as { account_id?: string | null }).account_id ?? null;
    const account_id = raw == null || raw === "" ? null : String(raw);
    await hydrate(sid);
    const s = getSession(sid);
    const before = s.account?.account_id ? String(s.account.account_id) : null;

    const r = await shopCall(`/sessions/${enc(sid)}/account`, { method: "PUT", body: JSON.stringify({ account_id }) });
    if (!r.ok) return fail(reply, r, "switch shopper account");
    const account = r.data?.account_id ? r.data.account : null;
    setAccount(sid, account);
    // A tender plan belongs to the previous persona's wallet: it is not carried across.
    setTender(sid, null);

    // 1+2. Persona-sourced memory is replaced; shopper-stated memory is untouched.
    const a = assistFor(sid);
    const prefs: AccountPrefs = (account?.prefs ?? {}) as AccountPrefs;
    a.memory = replacePersonaMemory(a.memory, personaMemory(prefs), account_id);

    // 3. Constraints go through the SAME add/remove path POST /constraints uses, so the chips,
    //    the verifier and appliesAs() work with zero new logic.
    await removeConstraints(sid, (c) => isPersonaSourced(s.meta.get(constraintId(c))?.source_text));
    const at = new Date().toISOString();
    if (account_id) {
      for (const c of personaConstraints(prefs)) {
        await addConstraint(sid, c.key, c.value, { source: "site", source_text: `${personaSource(account_id)} preference: ${c.value}`, at });
      }
    }

    // 4. The persona's home store, through the existing store-set path.
    const store = prefs.store_id ? String(prefs.store_id) : null;
    if (store && /^\d{4}$/.test(store) && store !== s.store_id) {
      const st = await shopCall(`/sessions/${enc(sid)}/store`, { method: "PUT", body: JSON.stringify({ store_id: store }) });
      if (st.ok) {
        s.store_id = store;
        log(sid, "site", "store", `Store set to ${store} from the shopper account`);
      }
    }

    // 5. The cart belongs to the session, not the account: read it back, never cleared.
    await refreshCart(sid);

    // 6. A mandate signed for another account's card is voided through the existing decision path.
    const ctx = getThread(sid);
    const m = ctx.state.mandate;
    let voided: string | null = null;
    if (m && m.status === "pending_approval" && m.account_id && String(m.account_id) !== String(account_id ?? "")) {
      const d = await shopCall(`/mandates/${enc(String(m.mandate_id))}/reject`, { method: "POST" });
      if (d.ok) {
        m.status = "rejected";
        voided = String(m.mandate_id);
        log(sid, "site", "mandate", "Mandate voided: the shopper switched persona.");
      }
    }

    // 7. Activity + audit, so the switch shows in the timeline.
    const label = account ? `${account.name} (${account.account_id})` : "Guest";
    log(sid, "site", "account", before === account_id ? `Shopper account confirmed: ${label}` : `Shopper switched to ${label}`);
    a.audit.push(audit(`acct_${account_id ?? "guest"}`, "approved", "shopper", `Shopper account switched to ${label}; persona preferences re-applied, cart kept${voided ? `, mandate ${voided} voided` : ""}`));
    saveSoon();

    await afterChange(sid, "site", "account");
    return { ok: true, account: r.data?.account ?? null, voided_mandate: voided, session: view(sid) };
  });

  // ---------------- wallet ----------------
  app.get("/api/session/:sid/wallet", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const aid = await requireAccount(sid, reply);
    if (!aid) return reply;
    const r = await shopCall(`/accounts/${enc(aid)}/payment-methods`);
    if (!r.ok) return fail(reply, r, "list payment methods");
    return { ...r.data, session: view(sid) };
  });

  app.post("/api/session/:sid/wallet", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const aid = await requireAccount(sid, reply);
    if (!aid) return reply;
    // The body carries a test-card number: it is forwarded and NEVER logged or echoed.
    const b = (req.body ?? {}) as { kind?: string; number?: string; balance?: number; nickname?: string; is_default?: boolean };
    const r = await shopCall(`/accounts/${enc(aid)}/payment-methods`, body({ kind: b.kind, number: b.number, balance: b.balance, nickname: b.nickname, is_default: Boolean(b.is_default) }));
    if (!r.ok) {
      // 422 = a number outside the frozen allowlist. Pass it through with {error, accepted} intact.
      if (r.status === 422) {
        const d = r.data?.detail ?? r.data ?? {};
        return reply.code(422).send({ ok: false, error: d.error ?? "that card number is not in this demo's allowlist", accepted: d.accepted ?? [], session: view(sid) });
      }
      return fail(reply, r, "add a payment method");
    }
    await reloadAccount(sid, aid);
    const pm = r.data?.payment_method ?? r.data;
    log(sid, "site", "wallet", `Shopper added ${pm?.display ?? pm?.kind ?? "a payment method"} to the wallet (simulated: no payment is ever executed)`);
    await afterChange(sid, "site", "wallet_add");
    return { ...r.data, session: view(sid) };
  });

  app.put("/api/session/:sid/wallet/:pmId", async (req, reply) => {
    const { sid, pmId } = req.params as { sid: string; pmId: string };
    const aid = await requireAccount(sid, reply);
    if (!aid) return reply;
    const b = (req.body ?? {}) as { nickname?: string; balance?: number; is_default?: boolean };
    const r = await shopCall(`/accounts/${enc(aid)}/payment-methods/${enc(pmId)}`, { method: "PUT", body: JSON.stringify({ nickname: b.nickname, balance: b.balance, is_default: b.is_default }) });
    if (!r.ok) return fail(reply, r, "update a payment method");
    await reloadAccount(sid, aid);
    log(sid, "site", "wallet", `Shopper updated payment method ${pmId}`);
    await afterChange(sid, "site", "wallet_update");
    return { ...r.data, session: view(sid) };
  });

  app.delete("/api/session/:sid/wallet/:pmId", async (req, reply) => {
    const { sid, pmId } = req.params as { sid: string; pmId: string };
    const aid = await requireAccount(sid, reply);
    if (!aid) return reply;
    const r = await shopCall(`/accounts/${enc(aid)}/payment-methods/${enc(pmId)}`, { method: "DELETE" });
    if (!r.ok) return fail(reply, r, "remove a payment method");
    await reloadAccount(sid, aid);
    setTender(sid, null);
    log(sid, "site", "wallet", `Shopper removed payment method ${pmId}`);
    await afterChange(sid, "site", "wallet_remove");
    return { ...r.data, session: view(sid) };
  });

  app.post("/api/session/:sid/wallet/:pmId/default", async (req, reply) => {
    const { sid, pmId } = req.params as { sid: string; pmId: string };
    const aid = await requireAccount(sid, reply);
    if (!aid) return reply;
    const r = await shopCall(`/accounts/${enc(aid)}/payment-methods/${enc(pmId)}/default`, { method: "POST" });
    if (!r.ok) return fail(reply, r, "set the default payment method");
    await reloadAccount(sid, aid);
    log(sid, "site", "wallet", `Shopper made payment method ${pmId} the default`);
    await afterChange(sid, "site", "wallet_default");
    return { ...r.data, session: view(sid) };
  });

  // ---------------- addresses ----------------
  app.get("/api/session/:sid/addresses", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const aid = await requireAccount(sid, reply);
    if (!aid) return reply;
    const r = await shopCall(`/accounts/${enc(aid)}/addresses`);
    if (!r.ok) return fail(reply, r, "list addresses");
    return { ...r.data, session: view(sid) };
  });

  app.post("/api/session/:sid/addresses", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const aid = await requireAccount(sid, reply);
    if (!aid) return reply;
    const r = await shopCall(`/accounts/${enc(aid)}/addresses`, body(req.body));
    if (!r.ok) return fail(reply, r, "add an address");
    await reloadAccount(sid, aid);
    const adr = r.data?.address ?? r.data;
    log(sid, "site", "address", `Shopper added address ${adr?.display ?? adr?.address_id ?? ""}`);
    await afterChange(sid, "site", "address_add");
    return { ...r.data, session: view(sid) };
  });

  app.put("/api/session/:sid/addresses/:adrId", async (req, reply) => {
    const { sid, adrId } = req.params as { sid: string; adrId: string };
    const aid = await requireAccount(sid, reply);
    if (!aid) return reply;
    const r = await shopCall(`/accounts/${enc(aid)}/addresses/${enc(adrId)}`, { method: "PUT", body: JSON.stringify(req.body ?? {}) });
    if (!r.ok) return fail(reply, r, "update an address");
    await reloadAccount(sid, aid);
    log(sid, "site", "address", `Shopper updated address ${adrId}`);
    await afterChange(sid, "site", "address_update");
    return { ...r.data, session: view(sid) };
  });

  app.delete("/api/session/:sid/addresses/:adrId", async (req, reply) => {
    const { sid, adrId } = req.params as { sid: string; adrId: string };
    const aid = await requireAccount(sid, reply);
    if (!aid) return reply;
    const r = await shopCall(`/accounts/${enc(aid)}/addresses/${enc(adrId)}`, { method: "DELETE" });
    if (!r.ok) return fail(reply, r, "remove an address");
    await reloadAccount(sid, aid);
    log(sid, "site", "address", `Shopper removed address ${adrId}`);
    await afterChange(sid, "site", "address_remove");
    return { ...r.data, session: view(sid) };
  });

  app.post("/api/session/:sid/addresses/:adrId/default", async (req, reply) => {
    const { sid, adrId } = req.params as { sid: string; adrId: string };
    const aid = await requireAccount(sid, reply);
    if (!aid) return reply;
    const r = await shopCall(`/accounts/${enc(aid)}/addresses/${enc(adrId)}/default`, { method: "POST" });
    if (!r.ok) return fail(reply, r, "set the default address");
    await reloadAccount(sid, aid);
    log(sid, "site", "address", `Shopper made address ${adrId} the default`);
    await afterChange(sid, "site", "address_default");
    return { ...r.data, session: view(sid) };
  });

  // ---------------- the payment step ----------------
  app.post("/api/session/:sid/checkout/tender", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    await hydrate(sid);
    const s = getSession(sid);
    const b = (req.body ?? {}) as { pm_ids?: string[]; store_id?: string };
    const pm_ids = (Array.isArray(b.pm_ids) ? b.pm_ids : []).map(String).filter(Boolean);
    if (!pm_ids.length) return reply.code(400).send({ ok: false, error: "pm_ids must name at least one payment method" });
    const r = await shopCall(`/cart/${enc(sid)}/tender-preview`, body({ pm_ids, store_id: b.store_id ?? s.store_id }));
    if (!r.ok) return fail(reply, r, "preview the tender split");
    setTender(sid, r.data);
    const t = s.tender;
    log(sid, "site", "tender", t && t.refusals.length ? `Payment step: ${t.plan.length} tender leg(s), ${t.refusals.length} refusal(s)` : `Payment step: ${t?.plan.length ?? 0} tender leg(s) cover $${Number(r.data?.covered_total ?? 0).toFixed(2)} of $${Number(r.data?.total ?? 0).toFixed(2)}`);
    await afterChange(sid, "site", "tender");
    return { tender: r.data, session: view(sid) };
  });

  app.post("/api/session/:sid/checkout/authorize", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const ctx = getThread(sid);
    const mandate_id = String(((req.body ?? {}) as any).mandate_id ?? ctx.state.mandate?.mandate_id ?? "");
    if (!mandate_id) return reply.code(400).send({ ok: false, error: "mandate_id required" });
    await hydrate(sid);
    const r = await shopCall(`/mandates/${enc(mandate_id)}/authorize`, { method: "POST" });
    if (!r.ok) return fail(reply, r, "record a simulated authorisation");
    const d = r.data ?? {};
    log(sid, "site", "authorize", `Simulated authorisation ${d.decision ?? "recorded"}${d.reason ? ` (${d.reason})` : ""} for mandate ${mandate_id}; no payment executed`);
    await afterChange(sid, "site", "authorize");
    return { ...d, session: view(sid) };
  });

  app.post("/api/session/:sid/checkout/step-up", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const b = (req.body ?? {}) as { step_up_id?: string; code?: string };
    const code = String(b.code ?? "");
    if (!code) return reply.code(400).send({ ok: false, error: "code required" });
    await hydrate(sid);
    const r = await shopCall(`/step-ups/${enc(b.step_up_id ?? sid)}/verify`, body({ code, step_up_id: b.step_up_id }));
    if (!r.ok) return fail(reply, r, "verify the payment step-up");
    const d = r.data ?? {};
    log(sid, "site", "step_up", d.verified ? `Verification code accepted; simulated authorisation ${d.authorisation?.decision ?? "recorded"}` : `Verification code rejected (${d.attempts_remaining ?? 0} attempt(s) left)`);
    await afterChange(sid, "site", "step_up");
    return { ...d, session: view(sid) };
  });

  // ---------------- order confirmation ----------------
  /**
   * Every order the bound persona has placed, across sessions.
   *
   * `GET /api/session/:sid/orders` is scoped to one session, so a returning shopper saw an empty
   * history the moment their session id rotated. shop-http has always had the account-wide view;
   * it simply had no route here, which left the orders page unable to offer it honestly.
   * A guest has no account, so it says so rather than returning someone else's orders.
   */
  app.get("/api/session/:sid/account/orders", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    await hydrate(sid);
    const accountId = view(sid)?.account?.account_id;
    if (!accountId) {
      return reply.code(409).send({
        ok: false,
        error: "This session is a guest session, so there is no account history. Pick a shopper account first.",
        session: view(sid),
      });
    }
    const r = await shopCall(`/accounts/${enc(accountId)}/orders`);
    if (!r.ok) return fail(reply, r, "read this account's order history");
    return { ...r.data, session: view(sid) };
  });

  app.get("/api/session/:sid/orders/:orderId", async (req, reply) => {
    const { sid, orderId } = req.params as { sid: string; orderId: string };
    await hydrate(sid);
    const r = await shopCall(`/orders/${enc(orderId)}`);
    if (!r.ok) return fail(reply, r, "read the order");
    return { order: r.data?.order ?? r.data, session: view(sid) };
  });

  app.post("/api/session/:sid/orders/:orderId/fulfilment", async (req, reply) => {
    const { sid, orderId } = req.params as { sid: string; orderId: string };
    await hydrate(sid);
    const stage = ((req.body ?? {}) as { stage?: string }).stage;
    const r = await shopCall(`/orders/${enc(orderId)}/fulfilment/advance`, body(stage ? { stage } : {}));
    if (!r.ok) return fail(reply, r, "advance fulfilment");
    const o = r.data?.order ?? r.data;
    log(sid, "site", "fulfilment", `Order ${orderId} is now ${o?.status ?? "advanced"}`);
    await afterChange(sid, "site", "fulfilment");
    return { order: o, session: view(sid) };
  });

  // ---------------- store reads (no session) ----------------
  app.get("/api/store/test-cards", async (req, reply) => {
    const r = await shopCall(`/payment-methods/test-cards`);
    return pass(reply, r, "list the accepted test cards");
  });
}
