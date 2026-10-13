/**
 * Browser half of deep tracing (docs/TRACING.md). The bff sends CUSTOM `trace` {traceId, spanId, runId,
 * replayRunId} right after RUN_STARTED; this module keeps that id per agent, measures what only the
 * browser can see and posts it as kind "ui" spans to POST /api/traces/web under the same traceId:
 *   - `ui send→first token`: composer send → first answer token painted (next animation frame)
 *   - `ui a2ui render`: A2UI surface event received → surface committed and painted
 *   - `ui web vitals`: largest LCP and worst INP-like event duration seen so far (PerformanceObserver)
 * Every span carries `sparky.layout`; the same layout is sent in agent state so the turn root records it.
 * Nothing is estimated: a measurement that did not happen is not sent.
 */

export interface TraceInfo {
  traceId: string;
  spanId: string | null;
  runId: string | null;
  replayRunId: string | null;
}

interface UiSpan {
  traceId: string;
  spanId: string;
  parentId: string | null;
  name: string;
  kind: "ui";
  start: number;
  end: number;
  attrs: Record<string, string | number | boolean>;
  status: "ok" | "error" | "unset";
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const current = new Map<string, TraceInfo>();
const sendAt = new Map<string, number>();
const firstPainted = new Set<string>();
const pending = new Map<string, UiSpan[]>();
const vitals = { lcp: null as number | null, inp: null as number | null };

const rand16 = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Where the chat is shown: shop-site / shop-chat / shop-split / shopper-plane / ops-dock / other. */
export function currentLayout(): string {
  if (typeof window === "undefined") return "unreported";
  const { pathname, search } = window.location;
  const p = new URLSearchParams(search);
  if (pathname.startsWith("/shop/") || pathname === "/shop") {
    const v = p.get("view") ?? p.get("layout");
    return `shop-${v === "chat" || v === "split" ? v : "site"}`;
  }
  if (pathname.startsWith("/shopper")) return "shopper-plane";
  if (pathname.startsWith("/ops")) return "ops-dock";
  return "other";
}

let observing = false;
function observeVitals() {
  if (observing || typeof PerformanceObserver === "undefined") return;
  observing = true;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) vitals.lcp = Math.round(e.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    /* unsupported */
  }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as PerformanceEventTiming[]) if ((e as any).interactionId) vitals.inp = Math.max(vitals.inp ?? 0, Math.round(e.duration));
    }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  } catch {
    /* unsupported */
  }
}
observeVitals();

function push(agentId: string, name: string, start: number, end: number, attrs: UiSpan["attrs"] = {}) {
  const t = current.get(agentId);
  if (!t) return;
  const span: UiSpan = { traceId: t.traceId, spanId: rand16(), parentId: t.spanId, name, kind: "ui", start, end: Math.max(start, end), attrs: { "sparky.layout": currentLayout(), "sparky.agent": agentId, ...attrs }, status: "ok" };
  pending.set(agentId, [...(pending.get(agentId) ?? []), span].slice(-40));
}

/** Composer or beat send: start of the send→first-token span. */
export function markSend(agentId: string) {
  sendAt.set(agentId, Date.now());
  firstPainted.delete(agentId);
}

/** CUSTOM `trace` event. */
export function onTraceEvent(agentId: string, v: any): TraceInfo | null {
  if (!v || !HEX32.test(String(v.traceId))) return null;
  const info: TraceInfo = { traceId: v.traceId, spanId: HEX16.test(String(v.spanId)) ? v.spanId : null, runId: v.runId ?? null, replayRunId: v.replayRunId ?? null };
  current.set(agentId, info);
  if (!sendAt.has(agentId)) sendAt.set(agentId, Date.now());
  return info;
}

export const traceFor = (agentId: string) => current.get(agentId) ?? null;

/** First TEXT_MESSAGE_CONTENT: measured once it has been painted (next frame). */
export function onFirstToken(agentId: string) {
  if (firstPainted.has(agentId)) return;
  firstPainted.add(agentId);
  const t0 = sendAt.get(agentId);
  if (t0 == null) return;
  requestAnimationFrame(() => {
    const end = Date.now();
    push(agentId, "ui send→first token", t0, end, { "sparky.ui.first_token_ms": end - t0 });
  });
}

/** A2UI surface: call with the time the surface event arrived, from a layout effect after commit. */
export function onA2uiRendered(agentId: string, receivedAt: number, surfaceId: string) {
  requestAnimationFrame(() => {
    const end = Date.now();
    push(agentId, "ui a2ui render", receivedAt, end, { "sparky.ui.a2ui_render_ms": end - receivedAt, "sparky.ui.surface_id": surfaceId.slice(0, 64) });
  });
}

/** End of run: add web vitals, post the batch. Failures are silent (tracing must never break chat). */
export async function flush(agentId: string) {
  const t = current.get(agentId);
  if (!t) return;
  const now = Date.now();
  const attrs: UiSpan["attrs"] = {};
  if (vitals.lcp != null) attrs["sparky.ui.lcp_ms"] = vitals.lcp;
  if (vitals.inp != null) attrs["sparky.ui.inp_ms"] = vitals.inp;
  if (Object.keys(attrs).length) push(agentId, "ui web vitals", now, now, attrs);
  const spans = pending.get(agentId) ?? [];
  pending.delete(agentId);
  sendAt.delete(agentId);
  if (!spans.length) return;
  try {
    await fetch("/api/traces/web", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spans }), keepalive: true });
  } catch {
    /* ignore */
  }
}
