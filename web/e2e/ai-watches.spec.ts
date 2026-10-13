import { expect, test } from "@playwright/test";
import {
  api,
  capShot,
  chatRegion,
  freshSession,
  inStockProduct,
} from "./helpers";

test("AI10 back-in-stock watch is evaluated against the inventory service and notifies in-app (synthetic) @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid, "paper towels");
  await api(request, sid).add(p.product_id, 1);
  const sold = await request.post("/api/store/inventory", {
    data: {
      product_id: p.product_id,
      store_id: "4108",
      qty: 0,
      reason: "e2e AI10: sold out",
    },
  });
  expect(sold.ok()).toBeTruthy();
  try {
    await page.goto("/shop?view=chat");
    await chatRegion(page).getByTestId("open-watches").click();
    const dlg = page.getByRole("dialog", {
      name: /Watches, alerts and reorder/,
    });
    await dlg
      .getByRole("combobox", { name: "Alert me on" })
      .selectOption("back_in_stock");
    await dlg
      .getByRole("combobox", { name: "Product" })
      .selectOption(p.product_id);
    await dlg.getByRole("button", { name: "Watch" }).click();
    await expect(dlg.getByTestId("watch-item").first()).toContainText(
      /out of stock/,
    );
    await request.post("/api/store/inventory", {
      data: {
        product_id: p.product_id,
        store_id: "4108",
        qty: 6,
        reason: "e2e AI10: restocked",
      },
    });
    await dlg.getByRole("button", { name: "Check now" }).click();
    await expect(dlg.getByTestId("notification").first()).toContainText(
      /Back in stock.*synthetic commerce data/,
    );
    await expect(dlg.getByTestId("watch-item").first()).toHaveAttribute(
      "data-status",
      "triggered",
    );
    await capShot(page, "10_watches");
  } finally {
    await request.post("/api/store/inventory", {
      data: {
        product_id: p.product_id,
        store_id: "4108",
        qty: 6,
        reason: "e2e AI10: cleanup",
      },
    });
  }
});

test("AI10 price watch baseline comes from the price service; unknown product is refused @nollm", async ({
  request,
}) => {
  const sid = crypto.randomUUID();
  const p = await inStockProduct(request, sid);
  const w = await (
    await request.post(`/api/session/${sid}/watches`, {
      data: { kind: "price_drop", product_id: p.product_id },
    })
  ).json();
  expect(w.watch.baseline_price).toBe(p.price);
  expect(w.synthetic_label).toMatch(/ESCI has no price or stock/);
  const bad = await request.post(`/api/session/${sid}/watches`, {
    data: { kind: "price_drop", product_id: "NOPE000000" },
  });
  expect(bad.ok()).toBeFalsy();
});
