import { expect, test } from "@playwright/test";
import { api, freshSession } from "./helpers";

test("M1 sponsored listings are labelled and capped at 1 per 8 @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  let found: string | null = null;
  for (const q of [
    "coffee",
    "dog treats",
    "diapers",
    "snacks",
    "shampoo",
    "phone case",
  ]) {
    const r = await api(request, sid).search(q);
    const res = r.search.results;
    const sp = res.filter((x: any) => x.sponsored);
    expect(sp.length).toBeLessThanOrEqual(
      Math.max(1, Math.ceil(res.length / 8)),
    );
    for (const x of sp) expect(x.label).toBe("Sponsored");
    if (sp.length && !found) found = q;
  }
  test.skip(!found, "no sponsored listing in these live results");
  await page.goto(`/shop/search?q=${encodeURIComponent(found!)}`);
  await expect(
    page.getByTestId("result-card").filter({ hasText: "Sponsored" }).first(),
  ).toBeVisible();
});
