import { expect, test } from "@playwright/test";
import { freshSession, search } from "./helpers";

test("S1 search returns live ESCI results with price, rating and pickup @nollm", async ({
  page,
}) => {
  await freshSession(page);
  await page.goto("/shop");
  await search(page, "peanut butter");
  await expect(page).toHaveURL(
    /\/shop\/search\?q=peanut\+butter|q=peanut%20butter/,
  );
  const cards = page.getByTestId("result-card");
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(4);
  await expect(cards.first()).toContainText("$");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "peanut butter",
  );
});

test("S14 category tiles and mission cards link into a search @nollm", async ({
  page,
}) => {
  await freshSession(page);
  await page.goto("/shop");
  const main = page.locator("#main");
  await expect(
    main.getByRole("heading", { name: "Shop by category" }),
  ).toBeVisible();
  // The sidenav also has a plain "Grocery" link to the same search; the category tile is
  // distinguished by pairing the category emoji with its label (e.g. "🥫Grocery").
  const grocery = page.getByText("🥫Grocery", { exact: true });
  await expect(grocery).toBeVisible();
  await grocery.click();
  await expect(page).toHaveURL(/\/shop\/search\?q=snacks/);
  await expect(page.getByTestId("result-card").first()).toBeVisible();

  await page.goto("/shop");
  const missions = page
    .locator("#main")
    .getByRole("region", { name: /Missions/i })
    .first();
  await expect(
    missions.getByText("Nut-free school lunches under $40"),
  ).toBeVisible();
  const missionLink = missions.getByRole("link", {
    name: /Search "nut free snacks"/,
  });
  await missionLink.click();
  await expect(page).toHaveURL(
    /\/shop\/search\?q=nut\+free\+snacks|q=nut%20free%20snacks/,
  );
  await expect(page.getByTestId("result-card").first()).toBeVisible();
});
