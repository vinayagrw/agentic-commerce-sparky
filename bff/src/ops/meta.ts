/** Ops-plane agent roster: tool -> agent, tier, lifecycle stage, playbook techniques. */
import type { LifecycleStage, Tier } from "@sparky/shared";

export interface OpsAgentDef {
  agent: string;
  tier: Tier;
  stage: LifecycleStage;
  techniques: string;
  avatar: string;
}

export const OPS_AGENTS: Record<string, OpsAgentDef> = {
  "Data Quality": { agent: "Data Quality", tier: "T1", stage: "Data", techniques: "4, 5", avatar: "🧹" },
  Labeling: { agent: "Labeling", tier: "T2", stage: "Data", techniques: "1, 19", avatar: "🏷️" },
  Eval: { agent: "Eval", tier: "T3", stage: "Validate", techniques: "18, 20, 21, 22", avatar: "🧪" },
  "Drift Monitor": { agent: "Drift Monitor", tier: "T0", stage: "Monitor", techniques: "30, 31", avatar: "📡" },
  Remediation: { agent: "Remediation", tier: "T2", stage: "Retrain", techniques: "32, 33", avatar: "🛠️" },
  Release: { agent: "Release", tier: "T2", stage: "Deploy", techniques: "28, 34, 35", avatar: "🚀" },
  FinOps: { agent: "FinOps Router", tier: "T1", stage: "Monitor", techniques: "26", avatar: "💸" },
};

export const OPS_TOOL_AGENT: Record<string, keyof typeof OPS_AGENTS> = {
  run_data_validation: "Data Quality",
  label_queries: "Labeling",
  record_labels: "Labeling",
  run_eval_suite: "Eval",
  gate_preregistered_candidate: "Eval",
  compute_drift: "Drift Monitor",
  estimate_performance: "Drift Monitor",
  propose_remediation: "Remediation",
  build_candidate: "Remediation",
  start_canary: "Release",
  promote: "Release",
  rollback: "Release",
  sign_model: "Release",
  generate_mlbom: "Release",
  get_audit_log: "Release",
  request_promotion: "Release",
  finops_router: "FinOps",
  // Ops Copilot top 10 (Phase 3)
  incident_triage: "Drift Monitor",
  metric_query: "Eval",
  list_runbooks: "Remediation",
  run_runbook: "Remediation",
  release_notes: "Release",
  compare_versions: "Eval",
  drift_explain: "Drift Monitor",
  eval_failure_clusters: "Eval",
  token_cost_report: "FinOps",
  replay_summary: "Release",
  trace_summary: "Release",
  watch_alerts: "Drift Monitor",
  // MLOps top 10 (MLO1-MLO10)
  interleave_rankers: "Eval",
  ab_sequential_test: "Eval",
  skew_check: "Data Quality",
  lineage_query: "Release",
  retrain_trigger: "Remediation",
  exposure_audit: "Eval",
  prompt_registry_diff: "Release",
  slo_budget_status: "Release",
  golden_set_diff: "Eval",
  shadow_deploy_diff: "Release",
};

/** Tier overrides per tool (rollback by guardrail is T3; the audit read is T0). */
export const OPS_TOOL_TIER: Record<string, Tier> = {
  rollback: "T3", get_audit_log: "T0", estimate_performance: "T1",
  incident_triage: "T0", metric_query: "T0", list_runbooks: "T0", run_runbook: "T2", release_notes: "T0", compare_versions: "T0",
  drift_explain: "T0", eval_failure_clusters: "T1", token_cost_report: "T0", replay_summary: "T0", trace_summary: "T0", watch_alerts: "T0",
  interleave_rankers: "T1", ab_sequential_test: "T1", skew_check: "T2", lineage_query: "T0", retrain_trigger: "T2",
  exposure_audit: "T1", prompt_registry_diff: "T2", slo_budget_status: "T2", golden_set_diff: "T1", shadow_deploy_diff: "T1",
};

export function opsToolMeta(tool: string): OpsAgentDef {
  const key = OPS_TOOL_AGENT[tool];
  const def = key ? OPS_AGENTS[key] : { agent: "Ops", tier: "T1" as Tier, stage: "Monitor" as LifecycleStage, techniques: "", avatar: "🤖" };
  return { ...def, tier: OPS_TOOL_TIER[tool] ?? def.tier };
}

/** ops-mcp uses slugs ("eval-agent"); the UI uses display names ("Eval"). */
const SLUG: Record<string, string> = {
  "data-quality-agent": "Data Quality",
  "labeling-agent": "Labeling",
  "eval-agent": "Eval",
  "drift-monitor-agent": "Drift Monitor",
  "retrain-agent": "Remediation",
  "remediation-agent": "Remediation",
  "release-agent": "Release",
  "finops-agent": "FinOps Router",
  "guardrail-watcher": "Release",
  guardrail: "Release",
  audit: "Release",
};
export function agentName(raw: unknown, tool: string): string {
  const s = typeof raw === "string" ? raw : "";
  return SLUG[s] ?? (s && Object.values(OPS_AGENTS).some((a) => a.agent === s) ? s : opsToolMeta(tool).agent);
}

export function shortOpsTool(name: string): string {
  return name.replace(/^mcp__ops__/, "");
}
