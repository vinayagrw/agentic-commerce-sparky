import { expect, test } from "@playwright/test";
import { api, chat, freshSession } from "./helpers";

test("C2+C3 nut-free stated in chat becomes a chip with provenance and a could-not-do entry @agent @llm", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const sid = await freshSession(page);
  await page.goto("/shop?view=chat");
  await chat(
    page,
    "I need nut-free granola bars for school lunches. Add one box to my cart.",
  );
  const chip = page
    .getByTestId("constraint-chip")
    .filter({ hasText: /nut-free/ })
    .first();
  await expect(chip).toBeVisible({ timeout: 60_000 });
  const s0 = await api(request, sid).session();
  const c = s0.constraints.find((x: any) => x.value === "nut-free");
  expect(c.source).toBe("chat");
  expect(c.source_text).toMatch(/nut-free granola/);
  // turn completes, verifier ran: nut-free can never be verified from the catalogue
  await expect(page.getByTestId("could-not-do").first()).toContainText(
    /allergen|nut/i,
    { timeout: 240_000 },
  );
  const s1 = await api(request, sid).session();
  expect(s1.could_not.some((x: any) => /nut/i.test(x.constraint))).toBeTruthy();
});
