import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  chatRegion,
  freshSession,
  inStockProduct,
  placeOrder,
} from "./helpers";

/** Site / Chat / Split at desktop and 390px, light and dark, into docs/ui/. */
const dir = resolve(process.cwd(), "../docs/ui");
for (const theme of ["light", "dark"] as const)
  for (const [label, vp] of [
    ["desktop", { width: 1440, height: 900 }],
    ["390", { width: 390, height: 844 }],
  ] as const)
    for (const view of ["site", "chat", "split"] as const)
      test(`SHOT ${view} ${label} ${theme} @nollm`, async ({ page }) => {
        mkdirSync(dir, { recursive: true });
        await freshSession(page, theme);
        await page.setViewportSize(vp);
        await page.goto(`/shop/search?q=peanut%20butter&view=${view}`);
        if (view !== "chat")
          await expect(page.getByTestId("result-card").first()).toBeVisible({
            timeout: 30_000,
          });
        else
          await expect(
            page.getByRole("main", { name: "Compass chat" }),
          ).toBeVisible();
        await page.waitForTimeout(800);
        await page.screenshot({
          path: resolve(dir, `store_${view}_${label}_${theme}.png`),
        });
      });

/** Wave 0b chat chrome: Chat and Split at desktop and 390px, light and dark, with a live approval card. */
for (const theme of ["light", "dark"] as const)
  for (const [label, vp] of [
    ["desktop", { width: 1440, height: 900 }],
    ["390", { width: 390, height: 844 }],
  ] as const)
    for (const view of ["chat", "split"] as const)
      test(`SHOT chat ${view} ${label} ${theme} @nollm`, async ({
        page,
        request,
      }) => {
        mkdirSync(dir, { recursive: true });
        const sid = await freshSession(page, theme);
        const p = await inStockProduct(request, sid);
        await placeOrder(request, sid, p.product_id, 1);
        await request.post(`/api/session/${sid}/reorder`);
        await page.setViewportSize(vp);
        await page.goto(`/shop?view=${view}`);
        if (label === "390" && view === "split")
          await page.getByRole("tab", { name: "Chat" }).click();
        await expect(
          chatRegion(page).getByTestId("approval-card").first(),
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          chatRegion(page).getByTestId("prompt-starter").first(),
        ).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(800);
        await page.screenshot({
          path: resolve(dir, `chat_${view}_${label}_${theme}.png`),
        });
      });
