import { expect, test } from "@playwright/test";
import { freshSession, inStockProduct } from "./helpers";

test("S9 pick another store: header and pickup follow @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid);
  await page.goto("/shop/stores");
  await page
    .getByRole("listitem")
    .filter({ hasText: "#2231" })
    .getByRole("button", { name: "Make this my store" })
    .click();
  await expect(page.getByTestId("store-picker")).toContainText(/Dallas/);
  await page.goto(`/shop/p/${p.product_id}`);
  await expect(
    page.getByRole("region", { name: /Pickup at store #2231/ }),
  ).toBeVisible();
});
