import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { expectNoSeriousA11y, freshSession } from "./helpers";

/**
 * /ops/tokens: the filterable token meter over data/token_ledger.jsonl. No model calls — it reads
 * the ledger lines real calls already wrote, so the numbers must agree with the API exactly.
 */

test("the token meter needs ledger lines", async ({ request }) => {
  const s = await (
    await request.get("/api/tokens/summary?group_by=role")
  ).json();
  expect(s.ok).toBe(true);
});

for (const theme of ["light", "dark"] as const) {
  test(`token meter: tiles agree with the API, filters change the totals, axe (${theme}) @nollm`, async ({
    page,
    request,
  }) => {
    const all = await (
      await request.get("/api/tokens/summary?group_by=role")
    ).json();
    test.skip(
      !all.totals.calls,
      "data/token_ledger.jsonl has no lines yet: run a turn first",
    );

    await freshSession(page, theme);
    await page.goto("/ops/tokens?hours=0&group=role");
    await expect(page.getByTestId("token-meter-page")).toBeVisible();
    // data/token_ledger.jsonl is append-only and any @llm spec running beside this one adds lines,
    // so an exact match against a single API snapshot is a race (seen: API 981, UI 982). Bracket the
    // rendered value between a read taken before the page loaded and one taken after: still proves
    // the tile agrees with the API, without pinning it to a number that legitimately moves.
    const tileNumber = async (testId: string) => {
      const text = await page.getByTestId(testId).innerText();
      const m = text.replace(/,/g, "").match(/\d+/);
      expect(m, `a number in ${testId}: ${text}`).toBeTruthy();
      return Number(m![0]);
    };
    await expect(page.getByTestId("token-tile-calls")).toContainText(/\d/);
    const uiCalls = await tileNumber("token-tile-calls");
    const uiIn = await tileNumber("token-tile-in");
    const after = await (
      await request.get("/api/tokens/summary?group_by=role")
    ).json();
    expect(
      uiCalls,
      `calls between ${all.totals.calls} and ${after.totals.calls}`,
    ).toBeGreaterThanOrEqual(all.totals.calls);
    expect(uiCalls).toBeLessThanOrEqual(after.totals.calls);
    expect(
      uiIn,
      `input tokens between ${all.totals.input_tokens} and ${after.totals.input_tokens}`,
    ).toBeGreaterThanOrEqual(all.totals.input_tokens);
    expect(uiIn).toBeLessThanOrEqual(after.totals.input_tokens);
    await expect(page.getByTestId("token-budget")).toContainText(
      "SESSION_COST_BUDGET_USD",
    );
    await expect(page.getByTestId("token-chart")).toBeVisible();

    const rows = page.getByTestId("token-row");
    await expect(rows).toHaveCount(all.buckets.length);

    // A filter must narrow the totals, and the URL must carry it.
    const role = all.buckets[0].key;
    const filtered = await (
      await request.get(
        `/api/tokens/summary?group_by=role&role=${encodeURIComponent(role)}`,
      )
    ).json();
    await page.getByTestId("token-filter-role").selectOption(role);
    await expect(page).toHaveURL(
      new RegExp(
        `role=${encodeURIComponent(role).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
    await expect(page.getByTestId("token-tile-calls")).toContainText(
      filtered.totals.calls.toLocaleString(),
    );
    expect(filtered.totals.calls).toBeLessThanOrEqual(all.totals.calls);
    await expect(page.getByTestId("token-row")).toHaveCount(1);

    // Grouping by another dimension re-buckets the same filtered rows.
    await page.getByTestId("token-filter-group").selectOption("model");
    const byModel = await (
      await request.get(
        `/api/tokens/summary?group_by=model&role=${encodeURIComponent(role)}`,
      )
    ).json();
    await expect(page.getByTestId("token-row")).toHaveCount(
      byModel.buckets.length,
    );

    // Back to everything, then sort the breakdown.
    await page.getByTestId("token-filter-role").selectOption("");
    await page.getByTestId("token-filter-group").selectOption("role");
    await expect(page.getByTestId("token-row")).toHaveCount(all.buckets.length);
    await page.getByTestId("token-sort-calls").click();
    await expect(page.getByTestId("token-row").first()).toBeVisible();

    await page.screenshot({
      path: resolve(process.cwd(), "../docs/ui", `token_meter_${theme}.png`),
      fullPage: false,
    });
    await expectNoSeriousA11y(page);
  });
}

test("CSV export downloads the breakdown, and a row drills through to its ledger lines and the trace @nollm", async ({
  page,
  request,
}) => {
  const all = await (
    await request.get("/api/tokens/summary?group_by=role")
  ).json();
  test.skip(!all.totals.calls, "data/token_ledger.jsonl has no lines yet");

  await freshSession(page);
  await page.goto("/ops/tokens?hours=0&group=role");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("token-export-csv").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^token_meter_role_\d{4}-\d{2}-\d{2}\.csv$/,
  );
  const stream = await download.createReadStream();
  const csv = await new Promise<string>((res, rej) => {
    let t = "";
    stream.on("data", (c) => (t += c));
    stream.on("end", () => res(t));
    stream.on("error", rej);
  });
  const lines = csv.trim().split("\n");
  expect(lines[0]).toContain("cost $");
  expect(lines.length).toBe(all.buckets.length + 1);
  expect(lines[1]).toContain(
    all.buckets.sort((a: any, b: any) => b.cost_usd - a.cost_usd)[0].key,
  );

  // Drill through: a breakdown row opens its ledger lines.
  await page
    .getByTestId("token-row")
    .first()
    .getByTestId("token-drill")
    .click();
  const panel = page.getByTestId("token-drill-panel");
  await expect(panel).toBeVisible();
  const ledgerLines = panel.getByTestId("token-ledger-line");
  expect(await ledgerLines.count()).toBeGreaterThan(0);

  // ... and on to a trace, when the line carries one (older lines honestly say they do not).
  const withTrace = panel.getByTestId("token-line-trace").first();
  if (await withTrace.count()) {
    const href = await withTrace.getAttribute("href");
    expect(href).toMatch(/^\/ops\/traces\/[0-9a-f]{32}$/);
    await withTrace.click();
    await expect(page).toHaveURL(new RegExp("/ops/traces/[0-9a-f]{32}"));
    await expect(page.getByTestId("trace-waterfall")).toBeVisible();
  } else {
    await expect(panel).toContainText("no trace id on this line");
  }
});
