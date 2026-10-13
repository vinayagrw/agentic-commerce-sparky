/**
 * Ops Copilot #10: proactive watch alerts. Polls GET /api/ops/watch (ops-mcp copilot.watch_alerts over
 * ops.db gates/alerts/audit and search-svc /canary/status) and shows each alert as a notification with its
 * suggested next action. Clicking the action sends that prompt to the Ops Copilot chat. Nothing is acted on
 * automatically: the action is a suggestion the operator chooses to send.
 */
import { useEffect, useState } from "react";
import { Bell, BellRing, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/store/session";
import { cn } from "@/lib/utils";

export interface WatchNote {
  id: string;
  kind: "gate_red" | "drift" | "canary_breach";
  severity: "high" | "medium";
  ts: number;
  message: string;
  next_action: string;
  prompt: string;
  cite: string;
}

export function WatchAlerts({ onAct, intervalMs = 30_000 }: { onAct: (prompt: string) => void; intervalMs?: number }) {
  const [notes, setNotes] = useState<WatchNote[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    const poll = () =>
      api
        .get<{ notifications: WatchNote[] }>("/api/ops/watch")
        .then((r) => live && (setNotes(r.notifications ?? []), setErr(null)))
        .catch((e) => live && setErr(String(e.message ?? e)));
    void poll();
    const t = window.setInterval(poll, intervalMs);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [intervalMs]);

  const unread = (notes ?? []).filter((n) => !seen.has(n.id)).length;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o && notes) setSeen(new Set(notes.map((n) => n.id)));
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="ops-watch-bell" aria-label={`Watch alerts${notes ? `: ${notes.length} active, ${unread} new` : ""}`}>
          {unread ? <BellRing aria-hidden className="text-warn" /> : <Bell aria-hidden />}
          Alerts
          {notes == null && !err ? <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {unread ? <span className="rounded-full bg-accent px-1.5 text-2xs text-accent-fg">{unread}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-2" data-testid="ops-watch-panel">
        <h3 className="m-0 px-1 pb-1 text-sm font-semibold">Watch alerts</h3>
        {err && (
          <p role="alert" className="m-0 px-1 text-xs text-bad">
            Watch unavailable (ops-http / search-svc): {err}
          </p>
        )}
        {notes && notes.length === 0 && <p className="m-0 px-1 text-xs text-fg-muted">No active alerts: gate green, no drift below p 0.05, no canary breach in the last 24h.</p>}
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {(notes ?? []).map((n) => (
            <li key={n.id} data-testid="ops-watch-note" data-kind={n.kind} className={cn("grid gap-1 rounded-md border-l-4 bg-surface-sunken p-2 text-xs", n.severity === "high" ? "border-l-bad" : "border-l-warn")}>
              <span className="font-medium text-fg">{n.message}</span>
              <span className="font-mono text-2xs text-fg-muted">
                {new Date(n.ts * 1000).toLocaleString()} · {n.cite}
              </span>
              <Button
                size="xs"
                variant="secondary"
                className="justify-self-start"
                data-testid="ops-watch-action"
                onClick={() => {
                  setOpen(false);
                  onAct(n.prompt);
                }}
              >
                {n.next_action}
              </Button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
