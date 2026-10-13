import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { CHAT_REGION_LABEL } from "@sparky/shared";

/** Each test gets its own shared session (the chat thread id and the site session are the same id). */
export async function freshSession(
  page: Page,
  theme: "light" | "dark" = "light",
) {
  const sid = crypto.randomUUID();
  await page.addInitScript(
    ([s, t]) => {
      try {
        localStorage.setItem("sparky.session", s);
        localStorage.setItem("sparky.theme", t);
      } catch {
        /* storage blocked */
      }
    },
    [sid, theme],
  );
  return sid;
}

export const api = (request: APIRequestContext, sid: string) => ({
  add: (product_id: string, qty = 1) =>
    request.post(`/api/session/${sid}/cart/items`, {
      data: { product_id, qty },
    }),
  constraint: (key: string, value: string) =>
    request.post(`/api/session/${sid}/constraints`, { data: { key, value } }),
  search: (query: string, filters: Record<string, unknown> = {}) =>
    request
      .post(`/api/session/${sid}/search`, { data: { query, filters } })
      .then((r) => r.json()),
  session: () => request.get(`/api/session/${sid}`).then((r) => r.json()),
});

/** A real product id from the live catalogue that is in stock at the store. */
export async function inStockProduct(
  request: APIRequestContext,
  sid: string,
  query = "peanut butter",
) {
  const r = await api(request, sid).search(query, { in_stock: true });
  const hit = r.search.results.find(
    (x: any) => x.in_stock && !x.age_restricted,
  );
  expect(hit, `an in-stock result for ${query}`).toBeTruthy();
  return hit as { product_id: string; title: string; price: number };
}

export async function search(page: Page, q: string) {
  const box = page.getByTestId("search-input");
  await box.fill(q);
  await box.press("Enter");
}

export async function expectNoSeriousA11y(page: Page, include?: string) {
  const b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
  if (include) b.include(include);
  const r = await b.analyze();
  // CopilotKit's default chat chrome (icon-only buttons without names) was replaced by our own in Wave 0b: no filter.
  const bad = r.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    bad.map((v) => `${v.id}: ${v.nodes.length} node(s) ${v.nodes[0]?.target}`),
  ).toEqual([]);
}

/** Send a chat message through the Compass composer (first textbox) in the visible chat region. */
export async function chat(page: Page, text: string) {
  const input = page
    .getByRole("complementary", { name: CHAT_REGION_LABEL })
    .or(page.getByRole("main", { name: CHAT_REGION_LABEL }))
    .getByRole("textbox")
    .first();
  await input.fill(text);
  await input.press("Enter");
}

/** The chat region in whichever layout is showing. */
export const chatRegion = (page: Page) =>
  page
    .getByRole("complementary", { name: CHAT_REGION_LABEL })
    .or(page.getByRole("main", { name: CHAT_REGION_LABEL }));

/** HITL: approve every pending Compass proposal as it appears (agent cart changes wait for the shopper). */
export async function approveProposals(page: Page, timeout = 240_000) {
  const btn = chatRegion(page)
    .getByTestId("approval-card")
    .getByRole("button", { name: /^Approve/ })
    .first();
  await btn.waitFor({ timeout });
  await btn.click();
}

/** Log the real cost of the Claude turn(s) in this session into the spec output. */
export async function logTurnCost(page: Page, label: string) {
  await waitTurnDone(page);
  const costs = await chatRegion(page)
    .getByTestId("run-cost")
    .allInnerTexts()
    .catch(() => []);
  const note = `${label}: per-turn Claude cost ${costs.map((c) => c.replace(/^·\s*/, "")).join(", ") || "n/a"}`;
  test.info().annotations.push({ type: "cost", description: note });
  console.log(`[cost] ${note}`);
}

/** Wait until the current Compass turn has finished streaming (stop button gone, cost known). */
export async function waitTurnDone(page: Page, timeout = 280_000) {
  const region = chatRegion(page);
  await expect(region.getByTestId("run-timeline").last()).toBeVisible({
    timeout,
  });
  await expect(region.getByTestId("stop-button")).toHaveCount(0, { timeout });
  await expect(region.getByTestId("run-cost").last()).not.toHaveText(
    /pending/,
    { timeout: 30_000 },
  );
}

/** One screenshot per capability into docs/ui/. */
export async function capShot(page: Page, name: string) {
  const { mkdirSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const dir = resolve(process.cwd(), "../docs/ui");
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(dir, `cap_${name}.png`) });
}

/** A past order in this session, created through the real mandate -> approve -> order flow. */
export async function placeOrder(
  request: APIRequestContext,
  sid: string,
  productId: string,
  qty = 1,
) {
  await api(request, sid).add(productId, qty);
  const m = await request.post(`/api/session/${sid}/checkout/mandate`, {
    data: { spend_cap: 500 },
  });
  expect(m.ok(), await m.text()).toBeTruthy();
  const mandate = (await m.json()).mandate;
  const d = await request.post(`/api/session/${sid}/checkout/decision`, {
    data: { mandate_id: mandate.mandate_id, approved: true },
  });
  expect(d.ok(), await d.text()).toBeTruthy();
}

/* ---------------- B16 shopper accounts, wallet, tender ---------------- */

/** Bind a session to a synthetic shopper persona (acct_maya | acct_dev | acct_rosa). */
export async function useAccount(
  request: APIRequestContext,
  sid: string,
  accountId: string | null,
) {
  const r = await request.put(`/api/session/${sid}/account`, {
    data: { account_id: accountId },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).account as {
    account_id: string;
    name: string;
  } | null;
}

/**
 * A past order paid with a named demo instrument, through the real flow:
 *   tender -> mandate(tender + tender_hash) -> approve -> authorize -> confirm.
 * The session must already be bound to the account that owns `pmId` (see `useAccount`).
 * `placeOrder()` (the guest path) is deliberately left untouched.
 */
export async function placeOrderWithCard(
  request: APIRequestContext,
  sid: string,
  productId: string,
  pmId: string,
  qty = 1,
) {
  await api(request, sid).add(productId, qty);
  const adrRes = await request.get(`/api/session/${sid}/addresses`);
  expect(adrRes.ok(), await adrRes.text()).toBeTruthy();
  const addresses = (await adrRes.json()).addresses as {
    address_id: string;
    is_default: boolean;
  }[];
  const address_id = (addresses.find((a) => a.is_default) ?? addresses[0])
    ?.address_id;

  const tr = await request.post(`/api/session/${sid}/checkout/tender`, {
    data: { pm_ids: [pmId] },
  });
  expect(tr.ok(), await tr.text()).toBeTruthy();
  const tender = (await tr.json()).tender as {
    plan: { pm_id: string; amount: number }[];
    tender_hash: string;
    ok: boolean;
  };
  expect(tender.ok, `tender plan for ${pmId} is complete`).toBeTruthy();

  const mr = await request.post(`/api/session/${sid}/checkout/mandate`, {
    data: {
      spend_cap: 500,
      address_id,
      tender: tender.plan.map((l) => ({ pm_id: l.pm_id, amount: l.amount })),
      tender_hash: tender.tender_hash,
    },
  });
  expect(mr.ok(), await mr.text()).toBeTruthy();
  const mandate_id = (await mr.json()).mandate.mandate_id as string;

  // The order is refused until a simulated authorisation exists, and the authorisation is refused
  // until the shopper has approved: record the approval first, then authorise, then confirm.
  await request.post(`/api/session/${sid}/checkout/decision`, {
    data: { mandate_id, approved: true },
  });
  const ar = await request.post(`/api/session/${sid}/checkout/authorize`, {
    data: { mandate_id },
  });
  expect(ar.ok(), await ar.text()).toBeTruthy();
  const auth = await ar.json();
  expect(auth.decision, `simulated authorisation for ${pmId}`).toBe("approved");

  const cr = await request.post(`/api/session/${sid}/checkout/decision`, {
    data: { mandate_id, approved: true },
  });
  expect(cr.ok(), await cr.text()).toBeTruthy();
  const order = (await cr.json()).order as { order_id: string; total: number };
  expect(order?.order_id, "an order was confirmed").toBeTruthy();
  return { order, mandate_id, auth_ref: auth.auth_ref as string };
}

/** An in-stock, non-age-restricted, SNAP-eligible product id (for EBT tender specs). */
export async function snapProduct(
  request: APIRequestContext,
  sid: string,
  query = "cereal",
) {
  const r = await api(request, sid).search(query, { in_stock: true });
  const hit = r.search.results.find(
    (x: any) => x.in_stock && x.snap_eligible && !x.age_restricted,
  );
  expect(hit, `a SNAP-eligible in-stock result for ${query}`).toBeTruthy();
  return hit as { product_id: string; title: string; price: number };
}

/** An in-stock product that SNAP does NOT cover (for the EBT refusal spec). */
export async function nonSnapProduct(
  request: APIRequestContext,
  sid: string,
  query = "vitamins",
) {
  const r = await api(request, sid).search(query, { in_stock: true });
  const hit = r.search.results.find(
    (x: any) => x.in_stock && x.snap_eligible === false && !x.age_restricted,
  );
  expect(hit, `an in-stock non-SNAP result for ${query}`).toBeTruthy();
  return hit as { product_id: string; title: string; price: number };
}
