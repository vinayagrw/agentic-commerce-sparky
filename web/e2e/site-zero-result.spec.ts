import { expect, test } from "@playwright/test";
import { freshSession } from "./helpers";

test("S4 zero result shows relaxation with count, applies it, files triage @nollm", async ({
  page,
}) => {
  await freshSession(page);
  const q = `peanut butter ${Date.now() % 100000}`;
  await page.goto(`/shop/search?q=${encodeURIComponent(q)}&brand=Zzznobrand`);
  const zero = page.getByTestId("zero-result");
  await expect(zero).toBeVisible();
  await expect(zero).toContainText(/\d+ result/);
  await expect(zero).toContainText(/triage/i);
  await page.getByTestId("relaxation-apply").click();
  await expect(page.getByTestId("result-card").first()).toBeVisible();
});
