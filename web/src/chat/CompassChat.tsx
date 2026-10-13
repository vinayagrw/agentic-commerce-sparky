/**
 * Compass chat chrome (Wave 0b): our own thread + composer over the SAME CopilotKit agent and AG-UI
 * stream (CopilotKit stays the runtime/state layer; its default chat UI is no longer rendered).
 *
 *  - thread: shopper/assistant identity, streaming text, inline A2UI surfaces (render_a2ui tool
 *    calls), per-turn run timeline, grounded citation chips, 👍/👎 feedback, follow-ups/clarify
 *  - session-bound cards: HITL approvals with undo, editable mission plan
 *  - composer: photo attach, voice (Web Speech API, EN/ES, editable transcript), slash commands,
 *    stop generation, edit last message + regenerate, error with retry
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "@copilotkit/react-core/v2";
import { AlertTriangle, ArrowUp, Bell, Bot, Brain, Camera, Mic, MicOff, Monitor, Pencil, RotateCcw, Sparkles, Square, UserRound, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { safeStorage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { api, getSessionId, sessionStore } from "@/store/session";
import { useStore } from "../store";
import { runningStore, surfaces, upsertSurface } from "../store";
import { SurfaceInline } from "@/components/ChatPane";
import { runsStore, type RunRecord } from "./runs";
import { announce, ApprovalCard, Citations, Feedback, FollowUps, PhotoCard, PlanCard, RunTimeline, StreamCursor, StreamingSkeleton, VerdictBadge, type FollowUpState, type PhotoResult } from "./cards";
import { postStream } from "@/lib/sse";
import { threadIdFor } from "@/components/ChatPane";
import { MemoryPanel, WatchesPanel } from "./panels";
import * as uiTrace from "@/lib/trace";
import { CHAT_COMPOSER_LABEL } from "@sparky/shared";

type Msg = { id: string; role: string; content?: unknown; toolCalls?: { id: string; function: { name: string; arguments: string } }[] };

const textOf = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("") : "");
const S = () => `/api/session/${encodeURIComponent(getSessionId())}`;

export const isSpanish = (t: string) => /[ñ¿¡]/i.test(t) || (t.match(/\b(el|la|los|las|para|con|sin|quiero|necesito|tu|carrito|gracias)\b/gi) ?? []).length >= 2;

/* ---------------- tiny markdown: paragraphs, bullets, **bold**, `code` ---------------- */

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded bg-surface-sunken px-1 font-mono text-[0.9em]">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function Markdown({ text, cursor }: { text: string; cursor?: boolean }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="grid gap-2 break-words">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        const caret = cursor && i === blocks.length - 1 ? <StreamCursor /> : null;
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l) || !l.trim()))
          return (
            <ul key={i} className="m-0 grid list-disc gap-0.5 pl-5">
              {lines.filter((l) => l.trim()).map((l, j) => (
                <li key={j}>
                  <Inline text={l.replace(/^\s*([-*]|\d+\.)\s/, "")} />
                </li>
              ))}
              {caret}
            </ul>
          );
        return (
          <p key={i} className="m-0 whitespace-pre-wrap">
            <Inline text={b} />
            {caret}
          </p>
        );
      })}
    </div>
  );
}

/* ---------------- voice ---------------- */

const SR: any = typeof window !== "undefined" ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : undefined;
const synth: SpeechSynthesis | undefined = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : undefined;

function useVoice(onText: (t: string) => void) {
  const [listening, setListening] = useState(false);
  const [lang, setLang] = useState<"en-US" | "es-US">("en-US");
  const [msg, setMsg] = useState<string | null>(null);
  const rec = useRef<any>(null);
  const supported = Boolean(SR);
  const toggle = () => {
    if (!supported) {
      setMsg("Voice input is not supported in this browser. Type your message instead.");
      return;
    }
    if (listening) {
      rec.current?.stop();
      return;
    }
    try {
      const r = new SR();
      r.lang = lang;
      r.interimResults = true;
      r.continuous = false;
      r.onresult = (e: any) => {
        let t = "";
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
        onText(t);
      };
      r.onerror = (e: any) => setMsg(`Voice input stopped: ${e.error}`);
      r.onend = () => {
        setListening(false);
        setMsg("Transcript is in the message box: edit it, then send.");
      };
      rec.current = r;
      r.start();
      setListening(true);
      setMsg(`Listening (${lang === "es-US" ? "Español" : "English"})… audio stays in your browser and is never stored.`);
    } catch (e) {
      setMsg(`Voice input unavailable: ${String(e)}`);
    }
  };
  return { supported, listening, lang, setLang, msg, toggle };
}

/* ---------------- slash commands ---------------- */

const COMMANDS = [
  { cmd: "/compare", desc: "Compare the top results of the last search" },
  { cmd: "/plan", desc: "Plan a mission, e.g. /plan pasta night for 4" },
  { cmd: "/memory", desc: "Open what Compass remembers" },
  { cmd: "/watch", desc: "Watches, alerts and reorder" },
  { cmd: "/reorder", desc: "Propose my usual items for approval" },
];

type Local =
  | { id: string; at: number; kind: "photo"; preview: string; state: any }
  | { id: string; at: number; kind: "surface"; surfaceId: string }
  | { id: string; at: number; kind: "note"; text: string; tone?: "error" };

interface Props {
  agentId: "default" | "ops";
  beat: number;
  extra?: Record<string, unknown>;
}

const prefilled = new Set<string>();

export function CompassChat({ agentId, beat, extra }: Props) {
  const { agent } = useAgent({ agentId });
  const [, force] = useState(0);
  const running = Boolean(useStore(runningStore)[agentId]);
  const runs = useStore(runsStore)[agentId] ?? [];
  const session = useStore(sessionStore);
  const shopper = agentId === "default";
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [locals, setLocals] = useState<Local[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [memOpen, setMemOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [dense, setDense] = useState(() => safeStorage.get("sparky.density") === "presenter");
  const [speak, setSpeak] = useState(false);
  const [followups, setFollowups] = useState<Record<string, FollowUpState>>({});
  const [starters, setStarters] = useState<{ status: "loading" | "done" | "error"; items: { query: string; category: string }[]; error?: string }>({ status: "loading", items: [] });
  const box = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const voice = useVoice((t) => setText(t));
  useAllSurfaces();

  // Deep link prefill (Guide "Try it"): ?chat=<prompt> for Compass, ?copilot=<prompt> for Ops Copilot.
  // Puts the text in the composer and focuses it; never sends.
  useEffect(() => {
    const key = shopper ? "chat" : "copilot";
    const v = new URLSearchParams(window.location.search).get(key);
    if (!v || prefilled.has(`${agentId}:${v}`)) return;
    prefilled.add(`${agentId}:${v}`);
    setText(v.slice(0, 2000));
    requestAnimationFrame(() => box.current?.focus({ preventScroll: true }));
  }, [agentId, shopper]);

  useEffect(() => safeStorage.set("sparky.density", dense ? "presenter" : "comfortable"), [dense]);

  useEffect(() => {
    if (!agent) return;
    const sub = agent.subscribe({ onMessagesChanged: () => force((n) => n + 1), onRunFinalized: () => force((n) => n + 1), onRunFailed: () => force((n) => n + 1) } as any);
    return () => sub.unsubscribe();
  }, [agent]);

  useEffect(() => {
    if (!shopper) return;
    api
      .get<{ starters: { query: string; category: string }[] }>("/api/assist/starters")
      .then((r) => setStarters({ status: "done", items: r.starters }))
      .catch((e) => setStarters({ status: "error", items: [], error: String(e.message ?? e) }));
  }, [shopper]);

  const messages: Msg[] = (agent?.messages ?? []) as Msg[];
  const lastRun = runs[runs.length - 1] as RunRecord | undefined;

  // announce + follow-ups + read-aloud once per finished run
  const handled = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!lastRun || lastRun.status === "running" || handled.current.has(lastRun.runId)) return;
    handled.current.add(lastRun.runId);
    if (lastRun.status === "error") {
      announce(`Compass hit an error: ${lastRun.error ?? "run failed"}`);
      return;
    }
    if (lastRun.status === "stopped") {
      announce("Stopped");
      return;
    }
    const answer = lastAssistantText(messages);
    announce("Compass replied");
    if (speak && synth && answer) {
      try {
        const u = new SpeechSynthesisUtterance(answer.replace(/[*`#🧭🔎✅⚠️⛔]/gu, "").slice(0, 600));
        u.lang = isSpanish(answer) ? "es-US" : "en-US";
        synth.cancel();
        synth.speak(u);
      } catch {
        /* synthesis unavailable */
      }
    }
    if (lastRun.question) {
      const rid = lastRun.runId;
      setFollowups((p) => ({ ...p, [rid]: { status: "loading" } }));
      const url = shopper ? `${S()}/followups` : `/api/session/${encodeURIComponent(threadIdFor("ops") ?? "ops")}/followups`;
      postStream<any>(url, { question: lastRun.question, answer, plane: shopper ? "shopper" : "ops" }, (e) => {
        if (e.type === "partial") setFollowups((p) => ({ ...p, [rid]: { status: "loading", followups: e.followups } }));
      })
        .then((r) => setFollowups((p) => ({ ...p, [rid]: { status: "done", clarify: r.clarify, followups: r.followups, cost_usd: r.cost_usd, model: r.model, cached: r.cached } })))
        .catch((e) => setFollowups((p) => ({ ...p, [rid]: { status: "error", error: String(e.message ?? e) } })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastRun?.status, lastRun?.runId]);

  // aria-live="polite", batched: while an answer streams, announce whole sentences at most every 4s
  // (never per token), so a screen reader hears the answer as it arrives without being flooded.
  const liveText = running ? lastAssistantText(messages) : "";
  const spoken = useRef(0);
  const liveRef = useRef("");
  liveRef.current = liveText;
  useEffect(() => {
    if (!running) {
      spoken.current = 0;
      return;
    }
    const t = window.setInterval(() => {
      const txt = liveRef.current;
      const end = Math.max(txt.lastIndexOf(". "), txt.lastIndexOf("\n"), txt.lastIndexOf("! "), txt.lastIndexOf("? "));
      if (end + 1 > spoken.current + 20) {
        const chunk = txt.slice(spoken.current, end + 1).replace(/[*`#]/g, "").trim();
        spoken.current = end + 1;
        if (chunk) announce(chunk.slice(0, 400));
      }
    }, 4000);
    return () => window.clearInterval(t);
  }, [running]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, locals.length, running, session?.pending_actions?.length, starters.status]);

  const send = useCallback(
    (raw: string, opts: { replaceFrom?: string } = {}) => {
      const t = raw.trim();
      if (!t || !agent) return false;
      if (runningStore.get()[agentId]) return false;
      try {
        if (opts.replaceFrom) {
          const all = (agent.messages ?? []) as Msg[];
          const i = all.findIndex((m) => m.id === opts.replaceFrom);
          if (i >= 0) agent.setMessages(all.slice(0, i) as never);
        }
        agent.setState({ ...(agent.state ?? {}), beat, ...(extra ?? {}), layout: uiTrace.currentLayout() });
        uiTrace.markSend(agentId);
        agent.addMessage({ id: `u_${crypto.randomUUID()}`, role: "user", content: t } as never);
        announce("Compass is responding");
        void agent.runAgent().catch(() => undefined);
        return true;
      } catch {
        return false;
      }
    },
    [agent, agentId, beat, extra],
  );

  const retry = () => {
    if (!agent || running) return;
    void agent.runAgent().catch(() => undefined);
  };

  const regenerate = () => {
    if (!agent || running) return;
    const all = (agent.messages ?? []) as Msg[];
    let i = all.length - 1;
    while (i >= 0 && all[i].role !== "user") i--;
    if (i < 0) return;
    agent.setMessages(all.slice(0, i + 1) as never);
    announce("Regenerating");
    void agent.runAgent().catch(() => undefined);
  };

  const stop = () => {
    const tid = agent?.threadId ?? threadIdFor(agentId);
    if (tid) void api.post("/api/agui/stop", { threadId: tid }).catch(() => undefined);
    try {
      agent?.abortRun?.();
    } catch {
      /* already stopped */
    }
    runningStore.set((p) => ({ ...p, [agentId]: false }));
    const r = runsStore.get()[agentId]?.at(-1);
    if (r && r.status === "running") runsStore.set((p) => ({ ...p, [agentId]: (p[agentId] ?? []).map((x) => (x.runId === r.runId ? { ...x, status: "stopped", finishedAt: Date.now() } : x)) }));
  };

  const addLocal = (l: Local) => setLocals((p) => [...p, l]);

  const photo = async (file: File) => {
    const id = crypto.randomUUID();
    const dataUrl = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(file);
    });
    const at = messages.length;
    const runIt = async () => {
      setLocals((p) => p.map((l) => (l.id === id ? { ...l, state: { status: "running" } } : l)));
      try {
        let chars = 0;
        const partial: PhotoResult["items"] = [];
        const r = await postStream<PhotoResult>(`${S()}/photo`, { dataUrl }, (e) => {
          if (e.type === "delta") chars += String(e.delta ?? "").length;
          if (e.type === "item") {
            partial.push(e.item);
            announce(`Photo: found ${e.item.name}`);
          }
          if (e.type === "delta" || e.type === "item") setLocals((p) => p.map((l) => (l.id === id ? { ...l, state: { status: "running", items: [...partial], chars } } : l)));
        });
        setLocals((p) => p.map((l) => (l.id === id ? { ...l, state: { status: "done", r } } : l)));
        announce(`Photo read: ${r.items.length} item(s) found`);
      } catch (e: any) {
        setLocals((p) => p.map((l) => (l.id === id ? { ...l, state: { status: "error", error: String(e.message ?? e), retry: runIt } } : l)));
      }
    };
    addLocal({ id, at, kind: "photo", preview: dataUrl, state: { status: "running" } });
    void runIt();
  };

  const runCommand = async (raw: string): Promise<boolean> => {
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(" ");
    const at = messages.length;
    if (cmd === "/memory") return setMemOpen(true), true;
    if (cmd === "/watch" || cmd === "/watches") return setWatchOpen(true), true;
    if (cmd === "/plan") {
      if (!arg) return addLocal({ id: crypto.randomUUID(), at, kind: "note", text: "Say what to plan, e.g. /plan pasta night for 4", tone: "error" }), true;
      return send(`Plan a shopping mission for: ${arg}. Use plan_meal and show me the plan. Do not add anything to my cart; I will review and edit the plan first.`);
    }
    if (cmd === "/compare") {
      const ids = (session?.last_search?.product_ids ?? []).slice(0, 3);
      if (ids.length < 2) return addLocal({ id: crypto.randomUUID(), at, kind: "note", text: "Search for something first (on the site or in chat), then /compare its top results.", tone: "error" }), true;
      try {
        const r = await api.post<any>(`${S()}/compare`, { product_ids: ids });
        upsertSurface({ ...r.surface, agentId, threadId: getSessionId() });
        addLocal({ id: crypto.randomUUID(), at, kind: "surface", surfaceId: r.surface.surfaceId });
        announce(r.recommendation ? `Compared ${ids.length} products. ${r.recommendation.reason}` : "Compared products; no recommendation");
      } catch (e: any) {
        addLocal({ id: crypto.randomUUID(), at, kind: "note", text: `Compare failed: ${e.message}`, tone: "error" });
      }
      return true;
    }
    if (cmd === "/reorder") {
      try {
        const r = await api.post<any>(`${S()}/reorder`);
        addLocal({ id: crypto.randomUUID(), at, kind: "note", text: `Proposed ${r.actions.length} item(s) from your usual orders. Approve each below.` });
      } catch (e: any) {
        addLocal({ id: crypto.randomUUID(), at, kind: "note", text: String(e.message ?? e), tone: "error" });
      }
      return true;
    }
    return false;
  };

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith("/") && shopper) {
      const handled = await runCommand(t);
      if (handled) {
        setText("");
        return;
      }
    }
    if (send(t, { replaceFrom: editing ?? undefined })) {
      setText("");
      setEditing(null);
    }
  };

  const slashMatches = text.startsWith("/") && !text.includes(" ") && shopper ? COMMANDS.filter((c) => c.cmd.startsWith(text.toLowerCase())) : [];

  // ---------------- thread assembly ----------------
  const turns = useMemo(() => {
    const out: { user?: Msg; parts: Msg[]; index: number }[] = [];
    messages.forEach((m, index) => {
      if (m.role === "user") out.push({ user: m, parts: [], index });
      else if (m.role === "assistant") {
        if (!out.length) out.push({ parts: [], index });
        out[out.length - 1].parts.push(m);
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, messages.map((m) => textOf(m.content).length + (m.toolCalls?.length ?? 0)).join(",")]);

  const lastUserId = [...messages].reverse().find((m) => m.role === "user")?.id;
  const pending = (session?.pending_actions ?? []).filter((a) => a.status === "pending" || (a.status === "approved" && Date.now() - new Date(a.created_at).getTime() < 30 * 60_000));
  const quarantined = (session?.memory ?? []).filter((m) => m.status === "quarantined").length;
  const unread = (session?.notifications ?? []).filter((n) => !n.read).length;
  const lastErr = lastRun?.status === "error" ? lastRun : null;

  const localsAt = (i: number) => locals.filter((l) => l.at === i);

  const renderLocal = (l: Local) =>
    l.kind === "photo" ? (
      <PhotoCard key={l.id} preview={l.preview} state={l.state} onAdd={(t) => send(t)} />
    ) : l.kind === "surface" ? (
      <div key={l.id} data-testid="compare-card">
        <SurfaceInline surfaceId={l.surfaceId} />
      </div>
    ) : (
      <p key={l.id} role={l.tone === "error" ? "alert" : undefined} className={cn("m-0 rounded-md px-3 py-2 text-sm", l.tone === "error" ? "bg-bad-soft text-bad" : "bg-info-soft text-fg")}>
        {l.text}
      </p>
    );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-canvas", dense ? "text-lg" : "text-base")} data-density={dense ? "presenter" : "comfortable"}>
      <div id="sparky-chat-announcer" role="status" aria-live="polite" className="sr-only" />
      {/* toolbar */}
      <div className="flex flex-none flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1" role="toolbar" aria-label="Chat tools">
        {shopper && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setMemOpen(true)} data-testid="open-memory">
              <Brain aria-hidden />
              Memory{quarantined ? <span className="rounded-full bg-warn-soft px-1.5 text-2xs text-fg">{quarantined} to confirm</span> : null}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setWatchOpen(true)} data-testid="open-watches">
              <Bell aria-hidden />
              Alerts{unread ? <span className="rounded-full bg-accent px-1.5 text-2xs text-accent-fg">{unread}</span> : null}
            </Button>
          </>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" aria-pressed={speak} disabled={!synth} title={synth ? undefined : "Speech output not supported in this browser"} onClick={() => setSpeak((s) => !s)}>
          <Volume2 aria-hidden />
          Read aloud
        </Button>
        <Button size="sm" variant="ghost" aria-pressed={dense} onClick={() => setDense((d) => !d)}>
          <Monitor aria-hidden />
          Large text
        </Button>
      </div>

      {/* thread */}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="chat-thread">
        <div role="log" aria-live="off" aria-label="Conversation with Compass" className={cn("mx-auto grid w-full max-w-3xl gap-4 px-3 py-4", dense && "gap-6")}>
          {messages.length === 0 && locals.length === 0 && (
            <div className="grid gap-3 py-6" data-testid="chat-empty">
              <div className="flex items-center gap-2">
                <span className="grid size-9 place-items-center rounded-full bg-accent text-accent-fg">
                  <Sparkles className="size-5" aria-hidden />
                </span>
                <h2 className="m-0 text-lg font-semibold">What are we shopping for?</h2>
              </div>
              {shopper && (
                <>
                  <p className="m-0 text-sm text-fg-muted">Try a real shopper query from the Amazon ESCI dataset, attach a photo, or type / for commands.</p>
                  {starters.status === "loading" && <div className="h-16 animate-pulse rounded-lg bg-surface-sunken" aria-label="Loading suggestions" />}
                  {starters.status === "error" && <p className="m-0 text-sm text-bad">Suggestions unavailable (search-svc): {starters.error}</p>}
                  <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
                    {starters.items.map((s) => (
                      <li key={s.query}>
                        <button type="button" data-testid="prompt-starter" onClick={() => send(s.query)} className="grid h-full w-full gap-0.5 rounded-lg border border-line bg-surface p-3 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus">
                          <span className="text-sm font-medium text-fg">{s.query}</span>
                          <span className="text-2xs text-fg-muted">ESCI query · {s.category.replace(/_/g, " ")}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {localsAt(0).length > 0 && turns.length === 0 && localsAt(0).map(renderLocal)}

          {turns.map((turn, ti) => {
            const run = turn.user ? runs.find((r) => r.userMessageId === turn.user!.id) : undefined;
            const answer = turn.parts.map((p) => textOf(p.content)).join("\n\n");
            const isLast = ti === turns.length - 1;
            const streaming = isLast && running;
            const f = run ? followups[run.runId] : undefined;
            const nextIndex = turns[ti + 1]?.index ?? Infinity;
            return (
              <div key={turn.user?.id ?? `t${ti}`} className="grid gap-3">
                {turn.user && (
                  <div className="flex justify-end gap-2" data-testid="msg-user">
                    <div className="grid max-w-[85%] gap-1">
                      <span className="text-right text-2xs font-semibold text-fg-muted">You</span>
                      <div className="rounded-2xl rounded-tr-sm bg-accent-soft px-3 py-2 text-fg ring-1 ring-accent/20">
                        <p className="m-0 whitespace-pre-wrap">{textOf(turn.user.content)}</p>
                      </div>
                      {turn.user.id === lastUserId && !running && shopper && (
                        <Button
                          size="xs"
                          variant="ghost"
                          className="justify-self-end"
                          aria-label="Edit last message"
                          onClick={() => {
                            setEditing(turn.user!.id);
                            setText(textOf(turn.user!.content));
                            box.current?.focus();
                          }}
                        >
                          <Pencil aria-hidden />
                          Edit
                        </Button>
                      )}
                    </div>
                    <UserRound className="mt-5 size-6 flex-none rounded-full bg-surface-sunken p-1 text-fg-muted" aria-hidden />
                  </div>
                )}
                {(turn.parts.length > 0 || streaming) && (
                  <div className="flex gap-2" data-testid="msg-assistant">
                    <Bot className="mt-5 size-6 flex-none rounded-full bg-accent p-1 text-accent-fg" aria-hidden />
                    <div className="grid min-w-0 flex-1 gap-2">
                      <span className="text-2xs font-semibold text-fg-muted">{shopper ? "Compass" : "Ops Copilot"}</span>
                      {turn.parts.map((p, pi) => {
                        const superseded = run?.verdict?.verdict === "revised" && run.verdict.messageIds.includes(p.id);
                        const revised = Boolean(run?.revisedIds?.includes(p.id));
                        const firstRevised = revised && run!.revisedIds![0] === p.id;
                        const lastText = streaming && pi === turn.parts.length - 1;
                        return (
                        <div key={p.id} className="grid gap-2" data-testid={superseded ? "superseded-answer" : revised ? "revised-answer" : undefined}>
                          {superseded && pi === turn.parts.findIndex((x) => run!.verdict!.messageIds.includes(x.id)) && (
                            <span className="text-2xs font-semibold text-warn">Superseded: the Critic rejected this draft{run!.verdict!.note ? ` (${run!.verdict!.note})` : ""}. A revised answer follows.</span>
                          )}
                          {firstRevised && <span className="text-2xs font-semibold text-fg-muted">Revised answer</span>}
                          {textOf(p.content) && (
                            <div data-testid="answer-text" className={cn(superseded && "text-fg-muted line-through decoration-fg-muted/70")}>
                              {superseded && <span className="sr-only">Superseded draft: </span>}
                              <Markdown text={textOf(p.content)} cursor={lastText} />
                            </div>
                          )}
                          {p.toolCalls
                            ?.filter((tc) => tc.function?.name === "render_a2ui")
                            .map((tc) => {
                              let args: any = {};
                              try {
                                args = JSON.parse(tc.function.arguments || "{}");
                              } catch {
                                /* partial args while streaming */
                              }
                              return <SurfaceInline key={tc.id} surfaceId={args.surfaceId} hint={args.hint} messages={args.messages} />;
                            })}
                        </div>
                        );
                      })}
                      {run?.verdict && <VerdictBadge v={run.verdict} />}
                      {run?.budget && (
                        <p role="status" data-testid="budget-notice" data-mode={run.budget.mode} className={cn("m-0 rounded-md px-3 py-2 text-xs", run.budget.mode === "exhausted" ? "bg-bad-soft text-bad" : "bg-warn-soft text-fg")}>
                          {run.budget.message}
                        </p>
                      )}
                      {streaming && !answer && <StreamingSkeleton />}
                      {streaming && answer && <span className="sr-only">Compass is still responding</span>}
                      {run && <RunTimeline run={run} dense={dense} />}
                      {shopper && run && run.status === "done" && run.productIds.length > 0 && <Citations productIds={run.productIds} />}
                      {run && run.status !== "running" && answer && (
                        <div className="flex flex-wrap items-center gap-1">
                          <Feedback messageId={turn.parts[turn.parts.length - 1]?.id ?? run.runId} question={run.question} answer={answer} runId={run.runId} />
                          {isLast && (
                            <Button size="xs" variant="ghost" onClick={regenerate}>
                              <RotateCcw aria-hidden />
                              Regenerate
                            </Button>
                          )}
                        </div>
                      )}
                      {isLast && f && <FollowUps f={f} onPick={(t) => send(t)} />}
                    </div>
                  </div>
                )}
                {locals.filter((l) => l.at > turn.index && l.at < nextIndex).map(renderLocal)}
              </div>
            );
          })}

          {lastErr && !running && (
            <div role="alert" data-testid="chat-error" className="flex flex-wrap items-center gap-2 rounded-lg border border-bad/40 bg-bad-soft px-3 py-2 text-sm text-bad">
              <AlertTriangle className="size-4" aria-hidden />
              The run failed: {lastErr.error ?? "unknown error"}. Nothing was substituted.
              <Button size="xs" onClick={retry}>
                <RotateCcw aria-hidden />
                Retry
              </Button>
            </div>
          )}

          {shopper && session?.plan && <PlanCard plan={session.plan} />}
          {shopper && pending.length > 0 && (
            <div className="grid gap-2" aria-label="Actions awaiting your approval" role="region">
              {pending.map((a) => (
                <ApprovalCard key={a.id} a={a} />
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {/* composer */}
      <form
        className="flex-none border-t border-line bg-surface px-3 pt-2 pb-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="mx-auto grid w-full max-w-3xl gap-1.5">
          {editing && (
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <Pencil className="size-3.5" aria-hidden />
              Editing your last message: sending replaces it and regenerates the answer.
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setEditing(null);
                  setText("");
                }}
              >
                Cancel edit
              </Button>
            </div>
          )}
          <div className="relative flex items-end gap-1.5 rounded-xl border border-line bg-surface-raised p-1.5 shadow-sm focus-within:outline-2 focus-within:outline-focus">
            <textarea
              ref={box}
              rows={dense ? 2 : 1}
              value={text}
              aria-label={CHAT_COMPOSER_LABEL}
              aria-describedby="composer-hint"
              aria-controls={slashMatches.length ? "slash-menu" : undefined}
              aria-activedescendant={slashMatches.length ? `slash-${slashMatches[Math.min(slashIdx, slashMatches.length - 1)].cmd.slice(1)}` : undefined}
              placeholder={shopper ? "Ask Compass, or type / for commands" : "Ask the Ops Copilot"}
              onChange={(e) => {
                setText(e.target.value);
                setSlashIdx(0);
              }}
              onKeyDown={(e) => {
                if (slashMatches.length) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIdx((i) => (i + (e.key === "ArrowDown" ? 1 : slashMatches.length - 1)) % slashMatches.length);
                    return;
                  }
                  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && text !== slashMatches[Math.min(slashIdx, slashMatches.length - 1)].cmd)) {
                    e.preventDefault();
                    setText(slashMatches[Math.min(slashIdx, slashMatches.length - 1)].cmd + " ");
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setText("");
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
              className="max-h-40 min-h-9 flex-1 resize-none self-center bg-transparent px-2 py-1.5 text-fg outline-none placeholder:text-fg-muted"
            />
            {slashMatches.length > 0 && (
              <ul id="slash-menu" role="listbox" aria-label="Commands" className="absolute right-0 bottom-full left-0 z-20 m-0 mb-1 grid list-none gap-0.5 rounded-lg border border-line bg-surface-raised p-1 shadow-lg">
                {slashMatches.map((c, i) => (
                  <li
                    key={c.cmd}
                    id={`slash-${c.cmd.slice(1)}`}
                    role="option"
                    aria-selected={i === Math.min(slashIdx, slashMatches.length - 1)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setText(c.cmd + " ");
                      box.current?.focus();
                    }}
                    className={cn("flex cursor-pointer gap-2 rounded-md px-2 py-1 text-sm", i === Math.min(slashIdx, slashMatches.length - 1) && "bg-surface-hover")}
                  >
                    <span className="font-mono font-semibold">{c.cmd}</span>
                    <span className="text-fg-muted">{c.desc}</span>
                  </li>
                ))}
              </ul>
            )}
            {shopper && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  tabIndex={-1}
                  aria-hidden
                  data-testid="photo-input"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void photo(f);
                    e.target.value = "";
                  }}
                />
                <Button type="button" size="icon" variant="ghost" aria-label="Attach a photo" onClick={() => fileRef.current?.click()}>
                  <Camera aria-hidden />
                </Button>
                <select aria-label="Voice language" value={voice.lang} onChange={(e) => voice.setLang(e.target.value as any)} className="h-8 rounded-md border border-line bg-surface px-1 text-xs text-fg">
                  <option value="en-US">EN</option>
                  <option value="es-US">ES</option>
                </select>
                <Button type="button" size="icon" variant="ghost" aria-label={!voice.supported ? "Voice input (not supported in this browser)" : voice.listening ? "Stop voice input" : "Voice input"} aria-pressed={voice.supported ? voice.listening : undefined} onClick={voice.toggle} data-testid="voice-button">
                  {voice.supported ? <Mic aria-hidden className={cn(voice.listening && "text-bad")} /> : <MicOff aria-hidden />}
                </Button>
              </>
            )}
            {running ? (
              <Button type="button" size="icon" variant="danger" aria-label="Stop generating" onClick={stop} data-testid="stop-button">
                <Square aria-hidden />
              </Button>
            ) : (
              <Button type="submit" size="icon" variant="primary" aria-label="Send message" disabled={!text.trim()}>
                <ArrowUp aria-hidden />
              </Button>
            )}
          </div>
          <p id="composer-hint" className="m-0 flex flex-wrap gap-x-3 text-2xs text-fg-muted">
            <span>Enter to send · Shift+Enter for a new line{shopper ? " · / for commands" : ""}</span>
            {voice.msg && (
              <span role="status" data-testid={voice.supported ? "voice-status" : "voice-unsupported"} className={cn(!voice.supported && "text-warn")}>
                {voice.msg}
              </span>
            )}
          </p>
        </div>
      </form>
      {shopper && <MemoryPanel open={memOpen} onOpenChange={setMemOpen} session={session} />}
      {shopper && <WatchesPanel open={watchOpen} onOpenChange={setWatchOpen} session={session} />}
    </div>
  );
}

function lastAssistantText(messages: Msg[]) {
  let i = messages.length - 1;
  const out: string[] = [];
  while (i >= 0 && messages[i].role !== "user") {
    if (messages[i].role === "assistant") out.unshift(textOf(messages[i].content));
    i--;
  }
  return out.join("\n\n").trim();
}

/** Keep a subscription on the surface store so inline cards re-render when their outcome changes. */
function useAllSurfaces() {
  useStore(surfaces);
}
