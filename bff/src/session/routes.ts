/**
 * Storefront + shared-session HTTP API (Wave 0). The web store talks only to these routes.
 * Mutations go to shop-http (the same SQLite the agent's MCP tools write), then update the
 * shared ThreadCtx, run the B09 verifier and publish a STATE_DELTA to both channels.
 * A service that is down is reported as such (503 naming it); nothing is substituted.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../config.js";
import { jfetch } from "../lib/http.js";
import { getThread } from "../agui/threadStore.js";
import { applyCart, applyToolResult } from "../agui/stateReducer.js";
import { constraintId, effectiveFilters, type SiteFilters } from "./constraints.js";
import { getSession, hydrate, log, publish, subscribe, view } from "./sessionStore.js";
import { addConstraint, afterChange, body, enc, fail, refreshCart, removeConstraints, shopCall } from "./shopProxy.js";

export function registerSessionRoutes(app: FastifyInstance) {
  // ---------------- session state + SSE ----------------
  app.get("/api/session/:sid", async (req) => {
    const { sid } = req.params as { sid: string };
    await hydrate(sid);
    return view(sid);
  });

  app.get("/api/session/:sid/events", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    await hydrate(sid);
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    const unsub = subscribe(sid, send);
    const ka = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000);
    req.raw.on("close", () => {
      clearInterval(ka);
      unsub();
    });
  });

  // ---------------- search ----------------
  app.post("/api/session/:sid/search", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const b = (req.body ?? {}) as { query?: string; filters?: SiteFilters; sort?: string; page?: number; page_size?: number };
    await hydrate(sid);
    const s = getSession(sid);
    const ctx = getThread(sid);
    const eff = effectiveFilters(b.filters ?? {}, ctx.state.constraints);
    const store_id = eff.store ?? s.store_id;
    const query = String(b.query ?? "").trim();
    const r = await shopCall(`/storefront/search`, body({ session_id: sid, query, store_id, filters: eff.filters, sort: b.sort ?? "relevance", page: Number(b.page ?? 1), page_size: Number(b.page_size ?? 24) }));
    if (!r.ok) return fail(reply, r, "search");
    const changed = s.query !== query || JSON.stringify(s.filters) !== JSON.stringify(b.filters ?? {}) || s.sort !== (b.sort ?? "relevance");
    s.query = query;
    s.filters = b.filters ?? {};
    s.sort = b.sort ?? "relevance";
    if (changed && query) {
      s.last_search = { query, filters: eff.filters as Record<string, unknown>, actor: "site", at: new Date().toISOString(), product_ids: (r.data?.results ?? []).map((x: any) => String(x.product_id)) };
      log(sid, "site", "search", r.data?.kind === "help" ? `Shopper asked the help centre: “${query}”` : `Shopper searched the site for “${query}” (${r.data?.total ?? 0} results${r.data?.zero_result ? ", zero-result" : ""})`);
      publish(sid, "site", "search");
    }
    return { search: r.data, effective_filters: { ...eff.filters, store_id }, from_constraints: eff.from_constraints, session: view(sid) };
  });

  // ---------------- cart ----------------
  app.post("/api/session/:sid/cart/items", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const { product_id, qty = 1 } = (req.body ?? {}) as { product_id?: string; qty?: number };
    if (!product_id) return reply.code(400).send({ ok: false, error: "product_id required" });
    await hydrate(sid);
    const s = getSession(sid);
    // A real store will not add an item the shopper's store cannot supply. If inventory is
    // unavailable the add proceeds, is marked unverified, and checkout revalidation decides.
    const q = await shopCall(`/catalog-services/quote/${enc(product_id)}?store_id=${enc(s.store_id)}`);
    const inv = q.ok ? q.data?.inventory : null;
    if (inv && inv.status !== "unavailable" && inv.in_stock === false) {
      return reply.code(409).send({ ok: false, error: `Out of stock at store ${s.store_id}. Pick another store or a substitute.`, quote: q.data, session: view(sid) });
    }
    const r = await shopCall(`/cart/${enc(sid)}/items`, body({ product_id, qty: Number(qty) }));
    if (!r.ok) return fail(reply, r, "add to cart");
    applyToolResult(getThread(sid), "add_to_cart", r.data);
    const title = getThread(sid).state.cart.find((l) => l.product_id === product_id)?.title ?? product_id;
    log(sid, "site", "cart_add", `Shopper added ${title} × ${qty} on the site${!inv || inv.status === "unavailable" ? " (stock unverified: inventory service unavailable)" : ""}`);
    await afterChange(sid, "site", "cart_add");
    return { ok: true, cart: r.data.cart, session: view(sid) };
  });

  app.put("/api/session/:sid/cart/items/:pid", async (req, reply) => {
    const { sid, pid } = req.params as { sid: string; pid: string };
    const qty = Number(((req.body ?? {}) as any).qty);
    if (!Number.isInteger(qty) || qty < 0 || qty > 20) return reply.code(400).send({ ok: false, error: "qty must be an integer 0-20" });
    await hydrate(sid);
    const title = getThread(sid).state.cart.find((l) => l.product_id === pid)?.title ?? pid;
    const r = await shopCall(`/cart/${enc(sid)}/items/${enc(pid)}`, { method: "PUT", body: JSON.stringify({ qty }) });
    if (!r.ok) return fail(reply, r, "update quantity");
    await refreshCart(sid);
    log(sid, "site", qty === 0 ? "cart_remove" : "cart_qty", qty === 0 ? `Shopper removed ${title} on the site` : `Shopper set ${title} to × ${qty} on the site`);
    await afterChange(sid, "site", "cart_qty");
    return { ok: true, session: view(sid) };
  });

  app.delete("/api/session/:sid/cart/items/:pid", async (req, reply) => {
    const { sid, pid } = req.params as { sid: string; pid: string };
    await hydrate(sid);
    const title = getThread(sid).state.cart.find((l) => l.product_id === pid)?.title ?? pid;
    const r = await shopCall(`/cart/${enc(sid)}/items/${enc(pid)}`, { method: "DELETE" });
    if (!r.ok) return fail(reply, r, "remove from cart");
    applyToolResult(getThread(sid), "remove_from_cart", r.data);
    log(sid, "site", "cart_remove", `Shopper removed ${title} on the site`);
    await afterChange(sid, "site", "cart_remove");
    return { ok: true, session: view(sid) };
  });

  // ---------------- store ----------------
  app.put("/api/session/:sid/store", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const store_id = String(((req.body ?? {}) as any).store_id ?? "");
    if (!/^\d{4}$/.test(store_id)) return reply.code(400).send({ ok: false, error: "store_id must be a 4-digit store" });
    await hydrate(sid);
    const r = await shopCall(`/sessions/${enc(sid)}/store`, { method: "PUT", body: JSON.stringify({ store_id }) });
    if (!r.ok) return fail(reply, r, "set store");
    getSession(sid).store_id = store_id;
    log(sid, "site", "store", `Shopper picked store ${store_id}`);
    await afterChange(sid, "site", "store");
    return { ok: true, session: view(sid) };
  });

  // ---------------- constraints (B11 chips) ----------------
  app.post("/api/session/:sid/constraints", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const { key, value } = (req.body ?? {}) as { key?: string; value?: string };
    if (!key || !value) return reply.code(400).send({ ok: false, error: "key and value required" });
    await hydrate(sid);
    await addConstraint(sid, String(key), String(value), { source: "site", source_text: `added on the site: ${value}`, at: new Date().toISOString() });
    log(sid, "site", "constraint_add", `Shopper added constraint “${value}” on the site`);
    await afterChange(sid, "site", "constraint_add");
    return { ok: true, session: view(sid) };
  });

  app.delete("/api/session/:sid/constraints/:key", async (req, reply) => {
    const { sid, key } = req.params as { sid: string; key: string };
    await hydrate(sid);
    const { gone, clearFailed } = await removeConstraints(sid, (c) => constraintId(c) === key || c.key === key);
    if (!gone.length) return reply.code(404).send({ ok: false, error: `no constraint ${key}`, session: view(sid) });
    if (clearFailed) return fail(reply, clearFailed, "clear budget");
    for (const c of gone) log(sid, "site", "constraint_remove", `Shopper removed constraint “${c.value}” on the site`);
    await afterChange(sid, "site", "constraint_remove");
    return { ok: true, session: view(sid) };
  });

  // ---------------- checkout ----------------
  app.post("/api/session/:sid/checkout/revalidate", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    await hydrate(sid);
    const s = getSession(sid);
    const r = await shopCall(`/cart/${enc(sid)}/revalidate?store_id=${enc(s.store_id)}`, { method: "POST" });
    if (!r.ok) return fail(reply, r, "checkout revalidation");
    if (r.data?.cart) applyCart(getThread(sid), r.data.cart);
    else await refreshCart(sid);
    const issues = (r.data?.lines ?? []).flatMap((l: any) => l.issues ?? []);
    log(sid, "site", "checkout", r.data?.ok ? "Checkout revalidated: prices and stock current" : `Checkout revalidation found ${issues.length} issue(s)`);
    await afterChange(sid, "site", "revalidate");
    return { revalidation: r.data, session: view(sid) };
  });

  app.post("/api/session/:sid/checkout/mandate", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const mb = (req.body ?? {}) as { spend_cap?: number; address_id?: string | null; tender?: { pm_id: string; amount: number }[]; tender_hash?: string };
    const spend_cap = Number(mb.spend_cap);
    if (!Number.isFinite(spend_cap) || spend_cap <= 0) return reply.code(400).send({ ok: false, error: "spend_cap must be a positive number" });
    await hydrate(sid);
    const s = getSession(sid);
    // Revalidate at checkout: a mandate is never signed over stale prices or unavailable stock.
    const rv = await shopCall(`/cart/${enc(sid)}/revalidate?store_id=${enc(s.store_id)}`, { method: "POST" });
    if (!rv.ok) return fail(reply, rv, "checkout revalidation");
    if (rv.data?.cart) applyCart(getThread(sid), rv.data.cart);
    if (!rv.data?.ok) {
      await afterChange(sid, "site", "revalidate");
      return reply.code(409).send({ ok: false, error: "The cart changed since you reviewed it. Resolve the issues before signing.", revalidation: rv.data, session: view(sid) });
    }
    // B16: an account/address/tender named by the payment step is signed INTO the mandate, and the
    // tender_hash from tender-preview must travel with it or authorize's tender_unchanged check fails.
    const r = await shopCall(
      `/cart/${enc(sid)}/mandate`,
      body({
        spend_cap,
        ...(getSession(sid).account?.account_id ? { account_id: String(getSession(sid).account.account_id) } : {}),
        ...(mb.address_id ? { address_id: mb.address_id } : {}),
        ...(Array.isArray(mb.tender) && mb.tender.length ? { tender: mb.tender.map((t) => ({ pm_id: String(t.pm_id), amount: Number(t.amount) })) } : {}),
        ...(mb.tender_hash ? { tender_hash: String(mb.tender_hash) } : {}),
      }),
    );
    if (!r.ok) return fail(reply, r, "create mandate");
    if (r.data?.error) return reply.code(400).send({ ok: false, error: r.data.error, session: view(sid) });
    applyToolResult(getThread(sid), "create_checkout_mandate", r.data);
    log(sid, "site", "mandate", `Shopper signed a checkout mandate (cap $${spend_cap.toFixed(2)}); no payment taken`);
    await afterChange(sid, "site", "mandate");
    return { ok: true, mandate: r.data.mandate, signature: r.data.signature, status: r.data.status, revalidation: rv.data, session: view(sid) };
  });

  app.post("/api/session/:sid/checkout/decision", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const { mandate_id, approved } = (req.body ?? {}) as { mandate_id?: string; approved?: boolean };
    if (!mandate_id) return reply.code(400).send({ ok: false, error: "mandate_id required" });
    await hydrate(sid);
    const d = await shopCall(`/mandates/${enc(mandate_id)}/${approved ? "approve" : "reject"}`, { method: "POST" });
    if (!d.ok) return fail(reply, d, "record decision");
    const ctx = getThread(sid);
    if (ctx.state.mandate && ctx.state.mandate.mandate_id === mandate_id) ctx.state.mandate.status = d.data?.status === "approved" ? "approved" : "rejected";
    let order = null;
    if (approved && d.data?.status === "approved") {
      const o = await shopCall(`/sessions/${enc(sid)}/orders`, body({ mandate_id }));
      if (!o.ok) return fail(reply, o, "place order");
      order = o.data?.order ?? o.data;
      await refreshCart(sid);
      log(sid, "site", "order", `Order placed from mandate ${mandate_id}; no payment taken`);
    } else {
      log(sid, "site", "mandate", `Mandate ${mandate_id} ${d.data?.status ?? "rejected"}`);
    }
    await afterChange(sid, "site", "decision");
    return { ok: d.data?.status === "approved" || !approved, decision: d.data, order, session: view(sid) };
  });

  // ---------------- orders, lists ----------------
  app.get("/api/session/:sid/orders", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const r = await shopCall(`/sessions/${enc(sid)}/orders`);
    return r.ok ? r.data : fail(reply, r, "list orders");
  });
  app.get("/api/session/:sid/lists", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const r = await shopCall(`/sessions/${enc(sid)}/lists`);
    return r.ok ? r.data : fail(reply, r, "list saved lists");
  });
  app.post("/api/session/:sid/lists", async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const r = await shopCall(`/sessions/${enc(sid)}/lists`, body(req.body));
    if (!r.ok) return fail(reply, r, "create list");
    log(sid, "site", "list", `Shopper created list “${(req.body as any)?.name ?? ""}”`);
    publish(sid, "site", "list");
    return r.data;
  });
  app.post("/api/session/:sid/lists/:name/items", async (req, reply) => {
    const { sid, name } = req.params as { sid: string; name: string };
    const r = await shopCall(`/sessions/${enc(sid)}/lists/${enc(name)}/items`, body(req.body));
    if (!r.ok) return fail(reply, r, "save to list");
    log(sid, "site", "list", `Shopper saved ${(req.body as any)?.product_id ?? "an item"} to “${name}”`);
    publish(sid, "site", "list");
    return r.data;
  });
  app.delete("/api/session/:sid/lists/:name/items/:pid", async (req, reply) => {
    const { sid, name, pid } = req.params as { sid: string; name: string; pid: string };
    const r = await shopCall(`/sessions/${enc(sid)}/lists/${enc(name)}/items/${enc(pid)}`, { method: "DELETE" });
    return r.ok ? r.data : fail(reply, r, "remove from list");
  });
  app.delete("/api/session/:sid/lists/:name", async (req, reply) => {
    const { sid, name } = req.params as { sid: string; name: string };
    const r = await shopCall(`/sessions/${enc(sid)}/lists/${enc(name)}`, { method: "DELETE" });
    return r.ok ? r.data : fail(reply, r, "delete list");
  });

  // ---------------- catalogue reads ----------------
  const passGet = (route: string, to: (req: any) => string, what: string) =>
    app.get(route, async (req, reply) => {
      const r = await shopCall(to(req));
      return r.ok ? r.data : fail(reply, r, what);
    });
  passGet("/api/store/stores", () => `/stores`, "list stores");
  passGet("/api/store/product/:pid", (req) => `/catalog-services/product/${enc(req.params.pid)}?store_id=${enc(String(req.query?.store_id ?? "4108"))}`, "product page");
  passGet("/api/store/suggest", (req) => `/storefront/suggest?q=${enc(String(req.query?.q ?? ""))}`, "suggestions");
  passGet("/api/store/help", (req) => `/help/answer?q=${enc(String(req.query?.q ?? ""))}${req.query?.lang ? `&lang=${enc(String(req.query.lang))}` : ""}`, "help answer");
  passGet("/api/store/faults", () => `/catalog-services/faults`, "read faults");
  app.post("/api/store/faults", async (req, reply) => {
    const r = await shopCall(`/catalog-services/faults`, body(req.body));
    return r.ok ? r.data : fail(reply, r, "set fault");
  });
  app.post("/api/store/inventory", async (req, reply) => {
    const r = await shopCall(`/catalog-services/inventory`, body(req.body));
    return r.ok ? r.data : fail(reply, r, "adjust inventory");
  });

  // ---------------- operator triage (B13) ----------------
  passGet("/api/triage", (req) => `/triage${req.query?.status ? `?status=${enc(String(req.query.status))}` : ""}`, "triage queue");
  app.post("/api/triage/:id", async (req, reply) => {
    const r = await shopCall(`/triage/${enc((req.params as any).id)}`, body(req.body));
    return r.ok ? r.data : fail(reply, r, "update triage record");
  });
}
