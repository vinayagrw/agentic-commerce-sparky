/**
 * Guide spec proof: GET /api/guide/spec-results serves the real Playwright JSON reporter
 * output (docs/recording/e2e-results.json, configured in web/playwright.config.ts) so the
 * Guide can say whether the spec it names actually passed on the last recorded run.
 *
 * Honesty rules (the whole point of this endpoint):
 *  - a spec file or test title with no row in the report is `not-run`, never assumed passing;
 *  - a file whose report contains a skipped/not-run test is `not-run` at file level too,
 *    because "some of this file ran" is not "this file passes";
 *  - a missing or malformed report is refused with 503 (same shape as GET /api/guide/features),
 *    never faked into a green tick.
 *
 * Read per request so a fresh run shows without restarting the bff (see the FIX note below on
 * which make targets actually rewrite the report).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { ROOT } from "../config.js";

export type SpecStatus = "passed" | "failed" | "flaky" | "not-run";

export interface SpecTest {
  title: string;
  status: SpecStatus;
}
export interface SpecFile {
  file: string;
  status: SpecStatus;
  tests: SpecTest[];
}
export interface SpecResults {
  /** Start of the recorded run (Playwright `stats.startTime`). */
  timestamp: string;
  /** Run duration in ms as reported, or null when the report has none. */
  durationMs: number | null;
  specs: SpecFile[];
}

export type SpecResultsLoad = { ok: true; results: SpecResults } | { ok: false; error: string };

const DEFAULT_PATH = join(ROOT, "docs", "recording", "e2e-results.json");
// NOTE: the json reporter only writes when no `--reporter=` is passed on the CLI, because a CLI
// reporter REPLACES the config's reporter list. `make e2e` refreshes this file; `make e2e-agent`,
// `make e2e-fast` and `make e2e-batch` (all `--reporter=dot`) do not.
const FIX = "run make e2e to regenerate docs/recording/e2e-results.json (a run with --reporter= on the CLI, e.g. make e2e-agent, replaces the json reporter and does not refresh it)";

/** One Playwright test entry -> our four states. Unknown/absent statuses stay `not-run`. */
function testStatus(test: any): SpecStatus {
  const results: any[] = Array.isArray(test?.results) ? test.results : [];
  const outcomes = results.map((r) => String(r?.status ?? ""));
  const failedRun = outcomes.some((s) => s === "failed" || s === "timedOut" || s === "interrupted");
  const passedRun = outcomes.includes("passed");
  // Playwright's own per-test verdict wins when present; it already folds retries.
  switch (String(test?.status ?? "")) {
    case "expected":
      return "passed";
    case "unexpected":
      return "failed";
    case "flaky":
      return "flaky";
    case "skipped":
      return "not-run";
  }
  if (failedRun && passedRun) return "flaky";
  if (failedRun) return "failed";
  if (passedRun) return "passed";
  return "not-run";
}

/** A spec (title) may carry several test entries (projects/retries): worst case wins. */
function worst(statuses: SpecStatus[]): SpecStatus {
  if (!statuses.length) return "not-run";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("flaky")) return "flaky";
  if (statuses.includes("not-run")) return "not-run";
  return "passed";
}

function collect(suites: any[], into: Map<string, SpecTest[]>): void {
  for (const suite of Array.isArray(suites) ? suites : []) {
    for (const spec of Array.isArray(suite?.specs) ? suite.specs : []) {
      const file = String(spec?.file ?? suite?.file ?? "");
      const title = String(spec?.title ?? "");
      if (!file || !title) continue;
      const status = worst((Array.isArray(spec?.tests) ? spec.tests : []).map(testStatus));
      const list = into.get(file) ?? [];
      list.push({ title, status });
      into.set(file, list);
    }
    collect(suite?.suites ?? [], into);
  }
}

export function loadSpecResults(path = DEFAULT_PATH): SpecResultsLoad {
  if (!existsSync(path)) return { ok: false, error: `docs/recording/e2e-results.json does not exist (${FIX})` };
  let data: any;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, error: `docs/recording/e2e-results.json could not be parsed (${(e as Error).message})` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "docs/recording/e2e-results.json must be a Playwright JSON report object" };
  if (!Array.isArray(data.suites)) return { ok: false, error: "docs/recording/e2e-results.json has no suites[] array (not a Playwright JSON report)" };
  const timestamp = data.stats?.startTime;
  if (typeof timestamp !== "string" || !timestamp) return { ok: false, error: "docs/recording/e2e-results.json has no stats.startTime (cannot date the run)" };
  const byFile = new Map<string, SpecTest[]>();
  collect(data.suites, byFile);
  const specs: SpecFile[] = [...byFile.entries()]
    .map(([file, tests]) => ({ file, status: worst(tests.map((t) => t.status)), tests }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const durationMs = typeof data.stats?.duration === "number" ? data.stats.duration : null;
  return { ok: true, results: { timestamp, durationMs, specs } };
}

/** Status of one spec file (or one test title inside it). No row at all -> `not-run`. */
export function statusFor(results: SpecResults, file: string, title?: string): SpecStatus {
  const spec = results.specs.find((s) => s.file === file);
  if (!spec) return "not-run";
  if (title === undefined) return spec.status;
  return spec.tests.find((t) => t.title === title)?.status ?? "not-run";
}

export function registerSpecResultsRoutes(app: FastifyInstance, path?: string) {
  app.get("/api/guide/spec-results", async (_req, reply) => {
    const r = loadSpecResults(path);
    if (!r.ok) {
      return reply.code(503).send({ ok: false, error: r.error, service: "bff", endpoint: "GET /api/guide/spec-results", fix: FIX });
    }
    const tally = { passed: 0, failed: 0, flaky: 0, "not-run": 0 } as Record<SpecStatus, number>;
    for (const s of r.results.specs) tally[s.status] += 1;
    return {
      ok: true,
      timestamp: r.results.timestamp,
      durationMs: r.results.durationMs,
      count: r.results.specs.length,
      tally,
      specs: r.results.specs,
      provenance: {
        service: "bff",
        endpoint: "GET /api/guide/spec-results",
        source: "docs/recording/e2e-results.json (Playwright JSON reporter, web/playwright.config.ts)",
        rule: "a spec or test with no row in the report is not-run; a file with any not-run test is not-run",
        timestamp: new Date().toISOString(),
      },
    };
  });
}
