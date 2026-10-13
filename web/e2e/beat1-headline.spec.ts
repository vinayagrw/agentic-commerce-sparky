import { expect, test } from "@playwright/test";
import { BEATS } from "@sparky/shared";
import {
  api,
  chat,
  chatRegion,
  freshSession,
  logTurnCost,
  waitTurnDone,
} from "./helpers";

/**
 * B03 headline beat 1 (replaces taco night), run live: a real Claude CLI turn, real ESCI products,
 * HITL approvals. Candidate runs and the selection reason: docs/evidence/B03_headline_beat_candidates.md.
 */
test("B03 beat 1 coffee + #4 cone filters: proposals approved, cart meets the goal and the budget @agent @llm", async ({
  page,
  request,
}) => {
  test.setTimeout(540_000);
  const beat = BEATS.find((b) => b.id === 1)!;
  expect(beat.prompt).toMatch(/#4 cone coffee filters/);
  expect(beat.prompt).not.toMatch(/taco/i);
  const sid = await freshSession(page);
  await page.goto("/shop?view=split");
  await expect(page.getByTestId("cart-count")).toHaveText("0");
  await chat(page, beat.prompt);
  const region = chatRegion(page);
  // HITL: approve each proposal as it arrives, until the turn is done and nothing is pending.
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
      !/pending/.test(await region.getByTestId("run-cost").last().innerText())
    )
      break;
    await page.waitForTimeout(2000);
  }
  await waitTurnDone(page);
  await logTurnCost(page, "B03 beat 1");
  expect(approved).toBeGreaterThanOrEqual(1);
  const s = await api(request, sid).session();
  const titles: string[] = s.cart.items.map((i: any) => i.title);
  expect(
    titles.some(
      (t) => /coffee/i.test(t) && !/filter/i.test(t) && /ground/i.test(t),
    ),
    `ground coffee in ${titles}`,
  ).toBeTruthy();
  expect(
    titles.some(
      (t) =>
        /filter/i.test(t) &&
        /(#|No\.?\s*|number\s*)4\b/i.test(t) &&
        /cone/i.test(t),
    ),
    `#4 cone filters in ${titles}`,
  ).toBeTruthy();
  expect(s.cart.total).toBeLessThanOrEqual(25);
  expect(
    s.pending_actions.filter((a: any) => a.status === "pending"),
  ).toHaveLength(0);
  expect(s.audit.map((a: any) => a.event)).toEqual(
    expect.arrayContaining(["proposed", "approved"]),
  );
  await expect(page.getByTestId("cart-count")).toHaveText(
    String(s.cart.item_count),
  );
});
