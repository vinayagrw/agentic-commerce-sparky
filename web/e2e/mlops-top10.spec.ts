import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoSeriousA11y, freshSession } from "./helpers";

/**
 * MLOps top 10 (docs/MLOPS_TOP10_SELECTION.md). Every capability is a real ops-mcp tool
 * (services/ops-mcp/src/ops_mcp/mlops_top10.py) against the live search-svc and repo data.
 * @nollm tests call the tool directly (seconds); @llm tests ask the live Ops Copilot, which calls it through
 * policy-mcp and renders the ops_insight card. data/registry.json and data/ops.db are backed up and restored
 * (skew_check / retrain_trigger write approvals, alerts and audit entries).
 * To add a capability: append to CAPS below (the nollm + llm tests are generated from it).
 */
const ROOT = resolve(process.cwd(), "..");
const DATA = resolve(ROOT, "data");
const BK = resolve(DATA, `.e2e-mlops-backup-${process.pid}`);

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  mkdirSync(BK, { recursive: true });
  copyFileSync(resolve(DATA, "registry.json"), resolve(BK, "registry.json"));
  execFileSync("sqlite3", [
    resolve(DATA, "ops.db"),
    `.backup '${resolve(BK, "ops.db")}'`,
  ]);
});

test.afterAll(() => {
  if (!existsSync(resolve(BK, "ops.db"))) return;
  execFileSync("sqlite3", [
    resolve(DATA, "ops.db"),
    `.restore '${resolve(BK, "ops.db")}'`,
  ]);
  copyFileSync(resolve(BK, "registry.json"), resolve(DATA, "registry.json"));
  unlinkSync(resolve(BK, "ops.db"));
  unlinkSync(resolve(BK, "registry.json"));
});

/** Run an ops-mcp MLOps tool directly (live search-svc + repo data, no model call). */
function tool(name: string, args: Record<string, unknown> = {}): any {
  const out = execFileSync(
    "uv",
    [
      "run",
      "--quiet",
      "python",
      "-m",
      "ops_mcp.mlops_top10",
      name,
      JSON.stringify(args),
    ],
    {
      cwd: resolve(ROOT, "services/ops-mcp"),
      encoding: "utf8",
      timeout: 240_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return JSON.parse(out.slice(out.indexOf("{")));
}

const region = (page: Page) =>
  page.getByRole("region", { name: "Ops Copilot chat" });

async function openOps(page: Page) {
  await freshSession(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem("sparky.opsDock.pct", "70");
      localStorage.setItem("sparky.opsDock.open", "1");
    } catch {
      /* storage blocked */
    }
  });
  await page.goto("/ops/1");
  await expect(region(page).getByRole("textbox").first()).toBeVisible();
}

async function ask(
  page: Page,
  prompt: string,
  timeout = 240_000,
): Promise<Locator> {
  const r = region(page);
  const before = await r.getByTestId("msg-assistant").count();
  const box = r.getByRole("textbox").first();
  await box.fill(prompt);
  await box.press("Enter");
  await expect(r.getByTestId("msg-assistant")).toHaveCount(before + 1, {
    timeout,
  });
  await expect(r.getByTestId("stop-button")).toHaveCount(0, { timeout });
  await expect(r.getByTestId("run-cost").last()).not.toHaveText(/pending/, {
    timeout: 30_000,
  });
  return r.getByTestId("msg-assistant").last();
}

async function shot(page: Page, n: number, slug: string, focus?: Locator) {
  const dir = resolve(ROOT, "docs/ui");
  mkdirSync(dir, { recursive: true });
  await focus?.scrollIntoViewIfNeeded().catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(dir, `mlops_${n}_${slug}.png`) });
}

interface Cap {
  n: number;
  slug: string;
  story: string;
  tool: string;
  args?: Record<string, unknown>;
  tier: string;
  check: (r: any) => void;
  prompt: string;
  card: RegExp;
  cardText: RegExp[];
}

const CAPS: Cap[] = [
  {
    n: 1,
    slug: "interleaving",
    story: "team-draft interleaving pre-screen with simulated-click label",
    tool: "interleave_rankers",
    args: { n_queries: 100 },
    tier: "T1",
    check: (r) => {
      expect(r.result.n_queries).toBe(100);
      expect(r.result.wins_a + r.result.wins_b + r.result.ties).toBe(100);
      expect(r.result.sign_test_p).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(r.facts)).toContain("SIMULATED");
    },
    prompt: "Run an interleaving pre-screen of rrf_rerank vs rrf.",
    card: /Interleaving pre-screen: \w+ vs \w+/,
    cardText: [/sign test p/, /SIMULATED/, /n = \d+/],
  },
  {
    n: 2,
    slug: "cuped_msprt",
    story: "CUPED + mSPRT sequential A/B on logged sessions",
    tool: "ab_sequential_test",
    tier: "T1",
    check: (r) => {
      expect(r.result.n_sessions).toBeGreaterThanOrEqual(40);
      expect(r.result.ci95_cuped).toHaveLength(2);
      expect(r.result.variance_reduction).toBeLessThanOrEqual(1);
      expect(r.result.assignment).toMatch(/re-randomised/);
    },
    prompt: "Analyse the A/B test with CUPED and a sequential mSPRT test.",
    card: /Sequential A\/B \(CUPED \+ mSPRT\)/,
    cardText: [/CUPED cut variance/, /online_sessions/],
  },
  {
    n: 3,
    slug: "skew",
    story: "training-serving skew with PSI per feature and promotion block",
    tool: "skew_check",
    tier: "T2",
    check: (r) => {
      expect(r.result.features.length).toBeGreaterThanOrEqual(4);
      for (const f of r.result.features.filter((f: any) => f.psi !== "n/a"))
        expect(Number.isFinite(f.psi)).toBeTruthy();
      expect(Boolean(r.approval_id)).toBe(r.result.flagged.length > 0);
    },
    prompt: "Check the candidate for training-serving skew.",
    card: /Training-serving skew check/,
    cardText: [/PSI/, /commerce\.db/],
  },
  {
    n: 4,
    slug: "lineage",
    story: "read-only lineage graph of the champion",
    tool: "lineage_query",
    args: { node: "champion" },
    tier: "T0",
    check: (r) => {
      expect(r.result.graph_edges).toBeGreaterThan(0);
      expect(
        r.result.upstream_nodes.length + r.result.downstream_nodes.length,
      ).toBeGreaterThan(0);
      expect(r.table.rows.every((row: string[]) => row[4])).toBeTruthy();
    },
    prompt:
      "Show the lineage of the champion model: where did it come from and what depends on it?",
    card: /Lineage: model:v\d+/,
    cardText: [/upstream/, /mlflow\.db/],
  },
  {
    n: 5,
    slug: "retrain_dag",
    story: "retraining trigger DAG that never promotes",
    tool: "retrain_trigger",
    args: { label_profile: "delayed" },
    tier: "T2",
    check: (r) => {
      const steps = Object.fromEntries(
        r.result.steps.map((s: any) => [s.step, s.status]),
      );
      expect(steps.promote).toBe("requires_human");
      if (r.result.fired)
        expect(steps.build_candidate_gate).toBe("waiting_human");
    },
    prompt: "Should we retrain? Run the retraining trigger.",
    card: /Retraining trigger \+ DAG/,
    cardText: [/requires_human/, /DAG/],
  },
  {
    n: 6,
    slug: "exposure",
    story:
      "sponsored vs organic exposure audit against a relevance-matched baseline",
    tool: "exposure_audit",
    args: { n_queries: 100 },
    tier: "T1",
    check: (r) => {
      expect(r.result.n_queries).toBe(100);
      expect(r.result.exposure_gap_ci95).toHaveLength(2);
      expect(r.result.sponsored_exposure_live).toBeGreaterThanOrEqual(0);
      expect(r.result.not_measured).toMatch(/1P vs 3P/);
    },
    prompt: "Run a fairness audit of sponsored vs organic exposure in search.",
    card: /Exposure audit: sponsored vs organic/,
    cardText: [/relevance-matched/, /1P vs 3P/],
  },
  {
    n: 7,
    slug: "config_registry",
    story:
      "prompt/agent config registry with eval-on-change and human-gated rollback",
    tool: "prompt_registry_diff",
    tier: "T2",
    check: (r) => {
      expect(r.result.hash).toMatch(/^[0-9a-f]{12}$/);
      expect(r.result.versions.length).toBeGreaterThanOrEqual(1);
      expect(r.result.tracked_files).toContain("bff/src/ops/prompt.ts");
      expect(Boolean(r.approval_id)).toBe(r.result.regressions.length > 0);
    },
    prompt:
      "Show the prompt/agent config registry: what changed in the agent config and did the eval regress?",
    card: /Prompt\/agent config registry/,
    cardText: [/token_ledger/, /cfg\d+/],
  },
  {
    n: 8,
    slug: "slo_budget",
    story: "SLO error budgets with a release freeze that blocks promote",
    tool: "slo_budget_status",
    tier: "T2",
    check: (r) => {
      expect(r.result.slos.length).toBe(3);
      for (const s of r.result.slos) expect(s.bad_ci95).toHaveLength(2);
      expect(Boolean(r.approval_id)).toBe(r.result.freeze_active);
    },
    prompt: "What is our SLO and error budget status? Are releases frozen?",
    card: /Model SLOs \+ error budgets/,
    cardText: [/burn/, /online_sessions/],
  },
  {
    n: 9,
    slug: "golden_set",
    story: "hashed golden set with dataset versioning and a failure diff",
    tool: "golden_set_diff",
    args: { n_queries: 150 },
    tier: "T1",
    check: (r) => {
      expect(r.result.golden_hash).toMatch(/^[0-9a-f]{12}$/);
      expect(r.result.n_queries).toBe(150);
      expect(r.result.newly_failing + r.result.fixed).toBeGreaterThanOrEqual(0);
      expect(r.result.delta_ci95).toHaveLength(2);
    },
    prompt: "Run the golden-set regression check of rrf against rrf_rerank.",
    card: /Golden-set regression: \w+ vs \w+/,
    cardText: [/golden set/i, /newly fail/],
  },
  {
    n: 10,
    slug: "shadow",
    story: "shadow deployment on mirrored queries with no shopper impact",
    tool: "shadow_deploy_diff",
    tier: "T1",
    check: (r) => {
      expect(r.result.n_queries).toBeGreaterThan(0);
      expect(r.result.overlap_at_10).toBeGreaterThanOrEqual(0);
      expect(r.result.overlap_at_10).toBeLessThanOrEqual(1);
      expect(r.result.shopper_impact.responses_returned_to_shoppers).toBe(0);
    },
    prompt:
      "Shadow deploy candidate v2 against the champion on mirrored traffic.",
    card: /Shadow deployment: v\d+ vs \w+/,
    cardText: [/overlap@10/, /No shopper saw shadow results/],
  },
];

for (const c of CAPS) {
  test(`MLO${c.n} ${c.story}: tool result from live data @nollm`, () => {
    test.setTimeout(300_000);
    const r = tool(c.tool, c.args);
    expect(r.ui).toBe("ops_insight");
    expect(r.tier).toBe(c.tier);
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.n).toBeGreaterThan(0);
    c.check(r);
    expect(
      existsSync(resolve(ROOT, `docs/evidence/mlops_${c.n}_${c.slug}.json`)),
    ).toBeTruthy();
  });
}

for (const c of CAPS) {
  test(`MLO${c.n} ${c.story}: Ops Copilot renders the cited card @llm`, async ({
    page,
  }) => {
    test.setTimeout(360_000);
    await openOps(page);
    const msg = await ask(page, c.prompt);
    await expect(msg).toContainText(c.card);
    for (const t of c.cardText) await expect(msg).toContainText(t);
    await expect(msg).toContainText(/Sources:/);
    await shot(page, c.n, c.slug, msg.getByText(c.card).first());
    if (c.n === 1)
      await expectNoSeriousA11y(page, '[aria-label="Ops Copilot chat"]');
  });
}
