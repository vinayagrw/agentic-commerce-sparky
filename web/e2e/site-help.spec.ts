import { expect, test } from "@playwright/test";
import { freshSession, search } from "./helpers";

test("S11 non-product question gets a cited help answer @nollm", async ({
  page,
}) => {
  await freshSession(page);
  await page.goto("/shop");
  await search(page, "what is your return policy");
  const a = page.getByTestId("help-answer");
  await expect(a).toBeVisible();
  await expect(a).toContainText(/return/i);
  await expect(a).toContainText(/not any real retailer's policy/i);
  await expect(page.getByTestId("result-card")).toHaveCount(0);
});
