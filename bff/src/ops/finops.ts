/**
 * Beat 8c: the cost-aware router (playbook technique 26), over measured numbers only.
 *
 * Every figure here is either measured now or refused:
 *  - the cheap arm's p50/p95 come from timing real search-svc /search calls on the sampled
 *    queries, in this request;
 *  - the Claude arm's p95 and per-task cost come from the real shopper runs recorded in
 *    metrics.ts (wall clock, and the CLI's own total_cost_usd and token counts);
 *  - fulfilment rates are NOT invented: with no labelled outcome data on this laptop the
 *    field is null and the UI says so.
 *
 * With no Claude runs recorded yet the whole card refuses: "run a shopper beat first".
 */
import type { Provenance } from "@sparky/shared";
import { config } from "../config.js";
import { jfetch } from "../lib/http.js";
import * as metrics from "../metrics.js";
import { opsToolMeta } from "./meta.js";

const prov = (service: string, endpoint: string, note?: string): Provenance => ({
  service,
  endpoint,
  timestamp: new Date().toISOString(),
  ...(note ? { note } : {}),
});

/** Multi-constraint goals go to the agent; keyword lookups take the cheap path. */
export function isHard(q: string): boolean {
  return /\b(for \d+|under \$?\d+|plan|party|trip|replace|compare|similar|what should|gift|recipe|night)\b/i.test(q) || q.split(/\s+/).length >= 7;
}

/** Time one real search-svc query. Returns null when the service is unreachable. */
async function timeCheapQuery(query: string): Promise<number | null> {
  const t0 = Date.now();
  const r = await jfetch(`${config.searchSvcUrl}/search`, {
    method: "POST",
    body: JSON.stringify({ query, k: 10, mode: "rrf", filters: {} }),
    timeoutMs: 20_000,
  });
  return r.ok ? Date.now() - t0 : null;
}

export async function finopsRouter(opts: { sampleSize?: number } = {}): Promise<any> {
  const meta = opsToolMeta("finops_router");
  const n = Math.max(8, Math.min(opts.sampleSize ?? 24, 60));

  const qs = await jfetch(`${config.searchSvcUrl}/queries/sample?n=${n}`, { timeoutMs: 8000 });
  if (!qs.ok) {
    return {
      blocked: true,
      error: `search-svc is not reachable at ${config.searchSvcUrl} — run \`make dev\`. The router needs real queries; there is no sample to substitute.`,
      service_unavailable: { service: "search-svc", url: config.searchSvcUrl, port: 8801, fix: "make dev" },
      ui: "finops",
      ...meta,
      provenance: prov("bff", "GET /queries/sample", "upstream unavailable"),
    };
  }
  const queries: string[] = (Array.isArray(qs.data) ? qs.data : qs.data?.queries ?? [])
    .map((x: any) => (typeof x === "string" ? x : x?.query))
    .filter(Boolean)
    .slice(0, n);

  const routed = queries.map((q) => ({ query: q, route: isHard(q) ? "claude" : "cheap" }));
  const claudeShare = routed.length ? routed.filter((r) => r.route === "claude").length / routed.length : 0;

  // ---- cheap arm: measure it, right now, on the queries the router sent there.
  const cheapQueries = routed.filter((r) => r.route === "cheap").map((r) => r.query).slice(0, 12);
  const timings: number[] = [];
  for (const q of cheapQueries) {
    const ms = await timeCheapQuery(q);
    if (ms != null) {
      timings.push(ms);
      metrics.record("cheap", { ms, costUsd: 0, inputTokens: 0, outputTokens: 0, label: q });
    }
  }
  const cheap = metrics.stats("cheap");

  // ---- Claude arm: only what real runs recorded.
  const claude = metrics.stats("claude");
  if (!claude.n) {
    return {
      blocked: true,
      error: "No Claude-path runs have been measured yet. Run a shopper beat, then open 8c: the per-task cost and p95 come from real runs and there is no default to fall back on.",
      measured: { cheap_arm: cheap, claude_arm: claude },
      sample: routed.slice(0, 12),
      claude_share: Number(claudeShare.toFixed(2)),
      ui: "finops",
      ...meta,
      provenance: prov("bff", "metrics.stats('claude')", "no samples recorded"),
    };
  }

  const claudeTaskCost = claude.mean_cost_usd ?? 0;
  // Cheap path is CPU-only on this laptop: the marginal money cost of a BM25+RRF query is
  // not measurable here, so it is reported as 0 with that stated, never as a made-up figure.
  const cheapCost = 0;
  const per1kAllClaude = claudeTaskCost * 1000;
  const per1kRouted = 1000 * (claudeShare * claudeTaskCost + (1 - claudeShare) * cheapCost);

  return {
    ui: "finops",
    ...meta,
    n: routed.length,
    sample: routed.slice(0, 12),
    claude_share: Number(claudeShare.toFixed(2)),
    paths: [
      {
        path: "cheap (BM25 + RRF on search-svc)",
        share: Number((1 - claudeShare).toFixed(2)),
        cost_per_query_usd: cheapCost,
        cost_note: "CPU-only on this laptop; no per-query money cost is measurable here",
        p50_ms: cheap.p50_ms,
        p95_ms: cheap.p95_ms,
        samples: cheap.n,
        measured_from: "search-svc POST /search, timed in this request",
      },
      {
        path: "Claude agent + rerank",
        share: Number(claudeShare.toFixed(2)),
        cost_per_query_usd: claudeTaskCost,
        p50_ms: claude.p50_ms,
        p95_ms: claude.p95_ms,
        samples: claude.n,
        tokens: claude.total_tokens,
        measured_from: `${claude.n} real shopper/ops run(s) on this process, ${claude.first_at} → ${claude.last_at}`,
      },
    ],
    cost_per_1k: {
      all_claude: Number(per1kAllClaude.toFixed(2)),
      routed: Number(per1kRouted.toFixed(2)),
      savings_pct: per1kAllClaude ? Number((100 * (1 - per1kRouted / per1kAllClaude)).toFixed(1)) : null,
    },
    fulfilment: null,
    fulfilment_note: "Not measured: there is no labelled task-outcome data on this laptop, so no fulfilment rate is shown and cost per *fulfilled* task is not claimed.",
    rule: "cascade: keyword and navigational queries → cheap path; multi-constraint goals, substitutions and comparisons → Claude",
    provenance: prov("bff", "ops/finops.ts", `router over ${routed.length} live search-svc queries; ${cheap.n} timed cheap calls; ${claude.n} recorded Claude runs`),
  };
}
