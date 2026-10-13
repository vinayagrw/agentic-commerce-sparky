import { expect, test } from "@playwright/test";
import {
  capShot,
  chat,
  chatRegion,
  freshSession,
  logTurnCost,
  waitTurnDone,
} from "./helpers";

test("AI3 voice: unsupported browser gets a clear state; the transcript box stays editable @nollm", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Simulate a browser without the Web Speech API (headless Chromium cannot capture a microphone).
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;
  });
  await freshSession(page);
  await page.goto("/shop?view=chat");
  const region = chatRegion(page);
  await region.getByTestId("voice-button").click();
  await expect(region.getByTestId("voice-unsupported")).toContainText(
    /not supported/,
  );
  const box = region.getByRole("textbox").first();
  await box.fill("find oat milk");
  await box.fill("find unsweetened oat milk");
  await expect(box).toHaveValue("find unsweetened oat milk");
  await expect(
    region.getByRole("combobox", { name: "Voice language" }),
  ).toHaveValue("en-US");
  await region
    .getByRole("combobox", { name: "Voice language" })
    .selectOption("es-US");
  await capShot(page, "3_voice");
});

test("AI3b reply language is auto-detected: a Spanish message gets a Spanish answer @agent @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await freshSession(page);
  await page.goto("/shop?view=chat");
  await chat(
    page,
    "Hola, busca mantequilla de maní cremosa y dime cuál es la más barata. No agregues nada al carrito.",
  );
  await waitTurnDone(page);
  const answer = await chatRegion(page)
    .getByTestId("msg-assistant")
    .last()
    .innerText();
  expect(answer).toMatch(/\b(la|el|más|barat[ao]|precio|disponible|tienda)\b/i);
  await logTurnCost(page, "AI3b Spanish");
});
