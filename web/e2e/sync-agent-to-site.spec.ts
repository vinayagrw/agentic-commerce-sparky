import { expect, test } from "@playwright/test";
import {
  api,
  approveProposals,
  chat,
  freshSession,
  logTurnCost,
} from "./helpers";

/** @agent: a real Claude CLI turn through policy-mcp -> shop tools. Slow by nature. */
test("X1+X2+A2 chat search navigates the site and highlights; chat cart add updates the site live @agent @llm", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const sid = await freshSession(page);
  await page.goto("/shop?view=split");
  await expect(page.getByTestId("cart-count")).toHaveText("0");
  await chat(
    page,
    "Search for creamy peanut butter and add the cheapest in-stock jar to my cart, quantity 1. Do not ask me to confirm.",
  );
  // X1: the site pane follows the agent's search, marks its picks
  await expect(page).toHaveURL(/\/shop\/search\?q=/, { timeout: 240_000 });
  await expect(
    page.getByTestId("highlight-found-by-sparky").first(),
  ).toBeVisible({ timeout: 30_000 });
  // Wave 0b HITL: the agent's add is a proposal; nothing reaches the cart until the shopper approves.
  await approveProposals(page);
  // X2 + A2: the approved agent cart add reaches the site without reload and is announced politely
  await expect(page.getByTestId("cart-count")).toHaveText("1", {
    timeout: 240_000,
  });
  await expect(
    page
      .locator('[aria-live="polite"]')
      .filter({ hasText: /Compass (added|searched)/ })
      .first(),
  ).toBeAttached();
  const s = await api(request, sid).session();
  expect(s.last_search.actor).toBe("agent");
  expect(
    s.activity.some((a: any) => a.actor === "agent" && a.kind === "cart_add"),
  ).toBeTruthy();
  expect(s.audit.map((a: any) => a.event)).toEqual(
    expect.arrayContaining(["proposed", "approved"]),
  );
  await logTurnCost(page, "X1+X2");
});
