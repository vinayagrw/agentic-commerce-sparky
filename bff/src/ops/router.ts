/**
 * Technique 26 - model routing / cascade, over measured numbers only.
 *
 * Three retrieval arms are real and routable on this laptop, each a different model stack
 * behind search-svc:
 *
 *   lexical  BM25 only               - no neural model in the path
 *   hybrid   BM25 + bi-encoder RRF   - the bge-small embedding model
 *   premium  hybrid + cross-encoder  - the MiniLM reranker, the expensive arm
 *
 * A fourth arm, `claude`, is the agent path. It is only reported when real Claude runs have
 * been recorded in metrics.ts; it is never given a default.
 *
 * Every number below is measured in the request that produces it: each routed query is a
 * real HTTP call to search-svc, timed here in the BFF. Cost is CPU time at a STATED rate -
 * the rate is an assumption and is labelled as one, the seconds are not.
 *
 * Cascade: the router starts most traffic on `hybrid`, then escalates to `premium` when the
 * hybrid result looks uncertain (small score margin between rank 1 and rank 3). The
 * escalation is a real second call and its latency and cost are charged to the request.
 *
 * Every decision emits a route receipt (playbook 26 US-1 AC3): policy version, features,
 * chosen arm, whether it escalated, measured ms and measured cost.
 */
import type { Provenance } from "@sparky/shared";
import { config } from "../config.js";
import { jfetch } from "../lib/http.js";
import * as metrics from "../metrics.js";
import { currentTraceId, recordUsage, withGenAiSpan } from "../otel.js";
import { opsToolMeta } from "./meta.js";

export const ROUTER_POLICY_VERSION = "sparky-router-1.0.0";

/**
 * ASSUMPTION, labelled: $/CPU-minute for this laptop's compute. The same rate the ops cost
 * model uses. Wall-clock seconds are measured; only this rate is assumed.
 */
export const USD_PER_CPU_MIN = 0.0017;

export type RouteArm = "lexical" | "hybrid" | "premium" | "claude";

export interface RouteFeatures {
  tokens: number;
  hasConstraint: boolean;
  isNavigational: boolean;
  isMultiConstraintGoal: boolean;
}

export interface RouteReceipt {
  policy_version: string;
  query: string;
  features: RouteFeatures;
  arm: RouteArm;
  initial_arm: RouteArm;
  escalated: boolean;
  escalation_reason?: string;
  ms: number;
  cost_usd: number;
  calls: { arm: RouteArm; mode: string; ms: number }[];
  ok: boolean;
}

const MODE: Record<Exclude<RouteArm, "claude">, string> = {
  lexical: "bm25",
  hybrid: "rrf",
  premium: "rrf_rerank",
};

/** Escalate when rank-1 barely leads rank-3: that is where the reranker earns its cost. */
export const MARGIN_ESCALATE = 0.15;

export function features(q: string): RouteFeatures {
  const tokens = q.trim().split(/\s+/).filter(Boolean).length;
  return {
    tokens,
    hasConstraint: /\b(under|below|less than|over|gluten|nut[- ]free|vegan|organic|for \d+|\$\d+)\b/i.test(q),
    isNavigational: tokens <= 2,
    isMultiConstraintGoal:
      /\b(for \d+|under \$?\d+|plan|party|trip|replace|compare|similar|what should|gift|recipe|night)\b/i.test(q) || tokens >= 7,
  };
}

/** The policy. Deterministic, versioned, and small enough to read. */
export function decide(q: string): { arm: RouteArm; reason: string; features: RouteFeatures } {
  const f = features(q);
  if (f.isMultiConstraintGoal) return { arm: "premium", reason: "multi-constraint goal: start on the reranked arm", features: f };
  if (f.isNavigational && !f.hasConstraint) return { arm: "lexical", reason: "navigational lookup: BM25 is enough", features: f };
  return { arm: "hybrid", reason: "default: hybrid RRF, escalate on low margin", features: f };
}

async function callArm(query: string, arm: Exclude<RouteArm, "claude">) {
  const t0 = Date.now();
  const r = await jfetch<any>(`${config.searchSvcUrl}/search`, {
    method: "POST",
    body: JSON.stringify({ query, k: 10, mode: MODE[arm], filters: {} }),
    timeoutMs: 30_000,
  });
  return { ok: r.ok, ms: Date.now() - t0, data: r.data };
}

/**
 * Score margin between rank 1 and rank 3 of a search-svc result, or null when unknowable.
 * search-svc reports per-signal scores under `scores` keyed by mode (bm25 / vector / rrf / rerank).
 */
export function margin(data: any): number | null {
  const items: any[] = data?.results ?? data?.items ?? data?.hits ?? [];
  const pick = (x: any) => {
    const s = x?.scores ?? {};
    const v = s.rerank ?? s.rrf ?? s.vector ?? s.bm25 ?? x?.score;
    return Number(v);
  };
  const scores = items.map(pick).filter((n) => Number.isFinite(n));
  if (scores.length < 3 || !scores[0]) return null;
  return Math.abs((scores[0] - scores[2]) / scores[0]);
}

const cost = (ms: number) => Number(((ms / 60_000) * USD_PER_CPU_MIN).toFixed(8));

const productIds = (data: any): string[] =>
  (data?.results ?? data?.items ?? []).map((x: any) => x?.product_id).filter(Boolean).slice(0, 10);

/**
 * Route and EXECUTE one query. Every ms in the receipt is wall clock measured here.
 * The whole decision runs inside one OTel GenAI span (technique 29), so a route receipt and
 * the trace that produced it share an id.
 */
export async function route(query: string, escalateThreshold: number = MARGIN_ESCALATE): Promise<RouteReceipt> {
  const d = decide(query);
  return withGenAiSpan(
    "sparky.route",
    {
      operation: "invoke_agent",
      system: "sparky",
      model: `router/${d.arm}`,
      promptVersion: ROUTER_POLICY_VERSION,
      surface: "search",
      missionType: d.features.isMultiConstraintGoal ? "multi_constraint_goal" : d.features.isNavigational ? "navigational" : "keyword",
      prompt: query,
      extra: {
        "sparky.router.initial_arm": d.arm,
        "sparky.router.reason": d.reason,
        "sparky.router.tokens": d.features.tokens,
      },
    },
    async (span) => {
      const calls: RouteReceipt["calls"] = [];
      let arm = d.arm as Exclude<RouteArm, "claude">;
      let escalated = false;
      let escalationReason: string | undefined;

      const first = await callArm(query, arm);
      calls.push({ arm, mode: MODE[arm], ms: first.ms });
      metrics.record(`route:${arm}`, { ms: first.ms, costUsd: cost(first.ms), inputTokens: 0, outputTokens: 0, label: query });
      let data = first.data;

      if (arm !== "premium" && first.ok) {
        const m = margin(first.data);
        if (m !== null && m < escalateThreshold) {
          escalated = true;
          escalationReason = `rank1-rank3 score margin ${m.toFixed(3)} < ${escalateThreshold}`;
          const second = await callArm(query, "premium");
          calls.push({ arm: "premium", mode: MODE.premium, ms: second.ms });
          metrics.record("route:premium", { ms: second.ms, costUsd: cost(second.ms), inputTokens: 0, outputTokens: 0, label: query });
          arm = "premium";
          if (second.ok) data = second.data;
        }
      }

      const ms = calls.reduce((a, c) => a + c.ms, 0);
      const receipt: RouteReceipt = {
        policy_version: ROUTER_POLICY_VERSION,
        query,
        features: d.features,
        arm,
        initial_arm: d.arm,
        escalated,
        ...(escalationReason ? { escalation_reason: escalationReason } : {}),
        ms,
        cost_usd: cost(ms),
        calls,
        ok: first.ok,
      };
      span?.setAttributes({ "sparky.router.final_arm": arm, "sparky.router.escalated": escalated });
      recordUsage(span, { model: `search-svc/${MODE[arm]}`, costUsd: receipt.cost_usd, ms });
      lastSessions.push({
        trace_id: currentTraceId() ?? `no-trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        query,
        arm,
        escalated,
        ms,
        cost_usd: receipt.cost_usd,
        product_ids: productIds(data),
        policy_version: ROUTER_POLICY_VERSION,
      });
      if (lastSessions.length > 500) lastSessions.splice(0, lastSessions.length - 500);
      return receipt;
    },
  );
}

/** Sessions this process really served, awaiting export to the online judge (technique 29). */
const lastSessions: any[] = [];

export function drainSessions(): any[] {
  return lastSessions.splice(0, lastSessions.length);
}

export function peekSessions(): any[] {
  return [...lastSessions];
}

const prov = (service: string, endpoint: string, note?: string): Provenance => ({
  service,
  endpoint,
  timestamp: new Date().toISOString(),
  ...(note ? { note } : {}),
});

function armStats(arm: RouteArm) {
  const s = metrics.stats(arm === "claude" ? "claude" : `route:${arm}`);
  return {
    arm,
    n: s.n,
    p50_ms: s.p50_ms,
    p95_ms: s.p95_ms,
    mean_cost_usd: s.mean_cost_usd,
    cost_per_1k_usd: s.mean_cost_usd == null ? null : Number((s.mean_cost_usd * 1000).toFixed(6)),
    measured_from: s.n ? `${s.n} real request(s) through the BFF, ${s.first_at} -> ${s.last_at}` : "no requests recorded",
  };
}

/**
 * Drive `n` REAL queries from search-svc's own query set through the router, then drive the
 * same queries through the premium arm alone as the always-premium control. Returns the
 * measured per-arm figures and the router's realised saving against that control.
 */
export async function routerReport(opts: { n?: number; control?: boolean; escalateThreshold?: number } = {}) {
  const escalateThreshold = opts.escalateThreshold ?? MARGIN_ESCALATE;
  const meta = opsToolMeta("finops_router");
  const n = Math.max(4, Math.min(opts.n ?? 24, 120));
  const qs = await jfetch<any>(`${config.searchSvcUrl}/queries/sample?n=${n}`, { timeoutMs: 8000 });
  if (!qs.ok) {
    return {
      blocked: true,
      error: `search-svc is not reachable at ${config.searchSvcUrl} — run \`make dev\`. The router measures real calls; there is nothing to substitute.`,
      service_unavailable: { service: "search-svc", url: config.searchSvcUrl, port: 8801, fix: "make dev" },
      ui: "finops",
      ...meta,
      provenance: prov("bff", "GET /queries/sample", "upstream unavailable"),
    };
  }
  const queries: string[] = (Array.isArray(qs.data) ? qs.data : (qs.data?.queries ?? []))
    .map((x: any) => (typeof x === "string" ? x : x?.query))
    .filter(Boolean)
    .slice(0, n);

  const receipts: RouteReceipt[] = [];
  for (const q of queries) receipts.push(await route(q, escalateThreshold));

  // Always-premium control on the SAME queries, so the saving is a paired comparison and
  // not two different workloads.
  let controlMs: number[] = [];
  if (opts.control !== false) {
    for (const q of queries) {
      const r = await callArm(q, "premium");
      controlMs.push(r.ms);
      metrics.record("control:premium", { ms: r.ms, costUsd: cost(r.ms), inputTokens: 0, outputTokens: 0, label: q });
    }
  }

  const routedTotal = receipts.reduce((a, r) => a + r.cost_usd, 0);
  const controlTotal = controlMs.reduce((a, ms) => a + cost(ms), 0);
  const routedPer1k = receipts.length ? Number(((routedTotal / receipts.length) * 1000).toFixed(6)) : null;
  const controlPer1k = controlMs.length ? Number(((controlTotal / controlMs.length) * 1000).toFixed(6)) : null;

  const mix: Record<string, number> = {};
  for (const r of receipts) mix[r.arm] = (mix[r.arm] ?? 0) + 1;

  const claude = metrics.stats("claude");

  return {
    ui: "finops",
    ...meta,
    technique: 26,
    policy_version: ROUTER_POLICY_VERSION,
    escalate_threshold: escalateThreshold,
    rule: "navigational <=2 tokens -> lexical; multi-constraint goal -> premium; everything else -> hybrid, escalating to premium when the rank1/rank3 score margin is under " + MARGIN_ESCALATE,
    n: receipts.length,
    requests_made: receipts.reduce((a, r) => a + r.calls.length, 0) + controlMs.length,
    arm_mix: mix,
    escalations: receipts.filter((r) => r.escalated).length,
    arms: (["lexical", "hybrid", "premium"] as RouteArm[]).map(armStats),
    claude_arm: claude.n
      ? armStats("claude")
      : {
          arm: "claude",
          n: 0,
          p50_ms: null,
          p95_ms: null,
          cost_per_1k_usd: null,
          measured_from: "no Claude runs recorded in this process; run a shopper beat first. No default is substituted.",
        },
    cost_per_1k: {
      routed: routedPer1k,
      always_premium: controlPer1k,
      savings_pct: routedPer1k != null && controlPer1k ? Number((100 * (1 - routedPer1k / controlPer1k)).toFixed(1)) : null,
      basis: "measured wall-clock ms per request x $/CPU-min",
    },
    assumptions: {
      usd_per_cpu_min: { value: USD_PER_CPU_MIN, provenance: "assumption", note: "laptop CPU rate; the seconds are measured, this rate is not" },
    },
    receipts: receipts.slice(0, 12),
    quality_note:
      "This reports cost and latency only. The router's quality delta per arm is NOT measured here; search-svc /eval/ndcg measures NDCG@10 per mode and is the place that belongs.",
    provenance: prov(
      "bff",
      "ops/router.ts -> search-svc POST /search",
      `${receipts.length} routed queries and ${controlMs.length} control queries, all executed in this request`,
    ),
  };
}
