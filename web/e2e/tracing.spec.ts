import { expect, test } from "@playwright/test";
import { expectNoSeriousA11y, freshSession } from "./helpers";

/**
 * G2: the replay Trace tab and /ops/traces render recorded traces from data/traces (no model calls).
 * Needs at least one traced replay run on disk (any shopper/ops turn since tracing was added).
 */
async function tracedRun(
  request: any,
): Promise<{ runId: string; traceId: string } | null> {
  const { runs } = await (await request.get("/api/replay/runs")).json();
  for (const r of runs ?? []) {
    const d = await (
      await request.get(`/api/traces/run/${encodeURIComponent(r.runId)}`)
    )
      .json()
      .catch(() => null);
    if (d?.ok && d.traceId) {
      const t = await request.get(`/api/traces/${d.traceId}`);
      if (t.ok()) return { runId: r.runId, traceId: d.traceId };
    }
  }
  return null;
}

for (const theme of ["light", "dark"] as const) {
  test(`G2 replay Trace tab: waterfall, kind filters, attribute panel, axe (${theme}) @nollm`, async ({
    page,
    request,
  }) => {
    const run = await tracedRun(request);
    test.skip(
      !run,
      "no traced replay run recorded yet: run one shopper turn first",
    );
    const tree = await (
      await request.get(`/api/traces/${run!.traceId}`)
    ).json();
    await freshSession(page, theme);
    await page.goto(`/ops/replay/${encodeURIComponent(run!.runId)}`);
    await page.getByTestId("replay-tab-trace").click();
    await expect(page).toHaveURL(/tab=trace/);
    const wf = page.getByTestId("trace-waterfall");
    await expect(wf).toHaveAttribute("data-trace-id", run!.traceId);
    const spans = wf.getByTestId("trace-span");
    await expect(spans).toHaveCount(tree.span_count);

    // per-kind counts match the API
    for (const [k, n] of Object.entries(
      tree.kind_counts as Record<string, number>,
    )) {
      await expect(
        wf
          .locator(`[data-testid="kind-chip"][data-kind="${k}"]`)
          .getByTestId("kind-count"),
      ).toHaveText(String(n));
    }
    // filter: turning a kind off removes exactly its rows
    const [kind, n] = Object.entries(
      tree.kind_counts as Record<string, number>,
    ).sort((a, b) => b[1] - a[1])[0];
    const chip = wf.locator(`[data-testid="kind-chip"][data-kind="${kind}"]`);
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await expect(spans).toHaveCount(tree.span_count - n);
    await chip.click();
    await expect(spans).toHaveCount(tree.span_count);

    // click-to-open attributes
    await spans.first().click();
    await expect(page.getByTestId("span-panel")).toContainText("span_id");
    await page.waitForTimeout(400);
    await expectNoSeriousA11y(page);
    const { resolve } = await import("node:path");
    await page.waitForTimeout(300);
    await page.screenshot({
      path: resolve(
        process.cwd(),
        "../docs/ui",
        `trace_waterfall_${theme}.png`,
      ),
    });
  });
}

test("G2 /ops/traces lists recent traces and opens one; ops dashboard links to it @nollm", async ({
  page,
  request,
}) => {
  const { traces } = await (await request.get("/api/traces?limit=50")).json();
  test.skip(!traces?.length, "no traces recorded yet");
  await freshSession(page);
  await page.goto("/ops/1");
  await page.getByTestId("ops-nav-traces").click();
  await expect(page).toHaveURL(/\/ops\/traces$/);
  await expect(page.getByTestId("trace-row").first()).toBeVisible();
  await page.getByTestId("trace-row").first().getByRole("link").click();
  await expect(page.getByTestId("trace-waterfall")).toBeVisible();
  await page.waitForTimeout(400);
  await expectNoSeriousA11y(page);
});
