import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  capShot,
  chat,
  chatRegion,
  freshSession,
  logTurnCost,
  waitTurnDone,
} from "./helpers";

/** AI1 + chat controls: visible run timeline, feedback -> online-eval sample, edit + regenerate, stop. @agent */
test("AI1 run timeline shows steps, tool calls, critic, latency, cost and links to replay; feedback is persisted @agent @llm", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const sid = await freshSession(page);
  await page.goto("/shop?view=chat");
  const region = chatRegion(page);
  await chat(
    page,
    "Search for gluten free pasta and tell me the two cheapest in-stock options. Do not add anything to my cart.",
  );
  await expect(
    region
      .getByTestId("streaming-skeleton")
      .or(region.getByTestId("msg-assistant"))
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  await waitTurnDone(page);
  await logTurnCost(page, "AI1 turn 1");
  const tl = region.getByTestId("run-timeline").last();
  await tl.getByRole("button", { name: /How Compass worked/ }).click();
  await expect(tl.getByRole("list", { name: "Plan steps" })).toContainText(
    /Planner/,
  );
  await expect(tl.getByTestId("timeline-tool").first()).toContainText(
    /search_products/,
  );
  await expect(tl.getByTestId("critic-verdict")).toBeVisible();
  await expect(tl.getByTestId("run-cost")).toHaveText(/\$\d/);
  const replay = tl.getByRole("link", { name: /operator replay/ });
  await expect(replay).toHaveAttribute("href", /^\/ops\/replay\/.+/);
  await capShot(page, "1_timeline");

  // 👎 with a reason -> an online-eval sample (technique 29) on disk
  const fb = region.getByTestId("feedback").last();
  await fb.getByRole("button", { name: "Not helpful" }).click();
  await fb.getByRole("button", { name: "Not grounded" }).click();
  await expect(fb.getByTestId("feedback-saved")).toBeVisible();
  const lines = readFileSync(
    resolve(process.cwd(), "../data/online_feedback.jsonl"),
    "utf-8",
  )
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const mine = lines.filter((l) => l.session_id === sid);
  expect(mine.at(-1)).toMatchObject({
    technique: 29,
    label: 0,
    reason: "Not grounded",
  });

  // edit last message + regenerate: the user message is replaced, not duplicated
  await region.getByRole("button", { name: "Edit last message" }).click();
  const box = region.getByRole("textbox").first();
  await expect(box).toHaveValue(/gluten free pasta/);
  await box.fill(
    "Search for whole wheat pasta and tell me the cheapest in-stock option. Do not add anything to my cart.",
  );
  await box.press("Enter");
  await expect(region.getByTestId("msg-user")).toHaveCount(1);
  await expect(region.getByTestId("msg-user")).toContainText(/whole wheat/);
  await waitTurnDone(page);
  await logTurnCost(page, "AI1 edited turn");

  // stop generation mid-run
  await chat(page, "Search for organic peanut butter and compare three jars.");
  await region.getByTestId("stop-button").click({ timeout: 30_000 });
  await expect(region.getByTestId("stop-button")).toHaveCount(0);
  await expect(
    region.getByRole("button", { name: "Send message" }),
  ).toBeVisible();
});
