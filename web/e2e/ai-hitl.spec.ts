import { expect, test } from "@playwright/test";
import {
  api,
  capShot,
  chatRegion,
  freshSession,
  inStockProduct,
  placeOrder,
} from "./helpers";

test("AI7+AI10b reorder my usual: proposals need approval, approve adds, undo removes, audit records all @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid);
  await placeOrder(request, sid, p.product_id, 1);
  await page.goto("/shop?view=split");
  await expect(page.getByTestId("cart-count")).toHaveText("0");
  const region = chatRegion(page);
  const box = region.getByRole("textbox").first();
  await box.fill("/reorder ");
  await box.press("Enter");
  const card = region.getByTestId("approval-card").first();
  await expect(card).toContainText(/Reorder proposes/);
  await expect(card).toContainText("synthetic commerce data");
  await expect(page.getByTestId("cart-count")).toHaveText("0");
  await capShot(page, "7_approval");
  await card.getByRole("button", { name: /^Approve/ }).click();
  await expect(page.getByTestId("cart-count")).toHaveText("1");
  await card.getByRole("button", { name: /^Undo/ }).click();
  await expect(page.getByTestId("cart-count")).toHaveText("0");
  const s = await api(request, sid).session();
  expect(s.audit.map((a: any) => a.event)).toEqual([
    "proposed",
    "approved",
    "undone",
  ]);
  // an undone action cannot be approved again
  const again = await request.post(
    `/api/session/${sid}/actions/${s.pending_actions[0].id}/approve`,
  );
  expect(again.status()).toBe(409);
});

test("AI7 reject leaves the cart untouched and is audited @nollm", async ({
  request,
  page,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid);
  await placeOrder(request, sid, p.product_id, 1);
  const r = await (await request.post(`/api/session/${sid}/reorder`)).json();
  const id = r.actions[0].id;
  expect(
    (await request.post(`/api/session/${sid}/actions/${id}/reject`)).ok(),
  ).toBeTruthy();
  const s = await api(request, sid).session();
  expect(s.cart.item_count).toBe(0);
  expect(s.audit.at(-1)).toMatchObject({ event: "rejected", actor: "shopper" });
});
