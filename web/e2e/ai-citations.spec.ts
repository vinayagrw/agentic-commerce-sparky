import { expect, test } from "@playwright/test";
import {
  api,
  capShot,
  chat,
  chatRegion,
  freshSession,
  logTurnCost,
  waitTurnDone,
} from "./helpers";

test("AI4 citations API: tiers from the PDP attributes, T3 phrased as uncertain @nollm", async ({
  request,
}) => {
  const sid = crypto.randomUUID();
  const r = await api(request, sid).search("peanut butter");
  const pid = r.search.results.find((x: any) =>
    /peanut/i.test(x.title),
  ).product_id;
  const c = await (
    await request.get(`/api/session/${sid}/citations/${pid}`)
  ).json();
  expect(c.claims.length).toBeGreaterThan(0);
  for (const x of c.claims) {
    expect(["T1", "T2", "T3"]).toContain(x.tier);
    expect(x.href).toBe(`/shop/p/${pid}#attr-${x.attribute}`);
    if (x.tier === "T3") expect(x.text).toMatch(/^Possibly .*unverified/);
  }
});

test("AI4 grounded claim chips after a turn link to the PDP attribute with its trust tier @agent @llm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await freshSession(page);
  await page.goto("/shop?view=chat");
  await chat(
    page,
    "Find creamy peanut butter and tell me if the top result is vegan. Do not add anything to my cart.",
  );
  await waitTurnDone(page);
  await logTurnCost(page, "AI4");
  const chip = chatRegion(page).getByTestId("claim-chip").first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  expect(await chip.getAttribute("data-tier")).toMatch(/^T[123]$/);
  await capShot(page, "4_citations");
  await chip.click();
  await expect(page).toHaveURL(/\/shop\/p\/[A-Z0-9]+.*#attr-/);
  await expect(page.getByTestId("pdp-attr").first()).toBeVisible();
});
