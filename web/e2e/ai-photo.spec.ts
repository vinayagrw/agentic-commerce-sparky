import { expect, test } from "@playwright/test";
import { capShot, chatRegion, freshSession } from "./helpers";

/** AI2 photo -> products: Claude vision reads a real image, search-svc matches the text. @agent */
test("AI2 photo upload extracts items with Claude and matches them by text, saying so @agent @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await freshSession(page);
  await page.goto("/shop?view=chat");
  // A real PNG drawn in the browser: a labelled jar (no stock photo is bundled with the demo).
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 480;
    c.height = 480;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 480, 480);
    g.fillStyle = "#b5651d";
    g.fillRect(140, 120, 200, 280);
    g.fillStyle = "#c00";
    g.fillRect(130, 90, 220, 40);
    g.fillStyle = "#fff";
    g.fillRect(150, 200, 180, 110);
    g.fillStyle = "#000";
    g.font = "bold 28px sans-serif";
    g.fillText("PEANUT", 180, 240);
    g.fillText("BUTTER", 180, 275);
    g.font = "18px sans-serif";
    g.fillText("Creamy · 16 oz", 175, 300);
    return c.toDataURL("image/png").split(",")[1];
  });
  const region = chatRegion(page);
  await region
    .getByTestId("photo-input")
    .setInputFiles({
      name: "jar.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
  const card = region.getByTestId("photo-card");
  await expect(card.getByTestId("photo-matching-note")).toContainText(
    /Text-based matching/,
  );
  await expect(card.getByTestId("photo-item").first()).toContainText(
    /peanut butter/i,
    { timeout: 240_000 },
  );
  await expect(
    card.getByTestId("photo-item").first().getByRole("link").first(),
  ).toBeVisible();
  const cost = await card.getByTestId("photo-cost").innerText();
  expect(cost).toMatch(/synthetic commerce data/);
  test
    .info()
    .annotations.push({ type: "cost", description: `AI2 photo: ${cost}` });
  console.log(`[cost] AI2 photo: ${cost}`);
  await capShot(page, "2_photo");
});
