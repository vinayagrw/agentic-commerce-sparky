/**
 * GET /api/diag: the health gate.
 *
 * The web app calls this on load and before every run. Each entry says whether that
 * dependency is available and, when it is not, carries the name, port and fix command the
 * red banner shows. `outagesFor(plane)` is what the run path uses to refuse: there is no
 * substitute path left, so a missing service stops the beat instead of quietly replacing it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Plane, ServiceOutage } from "@sparky/shared";
import { SERVICES } from "@sparky/shared";
import { config } from "./config.js";
import { jfetch } from "./lib/http.js";
import { McpStdioClient } from "./lib/mcpStdio.js";

function run(bin: string, args: string[], ms: number, stdin?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve({ code, out, err });
    };
    let child;
    try {
      child = spawn(bin, args, { shell: true, env: { ...process.env, ENABLE_TOOL_SEARCH: "false" } });
    } catch (e) {
      return resolve({ code: null, out, err: String(e) });
    }
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish(null);
    }, ms);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) => {
      err += String(e);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

/** Start policy-mcp for one role and list what it exposes. Proves the proxy runs AND that
 *  the capability policy is applied server-side (a shopper role must not see ops tools). */
async function probePolicyMcp(role: "shopper" | "ops", ms = 45_000): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  if (!existsSync(join(config.policyMcpDir, "pyproject.toml"))) return { ok: false, tools: [], error: `not found: ${config.policyMcpDir}` };
  const client = new McpStdioClient(
    {
      command: "uv",
      args: ["--directory", config.policyMcpDir, "run", "policy-mcp"],
      env: { POLICY_ROLE: role, SEARCH_SVC_URL: config.searchSvcUrl, OPS_HTTP_URL: config.opsHttpUrl, POLICY_EVENTS_PATH: config.policyEventsPath },
    },
    ms,
  );
  try {
    await client.start();
    const tools = (await client.listTools()).map((t) => t.name);
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, tools: [], error: `${String((e as Error).message)} ${client.stderr.slice(-200)}`.trim() };
  } finally {
    client.stop();
  }
}

let policyCache: { at: number; shopper: Awaited<ReturnType<typeof probePolicyMcp>>; ops: Awaited<ReturnType<typeof probePolicyMcp>> } | null = null;
/**
 * Whether a `claude -p --output-format json` probe succeeded. Finds the result line rather than
 * assuming it is the last one: CLI 2.1.246 prints a diagnostic line ("Client.listTools() called but
 * server does not advertise tools capability…") AFTER the JSON result, which made a healthy,
 * logged-in CLI read as down and locked every @llm beat.
 */
export function authProbeOk(stdout: string, code: number | null): boolean {
  const result = stdout
    .trim()
    .split("\n")
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((j) => j && typeof j === "object" && j.type === "result");
  return code === 0 && Boolean(result) && result.is_error !== true;
}

let authCache: { at: number; ok: boolean; detail: string } | null = null;
let binCache: { at: number; ver: { code: number | null; out: string; err: string }; uv: { code: number | null; out: string; err: string } } | null = null;

export type Diag = Awaited<ReturnType<typeof diag>>;

export async function diag(fresh = false) {
  const wantPolicy = fresh || !policyCache || Date.now() - policyCache.at > 10 * 60_000;
  const policyP = wantPolicy
    ? Promise.all([probePolicyMcp("shopper"), probePolicyMcp("ops")]).then(([shopper, ops]) => ({ at: Date.now(), shopper, ops }))
    : Promise.resolve(policyCache!);

  // Binary probes (~7 s of node/uv start-up) are cached for 5 min once they succeed; service health stays live.
  const binFresh = fresh || !binCache || Date.now() - binCache.at > 5 * 60_000;
  const [ver, uv, search, shop, opsHttp, policy] = await Promise.all([
    binFresh ? run(config.claudeBin, ["--version"], 8000) : Promise.resolve(binCache!.ver),
    binFresh ? run("uv", ["--version"], 5000) : Promise.resolve(binCache!.uv),
    jfetch(`${config.searchSvcUrl}/health`, { timeoutMs: 2000 }),
    jfetch(`${config.shopHttpUrl}/health`, { timeoutMs: 2000 }),
    jfetch(`${config.opsHttpUrl}/health`, { timeoutMs: 2000 }),
    policyP,
  ]);
  if (policy.shopper.ok || policy.ops.ok) policyCache = policy;
  if (binFresh && ver.code === 0 && uv.code === 0) binCache = { at: Date.now(), ver, uv };

  const claudeFound = ver.code === 0;
  if (claudeFound && (fresh || !authCache || Date.now() - authCache.at > 10 * 60_000)) {
    const a = await run(config.claudeBin, ["-p", "--max-turns", "1", "--output-format", "json"], 60_000, "ok");
    const ok = authProbeOk(a.out, a.code);
    authCache = { at: Date.now(), ok, detail: ok ? "claude -p ok" : (a.err || a.out).trim().slice(-200) };
  }

  const claude = { found: claudeFound, version: ver.out.trim() || null, authenticated: claudeFound ? authCache?.ok ?? false : false, authDetail: authCache?.detail ?? null };

  return {
    live: claude.found && claude.authenticated && search.ok && policy.shopper.ok,
    claude,
    uv: { found: uv.code === 0, version: uv.out.trim() || null },
    pathHasLocalBin: (process.env.PATH ?? "").includes(".local/bin"),
    searchSvc: { url: config.searchSvcUrl, ok: search.ok, health: search.data },
    shopHttp: { url: config.shopHttpUrl, ok: shop.ok, health: shop.data },
    opsHttp: { url: config.opsHttpUrl, ok: opsHttp.ok, health: opsHttp.data },
    policyMcp: {
      dir: config.policyMcpDir,
      ok: policy.shopper.ok,
      error: policy.shopper.error ?? policy.ops.error,
      /** The proxy is the only MCP server the CLI sees; these are the tools per role. */
      shopperTools: policy.shopper.tools,
      opsTools: policy.ops.tools,
      /** Capability policy proof: the shopper role is not given ops tools. */
      roleSeparationHolds: policy.shopper.ok && policy.ops.ok && !policy.shopper.tools.some((t) => ["promote", "build_candidate", "rollback"].includes(t)),
    },
    roles: { mode: config.roleMode, models: config.models, leanCli: config.leanCli },
  };
}

/** Services this plane cannot run without, and which of them are down right now. */
export function outagesFor(plane: Plane, d: Diag): ServiceOutage[] {
  const state: Record<string, { ok: boolean; detail?: string }> = {
    searchSvc: { ok: d.searchSvc.ok, detail: d.searchSvc.url },
    shopHttp: { ok: d.shopHttp.ok, detail: d.shopHttp.url },
    opsHttp: { ok: d.opsHttp.ok, detail: d.opsHttp.url },
    policyMcp: { ok: d.policyMcp.ok, detail: d.policyMcp.error ?? d.policyMcp.dir },
    claude: { ok: d.claude.found && d.claude.authenticated, detail: d.claude.authDetail ?? undefined },
  };
  return SERVICES.filter((s) => s.requiredFor.includes(plane) && !state[s.key]?.ok).map((s) => ({
    key: s.key,
    name: s.name,
    port: s.port,
    fix: s.fix,
    detail: state[s.key]?.detail,
  }));
}

/** One line per outage, exactly as the banner and the refusal message read. */
export function outageLine(o: ServiceOutage): string {
  return `${o.name} down${o.port ? ` on :${o.port}` : ""} — run \`${o.fix}\``;
}
