import { expect, test } from "@playwright/test";
import { freshSession } from "./helpers";

const prices = async (page: import("@playwright/test").Page) =>
  (
    await page
      .getByTestId("result-card")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-price") ?? ""))
  ).map(Number);

test("S2 dietary facet + price sort @nollm", async ({ page }) => {
  await freshSession(page);
  await page.goto("/shop/search?q=pasta");
  await expect(page.getByTestId("result-card").first()).toBeVisible();
  await page
    .getByRole("group", { name: "Dietary" })
    .getByRole("checkbox", { name: /gluten_free/ })
    .click();
  await expect(page).toHaveURL(/gluten_free/);
  await page
    .getByRole("combobox", { name: "Sort" })
    .selectOption({ label: "Price: low to high" });
  await expect(page).toHaveURL(/gluten_free/);
  await expect(page).toHaveURL(/price_asc/);
  await expect(page.getByTestId("result-card").first()).toBeVisible();
  const cards = page.getByTestId("result-card");
  const n = await cards.count();
  for (let i = 0; i < n; i++)
    await expect(cards.nth(i)).toContainText(/gluten.free/i);
  const p = await prices(page);
  if (p.every((x) => x > 0))
    for (let i = 1; i < p.length; i++)
      expect(p[i]).toBeGreaterThanOrEqual(p[i - 1]);
});

test("S3 pagination marks the current page @nollm", async ({ page }) => {
  await freshSession(page);
  await page.goto("/shop/search?q=dog%20food");
  const first = await page.getByTestId("result-card").first().textContent();
  await page
    .getByRole("navigation", { name: "Pagination" })
    .getByRole("button", { name: "Page 2" })
    .click();
  await expect(page.getByRole("button", { name: "Page 2" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("result-card").first()).not.toHaveText(
    first ?? "",
  );
});
