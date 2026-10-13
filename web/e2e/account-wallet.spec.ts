import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { freshSession, useAccount } from "./helpers";

/** A plausible-looking number that is NOT in the demo's frozen allowlist. */
const NOT_A_TEST_CARD = "4111111111111111";

/**
 * A persona's wallet is shared state in the commerce DB, not per-session, so these specs never
 * assert an absolute row count and never remove a SEEDED instrument: each one adds its own
 * instrument, acts on that row by pm_id, and removes it again.
 */
const walletIds = async (request: APIRequestContext, sid: string) =>
  (
    await request.get(`/api/session/${sid}/wallet`).then((r) => r.json())
  ).payment_methods.map((p: { pm_id: string }) => p.pm_id) as string[];

const row = (page: Page, pmId: string) =>
  page
    .getByTestId("wallet-row")
    .filter({ has: page.locator(`[data-pm="${pmId}"]`) })
    .or(page.locator(`[data-testid="wallet-row"][data-pm="${pmId}"]`));

test("B16-W1 the wallet shows each instrument's deliberate outcome as a badge @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_dev");
  await page.goto("/shop/account/wallet");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wallet");
  await expect(page.getByTestId("wallet-synthetic-label")).toContainText(
    /simulated authorisation only/i,
  );
  const rows = page.getByTestId("wallet-row");
  // Nothing is a surprise: the failing cards say what they will do before checkout.
  await expect(
    rows.filter({ hasText: "3220" }).getByTestId("pm-outcome"),
  ).toHaveText("test card: needs verification");
  await expect(
    rows.filter({ hasText: "0002" }).getByTestId("pm-outcome"),
  ).toHaveText("test card: declines");
  await expect(
    rows.filter({ hasText: "0069" }).getByTestId("pm-outcome"),
  ).toHaveText("test card: expired");
  // Exactly one default.
  await expect(page.getByTestId("wallet-default")).toHaveCount(1);
  // Every row carries the API's own label verbatim.
  await expect(rows.first()).toContainText(
    /published network test card number - accepted by this demo only; no money ever moves/,
  );
});

test("B16-W2 the add-card form warns permanently and lists the accepted test cards with one-click fill @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_maya");
  const before = await walletIds(request, sid);
  await page.goto("/shop/account/wallet");

  const warn = page.getByTestId("test-card-warning");
  await expect(warn).toBeVisible();
  await expect(warn).toContainText("Never enter a real card number");

  const number = page.getByTestId("add-card-number");
  await expect(number).toHaveAttribute("inputmode", "numeric");
  await expect(number).toHaveAttribute("autocomplete", "off");

  // The accepted list comes from GET /api/store/test-cards and fills the field in one click.
  const list = page.getByTestId("test-card-list");
  await expect(list).toContainText("4242424242424242");
  await list
    .getByTestId("test-card-fill")
    .filter({ hasText: "378282246310005" })
    .click();
  await expect(number).toHaveValue("378282246310005");

  const nickname = `W2 amex ${Date.now()}`;
  await page.getByTestId("add-card-nickname").fill(nickname);
  await page.getByRole("button", { name: "Add to wallet" }).click();

  const added = page.getByTestId("wallet-row").filter({ hasText: nickname });
  await expect(added).toHaveCount(1);
  await expect(added).toContainText("0005");
  await expect(added.getByTestId("pm-outcome")).toHaveText(
    "test card: approves",
  );
  // Only the last four digits are ever shown back: the number is never stored.
  await expect(added).not.toContainText("378282246310005");

  // Clean up so the next spec sees the persona's seeded wallet.
  const pmId = (await walletIds(request, sid)).find(
    (id) => !before.includes(id),
  )!;
  await request.delete(`/api/session/${sid}/wallet/${pmId}`);
});

test("B16-W3 a plausible non-test number is rejected and the response shows no card digits @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_maya");
  const before = await walletIds(request, sid);

  // The API refuses it, and neither the error nor the accepted list echoes the posted number.
  const r = await request.post(`/api/session/${sid}/wallet`, {
    data: {
      kind: "credit",
      number: NOT_A_TEST_CARD,
      nickname: "should not exist",
    },
  });
  expect(r.status()).toBe(422);
  const raw = await r.text();
  expect(raw, "the 422 body must not echo the posted digits").not.toContain(
    NOT_A_TEST_CARD,
  );
  expect(raw, "not even the last four of a rejected number").not.toContain(
    NOT_A_TEST_CARD.slice(-4),
  );
  const body = JSON.parse(raw);
  expect(body.error).toMatch(/allowlist/i);
  expect(body.accepted.length).toBeGreaterThan(0);
  expect(await walletIds(request, sid)).toEqual(before);

  // And the UI renders that error plus the accepted list, not a generic failure.
  await page.goto("/shop/account/wallet");
  await expect(page.getByTestId("wallet-row")).toHaveCount(before.length);
  await page.getByTestId("add-card-number").fill(NOT_A_TEST_CARD);
  await page.getByTestId("add-card-nickname").fill("should not exist");
  await page.getByRole("button", { name: "Add to wallet" }).click();

  await expect(page.getByText("That instrument was not added")).toBeVisible();
  await expect(page.getByTestId("add-card-error")).toContainText(/allowlist/i);
  await expect(page.getByTestId("add-card-accepted")).toContainText(
    "4242424242424242",
  );
  // Nothing was added, and the rejected number is nowhere on the page except the field I typed it in.
  await expect(page.getByTestId("wallet-row")).toHaveCount(before.length);
  await expect(
    page.getByTestId("wallet-row").filter({ hasText: "should not exist" }),
  ).toHaveCount(0);
  const shown = await page
    .getByRole("main", { name: "Storefront" })
    .innerText();
  expect(
    shown.split(NOT_A_TEST_CARD).length - 1,
    "the digits appear only in the input I typed them into",
  ).toBeLessThanOrEqual(1);
  expect(await walletIds(request, sid)).toEqual(before);
});

test("B16-W4 edit a label, move the default and remove an instrument @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await useAccount(request, sid, "acct_maya");
  const before = await walletIds(request, sid);
  // This spec's own instrument, so a seeded one is never renamed or removed.
  const added = await request.post(`/api/session/${sid}/wallet`, {
    data: { kind: "gift", balance: 40, nickname: "W4 gift" },
  });
  expect(added.ok(), await added.text()).toBeTruthy();
  const pmId = (await added.json()).payment_method.pm_id as string;

  await page.goto("/shop/account/wallet");
  const mine = row(page, pmId);
  await expect(mine).toContainText("W4 gift");
  await expect(mine.getByTestId("pm-outcome")).toContainText("approves");

  await mine.getByTestId("wallet-edit").click();
  await mine.getByTestId("wallet-edit-nickname").fill("W4 renamed");
  await mine.getByTestId("wallet-edit-balance").fill("15");
  await mine.getByRole("button", { name: "Save" }).click();
  await expect(mine).toContainText("W4 renamed");
  await expect(mine).toContainText("$15.00");

  await mine.getByTestId("wallet-make-default").click();
  await expect(mine.getByTestId("wallet-default")).toBeVisible();
  await expect(page.getByTestId("wallet-default")).toHaveCount(1);

  await mine.getByTestId("wallet-remove").click();
  await expect(page.getByTestId("wallet-row")).toHaveCount(before.length);
  // Removing the default promotes a remaining instrument, so the one-default invariant holds.
  await expect(page.getByTestId("wallet-default")).toHaveCount(1);
  expect(await walletIds(request, sid)).toEqual(before);
  // Restore the persona's own default, which this spec moved.
  await request.post(`/api/session/${sid}/wallet/${before[0]}/default`);
});
