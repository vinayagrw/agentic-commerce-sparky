import { expect, test } from "@playwright/test";
import {
  api,
  chatRegion,
  expectNoSeriousA11y,
  freshSession,
  inStockProduct,
  placeOrder,
  placeOrderWithCard,
  useAccount,
} from "./helpers";

for (const theme of ["light", "dark"] as const) {
  test(`A1 axe: no serious violations on store pages (${theme}) @nollm`, async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const sid = await freshSession(page, theme);
    const p = await inStockProduct(request, sid);
    await api(request, sid).add(p.product_id, 1);
    for (const url of [
      "/shop",
      "/shop/search?q=pasta",
      `/shop/p/${p.product_id}`,
      "/shop/cart",
      "/shop/checkout",
      "/shop?view=split",
      "/shop?view=chat",
      "/triage",
    ]) {
      await page.goto(url);
      await expect(
        page.getByRole("heading", { level: 1 }).first(),
      ).toBeVisible();
      await expectNoSeriousA11y(page);
    }
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`A3 axe: chat chrome with approval card, command menu and memory panel (${theme}) @nollm`, async ({
    page,
    request,
  }) => {
    const sid = await freshSession(page, theme);
    const p = await inStockProduct(request, sid);
    await placeOrder(request, sid, p.product_id, 1);
    await request.post(`/api/session/${sid}/reorder`);
    await page.goto("/shop?view=chat");
    const region = chatRegion(page);
    await expect(region.getByTestId("approval-card").first()).toBeVisible();
    await expect(region.getByTestId("prompt-starter").first()).toBeVisible();
    await region.getByRole("textbox").first().fill("/");
    await expect(
      region.getByRole("listbox", { name: "Commands" }),
    ).toBeVisible();
    await page.waitForTimeout(300); // let 150ms colour transitions settle before measuring contrast
    await expectNoSeriousA11y(page);
    // keyboard: arrow through commands, Escape clears
    await region.getByRole("textbox").first().press("ArrowDown");
    await expect(
      region
        .getByRole("listbox", { name: "Commands" })
        .getByRole("option", { selected: true }),
    ).toContainText("/plan");
    await region.getByRole("textbox").first().press("Escape");
    await region.getByTestId("open-memory").click();
    await expect(
      page.getByRole("dialog", { name: "What Compass remembers" }),
    ).toBeVisible();
    await page.waitForTimeout(400); // slide-in animation
    // modal open: the page behind is inert under the overlay, so scan the dialog itself
    await expectNoSeriousA11y(page, '[role="dialog"]');
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`A4 axe: no serious violations on the shopper plane beats (${theme}) @nollm`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await freshSession(page, theme);
    for (const url of [
      "/shopper/1",
      "/shopper/2",
      "/shopper/3",
      "/shopper/4",
      "/shopper/5",
      "/shopper/6",
      "/shopper/7",
    ]) {
      await page.goto(url);
      // exact: "Shopper beats" also prefix-matches HealthGate's "Shopper beats are locked".
      await expect(
        page.getByRole("heading", {
          level: 2,
          name: "Shopper beats",
          exact: true,
        }),
      ).toBeVisible();
      // A locked plane renders a placeholder, so axe would pass on a page that shows none of the
      // beat UI this test exists to check. Fail loudly instead of quietly checking nothing.
      await expect(
        page.getByRole("heading", { name: /beats are locked/i }),
        "a required service was down, so the beats never rendered and this axe run proves nothing",
      ).toHaveCount(0);
      await page.waitForTimeout(300); // let 150ms colour transitions settle before measuring contrast
      await expectNoSeriousA11y(page);
    }
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`A5 axe: no serious violations on the B16 account, payment and order routes (${theme}) @nollm`, async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const sid = await freshSession(page, theme);
    await useAccount(request, sid, "acct_maya");
    const p = await inStockProduct(request, sid);
    const { order } = await placeOrderWithCard(
      request,
      sid,
      p.product_id,
      "pm_maya_visa",
    );
    await api(request, sid).add(p.product_id, 1);
    // 390px: the narrowest phone width the storefront supports.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const url of [
      "/shop/account",
      "/shop/account/wallet",
      "/shop/account/addresses",
      "/shop/checkout",
      "/shop/orders",
      `/shop/order/${order.order_id}`,
    ]) {
      await page.goto(url);
      await expect(
        page.getByRole("heading", { level: 1 }).first(),
      ).toBeVisible();
      await page.waitForTimeout(300); // let 150ms colour transitions settle before measuring contrast
      await expectNoSeriousA11y(page);
    }
    // The persona switcher popover is part of the header on every route.
    await page.goto("/shop");
    await page.getByTestId("persona-switcher").click();
    await expect(page.getByTestId("persona-guest")).toBeVisible();
    await page.waitForTimeout(300);
    await expectNoSeriousA11y(page);

    // The step-up challenge and the authorisation result only exist mid-flow, so drive to them.
    await useAccount(request, sid, "acct_dev");
    await page.goto("/shop/checkout");
    await page.getByRole("spinbutton", { name: "Spend cap (USD)" }).fill("500");
    await page.getByRole("button", { name: "Create signed mandate" }).click();
    await expect(page.getByTestId("mandate-signature")).toBeVisible();
    await page.getByRole("button", { name: "Approve and place order" }).click();
    await expect(page.getByTestId("step-up-challenge")).toBeVisible();
    await page.waitForTimeout(300);
    await expectNoSeriousA11y(page);
  });
}
