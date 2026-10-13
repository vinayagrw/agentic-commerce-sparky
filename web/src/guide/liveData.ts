/**
 * Live reads the Guide portal makes so its claims are evidence, not derivation.
 *
 * - `useSpecResults()` -> GET /api/guide/spec-results (the parsed Playwright report). A spec with
 *   no row in the report is `not-run`; the endpoint 503s when no report exists at all and we then
 *   say so rather than implying anything passed.
 * - `useFeatureTelemetry(f)` -> GET /api/traces, /api/tokens/summary, /api/tokens/ledger, filtered
 *   to the surface/plane this feature is demonstrated on. Nothing here is derived from the
 *   feature's own text: if the endpoints report nothing for this plane, the tab says exactly that.
 */
import { useMemo } from "react";
import { usePoll } from "@/lib/usePoll";
import { planeOf, routeOf, type Feature } from "./guideModel";

/* ------------------------------------------------------------ spec results */

export type SpecStatus = "passed" | "failed" | "flaky" | "not-run";

export interface SpecResults {
  ok?: boolean;
  timestamp: string;
  durationMs: number;
  count: number;
  tally: Record<SpecStatus, number>;
  specs: { file: string; status: SpecStatus; tests: { title: string; status: SpecStatus }[] }[];
}

export const SPEC_TONE: Record<SpecStatus, "ok" | "bad" | "warn" | "neutral"> = {
  passed: "ok",
  failed: "bad",
  flaky: "warn",
  "not-run": "neutral",
};

export const SPEC_LABEL: Record<SpecStatus, string> = {
  passed: "passing",
  failed: "failing",
  flaky: "flaky",
  "not-run": "not run",
};

export interface SpecRun {
  /** Null while loading, or when no report exists (`error` then says so). */
  results: SpecResults | null;
  error: string | null;
  loading: boolean;
  /** Status of one spec file — "not-run" when the report has no row for it. */
  statusOf: (file: string) => SpecStatus;
  /** Playwright tags (@nollm, @llm …) that the recorded run actually executed. */
  ranTags: string[];
  /** Tags present in the report but with no executed test — legitimately "not run". */
  skippedTags: string[];
}

const TAG_RE = /@[a-z0-9-]+/gi;

export function useSpecResults(): SpecRun {
  const { data, error, loading } = usePoll<SpecResults>("/api/guide/spec-results", 0);
  const results = data && Array.isArray(data.specs) ? data : null;

  return useMemo(() => {
    const byFile = new Map((results?.specs ?? []).map((s) => [s.file, s]));
    const ran = new Set<string>();
    const all = new Set<string>();
    for (const s of results?.specs ?? [])
      for (const t of s.tests)
        for (const tag of t.title.match(TAG_RE) ?? []) {
          all.add(tag.toLowerCase());
          if (t.status !== "not-run") ran.add(tag.toLowerCase());
        }
    return {
      results,
      error: error ?? null,
      loading,
      statusOf: (file: string) => byFile.get(file)?.status ?? "not-run",
      ranTags: [...ran].sort(),
      skippedTags: [...all].filter((t) => !ran.has(t)).sort(),
    };
  }, [results, error, loading]);
}

/* -------------------------------------------------------------- telemetry */

interface TraceSummary {
  traceId: string;
  name: string | null;
  start: number;
  span_count: number;
  kind_counts: Record<string, number>;
  error_count: number;
  services: string[];
  attrs: Record<string, unknown>;
}

interface Bucket {
  key: string;
  calls: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface LedgerRow {
  ts: string;
  role: string;
  model: string;
  plane: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  trace_id: string | null;
}

export interface FeatureTelemetry {
  /** "shopper" | "ops" — the ledger `plane` / trace `sparky.surface` this feature runs on, or null. */
  plane: string | null;
  loading: boolean;
  /** What failed, when a telemetry endpoint did not answer. */
  error: string | null;
  /** Span kinds actually seen on this plane, commonest first. */
  kinds: { kind: string; count: number }[];
  /** How many of the recent traces were on this plane, out of how many were read. */
  traceCount: number;
  traceTotal: number;
  /** Newest matching trace, for a link straight into its waterfall. */
  newestTraceId: string | null;
  services: string[];
  /** Token-ledger roles on this plane. */
  roles: Bucket[];
  ledgerCalls: number;
  ledgerCost: number;
  ledgerRows: LedgerRow[];
  /** Deep links with this feature's filter already applied. */
  tracesHref: string;
  tokensHref: string;
}

/** Live spans and ledger rows for the surface this feature is demonstrated on. */
export function useFeatureTelemetry(f: Feature): FeatureTelemetry {
  const route = routeOf(f);
  const plane = planeOf(route) === "Ops" ? "ops" : planeOf(route) === "Shopper" ? "shopper" : null;
  const traces = usePoll<{ traces: TraceSummary[] }>("/api/traces?limit=50", 0);
  const q = plane ? `&plane=${plane}` : "";
  const summary = usePoll<{ buckets: Bucket[]; totals: Bucket }>(`/api/tokens/summary?group_by=role${q}`, 0);
  const ledger = usePoll<{ rows: LedgerRow[]; total: number }>(`/api/tokens/ledger?limit=5${q}`, 0);

  return useMemo(() => {
    const all = traces.data?.traces ?? [];
    const mine = plane ? all.filter((t) => String(t.attrs?.["sparky.surface"] ?? "") === plane) : all;
    const counts = new Map<string, number>();
    const services = new Set<string>();
    for (const t of mine) {
      for (const [k, n] of Object.entries(t.kind_counts ?? {})) counts.set(k, (counts.get(k) ?? 0) + n);
      for (const s of t.services ?? []) services.add(s);
    }
    const newest = [...mine].sort((a, b) => b.start - a.start)[0] ?? null;
    const roles = (summary.data?.buckets ?? []).filter((b) => b.calls > 0);
    return {
      plane,
      loading: traces.loading || summary.loading || ledger.loading,
      error: traces.error ?? summary.error ?? ledger.error ?? null,
      kinds: [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
      traceCount: mine.length,
      traceTotal: all.length,
      newestTraceId: newest?.traceId ?? null,
      services: [...services].sort(),
      roles,
      ledgerCalls: summary.data?.totals?.calls ?? 0,
      ledgerCost: summary.data?.totals?.cost_usd ?? 0,
      ledgerRows: ledger.data?.rows ?? [],
      tracesHref: newest ? `/ops/traces/${newest.traceId}` : "/ops/traces",
      tokensHref: plane ? `/ops/tokens?plane=${plane}&group=role` : "/ops/tokens?group=role",
    };
  }, [traces.data, traces.loading, traces.error, summary.data, summary.loading, summary.error, ledger.data, ledger.loading, ledger.error, plane]);
}
