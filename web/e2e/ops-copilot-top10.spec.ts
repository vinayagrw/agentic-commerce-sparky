import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoSeriousA11y, freshSession } from "./helpers";

/**
 * Phase 3: Ops Copilot top 10. Every capability is a real ops-mcp tool (services/ops-mcp/src/ops_mcp/copilot.py)
 * called by the live Ops Copilot through policy-mcp, rendered as an A2UI card with its citations.
 * data/registry.json and data/ops.db are backed up before and restored after (the runbook spec writes a gate
 * record and an audit entry). @llm
 */
const DATA = resolve(process.cwd(), "../data");
const BK = resolve(DATA, `.e2e-ops-backup-${process.pid}`);

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

/** Ask the Ops Copilot and wait for the turn to finish; returns the last assistant message. */
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
  const dir = resolve(process.cwd(), "../docs/ui");
  mkdirSync(dir, { recursive: true });
  await focus?.scrollIntoViewIfNeeded().catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(dir, `ops_${n}_${slug}.png`) });
}

test("OPS1 incident triage correlates drift, deploys and canary with cited records @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openOps(page);
  const msg = await ask(page, "Triage the latest incident.");
  await expect(msg).toContainText("Incident triage");
  await expect(msg).toContainText(/Sources: .*(ops\.db|search-svc)/);
  await expect(msg).toContainText(/audit#\d+|alr-|\/canary\/status/);
  await shot(
    page,
    1,
    "incident_triage",
    msg.getByText("Incident triage").first(),
  );
});

test("OPS2 natural-language metric query renders an inline chart from the registry @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openOps(page);
  const msg = await ask(
    page,
    "Show NDCG@10 for every registry version as a chart.",
  );
  await expect(msg).toContainText("registry test_ndcg10 per version");
  await expect(
    msg.locator('img[src^="data:image/svg+xml"]').first(),
  ).toBeVisible();
  await expect(msg).toContainText(/n = \d+/);
  await shot(page, 2, "metric_query", msg.locator("img").first());
});

test("OPS3 T2 runbook needs a human approval, then runs once and writes an audit entry @llm", async ({
  page,
  request,
}) => {
  test.setTimeout(420_000);
  await openOps(page);
  const msg = await ask(page, "Run the rerun_eval_gate runbook.");
  await expect(msg).toContainText("Approve runbook: Re-run the eval gate");
  await expect(msg).toContainText(/the agent cannot approve itself/);
  await shot(
    page,
    3,
    "runbook_approval",
    msg.getByText(/Approve runbook/).first(),
  );
  await msg.getByRole("button", { name: "Approve" }).last().click();
  await expect(
    msg
      .getByRole("status")
      .filter({ hasText: /Approved and executed runbook rerun_eval_gate/ }),
  ).toBeVisible({ timeout: 300_000 });
  const audit = await (await request.get("/api/ops/audit")).json();
  const entries = (audit.entries ?? audit) as any[];
  expect(
    entries.some(
      (e) => /runbook:rerun_eval_gate/.test(String(e.action)) && e.approval_id,
    ),
  ).toBeTruthy();
  await shot(page, 3, "runbook_executed", msg.getByRole("status").last());
});

test("OPS4 release notes and model card from the registry diff, gate and ML-BOM @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  // Release notes diff a candidate against the champion, so one has to exist. OCL2 rolls its canary
  // back (that is the behaviour it proves), which leaves search-svc with candidate = none, and the
  // agent then correctly answers "no registered candidate" and fails this spec on demo state rather
  // than on its own behaviour. Provision one first, the same way OCL2 does.
  const searchSvc = process.env.SEARCH_SVC_URL ?? "http://127.0.0.1:8801";
  const reg = await (await fetch(`${searchSvc}/models`)).json();
  if (!reg.candidate) {
    const champ = reg.versions.find(
      (v: { version: string }) => v.version === reg.champion,
    );
    await fetch(`${searchSvc}/models/candidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          ...champ.config,
          rerank_depth: (champ.config.rerank_depth ?? 50) + 1,
        },
        note: "e2e-OPS4 scratch candidate",
        actor: "e2e-OPS4",
      }),
    });
  }
  await openOps(page);
  const msg = await ask(
    page,
    "Write release notes and a model card for the candidate against the champion.",
  );
  await expect(msg).toContainText(/Release notes: v\d+/);
  await expect(msg).toContainText("Model card");
  await expect(msg).toContainText(/Sources: search-svc \/models/);
  await shot(
    page,
    4,
    "release_notes",
    msg.getByText(/Release notes: v/).first(),
  );
});

test("OPS5 compare champion vs candidate with paired CI and slices @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openOps(page);
  const msg = await ask(page, "Compare the champion with the candidate.");
  await expect(msg).toContainText(/Compare v\d+ vs v\d+/);
  await expect(msg).toContainText(/test_ndcg10/);
  await shot(
    page,
    5,
    "compare_versions",
    msg.getByText(/Compare v\d+ vs/).first(),
  );
});

test("OPS6 drift explainer names the query slices that moved with seasonal examples @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openOps(page);
  const msg = await ask(page, "Explain the drift: which query slices moved?");
  await expect(msg).toContainText("Drift explainer");
  await expect(msg).toContainText(/Largest slice shift: \w+/);
  await expect(msg).toContainText(/seasonal_queries/);
  await shot(
    page,
    6,
    "drift_explain",
    msg.getByText("Drift explainer").first(),
  );
});

test("OPS7 eval failures clustered by query type with proposal-only fixes @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openOps(page);
  const msg = await ask(
    page,
    "Cluster the eval failures by query type and suggest fixes.",
  );
  await expect(msg).toContainText("Eval failures clustered by query type");
  await expect(msg).toContainText(/proposal/i);
  await shot(
    page,
    7,
    "eval_clusters",
    msg.getByText("Eval failures clustered by query type").first(),
  );
});

test("OPS8 cost & token dashboard from the ledger with anomaly alerts, in chat and on the dashboard @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openOps(page);
  const msg = await ask(
    page,
    "Show model cost and token usage for the last 7 days, with any anomalies.",
  );
  await expect(msg).toContainText(/Cost & tokens/);
  await expect(msg).toContainText(/model calls/);
  await page.getByRole("radio", { name: /Cost & tokens/ }).click();
  const dash = page.getByTestId("ops-tokens");
  await expect(dash.getByTestId("ops-tokens-summary")).toContainText(
    /\$\d+\.\d{4} over \d+ model calls/,
  );
  await expect(dash.getByRole("table")).toBeVisible();
  await shot(page, 8, "cost_tokens", dash);
});

test("OPS9 replay 'what went wrong' summary for a recorded run @llm", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const runs = (await (await request.get("/api/replay/runs")).json()).runs as {
    runId: string;
  }[];
  expect(runs.length).toBeGreaterThan(0);
  const id = runs[runs.length > 1 ? 1 : 0].runId;
  await openOps(page);
  const msg = await ask(page, `What went wrong in run ${id}?`);
  await expect(msg).toContainText(`What went wrong in run ${id.slice(0, 8)}`);
  await expect(msg).toContainText(/agui_runs/);
  await shot(
    page,
    9,
    "replay_summary",
    msg.getByText(/What went wrong in run/).first(),
  );
});

test("OPS10 proactive watch alerts show a suggested next action that sends to the Copilot; axe clean @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openOps(page);
  const bell = page.getByTestId("ops-watch-bell");
  await expect(bell).toBeVisible();
  await expectNoSeriousA11y(page, '[aria-label="Ops Copilot chat"]');
  await bell.click();
  const panel = page.getByTestId("ops-watch-panel");
  await expect(panel).toBeVisible();
  await expect(
    panel
      .getByTestId("ops-watch-note")
      .or(panel.getByText(/No active alerts/))
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  await shot(page, 10, "watch_alerts", panel);
  await expectNoSeriousA11y(page, '[data-testid="ops-watch-panel"]');
  const notes = panel.getByTestId("ops-watch-note");
  if ((await notes.count()) > 0) {
    const action = notes.first().getByTestId("ops-watch-action");
    const label = (await action.innerText()).trim();
    await action.click();
    await expect(region(page).getByTestId("msg-user").last()).toBeVisible();
    const msg = region(page).getByTestId("msg-assistant").last();
    await expect(region(page).getByTestId("stop-button")).toHaveCount(0, {
      timeout: 240_000,
    });
    await expect(msg).toContainText(/Sources:/, { timeout: 30_000 });
    test
      .info()
      .annotations.push({ type: "watch", description: `acted on: ${label}` });
  }
});
