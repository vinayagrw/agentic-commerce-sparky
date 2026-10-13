/**
 * Chat: CopilotKit v2 provider + CopilotChat bound to one runtime agent
 * (`default` = shopper plane -> BFF /api/agui, `ops` = Ops Copilot -> /api/agui/ops),
 * following trust-graph CopilotChatBeat.tsx.
 *
 *  - <CopilotHost> lives in the app shell, above the router outlet, so the agents (and their
 *    message lists) survive switching planes. Only one plane is mounted at a time; the chat
 *    history is not.
 *  - <AgentBridge> (always mounted, one per agent): agent.subscribe STATE_SNAPSHOT/DELTA -> that
 *    plane's state store; CUSTOM "a2ui" -> surface store; run start/finish -> runningStore.
 *  - <ChatPane> renders CopilotChat on a stable per-agent threadId, themed through CopilotKit's
 *    supported mechanisms: its CSS variables (scoped on a wrapper) and slot classNames.
 *  - renderToolCalls: `render_a2ui` draws the A2UI surface inline; "*" shows a compact tool chip.
 *  - HITL: A2UI Button actions POST /api/a2ui/action to the thread that produced the surface.
 */
import * as uiTrace from "@/lib/trace";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { CopilotKitProvider, useAgent } from "@copilotkit/react-core/v2";
import type { ReactToolCallRenderer } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { CheckCircle2, Loader2, TriangleAlert, Wrench } from "lucide-react";
import type { A2uiMessage, AgentState, UiHint } from "@sparky/shared";
import { A2uiSurface, type A2uiUserAction } from "../a2ui/Renderer";
import { opsFeed, runningStore, setOutcome, setRunning, stateStoreFor, surfaces, upsertSurface, useStore, type SurfaceEntry } from "../store";
import { postJson } from "../api";
import { getSessionId } from "@/store/session";
import { cn } from "@/lib/utils";
import { KeyValue } from "@/components/states";
import { usePreferences } from "@/shell/preferences";
import { CompassChat } from "@/chat/CompassChat";
import { addRun, appendRole, productIdsIn, runsStore, updateRun } from "@/chat/runs";

export interface ChatHandle {
  send: (text: string, extra?: Record<string, unknown>) => boolean;
}

export interface ActionResponse {
  ok: boolean;
  message: string;
  result?: any;
  state?: AgentState;
  next?: string | null;
  surfaces?: SurfaceEntry[];
}

type AgentId = "default" | "ops";

interface Props {
  agentId: AgentId;
  beat: number;
  /** Extra shared state sent with every run (rerank, worseCandidate, ...). */
  extra?: Record<string, unknown>;
  className?: string;
}

/** One thread per agent for the life of the page: remounting the chat must not start a new one. */
const threads: Record<string, string> = {};
/** Agent "default" shares its thread with the storefront session (localStorage "sparky.session"). */
const stableThread = (agentId: string) => (threads[agentId] ??= agentId === "default" ? getSessionId() : crypto.randomUUID());
const agents: Record<string, any> = {};
const listeners: Record<string, (res: ActionResponse, a: A2uiUserAction) => void> = {};

export const threadIdFor = (agentId: string) => threads[agentId] ?? agents[agentId]?.threadId ?? null;
export const isRunning = (agentId: string) => Boolean(runningStore.get()[agentId]);
export const useRunning = (agentId: string) => Boolean(useStore(runningStore)[agentId]);

export function onActionResult(agentId: string, fn: (res: ActionResponse, a: A2uiUserAction) => void) {
  listeners[agentId] = fn;
}

export function applyServerState(agentId: string, state: AgentState | undefined) {
  if (!state) return;
  stateStoreFor(agentId).set(state);
  try {
    agents[agentId]?.setState?.({ ...(agents[agentId].state ?? {}), ...state });
  } catch {
    /* mirrored in the store regardless */
  }
}

export function pushFeed(agentId: string, list: SurfaceEntry[] | undefined) {
  if (!list?.length) return;
  for (const s of list) upsertSurface({ ...s, agentId, threadId: threadIdFor(agentId) });
  opsFeed.set((prev) => [...list.map((s) => s.surfaceId).reverse(), ...prev].slice(0, 6));
}

export async function handleAction(a: A2uiUserAction) {
  const entry = surfaces.get()[a.surfaceId];
  const agentId = entry?.agentId ?? "default";
  const threadId = entry?.threadId ?? threadIdFor(agentId);
  if (!threadId) return;
  const res = await postJson<ActionResponse>("/api/a2ui/action", { threadId, name: a.name, context: a.context, surfaceId: a.surfaceId });
  setOutcome(a.surfaceId, { ok: res.ok, message: res.message ?? (res as any).error ?? "done", result: res.result });
  applyServerState(agentId, res.state);
  pushFeed(agentId, res.surfaces);
  listeners[agentId]?.(res, a);
}

function ToolChip({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("my-1 inline-flex h-6 items-center gap-1.5 rounded-full border border-line bg-surface-sunken px-2.5 font-mono text-xs text-fg-muted", className)}>{children}</div>;
}

export function SurfaceInline({ surfaceId, hint, messages }: { surfaceId?: string; hint?: UiHint; messages?: A2uiMessage[] }) {
  const all = useStore(surfaces);
  const entry = surfaceId ? all[surfaceId] : undefined;
  const msgs = entry?.messages ?? messages;
  if (!msgs?.length)
    return (
      <ToolChip>
        <Loader2 className="size-3 animate-spin" aria-hidden />
        rendering {hint ?? "surface"}
      </ToolChip>
    );
  const h = hint ?? entry?.hint;
  // B09: a "could_not_do" surface (Basic catalog) gets a warning frame so it reads as a limitation, not a result.
  if (String(h) === "could_not_do")
    return (
      <div data-hint="could_not_do" role="note" aria-label="What I could not do" className="rounded-xl border-l-4 border-l-warn bg-warn-soft/60 pl-1">
        <SurfaceView entry={entry} messages={msgs} />
      </div>
    );
  return <SurfaceView entry={entry} messages={msgs} />;
}

export function SurfaceView({ entry, messages }: { entry?: SurfaceEntry; messages: A2uiMessage[] }) {
  const out = entry?.outcome;
  const signed = out?.result && (out.result as any).mandate ? (out.result as Record<string, unknown>) : null;
  return (
    <div>
      <A2uiSurface messages={messages} onAction={handleAction} disabled={Boolean(out)} />
      {out && (
        <div role="status" className={cn("mt-1 grid gap-2 rounded-lg border px-3 py-2 text-sm", out.ok ? "border-ok/40 bg-ok-soft text-ok" : "border-bad/40 bg-bad-soft text-bad")}>
          <div className="flex items-center gap-2 font-medium">
            {out.ok ? <CheckCircle2 className="size-4" aria-hidden /> : <TriangleAlert className="size-4" aria-hidden />}
            {out.message}
          </div>
          {signed ? <KeyValue data={(signed.mandate as Record<string, unknown>) ?? signed} className="rounded-md bg-surface p-2" /> : null}
        </div>
      )}
    </div>
  );
}

/** Always mounted (in the shell): keeps stores and the run flag current while a plane is away. */
function AgentBridge({ agentId }: { agentId: AgentId }) {
  const { agent } = useAgent({ agentId });
  useEffect(() => {
    if (!agent) return;
    agents[agentId] = agent;
    const store = stateStoreFor(agentId);
    let runId: string | null = null;
    const toolT0 = new Map<string, number>();
    const upd = (fn: Parameters<typeof updateRun>[2]) => runId && updateRun(agentId, runId, fn);
    const sub = agent.subscribe({
      onStateChanged: ({ state }: any) => {
        if (state && typeof state === "object" && Array.isArray(state.plan)) store.set(state as AgentState);
      },
      onCustomEvent: ({ event }: any) => {
        const v = event?.value;
        if (event?.name === "a2ui" && v?.surfaceId) {
          const t0 = Date.now();
          upsertSurface({ ...v, agentId, threadId: agent.threadId });
          uiTrace.onA2uiRendered(agentId, t0, String(v.surfaceId));
        } else if (event?.name === "trace") {
          const info = uiTrace.onTraceEvent(agentId, v);
          if (info) upd((r) => ({ ...r, traceId: info.traceId, replayRunId: info.replayRunId }));
        }
        else if (event?.name === "role_stream" && v?.role) upd((r) => appendRole(r, String(v.role), String(v.delta ?? "")));
        else if (event?.name === "role_summary" && v?.role) upd((r) => appendRole(r, String(v.role), "", String(v.text ?? "")));
        else if (event?.name === "answer_verdict" && v?.verdict) upd((r) => ({ ...r, verdict: { verdict: v.verdict, note: v.note, issues: v.issues, messageIds: Array.isArray(v.messageIds) ? v.messageIds : [] } }));
        else if (event?.name === "budget" && v?.mode) upd((r) => ({ ...r, budget: v }));
        else if (event?.name === "answer_revised") upd((r) => ({ ...r, revisedIds: Array.isArray(v?.messageIds) ? v.messageIds : [] }));
      },
      onTextMessageContentEvent: () => {
        uiTrace.onFirstToken(agentId);
        upd((r) => (r.firstTokenAt ? r : { ...r, firstTokenAt: Date.now() }));
      },
      onRunInitialized: () => setRunning(agentId, true),
      // Wave 0b run timeline: only events that were actually streamed.
      onRunStartedEvent: ({ event, messages, state }: any) => {
        runId = String(event.runId ?? crypto.randomUUID());
        const lastUser = [...(messages ?? [])].reverse().find((m: any) => m.role === "user");
        const q = typeof lastUser?.content === "string" ? lastUser.content : "";
        if ((runsStore.get()[agentId] ?? []).some((r) => r.runId === runId)) return;
        addRun({ runId, agentId, userMessageId: lastUser?.id ?? null, question: q, startedAt: Date.now(), finishedAt: null, status: "running", steps: [], tools: [], costStart: Number(state?.cost_usd ?? 0), costUsd: null, tokens: null, tokensStart: { input: Number(state?.tokens?.input ?? 0), output: Number(state?.tokens?.output ?? 0) }, critic: null, productIds: [], roles: [], verdict: null, revisedIds: [], firstTokenAt: null });
      },
      onStepStartedEvent: ({ event }: any) => upd((r) => ({ ...r, steps: [...r.steps, { name: String(event.stepName), t0: Date.now(), ms: null }] })),
      onStepFinishedEvent: ({ event }: any) => upd((r) => ({ ...r, steps: r.steps.map((s) => (s.name === event.stepName && s.ms == null ? { ...s, ms: Date.now() - s.t0 } : s)) })),
      onToolCallStartEvent: ({ event }: any) => {
        if (event.toolCallName === "render_a2ui") return;
        toolT0.set(event.toolCallId, Date.now());
        upd((r) => ({ ...r, tools: [...r.tools, { id: event.toolCallId, name: event.toolCallName, args: "", result: "", t0: Date.now(), ms: null, ok: null }] }));
      },
      onToolCallArgsEvent: ({ event }: any) => upd((r) => ({ ...r, tools: r.tools.map((t) => (t.id === event.toolCallId ? { ...t, args: t.args + String(event.delta ?? "") } : t)) })),
      onToolCallResultEvent: ({ event }: any) =>
        upd((r) => {
          if (!r.tools.some((t) => t.id === event.toolCallId)) return r;
          const content = String(event.content ?? "");
          const bad = /"blocked"\s*:\s*true|"error"\s*:/.test(content) && !/hitl\.needs_approval/.test(content);
          return { ...r, productIds: [...new Set([...r.productIds, ...productIdsIn(content)])].slice(0, 6), tools: r.tools.map((t) => (t.id === event.toolCallId ? { ...t, result: content, ms: Date.now() - (toolT0.get(t.id) ?? t.t0), ok: !bad } : t)) };
        }),
      onRunFinalized: ({ state }: any) => {
        setRunning(agentId, false);
        void uiTrace.flush(agentId);
        const critic = (state?.agents ?? []).find((a: any) => a.name === "Critic");
        upd((r) => ({
          ...r,
          status: r.status === "running" ? (state?.mode === "refused" ? "error" : "done") : r.status,
          error: state?.mode === "refused" ? state?.refusal?.message : r.error,
          finishedAt: r.finishedAt ?? Date.now(),
          costUsd: Math.round((Number(state?.cost_usd ?? 0) - r.costStart) * 1e5) / 1e5,
          tokens: { input: Number(state?.tokens?.input ?? 0) - r.tokensStart.input, output: Number(state?.tokens?.output ?? 0) - r.tokensStart.output },
          critic: critic && critic.status !== "idle" ? { verdict: critic.status === "done" ? "pass" : critic.status === "skipped" ? "skipped" : "fail", note: critic.note } : null,
        }));
      },
      onRunFailed: ({ error }: any) => {
        setRunning(agentId, false);
        void uiTrace.flush(agentId);
        upd((r) => ({ ...r, status: r.status === "stopped" ? "stopped" : "error", error: String(error?.message ?? error ?? "run failed"), finishedAt: r.finishedAt ?? Date.now() }));
      },
    } as any);
    return () => sub.unsubscribe();
  }, [agent, agentId]);
  return null;
}

export function CopilotHost({ children }: { children: React.ReactNode }) {
  const renderToolCalls = useMemo<ReactToolCallRenderer<any>[]>(
    () => [
      {
        name: "render_a2ui",
        args: z.object({ surfaceId: z.string().optional(), hint: z.string().optional(), messages: z.array(z.any()).optional() }),
        render: ({ args }: any) => <SurfaceInline surfaceId={args?.surfaceId} hint={args?.hint} messages={args?.messages} />,
      },
      {
        name: "*",
        args: z.any(),
        render: ({ name, status }: any) => {
          const done = String(status) === "complete";
          return (
            <ToolChip>
              <Wrench className="size-3" aria-hidden />
              {name}
              {done ? <CheckCircle2 className="size-3 text-ok" aria-label="complete" /> : <Loader2 className="size-3 animate-spin" aria-label="running" />}
            </ToolChip>
          );
        },
      },
    ],
    [],
  );
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" renderToolCalls={renderToolCalls}>
      <AgentBridge agentId="default" />
      <AgentBridge agentId="ops" />
      {children}
    </CopilotKitProvider>
  );
}

const Inner = forwardRef<ChatHandle, Props>(function Inner({ agentId, beat, extra }, ref) {
  const { agent } = useAgent({ agentId });
  const threadId = stableThread(agentId);
  // Contract: the default agent's AG-UI thread IS the storefront session (was CopilotChat's threadId prop).
  if (agent && agent.threadId !== threadId) agent.threadId = threadId;

  // Keep the BFF informed of beat + options through shared state (sent with every run).
  const extraKey = JSON.stringify(extra ?? {});
  useEffect(() => {
    if (!agent) return;
    try {
      agent.setState({ ...(agent.state ?? {}), beat, ...(extra ?? {}) });
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, beat, extraKey]);

  useImperativeHandle(
    ref,
    () => ({
      send: (text, more = {}) => {
        if (!agent) return false;
        // Beat 8b: a human can approve while the propose run is still streaming. Starting a run
        // then throws "Thread already running" and the continuation is silently lost, so wait
        // for the current run to finalize (up to 5 min) instead of dropping it.
        const fire = (attempt = 0): boolean => {
          if (isRunning(agentId) && attempt < 750) {
            setTimeout(() => fire(attempt + 1), 400);
            return true;
          }
          try {
            agent.setState({ ...(agent.state ?? {}), beat, ...(extra ?? {}), layout: uiTrace.currentLayout(), ...more });
            uiTrace.markSend(agentId);
            agent.addMessage({ id: `u_${crypto.randomUUID()}`, role: "user", content: text } as never);
            void agent.runAgent();
            return true;
          } catch {
            return false;
          }
        };
        return fire();
      },
    }),
    [agent, agentId, beat, extra],
  );

  return <CompassChat agentId={agentId} beat={beat} extra={extra} />;
});

export const ChatPane = forwardRef<ChatHandle, Props>(function ChatPane({ className, ...props }, ref) {
  // Wave 0b: our own chrome uses theme tokens directly; CopilotKit's `.dark` palette and variable
  // re-pointing are no longer needed (its `.dark --accent` would override our brand token).
  return (
    <div className={cn("relative isolate flex min-h-0 flex-1 flex-col overflow-hidden text-fg", className)}>
      <Inner ref={ref} {...props} />
    </div>
  );
});
