import { expect, test } from "@playwright/test";
import { api, capShot, chat, chatRegion, freshSession } from "./helpers";

test("AI8 memory panel: add, edit, delete with source and date; nothing stored without the shopper @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await page.goto("/shop?view=chat");
  await chatRegion(page).getByTestId("open-memory").click();
  const dlg = page.getByRole("dialog", { name: "What Compass remembers" });
  await dlg
    .getByRole("combobox", { name: "Type" })
    .selectOption("household_size");
  await dlg.getByRole("textbox", { name: "Value" }).fill("4");
  await dlg.getByRole("button", { name: "Remember this" }).click();
  const item = dlg.getByTestId("memory-item").first();
  await expect(item).toHaveAttribute("data-status", "confirmed");
  await expect(item).toContainText(/memory panel/);
  await item.getByRole("button", { name: /Edit memory/ }).click();
  await item.getByRole("textbox").fill("5");
  await item.getByRole("button", { name: "Save" }).click();
  await expect(dlg.getByTestId("memory-item").first()).toContainText("5");
  expect((await api(request, sid).session()).memory[0]).toMatchObject({
    key: "household_size",
    value: "5",
    status: "confirmed",
  });
  await capShot(page, "8_memory");
  await dlg.getByRole("button", { name: /Delete memory/ }).click();
  await expect(dlg.getByTestId("memory-item")).toHaveCount(0);
  const bad = await request.post(`/api/session/${sid}/memory`, {
    data: { key: "household_size", value: "lots" },
  });
  expect(bad.status()).toBe(400);
});

test("AI8 a dietary need said in chat is quarantined until confirmed @agent @llm", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const sid = await freshSession(page);
  await page.goto("/shop?view=chat");
  await chat(page, "I need nut-free snacks for my kids.");
  const region = chatRegion(page);
  await expect(region.getByTestId("open-memory")).toContainText(
    "1 to confirm",
    { timeout: 30_000 },
  );
  // the inference exists before the turn finishes; stopping the run keeps this spec cheap
  await region.getByTestId("stop-button").click();
  const s0 = await api(request, sid).session();
  expect(s0.memory[0]).toMatchObject({
    key: "dietary",
    value: "nut-free",
    status: "quarantined",
    origin: "inferred",
  });
  await region.getByTestId("open-memory").click();
  const dlg = page.getByRole("dialog", { name: "What Compass remembers" });
  await expect(dlg.getByTestId("memory-item").first()).toContainText(
    /Not saved: needs your confirmation/,
  );
  await dlg.getByRole("button", { name: /Confirm memory/ }).click();
  await expect(dlg.getByTestId("memory-item").first()).toHaveAttribute(
    "data-status",
    "confirmed",
  );
});
