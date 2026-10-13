import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { expectNoSeriousA11y, freshSession } from "./helpers";

/**
 * The Inspector's Trace tab as an LLM observability panel: one real shopper turn must show the
 * rendered prompt text, the output text, per-call tokens and cost, and the capture toggle must
 * stop text being captured on the next turn.
 * Live only: every assertion is against what the turn's own spans recorded.
 */

const TRACE_TAB = (page: import("@playwright/test").Page) =>
  page.getByRole("tab", { name: /^Trace/ });

/**
 * The plane routes host the Inspector; their chat section is not the storefront's "Compass chat"
 * landmark, so this spec drives the composer directly instead of using the storefront helpers.
 */
async function sendTurn(page: import("@playwright/test").Page, text: string) {
  const box = page.getByRole("textbox", { name: "Message Compass" });
  await box.fill(text);
  await box.press("Enter");
  const timeline = page.getByTestId("run-timeline").last();
  await expect(timeline).toBeVisible({ timeout: 280_000 });
  await expect(page.getByTestId("stop-button")).toHaveCount(0, {
    timeout: 280_000,
  });
  // The timeline's cost reads "cost pending" until RUN_FINISHED lands; assert on the same element
  // the visibility check matched, so a re-render between the two cannot leave us on a stale node.
  await expect(page.getByTestId("run-timeline").last()).toContainText(/\$\d/, {
    timeout: 120_000,
  });
}

test.beforeEach(async ({ request }) => {
  // The panel's own switch is exercised below; start from a known state either way.
  await request.post("/api/traces/config", { data: { capture: true } });
});

test.afterEach(async ({ request }) => {
  await request.post("/api/traces/config", { data: { capture: true } });
});

for (const theme of ["light", "dark"] as const) {
  test(`Trace tab shows prompt, output, per-call tokens and cost for a live turn (${theme}) @agent @llm`, async ({
    page,
    request,
  }) => {
    test.setTimeout(420_000);
    await freshSession(page, theme);
    await page.goto("/shopper/1");
    await sendTurn(
      page,
      "Find a cheaper ground coffee under $10, but do not change my cart.",
    );

    await TRACE_TAB(page).click();
    const panel = page.getByTestId("trace-panel");
    await expect(panel).toBeVisible();

    // Turn header: the numbers come from the trace, not from the chat timeline.
    const header = page.getByTestId("trace-turn-header");
    await expect(header.getByTestId("trace-tokens-in")).toContainText(/\d/, {
      timeout: 60_000,
    });
    await expect(header.getByTestId("trace-tokens-out")).toContainText(/\d/);
    await expect(header.getByTestId("trace-cost")).toContainText("$");
    await expect(header.getByTestId("trace-ttft")).toContainText("ms");
    const traceId = (await header.getByTestId("trace-id").innerText()).trim();
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    await expect(header.getByTestId("trace-view-link")).toHaveAttribute(
      "href",
      `/ops/traces/${traceId}`,
    );

    // The header totals agree with the API the panel read.
    const detail = await (await request.get(`/api/traces/${traceId}`)).json();
    expect(detail.ok).toBe(true);
    await expect(page.getByTestId("trace-span-count")).toContainText(
      `${detail.span_count} spans`,
    );

    // Generations: one row per real model call, expandable into Prompt / Output / Tokens / Metadata.
    const gens = page.getByTestId("trace-generation");
    expect(await gens.count()).toBeGreaterThan(0);
    await expect(
      gens.first().getByTestId("trace-generation-tokens"),
    ).toContainText("cache");
    await gens.first().getByTestId("trace-generation-toggle").click();
    await expect(page.getByTestId("trace-gen-prompt")).toBeVisible();
    await expect(page.getByTestId("trace-prompt-text")).toContainText(/\S/);
    await page.getByTestId("trace-gen-tab-output").click();
    await expect(page.getByTestId("trace-output-text")).toContainText(/\S/);
    await page.getByTestId("trace-gen-tab-tokens").click();
    const tokens = page.getByTestId("trace-gen-tokens");
    await expect(tokens).toContainText("Cache read");
    await expect(page.getByTestId("trace-reasoning-row")).toContainText(
      "not reported by the CLI",
    );
    await page.getByTestId("trace-gen-tab-meta").click();
    await expect(page.getByTestId("trace-gen-meta")).toContainText(
      "Stop reason",
    );

    await page.screenshot({
      path: resolve(
        process.cwd(),
        "../docs/ui",
        `inspector_trace_${theme}.png`,
      ),
      fullPage: false,
    });
    await expectNoSeriousA11y(page);

    // Narrow viewport: the panel must stay usable at phone width.
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(panel).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);
  });
}

test("the capture toggle stops prompt and output text being captured on the next turn @agent @llm", async ({
  page,
  request,
}) => {
  test.setTimeout(420_000);
  await freshSession(page);
  await page.goto("/shopper/1");
  await TRACE_TAB(page).click();
  const banner = page.getByTestId("trace-capture-banner");
  await expect(banner).toContainText("capture on");

  await banner.getByTestId("trace-capture-toggle").click();
  await expect(banner).toContainText("capture off");
  expect(
    (await (await request.get("/api/traces/config")).json()).tracing
      .capture_text,
  ).toBe(false);

  await sendTurn(page, "What is in my cart right now?");
  await TRACE_TAB(page).click();
  const gens = page.getByTestId("trace-generation");
  await expect(gens.first()).toBeVisible({ timeout: 60_000 });
  await gens.first().getByTestId("trace-generation-toggle").click();
  await expect(page.getByTestId("trace-gen-prompt")).toContainText(
    "was not captured",
  );
  await page.getByTestId("trace-gen-tab-output").click();
  await expect(page.getByTestId("trace-output-text")).toContainText(
    "was not captured",
  );

  // Per-call tokens and cost are still there: only the text is withheld.
  await page.getByTestId("trace-gen-tab-tokens").click();
  await expect(page.getByTestId("trace-gen-tokens")).toContainText(
    "Cache read",
  );

  await banner.getByTestId("trace-capture-toggle").click();
  await expect(banner).toContainText("capture on");
});
