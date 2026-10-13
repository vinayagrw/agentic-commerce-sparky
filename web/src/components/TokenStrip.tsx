/**
 * Compact session token meter for the Inspector: what this session has spent so far, against the
 * SESSION_COST_BUDGET_USD the bff degrades on, with a link to the full meter at /ops/tokens.
 *
 * Session tokens and cost come from the agent's shared state (the CLI's own reported usage, summed
 * by the bff). The budget figure and its mode come from GET /api/tokens/summary, which reads the
 * same budget the shopper turn uses. Nothing is estimated: with no model call yet, it says so.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Coins } from "lucide-react";
import type { AgentState } from "@sparky/shared";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { fetchTokenSummary, type TokenSummary } from "@/lib/traceDetail";
import { runsStore } from "@/chat/runs";
import { useStore } from "@/store";

export function TokenStrip({ state: s, agentId }: { state: AgentState; agentId: string }) {
  const [sum, setSum] = useState<TokenSummary | null>(null);
  const runs = useStore(runsStore)[agentId] ?? [];
  const degraded = [...runs].reverse().find((r) => r.budget)?.budget ?? null;
  const spent = s.cost_usd;

  useEffect(() => {
    let live = true;
    fetchTokenSummary({ group_by: "role" })
      .then((r) => {
        if (live && r?.ok) setSum(r);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [spent]);

  const budgetUsd = sum?.budget.budget_usd ?? null;
  const pct = budgetUsd ? Math.min(100, (spent / budgetUsd) * 100) : null;
  const ran = s.tokens.input > 0 || s.cost_usd > 0;

  return (
    <div className="grid gap-1.5 border-b border-line px-4 py-2.5" data-testid="token-strip">
      <div className="flex flex-wrap items-center gap-2">
        <Coins aria-hidden className="size-4 text-accent" />
        <span className="text-xs font-semibold">Session tokens</span>
        {degraded && (
          <Badge size="sm" tone={degraded.mode === "exhausted" ? "bad" : "warn"} data-testid="token-strip-degraded">
            {degraded.mode}
          </Badge>
        )}
        <Link to="/ops/tokens" className="ml-auto text-2xs font-medium text-accent underline-offset-4 hover:underline" data-testid="token-strip-link">
          Token meter
        </Link>
      </div>
      {ran ? (
        <>
          <div className="tabular flex flex-wrap gap-x-3 text-2xs text-fg-muted">
            <span data-testid="token-strip-in">in {s.tokens.input.toLocaleString()}</span>
            <span data-testid="token-strip-out">out {s.tokens.output.toLocaleString()}</span>
            <span data-testid="token-strip-cost" className="font-semibold text-fg">
              ${spent.toFixed(4)}
            </span>
            {budgetUsd != null && <span data-testid="token-strip-budget">of ${budgetUsd.toFixed(2)} budget</span>}
          </div>
          {pct != null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken" role="meter" aria-valuemin={0} aria-valuemax={budgetUsd ?? 0} aria-valuenow={spent} aria-label="Session model spend against the session budget">
              <div className={cn("h-full rounded-full", pct >= 100 ? "bg-bad" : pct >= 80 ? "bg-warn" : "bg-ok")} style={{ width: `${Math.max(1, pct)}%` }} />
            </div>
          )}
          {degraded && <p className="m-0 text-2xs text-warn">{degraded.message}</p>}
        </>
      ) : (
        <p className="m-0 text-2xs text-fg-muted">No model call in this session yet.</p>
      )}
    </div>
  );
}
