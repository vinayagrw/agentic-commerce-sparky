/**
 * Shop-plane calls the BFF makes on its own behalf: human-in-the-loop button actions
 * (accept a substitute, approve a mandate, add to cart) and a few read endpoints the web
 * app polls.
 *
 * Every one goes to shop-http (:8802) or search-svc (:8801). There is no local cart, no
 * bundled catalogue and no substitute of any kind: when a service is down the call
 * returns a ServiceUnavailable result naming the service, its port and the fix command,
 * and the caller surfaces that rather than inventing a number.
 */
import type { Provenance } from "@sparky/shared";
import { config } from "../config.js";
import { jfetch } from "../lib/http.js";

export interface ServiceUnavailable {
  error: string;
  service_unavailable: { service: string; url: string; port: number; fix: string; detail?: string };
}

export function isUnavailable(x: any): x is ServiceUnavailable {
  return Boolean(x && typeof x === "object" && x.service_unavailable);
}

function down(service: string, url: string, port: number, detail?: string): ServiceUnavailable {
  return {
    error: `${service} is not reachable at ${url} — run \`make dev\``,
    service_unavailable: { service, url, port, fix: "make dev", ...(detail ? { detail } : {}) },
  };
}

export function prov(service: string, endpoint: string, note?: string): Provenance {
  return { service, endpoint, timestamp: new Date().toISOString(), ...(note ? { note } : {}) };
}

/** shop-http call that reports the outage instead of falling back. */
export async function shop<T = any>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T | ServiceUnavailable> {
  const r = await jfetch<T>(`${config.shopHttpUrl}${path}`, { timeoutMs: 8000, ...init });
  if (r.status === 0) return down("shop-http", config.shopHttpUrl, 8802, r.error);
  if (!r.ok) return { error: (r.data as any)?.detail ?? (r.data as any)?.error ?? `shop-http ${r.status}`, ...(r.data as any) } as any;
  return r.data as T;
}

export async function search<T = any>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T | ServiceUnavailable> {
  const r = await jfetch<T>(`${config.searchSvcUrl}${path}`, { timeoutMs: 20_000, ...init });
  if (r.status === 0) return down("search-svc", config.searchSvcUrl, 8801, r.error);
  if (!r.ok) return { error: (r.data as any)?.detail ?? `search-svc ${r.status}`, ...(r.data as any) } as any;
  return r.data as T;
}

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

/**
 * The tools the BFF itself invokes for a human action on an A2UI card. The agent's own
 * tool calls do NOT come through here: they go through policy-mcp, which is the point.
 */
export async function execHumanAction(sessionId: string, tool: string, args: any): Promise<any> {
  const sid = encodeURIComponent(sessionId);
  switch (tool) {
    case "add_to_cart": {
      const r = await shop(`/cart/${sid}/items`, post({ product_id: args.product_id, qty: Number(args.qty ?? 1), budget: args.budget }));
      return withProv(r, "shop-http", `POST /cart/${sessionId}/items`);
    }
    case "remove_from_cart":
      return withProv(await shop(`/cart/${sid}/items/${encodeURIComponent(args.product_id)}`, { method: "DELETE" }), "shop-http", "DELETE /cart/items");
    case "get_cart":
      return withProv(await shop(`/cart/${sid}`), "shop-http", `GET /cart/${sessionId}`);
    case "create_checkout_mandate":
      return withProv(await shop(`/cart/${sid}/mandate`, post({ spend_cap: Number(args.spend_cap ?? 0) })), "shop-http", "POST /cart/mandate");
    case "approve_mandate":
      return withProv(
        await shop(`/mandates/${encodeURIComponent(args.mandate_id)}/${args.approved ? "approve" : "reject"}`, { method: "POST" }),
        "shop-http",
        "POST /mandates/{id}/approve",
      );
    case "agent_readiness_score":
      return withProv(await shop(`/agent/readiness/${encodeURIComponent(args.category ?? "Grocery")}`), "shop-http", "GET /agent/readiness");
    case "get_seller_listing":
      return withProv(await shop(`/seller-listing/${encodeURIComponent(args.product_id)}`), "shop-http", "GET /seller-listing");
    default:
      return { error: `unknown tool ${tool}` };
  }
}

function withProv(r: any, service: string, endpoint: string) {
  if (!r || typeof r !== "object" || isUnavailable(r)) return r;
  return { ...r, provenance: { ...(r.provenance ?? {}), ...prov(service, endpoint) } };
}

/** Beat 5: an external agent calls the signed catalogue feed as verified / unverified / tampered. */
export async function agentFeed(variant: string, category: string, agentId: string) {
  const signed = await shop<{ signature?: string }>(`/agent/sign?agent_id=${encodeURIComponent(agentId)}&category=${encodeURIComponent(category)}`);
  if (isUnavailable(signed)) return signed;
  const real = String(signed?.signature ?? "");
  let signature: string | undefined;
  if (variant === "verified") signature = real;
  if (variant === "tampered") signature = real.slice(0, -4) + (real.endsWith("0000") ? "ffff" : "0000");
  const headers: Record<string, string> = { "x-agent-id": agentId, ...(signature ? { "x-agent-signature": signature } : {}) };
  const r = await jfetch(`${config.shopHttpUrl}/agent/catalog/${encodeURIComponent(category)}`, { headers, timeoutMs: 20_000 });
  if (r.status === 0) return down("shop-http", config.shopHttpUrl, 8802, r.error);
  const d = (r.data as any)?.detail && typeof (r.data as any).detail === "object" ? (r.data as any).detail : r.data;
  return {
    ...d,
    status: r.status,
    variant,
    request_headers: { ...headers, "x-agent-signature": signature ? `${signature.slice(0, 16)}…` : "(none)" },
    ui: { surface: "agent_api" },
    provenance: prov("shop-http", `GET /agent/catalog/${category}`, "signature verified server-side"),
  };
}

/** NDCG@10 from search-svc. Cached for 10 minutes because the eval is slow, never substituted. */
let ndcgCache: { at: number; data: any } | null = null;
export async function ndcg(n = 100) {
  if (ndcgCache && Date.now() - ndcgCache.at < 10 * 60_000) return ndcgCache.data;
  const r = await search(`/eval/ndcg`, { ...post({ n_queries: n }), timeoutMs: 180_000 });
  if (isUnavailable(r)) return r;
  const data = { ...(r as any), provenance: prov("search-svc", "POST /eval/ndcg", `${n} ESCI test queries`) };
  ndcgCache = { at: Date.now(), data };
  return data;
}

export function resetNdcgCache() {
  ndcgCache = null;
}
