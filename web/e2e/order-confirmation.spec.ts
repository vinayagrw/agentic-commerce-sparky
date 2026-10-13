import { expect, test } from "@playwright/test";
import {
  freshSession,
  inStockProduct,
  placeOrderWithCard,
  snapProduct,
  useAccount,
} from "./helpers";

test("B16-O1 the confirmation shows the order, the simulated authorisation, the address and the labels @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_maya");
  const p = await inStockProduct(request, sid);
  const { order, auth_ref } = await placeOrderWithCard(
    request,
    sid,
    p.product_id,
    "pm_maya_visa",
  );

  await page.goto(`/shop/order/${order.order_id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Order confirmed",
  );
  await expect(page.getByTestId("order-id")).toHaveText(order.order_id);
  await expect(page.getByTestId("order-no-payment")).toContainText(
    "payment_executed: no",
  );

  // Tender rows: brand + last4 + amount + what they cover.
  const tender = page
    .getByTestId("order-tender")
    .getByTestId("order-tender-row");
  await expect(tender).toHaveCount(1);
  await expect(tender.first()).toContainText("VISA ending 4242");
  await expect(tender.first()).toContainText("whole basket");
  await expect(tender.first()).toContainText("$");

  // auth_ref in a <code> with the note that nothing settles.
  const ref = page.getByTestId("order-auth-ref");
  await expect(ref).toHaveText(auth_ref);
  await expect(ref).toHaveJSProperty("tagName", "CODE");
  await expect(page.getByTestId("order-auth-note")).toContainText(
    /nothing to settle or refund/i,
  );

  await expect(page.getByTestId("order-address")).toContainText(
    "1204 Walton Blvd",
  );
  await expect(page.getByTestId("order-synthetic-label")).toContainText(
    /synthetic commerce data/i,
  );
  await expect(page.getByTestId("order-back")).toHaveAttribute(
    "href",
    "/shop/orders",
  );
});

test("B16-O2 the fulfilment stepper advances on the demo control @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_rosa");
  const p = await snapProduct(request, sid);
  const { order } = await placeOrderWithCard(
    request,
    sid,
    p.product_id,
    "pm_rosa_ebt",
  );

  await page.goto(`/shop/order/${order.order_id}`);
  const ff = page.getByTestId("order-fulfilment");
  await expect(ff.getByTestId("order-fulfilment-stage")).toHaveText("Placed");
  await expect(ff.getByRole("listitem")).toHaveCount(4);
  await expect(ff).toContainText(/simulated fulfilment progress/i);

  await ff.getByTestId("advance-fulfilment").click();
  await expect(ff.getByTestId("order-fulfilment-stage")).toHaveText(
    "Preparing",
  );
  await expect(ff).toContainText("Derived from demo_control");
  await ff.getByTestId("advance-fulfilment").click();
  await expect(ff.getByTestId("order-fulfilment-stage")).toHaveText(
    "Ready for pickup",
  );
});

test("B16-O3 a split tender is shown leg by leg on the confirmation @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_rosa");
  const p = await snapProduct(request, sid);
  const { order } = await placeOrderWithCard(
    request,
    sid,
    p.product_id,
    "pm_rosa_ebt",
  );
  await page.goto(`/shop/order/${order.order_id}`);
  const rows = page.getByTestId("order-tender").getByTestId("order-tender-row");
  await expect(rows.first()).toContainText("EBT SNAP");
  await expect(page.getByTestId("order-payment")).toContainText(
    "payment executed: no",
  );
});

test("B16-O4 an unknown order id fails honestly @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_maya");
  await page.goto("/shop/order/ord_does_not_exist");
  await expect(page.getByText("That order could not be read")).toBeVisible();
});
