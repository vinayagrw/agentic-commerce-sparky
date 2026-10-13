/** Shape of data/coverage.json as served by GET /api/coverage (read from the file, not guessed). */
export type CoverageStatus = "real-measured" | "real-no-metric" | "script-ready-not-executed" | "absent";

export interface CodeRef {
  file: string;
  symbol: string;
  note?: string;
  resolved?: boolean;
}

export interface Measurement {
  label: string;
  /** Absent when the row explains `how` instead of asserting a number. */
  value?: number | string;
  unit?: string;
  n?: number;
  ci95?: [number, number];
  how?: string;
}

export interface NotRun {
  dir: string;
  entrypoint: string;
  gpu_sku: string;
  /** Deliberately a STRING carrying arithmetic. Never parse it into a number. */
  est_cost_usd: string;
  est_cost_usd_is_a_string?: boolean;
  cloud?: Record<string, string>;
  expected_result?: string;
  citation?: string;
}

export interface Technique {
  id: number;
  name: string;
  stage: string;
  status: CoverageStatus;
  code: CodeRef[];
  measurements: Measurement[];
  headline: string | null;
  no_metric_reason: string | null;
  provenance: string[];
  verdict: string | null;
  null_result: boolean;
  negative_result: boolean;
  caveats: string[];
  not_run: NotRun | null;
  playbook_section: string;
  playbook_link: string;
  code_ref?: string;
}

export interface CoverageBoardData {
  generated_by: string;
  about: string;
  rules: string[];
  sources: Record<string, unknown>;
  statuses: Record<CoverageStatus, string>;
  tally: Record<CoverageStatus, number>;
  null_or_negative: number[];
  total: number;
  techniques: Technique[];
  generated_at?: string;
  gate_config?: GateConfig;
  demo_inputs?: { inject_latency_ms?: number; inject_latency_note?: string; status?: string; source?: string };
  lifecycle?: Record<string, any>;
  evidence?: EvidenceRow[];
  judges?: JudgeRow[];
  claims?: Claim[];
  slice_report?: Record<string, any>;
  bypass_gate?: Record<string, any>;
  preregistered_gate?: Record<string, any>;
  provenance: {
    service: string;
    endpoint: string;
    timestamp: string;
    source: string;
    generated_by: string | null;
    generated_at: string | null;
    file_mtime: string;
    note: string;
  };
}

export interface CoverageRefusal {
  error: string;
  service?: string;
  endpoint?: string;
  fix?: string;
}

export interface GateConfig {
  source: string[];
  release_gate: { ndcg_delta_ci_lower_ge: number | null; p95_ms_le: number | null; red_team_blocked: number | null; pass_k_min: number | null };
  canary_guardrail: { p95_ms_le: number | null; p95_rel_to_champion_le: number | null; ndcg_drop_le: number | null; min_samples: number | null; rule: string };
}

/** A measured result that was NOT produced in this repo (B04). */
export interface EvidenceRow {
  key: string;
  name?: string;
  kind?: string;
  ran_in_this_repo?: boolean;
  status?: string;
  model?: string;
  measurements?: Measurement[];
  verdict?: string;
  headline?: string;
  caveats?: string[];
  provenance?: string[];
  related_techniques?: number[];
}

export interface JudgeRow {
  key: string;
  judge: "lexical" | "llm";
  label: string;
  ran_in_this_repo: boolean;
  technique: number | null;
  kappa: Measurement | null;
  fit_to_gate: boolean | null;
  what_it_is?: string | null;
  must_not_pretend: string;
  provenance: string[];
}

export interface Claim {
  id: number;
  claim: string;
  shown_by: string;
  evidence: (Measurement & Record<string, any>)[];
  must_not_pretend: string;
  built: "yes" | "partial" | "no";
}
