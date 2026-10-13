import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  approveProposals,
  chat,
  freshSession,
  logTurnCost,
  search,
} from "./helpers";

/**
 * Full split-view run, recorded as video into docs/recording/ with a RECORDED label and timestamp.
 * Live services, real agent turn. Run: npx playwright test recording --workers 1
 */
test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

test("REC full split-view run: site search, agent search + add, site removal, checkout @agent @llm", async ({
  page,
}, info) => {
  test.setTimeout(420_000);
  await freshSession(page);
  await page.goto("/shop?view=split");
  await search(page, "gluten free pasta");
  await expect(page.getByTestId("result-card").first()).toBeVisible();
  await page
    .getByTestId("result-card")
    .first()
    .getByRole("link")
    .first()
    .click();
  await expect(page.getByTestId("pdp-trust-tier").first()).toBeVisible();
  await page.getByTestId("add-to-cart").first().click();
  await expect(page.getByTestId("cart-count")).toHaveText("1");
  await chat(
    page,
    "Search for creamy peanut butter and add the cheapest in-stock jar to my cart, quantity 1. Do not ask me to confirm.",
  );
  await expect(
    page.getByTestId("highlight-found-by-sparky").first(),
  ).toBeVisible({ timeout: 240_000 });
  await approveProposals(page);
  await expect(page.getByTestId("cart-count")).toHaveText("2", {
    timeout: 240_000,
  });
  await logTurnCost(page, "REC");
  await page.waitForTimeout(3000);
  await page.goto("/shop/cart?view=split");
  await page
    .getByRole("main", { name: "Storefront" })
    .getByRole("button", { name: /^Remove (?!constraint)/ })
    .first()
    .click();
  await expect(page.getByTestId("cart-count")).toHaveText("1");
  await page.goto("/shop/checkout?view=split");
  await expect(page.getByTestId("no-payment-note")).toBeVisible();
  await page.getByRole("spinbutton", { name: "Spend cap (USD)" }).fill("100");
  await page.getByRole("button", { name: "Create signed mandate" }).click();
  await expect(page.getByTestId("mandate-signature")).toBeVisible();
  await page.waitForTimeout(2500);
  const video = page.video();
  await page.close();
  const src = await video!.path();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = resolve(process.cwd(), "../docs/recording");
  mkdirSync(dir, { recursive: true });
  const out = resolve(dir, `RECORDED_${stamp}_split-view-full-run.webm`);
  copyFileSync(src, out);
  writeFileSync(
    resolve(dir, `RECORDED_${stamp}_split-view-full-run.txt`),
    `RECORDED ${new Date().toISOString()}\nPlaywright video of a live split-view run (web ${info.project.use.baseURL}); live search-svc, shop-http, bff and a real Claude CLI agent turn.\nSteps: site search -> PDP -> add on site -> chat asks agent to search + add (site navigates, highlights, cart updates) -> remove on site -> checkout mandate (no payment).\n`,
  );
});
