import { expect, test } from "@playwright/test";
import { api, freshSession, inStockProduct, useAccount } from "./helpers";

test("B16-A1 the persona switcher names the current synthetic shopper and keeps the cart @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid);
  expect((await api(request, sid).add(p.product_id, 1)).ok()).toBeTruthy();
  await page.goto("/shop");

  const switcher = page.getByTestId("persona-switcher");
  // A guest session: the accessible name says who is shopping and that they are synthetic.
  await expect(switcher).toHaveAttribute(
    "aria-label",
    /shopping as a guest.*synthetic/i,
  );
  await expect(page.getByTestId("cart-count")).toHaveText("1");

  await switcher.click();
  await expect(page.getByTestId("persona-cart-note")).toContainText(
    /cart \(1 item\) is kept/i,
  );
  await expect(page.getByTestId("persona-guest")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const options = page.getByTestId("persona-option");
  await expect(options).toHaveCount(3);

  await options.filter({ hasText: "Maya Alvarez" }).click();
  await expect(switcher).toHaveAttribute(
    "aria-label",
    /shopping as maya alvarez.*synthetic/i,
  );
  // The cart belongs to the session, not the account.
  await expect(page.getByTestId("cart-count")).toHaveText("1");

  // Switching back to a guest is offered and works.
  await switcher.click();
  await page.getByTestId("persona-guest").click();
  await expect(switcher).toHaveAttribute("aria-label", /shopping as a guest/i);
  await expect(page.getByTestId("cart-count")).toHaveText("1");
});

test("B16-A2 the account page shows the persona and renders prefs through the existing chips and memory @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_maya");
  await page.goto("/shop/account");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Account");
  const id = page.getByTestId("account-identity");
  await expect(id).toContainText("Maya Alvarez");
  await expect(id).toContainText("acct_maya");
  await expect(page.getByTestId("account-synthetic-label")).toContainText(
    /synthetic/i,
  );

  // The persona's dietary preference arrives as a real B11 constraint chip, not a second store.
  await expect(page.getByTestId("constraint-chip").first()).toBeVisible();
  await expect(page.getByTestId("account-memory")).toContainText("gluten_free");
  await expect(page.getByTestId("account-memory-item").first()).toContainText(
    /persona:acct_maya/,
  );

  // Links into the wallet, addresses and orders.
  for (const [name, url] of [
    ["Wallet", "/shop/account/wallet"],
    ["Addresses", "/shop/account/addresses"],
    ["Orders", "/shop/orders"],
  ] as const) {
    await expect(
      page
        .getByRole("navigation", { name: "Account sections" })
        .getByRole("link", { name: new RegExp(name) }),
    ).toHaveAttribute("href", url);
  }
});

test("B16-A3 a guest session says it has no account, wallet or address @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, null);
  for (const url of [
    "/shop/account",
    "/shop/account/wallet",
    "/shop/account/addresses",
  ]) {
    await page.goto(url);
    await expect(
      page.getByText(
        /guest session: there is no account, no stored wallet and no saved address/i,
      ),
    ).toBeVisible();
  }
});

test("B16-A4 addresses: add, edit, set default and remove, with exactly one default @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_rosa");
  await page.goto("/shop/account/addresses");

  // A persona's addresses are shared state, so count from what is there rather than asserting one.
  const rows = page.getByTestId("address-row");
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  await expect(page.getByTestId("address-default")).toHaveCount(1);

  await page.getByTestId("address-add").click();
  const form = page.getByTestId("address-add-form");
  for (const [field, value] of [
    ["name", "Rosa Nguyen"],
    ["line1", "12 Demo Way"],
    ["city", "San Jose"],
    ["region", "CA"],
    ["postal_code", "95110"],
  ] as const) {
    await form.getByTestId(`address-${field}`).fill(value);
  }
  await form.getByRole("button", { name: "Save address" }).click();
  await expect(rows).toHaveCount(before + 1);

  const added = rows.filter({ hasText: "12 Demo Way" });
  await added.getByTestId("address-make-default").click();
  await expect(added.getByTestId("address-default")).toBeVisible();
  await expect(page.getByTestId("address-default")).toHaveCount(1);

  // Editing goes through the same rows.
  await added.getByTestId("address-edit").click();
  await added.getByTestId("address-instructions").fill("Ring the bell");
  await added.getByRole("button", { name: "Save address" }).click();
  await expect(added).toContainText("Ring the bell");

  await added.getByTestId("address-remove").click();
  await expect(rows).toHaveCount(before);
  await expect(page.getByTestId("address-default")).toHaveCount(1);
});
