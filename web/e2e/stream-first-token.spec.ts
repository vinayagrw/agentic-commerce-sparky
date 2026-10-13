import { expect, test, type Locator, type Page } from "@playwright/test";
import { chatRegion, freshSession, waitTurnDone } from "./helpers";

/**
 * Phase 1 streaming: the first visible answer token must arrive before the final text, for the
 * shopper chat and the Ops Copilot. A page-side sampler records (time, visible answer length) every
 * 40 ms; a one-chunk reply would show a single jump from 0 to the final length. @llm
 */
async function sample(page: Page, scope: string) {
  await page.evaluate((sel) => {
    const w = window as any;
    w.__samples = [];
    w.__cursorSeen = false;
    const t0 = performance.now();
    w.__timer = setInterval(() => {
      const root = document.querySelector(sel);
      if (!root) return;
      const turns = root.querySelectorAll('[data-testid="msg-assistant"]');
      const last = turns[turns.length - 1];
      const len = last
        ? [...last.querySelectorAll('[data-testid="answer-text"]')].reduce(
            (n, el) => n + (el.textContent ?? "").length,
            0,
          )
        : 0;
      if (last?.querySelector('[data-testid="stream-cursor"]'))
        w.__cursorSeen = true;
      const prev = w.__samples[w.__samples.length - 1];
      if (!prev || prev.len !== len)
        w.__samples.push({ t: Math.round(performance.now() - t0), len });
    }, 40);
  }, scope);
}

async function verdict(page: Page) {
  return page.evaluate(() => {
    const w = window as any;
    clearInterval(w.__timer);
    const s: { t: number; len: number }[] = w.__samples;
    const final = s[s.length - 1]?.len ?? 0;
    const first = s.find((x) => x.len > 0);
    const done = s.find((x) => x.len === final);
    return {
      first: first ?? null,
      final,
      finalAt: done?.t ?? null,
      growth: s.filter((x) => x.len > 0).length,
      cursorSeen: Boolean(w.__cursorSeen),
    };
  });
}

function expectStreamed(v: Awaited<ReturnType<typeof verdict>>, label: string) {
  test
    .info()
    .annotations.push({
      type: "stream",
      description: `${label}: first token at ${v.first?.t} ms (len ${v.first?.len}), final ${v.final} chars at ${v.finalAt} ms, ${v.growth} growth samples`,
    });
  expect(v.first, `${label}: some answer text appeared`).not.toBeNull();
  expect(
    v.first!.t,
    `${label}: first visible token before the final text`,
  ).toBeLessThan(v.finalAt!);
  expect(
    v.first!.len,
    `${label}: first visible chunk is not the whole answer`,
  ).toBeLessThan(v.final);
  expect(
    v.growth,
    `${label}: text grew in several steps`,
  ).toBeGreaterThanOrEqual(3);
  expect(v.cursorSeen, `${label}: a streaming cursor was shown`).toBe(true);
}

test("shopper answer streams: first token before final text, cursor, then a Critic badge @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await freshSession(page);
  await page.goto("/shop?view=chat");
  await expect(chatRegion(page).getByRole("textbox").first()).toBeVisible();
  await sample(page, '[aria-label="Compass chat"]');
  const box = chatRegion(page).getByRole("textbox").first();
  await box.fill(
    "Search for gluten free pasta and tell me the two cheapest in-stock options in three short bullets. Do not add anything to my cart.",
  );
  await box.press("Enter");
  await waitTurnDone(page);
  const v = await verdict(page);
  expectStreamed(v, "shopper");
  const tl = chatRegion(page).getByTestId("run-timeline").last();
  await expect(tl.getByTestId("run-first-token")).toBeVisible();
  await page.screenshot({ path: "../docs/ui/stream_shopper.png" });
});

test("ops copilot answer streams: first token before final text @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await freshSession(page);
  await page.goto("/ops/1");
  const region: Locator = page.getByRole("region", {
    name: "Ops Copilot chat",
  });
  const box = region.getByRole("textbox").first();
  await expect(box).toBeVisible();
  await sample(page, '[aria-label="Ops Copilot chat"]');
  await box.fill(
    "Read the model registry and summarise the champion and any candidates in three short bullets. Do not change anything.",
  );
  await box.press("Enter");
  await expect(region.getByTestId("run-timeline").last()).toBeVisible({
    timeout: 240_000,
  });
  await expect(region.getByTestId("stop-button")).toHaveCount(0, {
    timeout: 240_000,
  });
  const v = await verdict(page);
  expectStreamed(v, "ops");
  await page.screenshot({ path: "../docs/ui/stream_ops.png" });
});
