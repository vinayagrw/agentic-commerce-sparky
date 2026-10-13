import { expect, test } from "@playwright/test";
import { freshSession } from "./helpers";

test("C1 layout toggle: buttons, Alt shortcuts and URL param @nollm", async ({
  page,
}) => {
  await freshSession(page);
  await page.goto("/shop");
  await page.getByTestId("view-toggle-chat").click();
  await expect(page).toHaveURL(/view=chat/);
  await expect(page.getByRole("main", { name: "Compass chat" })).toBeVisible();
  await page.keyboard.press("Alt+3");
  await expect(page).toHaveURL(/view=split/);
  await expect(
    page.getByRole("complementary", { name: "Compass chat" }),
  ).toBeVisible();
  await page.keyboard.press("Alt+1");
  await expect(page).toHaveURL(/view=site/);
  await expect(page.getByRole("button", { name: "Ask Compass" })).toBeVisible();
});

test("X5 split divider resizes by keyboard; 390px stacks with tabs @nollm", async ({
  page,
}) => {
  await freshSession(page);
  await page.goto("/shop?view=split");
  const sep = page.getByRole("separator", { name: "Resize store and chat" });
  const before = Number(await sep.getAttribute("aria-valuenow"));
  await sep.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => Number(await sep.getAttribute("aria-valuenow")))
    .toBeLessThan(before);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tab", { name: /Chat/ })).toBeVisible();
  await page.getByRole("tab", { name: /Chat/ }).click();
  await expect(
    page.getByRole("complementary", { name: "Compass chat" }),
  ).toBeVisible();
});
