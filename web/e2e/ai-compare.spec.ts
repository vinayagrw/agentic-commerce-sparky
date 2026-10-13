import { expect, test } from "@playwright/test";
import { capShot, chatRegion, freshSession, search } from "./helpers";

test("AI5 /compare builds an A2UI compare table from live catalogue services with a recommendation @nollm", async ({
  page,
}) => {
  await freshSession(page);
  await page.goto("/shop?view=split");
  await search(page, "peanut butter");
  await expect(page.getByTestId("result-card").first()).toBeVisible();
  const region = chatRegion(page);
  const box = region.getByRole("textbox").first();
  await box.fill("/comp");
  await expect(region.getByRole("listbox", { name: "Commands" })).toContainText(
    "/compare",
  );
  await box.press("Tab");
  await expect(box).toHaveValue("/compare ");
  await box.press("Enter");
  const card = region.getByTestId("compare-card");
  await expect(card).toContainText("Unit price");
  await expect(card).toContainText(/Recommended: .*(unit price|shelf price)/);
  await expect(card).toContainText(
    "synthetic commerce data (ESCI has no price or stock)",
  );
  await capShot(page, "5_compare");
});

test("AI5 compare API: size, unit price, stock and a reasoned recommendation @nollm", async ({
  request,
}) => {
  const sid = crypto.randomUUID();
  const s = await (
    await request.post(`/api/session/${sid}/search`, {
      data: { query: "peanut butter", filters: { in_stock: true } },
    })
  ).json();
  const ids = s.search.results.slice(0, 3).map((x: any) => x.product_id);
  const r = await (
    await request.post(`/api/session/${sid}/compare`, {
      data: { product_ids: ids },
    })
  ).json();
  expect(r.rows).toHaveLength(3);
  for (const row of r.rows) expect(row).toHaveProperty("unit_price_label");
  expect(ids).toContain(r.recommendation.product_id);
  expect(r.surface.messages[0].createSurface.surfaceId).toBe(
    r.surface.surfaceId,
  );
});
