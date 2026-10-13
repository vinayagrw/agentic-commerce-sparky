import { expect, test } from "@playwright/test";
import {
  api,
  freshSession,
  nonSnapProduct,
  snapProduct,
  useAccount,
} from "./helpers";

test("B16-T1 EBT plus a card splits the basket along SNAP eligibility @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_rosa");
  const food = await snapProduct(request, sid);
  const other = await nonSnapProduct(request, sid);
  expect((await api(request, sid).add(food.product_id, 1)).ok()).toBeTruthy();
  expect((await api(request, sid).add(other.product_id, 1)).ok()).toBeTruthy();

  await page.goto("/shop/checkout");
  const pay = page.getByTestId("checkout-payment");
  // EBT is Rosa's default; adding the debit card makes it a split tender.
  await pay
    .getByTestId("tender-pm")
    .filter({ hasText: "9995" })
    .locator('input[type="checkbox"]')
    .check();

  const plan = page.getByTestId("tender-plan");
  await expect(plan).toContainText("split tender");
  const rows = plan.getByTestId("tender-plan-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "EBT SNAP" })).toContainText(
    "covers SNAP-eligible lines",
  );
  await expect(rows.filter({ hasText: "9995" })).toContainText(
    "covers remainder not covered by EBT",
  );
  await expect(plan).toContainText("Not covered");
  await expect(plan).toContainText("$0.00");
  // The SNAP rule text is attributed to the service that produced it, not paraphrased.
  await expect(plan).toContainText("catalog_services.evaluate_eligibility");
  // No blocking refusal, so the mandate can be signed.
  await expect(
    page.locator('[data-testid="tender-refusal"][data-blocking="true"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create signed mandate" }),
  ).toBeEnabled();
});

test("B16-T2 EBT alone refuses a non-SNAP line with blocking styling and stops the mandate @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_rosa");
  const food = await snapProduct(request, sid);
  const other = await nonSnapProduct(request, sid);
  expect((await api(request, sid).add(food.product_id, 1)).ok()).toBeTruthy();
  expect((await api(request, sid).add(other.product_id, 1)).ok()).toBeTruthy();

  await page.goto("/shop/checkout");
  const pay = page.getByTestId("checkout-payment");
  // Only the EBT instrument: nothing covers the non-SNAP line.
  await expect(
    pay
      .getByTestId("tender-pm")
      .filter({ hasText: "EBT SNAP" })
      .locator('input[type="checkbox"]'),
  ).toBeChecked();

  const refusal = page.getByTestId("tender-refusal");
  await expect(refusal.first()).toHaveAttribute("data-blocking", "true");
  await expect(refusal.first()).toContainText(/cannot be covered by EBT/i);
  await expect(refusal.first()).toContainText(/SNAP covers food/);
  await expect(refusal.first()).toContainText("Blocking:");

  // A blocking refusal stops the flow here: no mandate can be signed over it.
  await expect(page.getByTestId("tender-not-ready")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create signed mandate" }),
  ).toBeDisabled();

  // Adding the second instrument clears it.
  await pay
    .getByTestId("tender-pm")
    .filter({ hasText: "9995" })
    .locator('input[type="checkbox"]')
    .check();
  await expect(page.getByTestId("tender-refusal")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create signed mandate" }),
  ).toBeEnabled();
});

test("B16-T3 the signed mandate carries the previewed tender rows and hash @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_maya");
  const food = await snapProduct(request, sid);
  expect((await api(request, sid).add(food.product_id, 1)).ok()).toBeTruthy();

  await page.goto("/shop/checkout");
  const plan = page.getByTestId("tender-plan");
  await expect(plan).toContainText("4242");
  await page.getByRole("spinbutton", { name: "Spend cap (USD)" }).fill("500");
  await page.getByRole("button", { name: "Create signed mandate" }).click();
  await expect(page.getByTestId("mandate-signature")).toBeVisible();

  const s = await api(request, sid).session();
  const m = s.mandate;
  expect(m.tender.map((t: any) => t.pm_id)).toEqual(["pm_maya_visa"]);
  expect(m.tender_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(m.address_id).toBe("adr_maya_home");
  expect(m.payment_executed).toBe(false);
});
