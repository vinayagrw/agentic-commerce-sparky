/**
 * B14: operator session replay. /ops/replay lists recorded AG-UI runs; /ops/replay/:runId steps
 * through one run's stored events at their recorded pacing. It never re-runs anything: every
 * frame shown is an event that was actually streamed to a user, read from data/agui_runs/.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TraceWaterfall } from "./TraceWaterfall";
import { History, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { usePoll } from "@/lib/usePoll";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, KeyValue, PanelSkeleton } from "@/components/states";
import { ProvenanceChip, provenanceIn } from "@/components/Provenance";

interface RunSummary {
  runId: string;
  threadId: string | null;
  plane: string;
  question: string;
  beat: number | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  event_count: number;
  outcome: string;
}
interface RecordedEvent {
  seq: number;
  t_ms: number;
  event: Record<string, any>;
}

const fmt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

/** Fold recorded events up to `upto` into what the user saw: messages, tool calls, steps, latest state. */
export function foldEvents(events: RecordedEvent[], upto: number) {
  const messages = new Map<string, string>();
  const tools = new Map<string, { name: string; args: string; result?: string }>();
  const steps: string[] = [];
  let state = null as Record<string, any> | null;
  for (const { event: e } of events.slice(0, upto + 1)) {
    switch (e.type) {
      case "TEXT_MESSAGE_START":
        messages.set(e.messageId, "");
        break;
      case "TEXT_MESSAGE_CONTENT":
        messages.set(e.messageId, (messages.get(e.messageId) ?? "") + (e.delta ?? ""));
        break;
      case "TOOL_CALL_START":
        tools.set(e.toolCallId, { name: e.toolCallName, args: "" });
        break;
      case "TOOL_CALL_ARGS": {
        const t = tools.get(e.toolCallId);
        if (t) t.args += e.delta ?? "";
        break;
      }
      case "TOOL_CALL_RESULT": {
        const t = tools.get(e.toolCallId);
        if (t) t.result = typeof e.content === "string" ? e.content : JSON.stringify(e.content);
        break;
      }
      case "STEP_STARTED":
        steps.push(e.stepName);
        break;
      case "STATE_SNAPSHOT":
        state = e.snapshot ?? null;
        break;
      case "STATE_DELTA":
        if (state && Array.isArray(e.delta)) {
          const next: Record<string, any> = { ...(state as Record<string, any>) };
          for (const op of e.delta) if (typeof op.path === "string" && op.path.split("/").length === 2) next[op.path.slice(1)] = op.value;
          state = next;
        }
        break;
    }
  }
  return { messages: [...messages.values()].filter(Boolean), tools: [...tools.entries()], steps, state };
}

function RunList() {
  const { data, loading, error } = usePoll<{ runs: RunSummary[] }>("/api/replay/runs", 10000);
  const prov = data ? provenanceIn(data) : null;
  return (
    <Card>
      <CardHeader className="items-center">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4 text-fg-subtle" aria-hidden /> Recorded sessions
        </CardTitle>
        {prov && <ProvenanceChip compact provenance={prov} />}
      </CardHeader>
      <CardContent>
        {loading && !data ? (
          <PanelSkeleton rows={4} label="Loading recorded runs" />
        ) : error ? (
          <ErrorState title="Recorded runs unavailable" fix="make dev">{error}</ErrorState>
        ) : !data?.runs.length ? (
          <EmptyState icon={History}>No recorded runs yet. Every shopper or ops run streamed through the BFF is recorded; run a beat first.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>recorded</TableHead>
                <TableHead>plane</TableHead>
                <TableHead>question</TableHead>
                <TableHead>events</TableHead>
                <TableHead>outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.runs.map((r) => (
                <TableRow key={r.runId}>
                  <TableCell className="text-xs whitespace-nowrap">
                    <Link to={`/ops/replay/${encodeURIComponent(r.runId)}`} className="text-accent">{fmt(r.started_at)}</Link>
                  </TableCell>
                  <TableCell><Badge size="sm">{r.plane}{r.beat != null ? ` · beat ${r.beat}` : ""}</Badge></TableCell>
                  <TableCell className="max-w-[40ch] truncate text-sm">{r.question || <span className="text-fg-subtle">(no question)</span>}</TableCell>
                  <TableCell className="tabular text-sm">{r.event_count}</TableCell>
                  <TableCell><Badge size="sm" tone={r.outcome === "finished" ? "ok" : "bad"}>{r.outcome}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function Player({ runId }: { runId: string }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "trace" ? "trace" : "replay";
  const { data, loading, error } = usePoll<{ summary: RunSummary | null; events: RecordedEvent[]; trace_id?: string | null }>(`/api/replay/runs/${encodeURIComponent(runId)}`, 0);
  const events = data?.events ?? [];
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!playing || pos >= events.length - 1) {
      if (pos >= events.length - 1) setPlaying(false);
      return;
    }
    const wait = Math.min(1500, Math.max(0, events[pos + 1].t_ms - events[pos].t_ms));
    timer.current = window.setTimeout(() => setPos((p) => p + 1), wait);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [playing, pos, events]);

  const view = useMemo(() => foldEvents(events, pos), [events, pos]);
  const s = data?.summary;
  const startedIso = s?.started_at ?? (events[0]?.event.timestamp ? new Date(events[0].event.timestamp).toISOString() : "unknown time");

  if (loading && !data) return <PanelSkeleton rows={6} label="Loading recorded run" />;
  if (error || !events.length) return <ErrorState title="Recorded run not found" fix="open /ops/replay">{error ?? "This run has no recorded events."}</ErrorState>;

  return (
    <div className="grid gap-4">
      <div role="note" data-replay-banner className="flex flex-wrap items-center gap-2 rounded-lg border-2 border-warn bg-warn-soft px-3 py-2.5">
        <History className="size-5 text-warn" aria-hidden />
        <span className="font-semibold">
          Replay of recorded session {runId}, recorded {fmt(startedIso)}
        </span>
        <span className="text-sm text-fg-muted">Not live. Every frame is a stored AG-UI event; nothing is re-run.</span>
      </div>

      <Tabs value={tab} onValueChange={(v) => setParams((p) => { const n = new URLSearchParams(p); if (v === "trace") n.set("tab", "trace"); else n.delete("tab"); return n; }, { replace: true })}>
        <TabsList aria-label="Replay views">
          <TabsTrigger value="replay" data-testid="replay-tab-events">Events</TabsTrigger>
          <TabsTrigger value="trace" data-testid="replay-tab-trace">Trace</TabsTrigger>
        </TabsList>
        <TabsContent value="trace" className="pt-4">
          {data?.trace_id ? (
            <Card><CardContent className="pt-4"><TraceWaterfall traceId={data.trace_id} /></CardContent></Card>
          ) : (
            <EmptyState icon={History}>No trace was recorded for this run (tracing off, or a run from before tracing).</EmptyState>
          )}
        </TabsContent>
        <TabsContent value="replay" className="grid gap-4 pt-4">
      <Card>
        <CardContent className="grid gap-3 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setPlaying(false); setPos(0); }} aria-label="Restart"><SkipBack /></Button>
            <Button variant="primary" size="sm" onClick={() => setPlaying((p) => !p)}>{playing ? <Pause /> : <Play />}{playing ? "Pause" : "Play at recorded pace"}</Button>
            <Button variant="ghost" size="sm" onClick={() => setPos((p) => Math.min(events.length - 1, p + 1))} aria-label="Next event"><SkipForward /></Button>
            <input type="range" min={0} max={events.length - 1} value={pos} onChange={(e) => { setPlaying(false); setPos(Number(e.target.value)); }} aria-label="Event position" className="min-w-[10rem] flex-1 accent-[var(--accent)]" />
            <span className="tabular text-xs text-fg-muted">event {pos + 1}/{events.length} · +{(events[pos].t_ms / 1000).toFixed(1)} s · <span className="font-mono">{String(events[pos].event.type)}</span></span>
          </div>
          {s && <p className="m-0 text-sm text-fg-muted">{s.plane} plane{s.beat != null ? `, beat ${s.beat}` : ""}: “{s.question}” · outcome {s.outcome}</p>}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader><CardTitle className="text-base">What the user saw</CardTitle></CardHeader>
          <CardContent className="grid gap-2">
            {view.steps.length > 0 && <div className="flex flex-wrap gap-1">{view.steps.map((st, i) => <Badge key={i} size="sm" tone="accent">{st}</Badge>)}</div>}
            {view.messages.length ? view.messages.map((m, i) => <p key={i} className="m-0 rounded-md bg-surface-sunken px-3 py-2 text-sm whitespace-pre-wrap">{m}</p>) : <p className="m-0 text-sm text-fg-subtle">No assistant text yet at this point.</p>}
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader><CardTitle className="text-base">Tool calls ({view.tools.length})</CardTitle></CardHeader>
          <CardContent className="grid gap-2">
            {view.tools.length === 0 && <p className="m-0 text-sm text-fg-subtle">No tool calls yet at this point.</p>}
            {view.tools.map(([id, t]) => (
              <details key={id} className="rounded-md border border-line px-3 py-2">
                <summary className={cn("cursor-pointer font-mono text-sm", t.result == null && "text-fg-muted")}>{t.name}{t.result == null ? " (no result yet)" : ""}</summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-code-bg p-2 text-2xs text-code-fg">{t.args}</pre>
                {t.result != null && <pre className="mt-1 max-h-40 overflow-auto rounded bg-code-bg p-2 text-2xs text-code-fg">{t.result.slice(0, 4000)}</pre>}
              </details>
            ))}
          </CardContent>
        </Card>
      </div>
      {view.state && (
        <details className="rounded-lg border border-line bg-surface px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Shared state at this event (recorded)</summary>
          <KeyValue className="mt-2" data={{ mode: view.state.mode, agents: view.state.agents, cart: view.state.cart, guard_events: view.state.guard_events, ops_gate: view.state.ops?.gate?.verdict }} />
        </details>
      )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function Component() {
  const { runId } = useParams();
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-[90rem] gap-4 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 text-2xl font-semibold tracking-[-0.02em]">Operator session replay</h1>
          {runId && <Link to="/ops/replay" className="text-sm text-accent-soft-fg underline-offset-4 hover:underline">All recorded sessions</Link>}
          <Link to="/ops/traces" className="text-sm text-accent-soft-fg underline-offset-4 hover:underline">Traces</Link>
          <Link to="/ops/1" className="ml-auto text-sm text-accent-soft-fg underline-offset-4 hover:underline">Back to Ops</Link>
        </header>
        {runId ? <Player runId={runId} /> : <RunList />}
      </div>
    </div>
  );
}
