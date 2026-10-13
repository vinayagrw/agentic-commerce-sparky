/**
 * Measured run metrics.
 *
 * The FinOps view used to quote a p95 and a per-task cost that were constants written by
 * hand. They are now sampled from what actually happened on this laptop:
 *
 *  - the Claude arm's latency and cost come from real runs — wall-clock per run, and the
 *    `total_cost_usd` / token counts the CLI reports in its result event;
 *  - the cheap arm's latency comes from real search-svc calls, timed here.
 *
 * Nothing is seeded. With no runs recorded yet the accessors return null and the UI says
 * "no measured runs yet" rather than showing a number.
 */
export interface Sample {
  ms: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  at: number;
  label?: string;
}

/**
 * "claude" and "cheap" are the original two. The router (technique 26) records one bucket
 * per model arm it can actually route to, so arm names are open: anything the router names.
 */
export type Arm = string;

const MAX_SAMPLES = 500;
const samples: Record<string, Sample[]> = { claude: [], cheap: [] };

function bucket(arm: Arm): Sample[] {
  return (samples[arm] ??= []);
}

export function record(arm: Arm, s: Omit<Sample, "at">) {
  const list = bucket(arm);
  list.push({ ...s, at: Date.now() });
  if (list.length > MAX_SAMPLES) list.shift();
}

export function reset(arm?: Arm) {
  if (arm) {
    samples[arm] = [];
    return;
  }
  for (const k of Object.keys(samples)) delete samples[k];
  samples.claude = [];
  samples.cheap = [];
}

export function arms(): string[] {
  return Object.keys(samples);
}

export function count(arm: Arm) {
  return bucket(arm).length;
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: with a handful of real samples this is honest about its own coarseness.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

export interface ArmStats {
  n: number;
  p50_ms: number | null;
  p95_ms: number | null;
  mean_cost_usd: number | null;
  total_cost_usd: number;
  total_tokens: { input: number; output: number };
  first_at: string | null;
  last_at: string | null;
}

export function stats(arm: Arm): ArmStats {
  const list = bucket(arm);
  const ms = list.map((s) => s.ms);
  const costs = list.map((s) => s.costUsd).filter((c) => Number.isFinite(c));
  return {
    n: list.length,
    p50_ms: percentile(ms, 50),
    p95_ms: percentile(ms, 95),
    mean_cost_usd: costs.length ? Number((costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(9)) : null,
    total_cost_usd: Number(costs.reduce((a, b) => a + b, 0).toFixed(9)),
    total_tokens: {
      input: list.reduce((a, s) => a + s.inputTokens, 0),
      output: list.reduce((a, s) => a + s.outputTokens, 0),
    },
    first_at: list.length ? new Date(list[0].at).toISOString() : null,
    last_at: list.length ? new Date(list[list.length - 1].at).toISOString() : null,
  };
}

/** Every arm that has recorded at least one sample, plus the two originals even when empty. */
export function all() {
  const out: Record<string, ArmStats> = { claude: stats("claude"), cheap: stats("cheap") };
  for (const a of arms()) out[a] = stats(a);
  return out;
}
