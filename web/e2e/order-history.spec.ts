import { expect, test } from "@playwright/test";
import {
  freshSession,
  inStockProduct,
  placeOrder,
  placeOrderWithCard,
  useAccount,
} from "./helpers";

test("B16-H1 order rows link to the confirmation and show the tender and fulfilment @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_maya");
  const p = await inStockProduct(request, sid);
  const { order } = await placeOrderWithCard(
    request,
    sid,
    p.product_id,
    "pm_maya_visa",
  );

  await page.goto("/shop/orders");
  const row = page.getByTestId("order-row").filter({ hasText: order.order_id });
  await expect(row.getByTestId("order-link")).toHaveAttribute(
    "href",
    `/shop/order/${order.order_id}`,
  );
  await expect(row.getByTestId("order-fulfilment-badge")).toHaveText("Placed");
  await expect(row.getByTestId("order-tender-summary")).toContainText(
    "VISA ending 4242",
  );
  await expect(row).toContainText("payment executed: no");

  await row.getByTestId("order-link").click();
  await expect(page).toHaveURL(`/shop/order/${order.order_id}`);
});

test("B16-H2 the scope filter separates this session from this shopper's orders @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  // One guest order (no account), then one order as Maya in the same session.
  const p = await inStockProduct(request, sid);
  await placeOrder(request, sid, p.product_id, 1);
  await useAccount(request, sid, "acct_maya");
  const { order } = await placeOrderWithCard(
    request,
    sid,
    p.product_id,
    "pm_maya_visa",
  );

  await page.goto("/shop/orders");
  await expect(page.getByTestId("order-row")).toHaveCount(2);
  // The guest order names no tender, and says so.
  await expect(
    page.getByTestId("order-row").filter({ hasText: "guest checkout" }),
  ).toHaveCount(1);

  await page.getByTestId("orders-scope-account").click();
  await expect(page.getByTestId("order-row")).toHaveCount(1);
  await expect(page.getByTestId("order-row")).toContainText(order.order_id);

  await page.getByTestId("orders-scope-session").click();
  await expect(page.getByTestId("order-row")).toHaveCount(2);
});

test("B16-H3 reorder goes through the existing reorder path and waits for approval in chat @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_maya");
  const p = await inStockProduct(request, sid);
  await placeOrderWithCard(request, sid, p.product_id, "pm_maya_visa");

  await page.goto("/shop/orders");
  await page.getByTestId("order-reorder").first().click();
  await expect(page.getByTestId("reorder-note")).toContainText(
    /approve each one/i,
  );

  // It used POST /reorder: the proposals are pending actions, not silent cart writes.
  const s = await request.get(`/api/session/${sid}`).then((r) => r.json());
  expect(s.pending_actions.length).toBeGreaterThan(0);
  expect(
    s.pending_actions.every(
      (a: any) => a.status === "pending" && a.proposed_by === "reorder",
    ),
  ).toBeTruthy();
});

test("B16-H4 a guest session can still read its order history @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid);
  await placeOrder(request, sid, p.product_id, 1);
  await page.goto("/shop/orders");
  await expect(page.getByTestId("order-row")).toHaveCount(1);
  await expect(page.getByTestId("orders-scope-account")).toBeDisabled();
});
