/**
 * Shared shop-http proxy helpers for the session routes (extracted from routes.ts so that
 * routes.ts and accountRoutes.ts use ONE convention: shop call -> log() -> afterChange() ->
 * return { ..., session: view(sid) }).
 *
 * A service that is down is reported as such (503 naming it); nothing is substituted.
 * Nothing here ever logs a request body: wallet writes carry a test-card number.
 */
import type { FastifyReply } from "fastify";
import { config } from "../config.js";
import { jfetch } from "../lib/http.js";
import { getThread } from "../agui/threadStore.js";
import { applyCart } from "../agui/stateReducer.js";
import type { ConstraintEntry } from "@sparky/shared";
import { constraintId, type ConstraintMeta } from "./constraints.js";
import { getSession, publish, runVerifier } from "./sessionStore.js";

export const enc = encodeURIComponent;
export const SHOP = () => config.shopHttpUrl;

export type Res = { ok: boolean; status: number; data: any; error?: string };

export async function shopCall(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Res> {
  return jfetch(`${SHOP()}${path}`, { timeoutMs: 20_000, ...init });
}

export function fail(reply: FastifyReply, r: Res, what: string) {
  if (r.status === 0) {
    return reply.code(503).send({
      ok: false,
      error: `shop-http is not reachable at ${SHOP()}: ${what} did not run. Run \`make dev\`.`,
      service_unavailable: { service: "shop-http", url: SHOP(), port: Number(new URL(SHOP()).port), fix: "make dev", detail: r.error },
    });
  }
  const d = r.data ?? {};
  return reply.code(r.status >= 400 ? r.status : 502).send({ ok: false, error: d.detail ?? d.error ?? `shop-http ${r.status}`, ...(typeof d === "object" ? d : {}) });
}

export const body = (x: unknown) => ({ method: "POST", body: JSON.stringify(x ?? {}) });

export async function refreshCart(sid: string) {
  const r = await shopCall(`/cart/${enc(sid)}`);
  if (r.ok && r.data?.cart) applyCart(getThread(sid), r.data.cart);
  return r;
}

export async function afterChange(sid: string, actor: "site" | "agent" | "system", reason: string) {
  try {
    await runVerifier(sid);
  } catch {
    /* verifier facts unavailable: constraints keep their last status */
  }
  publish(sid, actor, reason);
}

// ---------------------------------------------------------------- constraints (one code path)

/**
 * The single add-a-constraint path used by POST /constraints and by a persona switch: pushes the
 * chip, records its provenance meta and mirrors a budget into shop-http, so chips, the verifier
 * and appliesAs() work with no extra logic.
 */
export async function addConstraint(sid: string, key: string, value: string, meta: ConstraintMeta) {
  const ctx = getThread(sid);
  const c = { key: String(key), value: String(value), status: "unknown" as const };
  const id = constraintId(c);
  if (!ctx.state.constraints.some((x) => constraintId(x) === id)) ctx.state.constraints.push(c);
  getSession(sid).meta.set(id, meta);
  if (key === "budget") {
    const n = Number(String(value).replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n > 0) {
      ctx.state.budget = n;
      await shopCall(`/sessions/${enc(sid)}/budget`, body({ budget: n }));
    }
  }
}

/** The single remove path: drops the matching chips, clearing the shop-http budget if one went. */
export async function removeConstraints(sid: string, match: (c: ConstraintEntry) => boolean) {
  const ctx = getThread(sid);
  const s = getSession(sid);
  const gone = ctx.state.constraints.filter(match);
  if (!gone.length) return { gone, clearFailed: null as Res | null };
  ctx.state.constraints = ctx.state.constraints.filter((c) => !gone.includes(c));
  for (const c of gone) s.meta.delete(constraintId(c));
  let clearFailed: Res | null = null;
  if (gone.some((c) => c.key === "budget")) {
    ctx.state.budget = null;
    const r = await shopCall(`/sessions/${enc(sid)}/budget`, { method: "DELETE" });
    if (!r.ok) clearFailed = r;
  }
  return { gone, clearFailed };
}
