import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "@sparky/shared";
import { deterministicCritic, mergeVerdicts, parseJsonObject, applyPlannerLedger, rolesFor } from "./roles.js";
import { buildArgs } from "../llm/claudeCode.js";
import { policyMcpConfig, POLICY_TOOLS } from "./mcpConfig.js";

test("lean CLI args: no built-in tools, custom system prompt, strict MCP", () => {
  const a = buildArgs({ model: "haiku", systemPrompt: "Be brief.", tools: "", maxTurns: 1 });
  const i = a.indexOf("--tools");
  assert.ok(i >= 0 && a[i + 1] === "");
  assert.equal(a[a.indexOf("--system-prompt") + 1], "Be brief.");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(a[a.indexOf("--model") + 1], "haiku");
  const b = buildArgs({ mcpConfigPath: "/tmp/x.json", allowedTools: ["mcp__policy__*"] });
  assert.equal(b[b.indexOf("--mcp-config") + 1], "/tmp/x.json");
  assert.equal(b[b.indexOf("--allowedTools") + 1], "mcp__policy__*");
});

test("roles: checkout replaces shopper on beat 4 at T2", () => {
  const r = rolesFor(4).map((x) => `${x.name}:${x.tier}`);
  assert.deepEqual(r, ["Planner:T1", "Checkout:T2", "Critic:T1", "Guard:—"]);
});

test("critic fails over-budget and over-qty carts", () => {
  const s = emptyState(1);
  s.budget = 10;
  s.cart = [{ product_id: "a", title: "Beef", qty: 6, price: 3 }];
  s.cart_total = 18;
  const v = deterministicCritic(s);
  assert.equal(v.verdict, "fail");
  assert.equal(v.issues.length, 2);
  const merged = mergeVerdicts(deterministicCritic({ ...s, cart: [], cart_total: 0 }), { verdict: "fail", issues: ["no GF tortillas"], omissions: [], note: "x" });
  assert.equal(merged.verdict, "fail");
});

test("planner JSON parsing tolerates fences and merges ledger", () => {
  const p = parseJsonObject<any>('```json\n{"steps":["a"],"constraints":[{"key":"headcount","value":"6 people"}],"budget":40}\n```');
  assert.equal(p.budget, 40);
  const s = emptyState(1);
  applyPlannerLedger(s, p);
  assert.equal(s.budget, 40);
  assert.equal(s.constraints[0].key, "headcount");
  assert.equal(parseJsonObject("no json"), null);
});

test("the CLI is given policy-mcp and nothing else, in a named role", () => {
  assert.deepEqual(POLICY_TOOLS, ["mcp__policy__*"], "one server, one tool prefix");
  const cfg = policyMcpConfig("checkout");
  assert.deepEqual(Object.keys(cfg.mcpServers), ["policy"], "shop-mcp and ops-mcp are never handed to the CLI");
  assert.equal(cfg.mcpServers.policy.args.at(-1), "policy-mcp");
  assert.equal(cfg.mcpServers.policy.env.POLICY_ROLE, "checkout");
  assert.equal(policyMcpConfig("shopper").mcpServers.policy.env.POLICY_ROLE, "shopper");
});
