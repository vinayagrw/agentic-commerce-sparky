/** Apply an ops tool result to shared state: lifecycle stage, active agent + tier, latest payload per surface. */
import type { AgentState, AuditRow, LifecycleStage, Tier } from "@sparky/shared";
import { LIFECYCLE } from "@sparky/shared";
import { agentName, opsToolMeta } from "./meta.js";

type Json = Record<string, any>;

export function upsertAgent(state: AgentState, name: string, tier: Tier, status: "running" | "done" | "blocked" | "idle") {
  const a = state.agents.find((x) => x.name === name);
  if (a) Object.assign(a, { tier, status });
  else state.agents.push({ name, tier, status });
}

export function markOpsActive(state: AgentState, tool: string) {
  const m = opsToolMeta(tool);
  for (const a of state.agents) if (a.status === "running" && a.name !== m.agent) a.status = "done";
  upsertAgent(state, m.agent, m.tier, "running");
  state.ops.active_agent = m.agent;
  state.ops.tier = m.tier;
  state.ops.stage = m.stage;
}

/** Accept ops-http rows ({ts epoch, actor, actor_type, tier, action, subject, approval_id, outcome}) and sim rows. Oldest first. */
export function normalizeAudit(rows: Json[]): AuditRow[] {
  const out = rows.map((r) => {
    const ts = typeof r.ts === "number" ? new Date(r.ts * (r.ts < 1e12 ? 1000 : 1)).toISOString() : String(r.ts ?? "");
    const isAgent = r.actor_type ? r.actor_type === "agent" : r.actor === "agent";
    return {
      ts,
      actor: String(r.actor_type === "human" || r.actor === "human" ? `human${r.actor && r.actor !== "human" ? ` (${r.actor})` : ""}` : r.actor_type ?? r.actor ?? ""),
      agent: r.agent ?? (isAgent ? agentName(r.actor, "") : r.actor_type === "human" ? "" : String(r.actor ?? "")),
      tier: r.tier,
      action: String(r.action ?? ""),
      approval: r.approval ?? r.approval_id ?? undefined,
      detail: r.detail && typeof r.detail === "string" ? r.detail : [r.subject, r.outcome && r.outcome !== "ok" ? r.outcome : ""].filter(Boolean).join(" · ") || undefined,
    } as AuditRow;
  });
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** ops-mcp gate {ndcg10:{champion,candidate,delta,ci95}, gate_passed, checks:{k:{value,passed}}, agent_pass_k} -> sim shape. */
export function normalizeGate(d: Json): Json {
  const raw = d.metrics?.ndcg10 ?? d.ndcg10 ?? {};
  const delta = typeof raw.delta === "number" ? { mean: raw.delta, ci95: raw.ci95 } : raw.delta ?? { mean: (raw.candidate ?? 0) - (raw.champion ?? 0), ci95: raw.ci95 };
  const checks = Object.fromEntries(Object.entries(d.checks ?? d.gate?.checks ?? {}).map(([k, v]: [string, any]) => [k, typeof v === "object" && v ? Boolean(v.passed) : Boolean(v)]));
  const passed = Boolean(d.passed ?? d.gate_passed ?? d.gate?.passed ?? d.verdict === "PASS");
  const pk = d.pass_k ?? (d.agent_pass_k && d.agent_pass_k.status !== "not_run" ? d.agent_pass_k : null);
  return { ...d, metrics: { ...(d.metrics ?? {}), ndcg10: { champion: raw.champion, candidate: raw.candidate, delta } }, gate: { ...(d.gate ?? {}), checks, passed }, passed, pass_k: pk ?? d.pass_k, verdict: passed ? "PASS" : "FAIL" };
}

/** Approval payloads: sim {approval_id, options[]} or ops-mcp {proposals[] each with approval_id} or {error: awaiting_human_approval, approval_id}. */
export function approvalsOf(d: Json): { approval_id: string; kind: string; title?: string; subject?: string; option?: Json }[] {
  if (Array.isArray(d.proposals) && d.proposals.length) return d.proposals.map((p: Json) => ({ approval_id: String(p.approval_id), kind: "remediation", title: p.title, subject: String(p.remediation_id ?? ""), option: p }));
  const id = d.approval_id ?? d.id;
  if (!id) return [];
  const kind = d.kind ?? (d.version && !d.remediation_id ? "promote" : "remediation");
  return [{ approval_id: String(id), kind, title: d.title ?? (d.version ? `Promote ${d.version}` : d.remediation_id), subject: String(d.remediation_id ?? d.version ?? "") }];
}

/** ops-mcp sends `ui: {surface}`; the local sim sends `ui: "<hint>"`. */
export function uiOf(data: Json | null | undefined): string | null {
  const u = data?.ui;
  return typeof u === "string" ? u : typeof u?.surface === "string" ? u.surface : typeof u?.type === "string" ? u.type : null;
}

export function applyOpsResult(state: AgentState, tool: string, data: Json) {
  if (!data || typeof data !== "object") return;
  const m = opsToolMeta(tool);
  const agent = agentName(data.agent, tool);
  const tier = (data.tier ?? m.tier) as Tier;
  const stage = (LIFECYCLE as string[]).includes(data.stage) ? (data.stage as LifecycleStage) : m.stage;
  Object.assign(state.ops, { active_agent: agent, tier, stage });
  upsertAgent(state, agent, tier, data.blocked || data.error ? "blocked" : "done");
  const o = state.ops;
  switch (uiOf(data)) {
    case "dq_report":
      o.dq = data;
      break;
    case "label_queue":
      o.labels = data;
      break;
    case "drift_chart":
      o.drift = data;
      break;
    case "alert":
      if (Array.isArray(data.timeline)) o.drift = data;
      o.alerts = [...o.alerts, { title: data.title ?? data.error, severity: data.severity ?? (data.blocked ? "blocked" : "info"), message: data.message ?? data.error }].slice(-5);
      break;
    case "approval": {
      for (const a of approvalsOf(data)) {
        o.approvals = [...o.approvals.filter((x) => x.approval_id !== a.approval_id), { approval_id: a.approval_id, kind: a.kind, status: "pending", title: a.title, subject: a.subject }];
      }
      break;
    }
    case "eval_gate":
      if (data.metrics || data.ndcg10) o.gate = normalizeGate(data);
      break;
    case "canary":
      o.canary = data;
      break;
    case "registry":
      o.registry = data;
      if (data.status === "candidate" || tool === "build_candidate") o.candidate = String(data.candidate_version ?? data.version ?? data.candidate ?? "");
      if (data.status === "promoted") o.candidate = null;
      break;
    case "mlbom":
      o.mlbom = { ...(o.mlbom ?? {}), ...data, signature: { ...(o.mlbom?.signature ?? {}), ...(data.signature ?? {}), verified: Boolean(data.signature?.verified ?? data.verification?.verified ?? data.verified ?? data.signed ?? o.mlbom?.signature?.verified) } };
      break;
    case "audit":
      o.audit = normalizeAudit(Array.isArray(data.entries) ? data.entries : []).slice(-40);
      break;
    case "finops":
      o.finops = data;
      break;
  }
}
