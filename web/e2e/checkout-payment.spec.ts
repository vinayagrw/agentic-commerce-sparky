import { expect, test } from "@playwright/test";
import { api, freshSession, inStockProduct, useAccount } from "./helpers";

/**
 * Drive the payment step to a signed mandate with exactly the given instrument selected.
 * Each toggle is asserted before the next one, because every change re-prices the plan.
 */
async function signWith(page: import("@playwright/test").Page, last4: string) {
  const pay = page.getByTestId("checkout-payment");
  await expect(pay.getByTestId("tender-pm").first()).toBeVisible();
  const want = pay.getByTestId("tender-pm").filter({ hasText: last4 });
  for (const pm of await pay.getByTestId("tender-pm").all()) {
    const box = pm.locator('input[type="checkbox"]');
    const target = (await pm.innerText()).includes(last4);
    if ((await box.isChecked()) === target) continue;
    await box.setChecked(target);
    await expect(box).toBeChecked({ checked: target });
  }
  await expect(want.locator('input[type="checkbox"]')).toBeChecked();
  await expect(
    page.getByTestId("tender-plan").getByTestId("tender-plan-row"),
  ).toHaveCount(1);
  await expect(page.getByTestId("tender-plan")).toContainText(last4);
  await page.getByRole("spinbutton", { name: "Spend cap (USD)" }).fill("500");
  await page.getByRole("button", { name: "Create signed mandate" }).click();
  await expect(page.getByTestId("mandate-signature")).toContainText(
    /HMAC-SHA256/,
  );
}

test("B16-P1 approved card: authorise, confirm, land on the order confirmation @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_maya");
  const p = await inStockProduct(request, sid);
  expect((await api(request, sid).add(p.product_id, 1)).ok()).toBeTruthy();
  await page.goto("/shop/checkout");

  // The hard rule: this exact note is untouched by the payment step.
  await expect(page.getByTestId("no-payment-note")).toContainText(
    "No payment is taken in this environment.",
  );
  const pay = page.getByTestId("checkout-payment");
  await expect(pay.getByTestId("tender-address")).toBeVisible();
  // The outcome is on the row before it is picked.
  await expect(
    pay
      .getByTestId("tender-pm")
      .filter({ hasText: "4242" })
      .getByTestId("pm-outcome"),
  ).toHaveText("test card: approves");

  await signWith(page, "4242");
  await page.getByRole("button", { name: "Approve and place order" }).click();

  await expect(page).toHaveURL(/\/shop\/order\/ord_/);
  await expect(page.getByTestId("order-no-payment")).toContainText(
    "payment_executed: no",
  );
  await expect(page.getByTestId("order-auth-ref")).toContainText(
    /auth_[0-9a-f]+/,
  );
});

test("B16-P2 a declined card creates no order and says the mandate is dead @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_dev");
  const p = await inStockProduct(request, sid);
  expect((await api(request, sid).add(p.product_id, 1)).ok()).toBeTruthy();
  await page.goto("/shop/checkout");

  await signWith(page, "0002");
  await page.getByRole("button", { name: "Approve and place order" }).click();

  const result = page.getByTestId("auth-result");
  await expect(result).toHaveAttribute("data-decision", "declined");
  await expect(result).toContainText(/declined by the demo issuer/i);
  await expect(page.getByTestId("auth-declined-note")).toContainText(
    /No order was created, and this mandate is dead/i,
  );
  // No navigation to a confirmation, and no order in history.
  await expect(page).toHaveURL(/\/shop\/checkout/);
  const orders = await request
    .get(`/api/session/${sid}/orders`)
    .then((r) => r.json());
  expect(orders.orders).toHaveLength(0);

  // Recovery: sign a new mandate with a different instrument.
  await page.getByTestId("auth-start-over").click();
  await signWith(page, "3220");
  await expect(page.getByTestId("mandate-signature")).toBeVisible();
});

test("B16-P3 a step-up card asks for a code, rejects a wrong one, then completes @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_dev");
  const p = await inStockProduct(request, sid);
  expect((await api(request, sid).add(p.product_id, 1)).ok()).toBeTruthy();
  await page.goto("/shop/checkout");

  await signWith(page, "3220");
  await page.getByRole("button", { name: "Approve and place order" }).click();

  const challenge = page.getByTestId("step-up-challenge");
  await expect(challenge).toBeVisible();
  await expect(page.getByTestId("auth-result")).toHaveAttribute(
    "data-decision",
    "step_up_required",
  );

  await challenge.getByTestId("step-up-code").fill("111111");
  await challenge.getByTestId("step-up-submit").click();
  await expect(challenge.getByTestId("step-up-message")).toContainText(
    /not correct/i,
  );
  await expect(challenge.getByTestId("step-up-attempts")).toContainText(
    "2 attempt(s) remaining",
  );

  await challenge.getByTestId("step-up-code").fill("000000");
  await challenge.getByTestId("step-up-submit").click();

  await expect(page).toHaveURL(/\/shop\/order\/ord_/);
  await expect(page.getByTestId("order-no-payment")).toContainText(
    "payment_executed: no",
  );
  await expect(page.getByTestId("order-payment")).toContainText(
    /simulated authorisation/i,
  );
});

test("B16-P4 the guest path still signs and places an order with no tender @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid);
  expect((await api(request, sid).add(p.product_id, 1)).ok()).toBeTruthy();
  await page.goto("/shop/checkout");

  const pay = page.getByTestId("checkout-payment");
  await expect(pay).toContainText(
    /guest session: there is no wallet and no saved address/i,
  );
  await expect(pay.getByTestId("tender-pm")).toHaveCount(0);

  await page.getByRole("spinbutton", { name: "Spend cap (USD)" }).fill("500");
  await page.getByRole("button", { name: "Create signed mandate" }).click();
  await page.getByRole("button", { name: "Approve and place order" }).click();

  await expect(page).toHaveURL(/\/shop\/order\/ord_/);
  await expect(page.getByTestId("order-payment")).toContainText(
    /named no payment instrument/i,
  );
  await expect(page.getByTestId("cart-count")).toHaveText("0");
});

test("B16-P5 each instrument checkbox names its card and its deliberate outcome @nollm", async ({
  page,
  request,
}) => {
  // The card's visible text and its outcome badge are siblings of the checkbox, not a <label for>,
  // so the control announced as bare "checkbox, on" — three identically-named controls, with the
  // "this card declines" warning available to sighted users only. axe does not flag it (the row has
  // text near it), which is exactly why it needs an assertion of its own.
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_dev");
  const p = await inStockProduct(request, sid);
  expect((await api(request, sid).add(p.product_id, 1)).ok()).toBeTruthy();
  await page.goto("/shop/checkout");

  const boxes = page.getByTestId("checkout-payment").getByRole("checkbox");
  await expect(boxes.first()).toBeVisible();
  const names = await boxes.evaluateAll((els) =>
    els.map((e) => e.getAttribute("aria-label") ?? ""),
  );
  expect(names.length).toBeGreaterThanOrEqual(3);
  for (const n of names) expect(n, "every instrument names the card it pays with").toMatch(/Pay with .+ending \d{4}/);
  expect(new Set(names).size, "no two instruments may announce identically").toBe(names.length);
  // Dev's wallet is the failure-mode persona: the outcomes must be audible, not just visible.
  expect(names.join(" | ")).toMatch(/needs verification/);
  expect(names.join(" | ")).toMatch(/declines/);
  expect(names.join(" | ")).toMatch(/expired/);
});
