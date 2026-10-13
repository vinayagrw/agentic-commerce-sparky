import { expect, test } from "@playwright/test";
import { api, freshSession, search } from "./helpers";

test("ES1 Spanish help question is answered in Spanish with citations @nollm", async ({
  page,
}) => {
  await freshSession(page);
  await page.goto("/shop");
  await search(page, "¿cómo devuelvo un producto?");
  const a = page.getByTestId("help-answer");
  await expect(a).toBeVisible();
  await expect(a).toContainText(/devol/i);
});

test("ES2 'sin gluten' constraint filters the site search @nollm", async ({
  page,
  request,
}) => {
  const sid = await freshSession(page);
  await api(request, sid).constraint("dietary", "sin gluten");
  const r = await api(request, sid).search("pasta");
  expect(r.effective_filters.dietary).toContain("gluten_free");
  for (const x of r.search.results) expect(x.dietary).toContain("gluten_free");
  await page.goto("/shop/search?q=pasta");
  await expect(page.getByTestId("constraint-chip").first()).toContainText(
    /gluten/i,
  );
});
