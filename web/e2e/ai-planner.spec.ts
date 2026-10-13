import { expect, test } from "@playwright/test";
import {
  api,
  capShot,
  chatRegion,
  freshSession,
  logTurnCost,
  waitTurnDone,
} from "./helpers";

test("AI6 mission plan cards are editable before cart; the B09 verifier re-runs on each edit @agent @llm", async ({
  page,
  request,
}) => {
  test.setTimeout(360_000);
  const sid = await freshSession(page);
  await page.goto("/shop?view=chat");
  const region = chatRegion(page);
  const box = region.getByRole("textbox").first();
  await box.fill("/plan pasta night for 4");
  await box.press("Enter");
  const plan = region.getByTestId("plan-card");
  await expect(plan).toBeVisible({ timeout: 280_000 });
  await waitTurnDone(page);
  await logTurnCost(page, "AI6 plan");
  expect((await api(request, sid).session()).cart.item_count).toBe(0);
  const lines = plan.getByTestId("plan-line");
  const n = await lines.count();
  expect(n).toBeGreaterThan(1);
  const v = plan.getByTestId("plan-verifier");
  await lines.first().getByRole("spinbutton").fill("2");
  await expect(v).toHaveAttribute("data-edits", "1");
  await lines
    .last()
    .getByRole("button", { name: /^Remove/ })
    .click();
  await expect(v).toHaveAttribute("data-edits", "2");
  await expect(lines).toHaveCount(n - 1);
  const s = await api(request, sid).session();
  expect(s.plan.verifier.checked_at).toBeTruthy();
  await capShot(page, "6_planner");
  await plan.getByRole("button", { name: "Add plan to cart" }).click();
  await expect(plan).toContainText("Added to cart");
  await expect
    .poll(async () => (await api(request, sid).session()).cart.item_count)
    .toBeGreaterThan(n - 1);
});
