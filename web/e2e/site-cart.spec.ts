import { expect, test } from "@playwright/test";
import { freshSession, inStockProduct } from "./helpers";

test("S6 add, change quantity, remove: header count follows @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid);
  await page.goto(`/shop/p/${p.product_id}`);
  await page.getByTestId("add-to-cart").first().click();
  await expect(page.getByTestId("cart-count")).toHaveText("1");
  await page.goto("/shop/cart");
  await page.getByRole("button", { name: "Increase quantity" }).first().click();
  await expect(page.getByTestId("cart-count")).toHaveText("2");
  await page
    .getByRole("main", { name: "Storefront" })
    .getByRole("button", { name: /^Remove (?!constraint)/ })
    .first()
    .click();
  await expect(page.getByTestId("cart-count")).toHaveText("0");
});
