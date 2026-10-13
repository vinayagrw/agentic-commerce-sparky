import { expect, test } from "@playwright/test";
import {
  capShot,
  chat,
  chatRegion,
  freshSession,
  logTurnCost,
  waitTurnDone,
} from "./helpers";

test("AI9 an ambiguous goal gets follow-up chips (and at most one clarifying question) that send on click @agent @llm", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await freshSession(page);
  await page.goto("/shop?view=chat");
  const region = chatRegion(page);
  await chat(page, "I need snacks for a party");
  await waitTurnDone(page);
  await logTurnCost(page, "AI9 turn");
  const chips = region
    .getByTestId("clarify-option")
    .or(region.getByTestId("followup-chip"));
  await expect(chips.first()).toBeVisible({ timeout: 120_000 });
  expect(
    await region.getByTestId("clarify-question").count(),
  ).toBeLessThanOrEqual(1);
  await capShot(page, "9_followups");
  const label = await chips.first().innerText();
  await chips.first().click();
  await expect(region.getByTestId("msg-user").last()).toContainText(label);
});
