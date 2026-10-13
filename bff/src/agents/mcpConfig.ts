/**
 * The Claude CLI sees exactly one MCP server: policy-mcp.
 *
 * It proxies every shop-mcp and ops-mcp tool and applies the capability policy, the
 * deterministic guard rules and the tier limits BEFORE forwarding, so a blocked call
 * never reaches the underlying tool. Previously the CLI held shop-mcp directly and the
 * BFF could only react to a call it saw stream past.
 *
 * The role is passed as POLICY_ROLE. policy-mcp registers only the tools that role may
 * use, so `--allowedTools` is enforced server-side as well as client-side.
 */
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

export type PolicyRole = "shopper" | "checkout" | "ops";

/** Every tool the CLI may name. policy-mcp narrows this further by role. */
export const POLICY_TOOLS = ["mcp__policy__*"];

export function policyMcpAvailable(): boolean {
  return existsSync(join(config.policyMcpDir, "pyproject.toml"));
}

export function policyMcpConfig(role: PolicyRole, opts: { hitl?: boolean; tools?: string[] | null } = {}) {
  return {
    mcpServers: {
      policy: {
        command: "uv",
        args: ["--directory", config.policyMcpDir, "run", "policy-mcp"],
        env: {
          POLICY_ROLE: role,
          SEARCH_SVC_URL: config.searchSvcUrl,
          OPS_HTTP_URL: config.opsHttpUrl,
          POLICY_EVENTS_PATH: config.policyEventsPath,
          ...(opts.hitl ? { POLICY_HITL: "propose" } : {}),
          // Per-intent allow-list: policy-mcp registers ONLY these, so other tool schemas never enter the prompt.
          ...(opts.tools ? { POLICY_TOOLS_ALLOW: opts.tools.join(",") } : {}),
          ...(config.optimise.diet ? { POLICY_TRIM: "1" } : {}),
        },
      },
    },
  };
}

/** Write a per-run MCP config (mode 0600). The caller removes it. */
export function writePolicyMcpConfig(role: PolicyRole, opts: { hitl?: boolean; tools?: string[] | null } = {}): { path: string; cleanup: () => void } {
  const path = join(tmpdir(), `sparky-next-policy-mcp-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(policyMcpConfig(role, opts)), { encoding: "utf-8", mode: 0o600 });
  return {
    path,
    cleanup: () => {
      try {
        unlinkSync(path);
      } catch {
        /* gone */
      }
    },
  };
}
