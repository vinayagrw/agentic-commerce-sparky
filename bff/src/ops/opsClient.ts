/**
 * Ops-plane calls the BFF makes on its own behalf: a human decision on an approval card,
 * a label review, the audit log, and the presenter's "inject latency" button.
 *
 * These go to ops-http (:8803) and search-svc (:8801). The in-memory simulation that used
 * to stand in for both is gone, so when a service is down the call says so and the UI
 * shows the red banner instead of rendering a simulated result.
 */
import type { AuditRow, Provenance } from "@sparky/shared";
import { config } from "../config.js";
import { jfetch } from "../lib/http.js";
import { opsToolMeta } from "./meta.js";

const prov = (service: string, endpoint: string, note?: string): Provenance => ({
  service,
  endpoint,
  timestamp: new Date().toISOString(),
  ...(note ? { note } : {}),
});

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

export interface OpsUnavailable {
  blocked: true;
  error: string;
  service_unavailable: { service: string; url: string; port: number; fix: string; detail?: string };
  provenance: Provenance;
}

function down(service: string, url: string, port: number, detail?: string): OpsUnavailable {
  return {
    blocked: true,
    error: `${service} is not reachable at ${url} — run \`make dev\``,
    service_unavailable: { service, url, port, fix: "make dev", ...(detail ? { detail } : {}) },
    provenance: prov("bff", url, "upstream unavailable"),
  };
}

export const isOpsUnavailable = (x: any): x is OpsUnavailable => Boolean(x?.service_unavailable);

async function ops<T = any>(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const r = await jfetch<T>(`${config.opsHttpUrl}${path}`, { timeoutMs: 8000, ...init });
  if (r.status === 0) return down("ops-http", config.opsHttpUrl, 8803, r.error);
  return (r.data ?? {}) as T;
}

async function svc<T = any>(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const r = await jfetch<T>(`${config.searchSvcUrl}${path}`, { timeoutMs: 20_000, ...init });
  if (r.status === 0) return down("search-svc", config.searchSvcUrl, 8801, r.error);
  return (r.data ?? {}) as T;
}

/** The audit log, straight from ops-http. */
export async function auditLog(limit = 40) {
  const r = await ops<any>(`/audit?limit=${limit}`);
  if (isOpsUnavailable(r)) return { ...r, ui: "audit", ...opsToolMeta("get_audit_log") };
  const entries: AuditRow[] = Array.isArray(r) ? r : (r.entries ?? []);
  return {
    entries: entries.slice(-limit),
    ui: "audit",
    ...opsToolMeta("get_audit_log"),
    provenance: prov("ops-http", "GET /audit"),
  };
}

/** A human confirming labels from the review queue. */
export async function recordLabelReviews(decisions: { item_id: string; label: string }[]) {
  const results: any[] = [];
  for (const d of decisions) {
    const r = await ops(`/labels/review`, post({ item_id: d.item_id, label: d.label, reviewer: "human@demo" }));
    if (isOpsUnavailable(r)) return { ...r, ui: "label_queue", ...opsToolMeta("record_labels") };
    results.push(r);
  }
  return {
    recorded: results.length,
    items: results,
    ui: "label_queue",
    ...opsToolMeta("record_labels"),
    provenance: prov("ops-http", "POST /labels/review", "human review, one row per item"),
  };
}

/** A human approving or rejecting an approval card. ops-http is the only place this is recorded. */
export async function decideApproval(approvalId: string, approved: boolean, choice?: string) {
  const verb = approved ? "approve" : "reject";
  const r = await ops<any>(`/approvals/${encodeURIComponent(approvalId)}/${verb}`, post({ decided_by: "human@demo", note: choice ?? "Compass UI" }));
  if (isOpsUnavailable(r)) return r;
  if (r?.detail || r?.error) {
    return { blocked: true, error: String(r.detail ?? r.error), approval_id: approvalId, provenance: prov("ops-http", `POST /approvals/${approvalId}/${verb}`) };
  }
  return {
    ok: true,
    approval_id: approvalId,
    kind: r.kind ?? "remediation",
    status: approved ? "approved" : "rejected",
    subject: r.subject,
    choice: choice ?? r.subject,
    provenance: prov("ops-http", `POST /approvals/${approvalId}/${verb}`, "recorded by a human, outside the agent's reach"),
  };
}

/** Phase 3: run a T2 runbook after a human approval (ops-http re-checks the approval; single use). */
export async function executeRunbook(approvalId: string) {
  return ops<any>(`/runbooks/execute`, { ...post({ approval_id: approvalId }), timeoutMs: 600_000 });
}

/** Phase 3 watch alerts and cost/token dashboard (ops-mcp copilot, read-only). */
export const watchAlerts = () => ops<any>(`/copilot/watch`, { timeoutMs: 30_000 });
export const tokenReport = (hours = 168) => ops<any>(`/copilot/tokens?hours=${hours}`, { timeoutMs: 30_000 });

/** B08: a preregistered null candidate through the gate, measured live by ops-http + search-svc (slow: ~1 min). */
export async function gatePreregisteredCandidate(candidate = "late_interaction", nQueries = 200) {
  const r = await ops<any>(`/gates/preregistered/${encodeURIComponent(candidate)}?n_queries=${nQueries}`, { ...post({}), timeoutMs: 600_000 });
  if (isOpsUnavailable(r)) return { ...r, ui: "eval_gate", ...opsToolMeta("gate_preregistered_candidate") };
  if (r?.detail && !r?.checks) return { blocked: true, error: String(r.detail), provenance: prov("ops-http", `POST /gates/preregistered/${candidate}`) };
  return { ...r, provenance: { ...(r.provenance ?? {}), service: "ops-http", endpoint: `POST /gates/preregistered/${candidate}`, timestamp: new Date().toISOString(), note: "live re-measurement on search-svc POST /eval/late_interaction" } };
}

/** The model registry, live from search-svc. Refuses rather than showing a stale shape. */
export async function registry() {
  const r = await svc<any>("/models", { timeoutMs: 8000 });
  if (isOpsUnavailable(r)) return r;
  return { ...r, provenance: prov("search-svc", "GET /models") };
}

/**
 * Presenter button: slow the canary arm on search-svc, drive real traffic through it, and
 * let ops-http's guardrail watcher decide whether to roll back. Everything reported here
 * is read back from those two services.
 */
export async function injectLatency(ms: number) {
  const inj = await svc<any>("/debug/inject_latency", { ...post({ ms }), timeoutMs: 8000 });
  if (isOpsUnavailable(inj)) return [{ ...inj, ui: "canary", ...opsToolMeta("rollback") }];

  let status: any = null;
  let guard: any = null;
  let breached = false;
  for (let i = 0; i < 6 && !breached; i++) {
    await svc("/canary/traffic", { ...post({ n: 40 }), timeoutMs: 60_000 });
    const chk = await ops<any>("/guardrail/check", post({}));
    if (!isOpsUnavailable(chk)) guard = chk;
    const st = await svc<any>("/canary/status", { timeoutMs: 8000 });
    if (!isOpsUnavailable(st)) status = st;
    breached = guard?.action === "rolled_back" || status?.status === "rolled_back" || Boolean(status?.guardrail?.breached);
  }

  const out: any[] = [
    {
      ...(status ?? {}),
      injected_ms: ms,
      guardrail_check: guard,
      ui: "canary",
      ...opsToolMeta("rollback"),
      provenance: prov(
        "search-svc + ops-http",
        "POST /debug/inject_latency, POST /canary/traffic, POST /guardrail/check",
        breached ? "guardrail breached and ops-http rolled the canary back (T3)" : "guardrail not breached on the traffic driven so far",
      ),
    },
  ];
  out.push(await auditLog());
  return out;
}
