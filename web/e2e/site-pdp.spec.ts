import { expect, test } from "@playwright/test";
import { freshSession, inStockProduct } from "./helpers";

test("S5 product page: trust tiers, stock, pickup, synthetic label @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid);
  await page.goto(`/shop/p/${p.product_id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const tiers = page.getByTestId("pdp-trust-tier");
  expect(await tiers.count()).toBeGreaterThan(2);
  await expect(page.getByLabel("Trust tier legend")).toContainText("T1");
  await expect(
    page.getByRole("region", { name: /Pickup at store/ }),
  ).toContainText(/ready|Pickup/i);
  await expect(
    page
      .getByText("synthetic commerce data (ESCI has no price or stock)")
      .first(),
  ).toBeVisible();
});

test("S12 promo service down is shown, price and stock still render @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid, "coffee");
  await request.post("/api/store/faults", {
    data: { service: "promo", down: true, seconds: 60 },
  });
  try {
    await page.goto(`/shop/p/${p.product_id}`);
    await expect(page.getByRole("region", { name: "Price" })).toContainText(
      /Promo service unavailable/i,
    );
    await expect(page.getByRole("region", { name: "Price" })).toContainText(
      "$",
    );
    await expect(
      page.getByRole("region", { name: /Pickup at store/ }),
    ).toBeVisible();
  } finally {
    await request.post("/api/store/faults", {
      data: { service: "promo", down: false },
    });
  }
});
