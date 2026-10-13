/**
 * The policy-mcp decision log (GET /api/policy/events <- data/policy_events.jsonl).
 *
 * This is the live proof the guard works: every tool call the Claude CLI makes goes through the
 * policy-mcp proxy, and each allow / refuse / quarantine decision is appended to the log BEFORE
 * the call executes. A refusal here means the call never reached shop-mcp.
 */
import { useMemo, useState } from "react";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import type { Provenance } from "@sparky/shared";
import { cn } from "@/lib/utils";
import { usePoll } from "@/lib/usePoll";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { Stat, StatGroup } from "@/components/Provenance";
import { EmptyState, ErrorState, PanelSkeleton } from "@/components/states";

export interface PolicyEvent {
  id: string;
  ts: number;
  iso: string;
  decision: "allow" | "refuse" | "quarantine";
  tool: string;
  role: string;
  session_id?: string | null;
  args?: Record<string, unknown>;
  rule?: string | null;
  reason?: string | null;
}

const DECISION = {
  refuse: { icon: ShieldX, tone: "bad", label: "Refused", row: "border-l-bad bg-bad-soft/50" },
  quarantine: { icon: ShieldAlert, tone: "warn", label: "Quarantined", row: "border-l-warn bg-warn-soft/50" },
  allow: { icon: ShieldCheck, tone: "ok", label: "Allowed", row: "border-l-transparent" },
} as const;

function time(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const argSummary = (a: Record<string, unknown> | undefined) =>
  Object.entries(a ?? {})
    .filter(([k, v]) => v != null && k !== "session_id")
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === "object" ? "…" : String(v)}`)
    .join("  ");

/**
 * @param compact  inspector column: tighter rows, no stats header.
 * @param emptyHint the action that fills the feed on this plane.
 */
export function PolicyEventsFeed({ compact, emptyHint = "Run beat 7 to send an injected seller listing through the proxy.", limit = 60 }: { compact?: boolean; emptyHint?: string; limit?: number }) {
  const { data, error, loading } = usePoll<{ events: PolicyEvent[] }>(`/api/policy/events?limit=${limit}`, 4000);
  const [filter, setFilter] = useState<"blocks" | "all">("blocks");
  const events = useMemo(() => [...(data?.events ?? [])].reverse(), [data]);
  const blocks = events.filter((e) => e.decision !== "allow");
  const shown = filter === "blocks" ? blocks : events;

  if (loading && !data) return <PanelSkeleton rows={4} label="Loading policy decisions" />;
  if (error && !data) return <ErrorState title="Policy decision log unavailable" fix="make dev">{error}. The feed reads data/policy_events.jsonl through the BFF.</ErrorState>;

  const prov: Provenance = {
    service: "policy-mcp",
    endpoint: "GET /api/policy/events (data/policy_events.jsonl)",
    timestamp: events[0]?.iso ?? "no events logged",
    note: `last ${events.length} decisions in the log`,
  };

  return (
    <div className="grid gap-3">
      {!compact && events.length > 0 && (
        <StatGroup provenance={prov}>
          <Stat hideChip label="Refused before execution" value={{ value: events.filter((e) => e.decision === "refuse").length, provenance: prov }} tone={blocks.length ? "bad" : "default"} />
          <Stat hideChip label="Quarantined" value={{ value: events.filter((e) => e.decision === "quarantine").length, provenance: prov }} tone="warn" />
          <Stat hideChip label="Allowed" value={{ value: events.filter((e) => e.decision === "allow").length, provenance: prov }} />
        </StatGroup>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented<"blocks" | "all">
          size="sm"
          label="Show decisions"
          value={filter}
          onValueChange={setFilter}
          items={[
            { value: "blocks", label: <>Blocks <span className="tabular text-fg-subtle">{blocks.length}</span></> },
            { value: "all", label: <>All <span className="tabular text-fg-subtle">{events.length}</span></> },
          ]}
        />
        <span className="flex items-center gap-1.5 text-2xs text-fg-subtle">
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-ok motion-reduce:animate-none" />
          live · every 4s
        </span>
      </div>
      {error && <ErrorState title="Last poll failed; showing the previous log">{error}</ErrorState>}
      {shown.length === 0 ? (
        <EmptyState icon={ShieldCheck}>{filter === "blocks" ? (events.length ? `No refusals among the last ${events.length} decisions. ${emptyHint}` : `No policy decisions logged yet. ${emptyHint}`) : `No policy decisions logged yet. ${emptyHint}`}</EmptyState>
      ) : (
        <ol aria-live="polite" aria-label="Policy decisions, newest first" className="m-0 grid list-none gap-1.5 p-0">
          {shown.slice(0, compact ? 20 : 40).map((e) => {
            const d = DECISION[e.decision] ?? DECISION.allow;
            const Icon = d.icon;
            return (
              <li key={e.id} className={cn("grid gap-1 rounded-md border border-line border-l-4 px-2.5 py-2", d.row)}>
                <div className="flex flex-wrap items-center gap-2">
                  <Icon aria-hidden className={cn("size-4 flex-none", d.tone === "bad" ? "text-bad" : d.tone === "warn" ? "text-warn" : "text-ok")} />
                  <Badge size="sm" tone={d.tone}>{d.label}</Badge>
                  <code className="text-sm font-semibold text-fg">{e.tool}</code>
                  {e.rule && <Badge size="sm" tone="outline" className="font-mono">{e.rule}</Badge>}
                  <span className="tabular ml-auto text-2xs text-fg-subtle">{time(e.iso)}</span>
                </div>
                {e.reason && <p className={cn("m-0 text-sm", e.decision === "allow" ? "text-fg-muted" : "text-fg")}>{e.reason}</p>}
                {!compact && argSummary(e.args) && <div className="truncate font-mono text-2xs text-fg-subtle">{argSummary(e.args)}</div>}
                <div className="text-2xs text-fg-subtle">role {e.role}{e.decision !== "allow" ? " · stopped at policy-mcp, never executed" : ""}</div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** Count of refusals for a tab badge. Shares the poll interval with the feed. */
export function usePolicyBlockCount() {
  const { data } = usePoll<{ events: PolicyEvent[] }>("/api/policy/events?limit=60", 4000);
  return (data?.events ?? []).filter((e) => e.decision !== "allow").length;
}
