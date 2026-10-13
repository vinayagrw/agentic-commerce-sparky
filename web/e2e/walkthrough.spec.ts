import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { BEATS } from "@sparky/shared";
import {
  api,
  chat,
  chatRegion,
  freshSession,
  inStockProduct,
  placeOrder,
  search,
  waitTurnDone,
} from "./helpers";

/**
 * Demo walkthrough, LIVE (no mocks): every beat screenshotted into docs/ui/walkthrough_<name>_<theme>.png
 * for light and dark. The headline beat and the could-not-do beat are real Claude turns (slow).
 */
type Theme = "light" | "dark";
const THEMES: Theme[] = ["light", "dark"];

async function shot(page: Page, name: string, theme: Theme) {
  const dir = resolve(process.cwd(), "../docs/ui");
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: resolve(dir, `walkthrough_${name}_${theme}.png`),
  });
}

for (const theme of THEMES) {
  test.describe(`walkthrough ${theme}`, () => {
    test(`1 headline beat in split view (${theme}) @agent @llm`, async ({
      page,
      request,
    }) => {
      test.setTimeout(540_000);
      const beat = BEATS.find((b) => b.id === 1)!;
      const sid = await freshSession(page, theme);
      await page.goto("/shop?view=split");
      await expect(page.getByTestId("cart-count")).toHaveText("0");
      await chat(page, beat.prompt);
      const region = chatRegion(page);
      const approve = region
        .getByTestId("approval-card")
        .getByRole("button", { name: /^Approve/ });
      const deadline = Date.now() + 420_000;
      let approved = 0;
      while (Date.now() < deadline) {
        if (await approve.count()) {
          await approve.first().click();
          approved++;
          await page.waitForTimeout(1000);
          continue;
        }
        const done =
          !(await region.getByTestId("stop-button").count()) &&
          (await region.getByTestId("run-cost").count()) > 0;
        if (
          done &&
          !/pending/.test(
            await region.getByTestId("run-cost").last().innerText(),
          )
        )
          break;
        await page.waitForTimeout(2000);
      }
      await waitTurnDone(page);
      expect(approved).toBeGreaterThanOrEqual(1);
      const s = await api(request, sid).session();
      expect(s.cart.item_count).toBeGreaterThan(0);
      await expect(page.getByTestId("cart-count")).toHaveText(
        String(s.cart.item_count),
      );
      await shot(page, "1_headline_cart", theme);
    });

    test(`2 approval and undo (${theme}) @nollm`, async ({ page, request }) => {
      const sid = await freshSession(page, theme);
      const p = await inStockProduct(request, sid);
      await placeOrder(request, sid, p.product_id, 1);
      await page.goto("/shop?view=split");
      await expect(page.getByTestId("cart-count")).toHaveText("0");
      const region = chatRegion(page);
      const box = region.getByRole("textbox").first();
      await box.fill("/reorder ");
      await box.press("Enter");
      const card = region.getByTestId("approval-card").first();
      await expect(card).toContainText(/Reorder proposes/);
      await card.getByRole("button", { name: /^Approve/ }).click();
      await expect(page.getByTestId("cart-count")).toHaveText("1");
      await shot(page, "2_approved", theme);
      await card.getByRole("button", { name: /^Undo/ }).click();
      await expect(page.getByTestId("cart-count")).toHaveText("0");
      await shot(page, "2_undone", theme);
      const s = await api(request, sid).session();
      expect(s.audit.map((a: any) => a.event)).toEqual([
        "proposed",
        "approved",
        "undone",
      ]);
    });

    test(`3 could-not-do (${theme}) @agent @llm`, async ({ page, request }) => {
      test.setTimeout(360_000);
      const sid = await freshSession(page, theme);
      await page.goto("/shop?view=split");
      await chat(
        page,
        "I need nut-free granola bars for school lunches. Add one box to my cart.",
      );
      const region = chatRegion(page);
      const cnd = page.getByTestId("could-not-do").first();
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline && !(await cnd.isVisible())) {
        const btn = region
          .getByTestId("approval-card")
          .getByRole("button", { name: /^Approve/ });
        if (await btn.count())
          await btn
            .first()
            .click()
            .catch(() => {});
        await page.waitForTimeout(2000);
      }
      await expect(cnd).toContainText(/allergen|nut/i);
      const s = await api(request, sid).session();
      expect(
        s.could_not.some((x: any) => /nut/i.test(x.constraint)),
      ).toBeTruthy();
      await cnd.scrollIntoViewIfNeeded();
      await shot(page, "3_could_not_do", theme);
    });

    test(`4 zero-result relaxation and triage row (${theme}) @nollm`, async ({
      page,
    }) => {
      await freshSession(page, theme);
      const q = `peanut butter walkthrough ${Date.now() % 100000}`;
      await page.goto(
        `/shop/search?q=${encodeURIComponent(q)}&brand=Zzznobrand`,
      );
      const zero = page.getByTestId("zero-result");
      await expect(zero).toBeVisible();
      await expect(zero).toContainText(/\d+ result/);
      await shot(page, "4_zero_result", theme);
      await page.goto("/triage");
      const row = page.getByTestId("triage-row").filter({ hasText: q });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("Zzznobrand");
      await row.scrollIntoViewIfNeeded();
      await shot(page, "4_triage", theme);
    });

    test(`5 help answer (${theme}) @nollm`, async ({ page }) => {
      await freshSession(page, theme);
      await page.goto("/shop");
      await search(page, "what is your return policy");
      const a = page.getByTestId("help-answer");
      await expect(a).toBeVisible();
      await expect(a).toContainText(/return/i);
      await shot(page, "5_help_answer", theme);
    });

    test(`6 ops eval gate goes red (${theme}) @nollm`, async ({ page }) => {
      test.setTimeout(360_000);
      await freshSession(page, theme);
      await page.goto("/ops/8b");
      const btn = page.getByRole("button", {
        name: /Gate a preregistered null/,
      });
      await expect(btn).toBeEnabled({ timeout: 60_000 });
      await btn.click();
      const red = page.locator('[data-gate="red"]').first();
      await expect(red).toBeVisible({ timeout: 300_000 });
      await expect(red).toContainText("FAIL");
      await red.scrollIntoViewIfNeeded();
      await shot(page, "6_gate_red", theme);
    });

    test(`7 session replay (${theme}) @nollm`, async ({ page }) => {
      await freshSession(page, theme);
      await page.goto("/ops/replay");
      const link = page.locator('a[href^="/ops/replay/"]').first();
      await expect(link).toBeVisible({ timeout: 30_000 });
      await shot(page, "7_replay_list", theme);
      await link.click();
      await expect(page).toHaveURL(/\/ops\/replay\/.+/);
      await page.waitForLoadState("networkidle");
      const slider = page.getByRole("slider").first();
      await expect(slider).toBeVisible();
      await slider.focus();
      await slider.press("End");
      await shot(page, "7_replay_session", theme);
    });

    test(`8 simulated feed failure (${theme}) @nollm`, async ({
      page,
      request,
    }) => {
      await freshSession(page, theme);
      try {
        const r = await request.post("/api/store/faults", {
          data: { service: "price", down: true, seconds: 120 },
        });
        expect(r.ok(), await r.text()).toBeTruthy();
        expect((await r.json()).faults.price.down).toBe(true);
        await page.goto("/shop/search?q=peanut%20butter");
        const notice = page.getByRole("status").filter({ hasText: /degraded/ });
        await expect(notice).toBeVisible();
        await expect(notice).toContainText(/price/i);
        await shot(page, "8_feed_failure", theme);
      } finally {
        await request.post("/api/store/faults", {
          data: { service: "price", down: false },
        });
        const f = await (await request.get("/api/store/faults")).json();
        expect(Object.values(f.faults).every((x: any) => !x.down)).toBeTruthy();
      }
    });

    test(`9 presenter mode (${theme}) @nollm`, async ({ page }) => {
      await freshSession(page, theme);
      await page.goto("/shop?view=split");
      await page
        .getByRole("radio", { name: /Presenter/ })
        .first()
        .click();
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("sparky.density")))
        .toBe("presenter");
      await shot(page, "9_presenter", theme);
      await page.getByRole("radio", { name: /Dense/ }).first().click();
    });
  });
}

/**
 * ARCH1: the three planes named in docs/FEATURE_CATALOGUE.md §0.1 (web on 5173 talking to bff on
 * 8787, which fronts search-svc/shop-http/ops-http) each respond. This proves reachability of
 * /shop, /ops/1 and /guide against the live stack; it does not (and cannot, from a browser) prove
 * which backend service served each response, only that the front door for each plane is up.
 */
test("ARCH1 shop, ops and guide planes each respond @nollm", async ({
  page,
  request,
}) => {
  await freshSession(page);
  const shopResp = await page.goto("/shop");
  expect(shopResp?.ok(), "GET /shop").toBeTruthy();
  await expect(
    page.getByRole("heading", { name: "Shop by category" }),
  ).toBeVisible();

  const opsResp = await page.goto("/ops/1");
  expect(opsResp?.ok(), "GET /ops/1").toBeTruthy();
  await expect(
    page
      .getByRole("region", { name: "Ops Copilot chat" })
      .getByRole("textbox")
      .first(),
  ).toBeVisible();

  const guideResp = await page.goto("/guide");
  expect(guideResp?.ok(), "GET /guide").toBeTruthy();
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();

  // The bff itself, which the web app on 5173 talks to and which fronts search-svc/shop-http/ops-http.
  const health = await request.get("/api/coverage");
  expect([200, 503]).toContain(health.status());
});

const COVERAGE_PATH = resolve(process.cwd(), "../data/coverage.json");

test("OCOV1 coverage board tallies real evidence @nollm", async ({
  page,
  request,
}) => {
  const board = await (await request.get("/api/coverage")).json();
  await freshSession(page);
  await page.goto("/coverage");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  // The summary heading states the real tally read from data/coverage.json (total + all 4 buckets).
  const summary = page.getByRole("heading", {
    level: 2,
    name: new RegExp(`^${board.total} techniques:`),
  });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(
    `${board.tally["real-measured"] ?? 0} measured`,
  );
  await expect(summary).toContainText(
    `${board.tally["real-no-metric"] ?? 0} runs, no metric`,
  );
  await expect(summary).toContainText(
    `${board.tally["script-ready-not-executed"] ?? 0} script ready, not run`,
  );
  await expect(summary).toContainText(`${board.tally["absent"] ?? 0} absent`);
  // Each technique row links to its own evidence detail page.
  const first = board.techniques[0];
  const link = page.getByRole("link", {
    name: new RegExp(`Open detail for technique ${first.id},`),
  });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/coverage/${first.id}`));
});

test("OCOV2 coverage board refuses rather than fakes @nollm", async ({
  page,
  request,
}) => {
  const backup = resolve(
    process.cwd(),
    `../data/.e2e-coverage-backup-${process.pid}.json`,
  );
  renameSync(COVERAGE_PATH, backup);
  try {
    // Missing file: the API refuses with a real 503, not a placeholder.
    const missing = await request.get("/api/coverage");
    expect(missing.status()).toBe(503);
    const missingBody = await missing.json();
    expect(missingBody.error).toMatch(/does not exist/i);

    // Malformed file: same refusal, different reason.
    writeFileSync(COVERAGE_PATH, "{ not json", "utf8");
    const malformed = await request.get("/api/coverage");
    expect(malformed.status()).toBe(503);
    const malformedBody = await malformed.json();
    expect(malformedBody.error).toMatch(/could not be parsed/i);

    await freshSession(page);
    await page.goto("/coverage");
    await expect(page.getByRole("alert")).toContainText("not available", {
      timeout: 15_000,
    });
    await expect(page.getByRole("alert")).toContainText(/could not be parsed/i);
  } finally {
    renameSync(backup, COVERAGE_PATH);
  }
});

/**
 * OCL2: a canaried candidate that breaches its guardrail (p95 latency here) is auto-rolled-back by
 * ops-http's guardrail watcher, not left running. Talks to search-svc (8801) directly to start the
 * canary — no LLM turn is needed since this is a deterministic control-plane path — then drives it
 * through the same POST /api/ops/inject-latency the presenter button on /ops/8b uses.
 */
test("OCL2 guardrail breach rolls back the canary automatically @nollm", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const searchSvc = process.env.SEARCH_SVC_URL ?? "http://127.0.0.1:8801";
  const registryPath = resolve(process.cwd(), "../data/registry.json");
  const registryBackup = resolve(
    process.cwd(),
    `../data/.e2e-registry-backup-${process.pid}.json`,
  );
  writeFileSync(registryBackup, readFileSync(registryPath));

  const reg = await (await fetch(`${searchSvc}/models`)).json();
  let candidate: string = reg.candidate;
  if (!candidate) {
    // No candidate registered right now (e.g. a previous OCL2 run already rolled its candidate
    // back and search-svc has not restarted since): build a fresh, cheap one off the champion's
    // own config so there is something to canary.
    const champ = reg.versions.find((v: any) => v.version === reg.champion);
    const cfg = {
      ...champ.config,
      rerank_depth: (champ.config.rerank_depth ?? 50) + 1,
    };
    const built = await (
      await fetch(`${searchSvc}/models/candidate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: cfg,
          note: "e2e-OCL2 scratch candidate",
          actor: "e2e-OCL2",
        }),
      })
    ).json();
    candidate = built.version;
  }
  expect(candidate, "a registered candidate version to canary").toBeTruthy();

  const start = await fetch(`${searchSvc}/canary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // background: false — bff's POST /api/ops/inject-latency already drives traffic explicitly via
    // POST /canary/traffic; a background replay thread would just add unrelated load competing with
    // other live specs for search-svc's shared inference lock.
    body: JSON.stringify({
      version: candidate,
      traffic_pct: 50,
      background: false,
      actor: "e2e-OCL2",
    }),
  });
  expect(start.ok, await start.text()).toBeTruthy();

  try {
    const r = await request.post("/api/ops/inject-latency", {
      data: { ms: 900 },
      timeout: 150_000,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);
    const [status, audit] = body.results;
    // Either field is valid evidence of the rollback, so don't prefer one over the other: the bff
    // polls /guardrail/check before /canary/status, so when the watcher rolls back between those two
    // calls guardrail_check.action is still "none" while the canary is already "rolled_back".
    expect(
      [status.guardrail_check?.action, status.status],
      `guardrail_check.action or canary status to report the rollback: ${JSON.stringify({ action: status.guardrail_check?.action, status: status.status })}`,
    ).toContain("rolled_back");
    expect(String(status.provenance?.note ?? "")).toMatch(
      /guardrail breached/i,
    );
    const rollbackEntry = audit.entries.find(
      (e: any) =>
        e.actor === "guardrail-watcher" && e.action === "auto_rollback",
    );
    expect(
      rollbackEntry,
      `an auto_rollback audit entry: ${JSON.stringify(audit.entries.slice(-5))}`,
    ).toBeTruthy();
    expect(rollbackEntry.subject).toBe(candidate);
  } finally {
    // The guardrail watcher's own POST /models/rollback already stopped the canary (canary_stop
    // inside MLOps.rollback); this is a belt-and-braces cleanup in case the breach did not fire.
    const st = await (await fetch(`${searchSvc}/canary/status`)).json();
    if (st.status === "running")
      await fetch(`${searchSvc}/models/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: candidate,
          reason: "e2e-OCL2 cleanup",
          actor: "e2e-OCL2",
        }),
      }).catch(() => {});
    // Restore the on-disk registry (same pattern as mlops-top10.spec.ts); the in-process copy inside
    // the running search-svc still reflects the rollback until it next restarts, same as that suite.
    writeFileSync(registryPath, readFileSync(registryBackup));
    unlinkSync(registryBackup);
  }
});
