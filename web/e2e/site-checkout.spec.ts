import { expect, test } from "@playwright/test";
import { api, freshSession, inStockProduct } from "./helpers";

test("S7+H1 revalidate, sign mandate, approve, order in history, no payment @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid);
  expect((await api(request, sid).add(p.product_id, 1)).ok()).toBeTruthy();
  await page.goto("/shop/checkout");
  await expect(page.getByTestId("no-payment-note")).toContainText(
    "No payment is taken in this environment.",
  );
  await expect(page.getByTestId("checkout-revalidate")).toContainText(/Ready/);
  await page.getByRole("spinbutton", { name: "Spend cap (USD)" }).fill("500");
  await page.getByRole("button", { name: "Create signed mandate" }).click();
  await expect(page.getByTestId("mandate-signature")).toContainText(
    /HMAC-SHA256.*[0-9a-f]{32}/,
  );
  await page.getByRole("button", { name: "Approve and place order" }).click();
  await page.goto("/shop/orders");
  await expect(page.getByRole("main", { name: "Storefront" })).toContainText(
    p.title.slice(0, 20),
  );
  await expect(page.getByRole("main", { name: "Storefront" })).toContainText(
    /no payment/i,
  );
  await expect(page.getByTestId("cart-count")).toHaveText("0");
});

test("S8 out of stock between cart and checkout blocks signing and offers a substitute @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid, "paper towels");
  expect((await api(request, sid).add(p.product_id, 1)).ok()).toBeTruthy();
  const adj = await request.post("/api/store/inventory", {
    data: {
      product_id: p.product_id,
      store_id: "4108",
      qty: 0,
      reason: "e2e S8: sold out between cart and checkout",
    },
  });
  expect(adj.ok()).toBeTruthy();
  await page.goto("/shop/checkout");
  const check = page.getByTestId("checkout-revalidate");
  await expect(check).toContainText(/out of stock/i);
  await expect(check).toContainText("Swap for:");
  await expect(page.getByRole("button", { name: "Create signed mandate" }))
    .toBeDisabled()
    .catch(async () => {
      await page
        .getByRole("spinbutton", { name: "Spend cap (USD)" })
        .fill("500");
      await page.getByRole("button", { name: "Create signed mandate" }).click();
      await expect(page.getByText("Mandate not created")).toBeVisible();
    });
});
