import { expect, test } from "@playwright/test";
import {
  api,
  chat,
  freshSession,
  inStockProduct,
  waitTurnDone,
} from "./helpers";

test("X4 nut-free constraint filters the site; a chip explains and removal restores @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await api(request, sid).constraint("allergy", "nut-free");
  await page.goto("/shop/search?q=trail%20mix&view=split");
  const chip = page
    .getByTestId("constraint-chip")
    .filter({ hasText: /nut-free/ })
    .first();
  await expect(chip).toBeVisible();
  await expect(
    page.getByLabel("Filters applied from your constraints"),
  ).toContainText(/nut-free/);
  // Exclusion is on product titles (a brand such as "The Peanut Shell" crib sheets is not food).
  const r = await api(request, sid).search("trail mix");
  expect(r.search.results.length).toBeGreaterThan(0);
  for (const x of r.search.results)
    expect(x.title).not.toMatch(/\b(peanuts?|almonds?|cashews?|nuts?)\b/i);
  await expect(page.getByTestId("result-card").first()).toBeVisible();
  await chip.getByRole("button", { name: /Remove/ }).click();
  await expect(
    page.getByTestId("constraint-chip").filter({ hasText: /nut-free/ }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Filters applied from your constraints"),
  ).toHaveCount(0);
});

test("X3a site cart edit appears in the chat activity (live, no reload) @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid);
  await page.goto("/shop/cart?view=split");
  await expect(page.getByTestId("cart-count")).toHaveText("0");
  await api(request, sid).add(p.product_id, 1); // another channel writes the session
  await expect(page.getByTestId("cart-count")).toHaveText("1");
  await page
    .getByRole("main", { name: "Storefront" })
    .getByRole("button", { name: /^Remove (?!constraint)/ })
    .first()
    .click();
  await expect(page.getByTestId("cart-count")).toHaveText("0");
  await expect(page.getByTestId("site-activity")).toContainText(/removed/i);
  const s = await api(request, sid).session();
  expect(
    s.activity.some((a: any) => a.actor === "site" && a.kind === "cart_remove"),
  ).toBeTruthy();
});

test("X3b the agent's next turn knows about a site removal and re-plans @agent @llm", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const sid = await freshSession(page);
  const p = await inStockProduct(request, sid, "paper towels");
  await api(request, sid).add(p.product_id, 1);
  await page.goto("/shop/cart?view=split");
  await expect(page.getByTestId("cart-count")).toHaveText("1");
  await page
    .getByRole("main", { name: "Storefront" })
    .getByRole("button", { name: /^Remove (?!constraint)/ })
    .first()
    .click();
  await expect(page.getByTestId("cart-count")).toHaveText("0");
  await chat(
    page,
    "Did I change anything in my cart on the website? Answer in one sentence, and tell me what is in the cart now.",
  );
  const chatPane = page.getByRole("complementary", { name: "Compass chat" });
  // Only the agent's reply to THIS question counts (the activity strip above the chat also says "removed").
  const reply = async () => {
    const t = await chatPane.innerText();
    const i = t.lastIndexOf("Did I change anything in my cart");
    return i < 0 ? "" : t.slice(i + 60);
  };
  // The answer streams live now; the Critic's verdict is a badge on it, no longer a line of chat text.
  await waitTurnDone(page);
  await expect
    .poll(
      async () =>
        /(removed|took out|empty|no items|nothing in)/i.test(await reply()),
      { timeout: 60_000, intervals: [2000] },
    )
    .toBe(true);
});
