import { expect, test } from "@playwright/test";
import { api, freshSession } from "./helpers";

test("O1 operator sees and resolves a zero-result record @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  const q = `oat milk triage ${Date.now()}`;
  const r = await api(request, sid).search(q, { brands: ["Zzznobrand"] });
  expect(r.search.zero_result?.triage_id).toBeTruthy();
  await page.goto("/triage");
  const row = page.getByTestId("triage-row").filter({ hasText: q });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Zzznobrand");
  await row.getByRole("button", { name: /Acknowledge/ }).click();
  await page.getByRole("radio", { name: "Show all" }).click();
  const row2 = page.getByTestId("triage-row").filter({ hasText: q });
  await expect(row2).toContainText("acknowledged");
  await row2.getByRole("button", { name: /Resolve/ }).click();
  await expect(row2).toContainText("resolved");
});
