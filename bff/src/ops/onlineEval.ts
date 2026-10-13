/**
 * Technique 29 (BFF side): ship the sessions this process really served to the online judge
 * in ops-http, and read back the judge's measured agreement.
 *
 * The BFF is deliberately not the judge: scoring lives next to the ESCI ground truth in
 * ops-mcp, and the BFF only supplies what actually happened. When ops-http is down this
 * refuses and names the port, like everything else on this plane.
 */
import type { Provenance } from "@sparky/shared";
import { config } from "../config.js";
import { jfetch } from "../lib/http.js";
import { status as otelStatus } from "../otel.js";
import { drainSessions, peekSessions } from "./router.js";

const prov = (service: string, endpoint: string, note?: string): Provenance => ({
  service,
  endpoint,
  timestamp: new Date().toISOString(),
  ...(note ? { note } : {}),
});

function down(detail?: string) {
  return {
    blocked: true,
    error: `ops-http is not reachable at ${config.opsHttpUrl} — run \`make dev\`. The online judge lives beside the ESCI ground truth; there is nothing here to substitute.`,
    service_unavailable: { service: "ops-http", url: config.opsHttpUrl, port: 8803, fix: "make dev", ...(detail ? { detail } : {}) },
    provenance: prov("bff", "ops/onlineEval.ts", "upstream unavailable"),
  };
}

/** Push every session recorded since the last export. */
export async function exportSessions() {
  const pending = peekSessions();
  if (!pending.length) {
    return {
      exported: 0,
      note: "no traced sessions recorded in this process yet. Drive traffic through GET /api/ops/router or POST /api/route first.",
      tracing: otelStatus(),
      provenance: prov("bff", "ops/router.ts", "no sessions"),
    };
  }
  const r = await jfetch<any>(`${config.opsHttpUrl}/online_evals/sessions`, {
    method: "POST",
    body: JSON.stringify({ sessions: pending }),
    timeoutMs: 15_000,
  });
  if (r.status === 0) return down(r.error);
  drainSessions();
  return { exported: pending.length, result: r.data, tracing: otelStatus(), provenance: prov("bff", "POST ops-http /online_evals/sessions") };
}

export async function judgeAgreement(rate = 1.0, maxPairs = 400) {
  const r = await jfetch<any>(`${config.opsHttpUrl}/online_evals/agreement?rate=${rate}&max_pairs=${maxPairs}`, { timeoutMs: 30_000 });
  if (r.status === 0) return down(r.error);
  return { ...(r.data ?? {}), judge_kind: "lexical", judge_label: "lexical judge (token overlap, not an LLM)", tracing: otelStatus(), provenance: prov("ops-http", "GET /online_evals/agreement", "lexical judge") };
}
