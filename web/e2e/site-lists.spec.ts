import { expect, test } from "@playwright/test";
import { freshSession, inStockProduct } from "./helpers";

test("S10 saved list and cart survive a reload (return visit) @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid);
  await page.goto(`/shop/p/${p.product_id}`);
  await page.getByRole("button", { name: "Save to list" }).click();
  await page.getByTestId("add-to-cart").first().click();
  await expect(page.getByTestId("cart-count")).toHaveText("1");
  await page.reload();
  await page.goto("/shop/lists");
  await expect(page.getByRole("main", { name: "Storefront" })).toContainText(
    p.title.slice(0, 20),
  );
  await expect(page.getByTestId("cart-count")).toHaveText("1");
});
