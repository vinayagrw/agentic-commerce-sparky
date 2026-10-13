/**
 * Reader for the policy-mcp decision log.
 *
 * The Claude CLI is the MCP client for a normal run, so the BFF does not see the tool
 * call itself — only what streams past. policy-mcp appends one JSON object per decision
 * to data/policy_events.jsonl; the BFF reads the tail after a run and turns every refusal
 * into a guard event, so a block that happened inside the proxy still reaches the trace.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import type { GuardEvent } from "@sparky/shared";
import { config } from "./config.js";

export interface PolicyEvent {
  id: string;
  ts: number;
  iso: string;
  decision: "allow" | "refuse" | "quarantine";
  tool: string;
  role: string;
  session_id?: string | null;
  args?: Record<string, unknown>;
  capabilities?: Record<string, string>;
  rule?: string | null;
  reason?: string | null;
  detail?: Record<string, unknown>;
}

export function mark(): number {
  // Epoch seconds, matching the writer's time.time().
  return Date.now() / 1000;
}

export function read(opts: { sessionId?: string; since?: number; limit?: number } = {}): PolicyEvent[] {
  const p = config.policyEventsPath;
  if (!existsSync(p)) return [];
  let text: string;
  try {
    // Only read the tail: this file grows for the life of the demo.
    const size = statSync(p).size;
    text = readFileSync(p, "utf-8").slice(Math.max(0, size - 512 * 1024));
  } catch {
    return [];
  }
  const out: PolicyEvent[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev: PolicyEvent;
    try {
      ev = JSON.parse(t) as PolicyEvent;
    } catch {
      continue;
    }
    if (opts.since != null && ev.ts < opts.since) continue;
    if (opts.sessionId && ev.session_id && ev.session_id !== opts.sessionId) continue;
    out.push(ev);
  }
  return out.slice(-(opts.limit ?? 200));
}

const KINDS: Record<string, GuardEvent["kind"]> = {
  qty_jump: "qty_jump",
  budget: "budget",
  injection: "injection",
};

export function toGuardEvents(events: PolicyEvent[]): GuardEvent[] {
  return events
    .filter((e) => e.decision === "refuse")
    .map((e) => ({
      id: e.id,
      kind: KINDS[String(e.rule)] ?? (String(e.rule).startsWith("capability") ? "capability" : String(e.rule).startsWith("tier") ? "tool_denied" : "tool_denied"),
      severity: "block" as const,
      tool: e.tool,
      source: "policy-mcp" as const,
      rule: e.rule ?? undefined,
      message: `Refused at policy-mcp before execution: ${e.reason}`,
    }));
}
