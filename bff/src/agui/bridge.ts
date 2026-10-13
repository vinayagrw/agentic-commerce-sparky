/**
 * AG-UI bridge: POST /api/agui (shopper plane) and POST /api/agui/ops (Ops Copilot).
 *
 * Every run is live. There is no substitute path: a missing service or a failed CLI run
 * stops the beat with a refusal that names what is wrong, rather than replaying something
 * canned. Tool calls go through policy-mcp, which refuses before the tool executes.
 *
 * CopilotKit's runtime HttpAgent POSTs RunAgentInput here; we answer with an SSE
 * stream of AG-UI events. Normalised Claude CLI events are mapped as:
 *   token        -> TEXT_MESSAGE_START / CONTENT / END
 *   tool_use     -> TOOL_CALL_START / ARGS / END (+ guard pre-check on the shopper plane)
 *   tool_result  -> TOOL_CALL_RESULT, trace, shared state (STATE_DELTA), and when the
 *                   result has a `ui` hint: CUSTOM "a2ui" { surfaceId, hint, messages }
 *                   plus a `render_a2ui` tool call so the surface renders inline in chat.
 *   usage        -> tokens / cost_usd in state (also per agent role)
 *   agent roles  -> STEP_STARTED / STEP_FINISHED (stepName "Planner · T1") + state.agents[]
 * Shared state starts with STATE_SNAPSHOT and ends with a final STATE_SNAPSHOT.
 *
 * Shopper plane: Planner (no tools, cheap model) -> Shopper/Checkout (mcp__policy__*) ->
 * Critic (no tools, cheap model; checks the cart against the ledger AFTER the answer streamed).
 *
 * Streaming (Phase 1): the Shopper's answer streams token by token as it is written. Planner and
 * Critic stream their own output into the run timeline as CUSTOM "role_stream" {role, delta}.
 * When the verifier + Critic finish, CUSTOM "answer_verdict" {messageIds, verdict} attaches a
 * badge to the streamed answer: "checked" (Critic pass) or "revised" (Critic fail). On "revised"
 * the streamed text is marked superseded (never silently swapped) and a revised answer streams
 * below it, announced with CUSTOM "answer_revised" {messageIds}.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AgentState, GuardEvent, Plane, Tier } from "@sparky/shared";
import { OPS_UI_HINTS } from "@sparky/shared";
import { config } from "../config.js";
import type { CliEvent } from "../llm/claudeCode.js";
import { runClaudeCode } from "../llm/claudeCode.js";
import { setRunIntent, withRun } from "../llm/ledger.js";
import { cartAmounts, cartKey, criticNeeded, routeIntent } from "../agents/intent.js";
import { budgetState } from "../agents/budget.js";
import { writePolicyMcpConfig, POLICY_TOOLS } from "../agents/mcpConfig.js";
import { buildPrompt, SYSTEM_PROMPT } from "../agents/prompt.js";
import { planFor, advancePlan, finishPlan, constraintsFrom } from "../agents/planner.js";
import { shortTool } from "../agents/guard.js";
import { rolesFor, PLANNER_SYSTEM, CRITIC_SYSTEM, plannerPrompt, criticPrompt, parseJsonObject, deterministicCritic, mergeVerdicts, applyPlannerLedger, ROLE_TIERS } from "../agents/roles.js";
import { getThread, type ThreadCtx } from "./threadStore.js";
import { buildA2ui, hintOf } from "./a2ui.js";
import { applyToolResult } from "./stateReducer.js";
import { jfetch } from "../lib/http.js";
import { buildOpsA2ui } from "../ops/a2uiOps.js";
import { applyOpsResult, markOpsActive } from "../ops/reducer.js";
import { opsToolMeta } from "../ops/meta.js";
import { OPS_SYSTEM_PROMPT, buildOpsPrompt } from "../ops/prompt.js";
import { finopsRouter } from "../ops/finops.js";
import { runCamel } from "../agents/camel.js";
import { diag, outageLine, outagesFor } from "../diag.js";
import * as metrics from "../metrics.js";
import { mark as policyMark, read as readPolicyEvents, toGuardEvents } from "../policyEvents.js";
import { getSession, noteConstraints, onAgentTool, publish as publishSession, runVerifier, takeSiteActivity } from "../session/sessionStore.js";
import { detectConstraints, mergeConstraints } from "../session/constraints.js";
import { addInferred, detectLang, inferFromConstraints, languageInstruction, memoryPromptLines, planFromMealTool } from "../assist/logic.js";
import { assistFor, saveSoon } from "../assist/store.js";
import { compareFor, onPlanTool, recordProposal } from "../assist/routes.js";
import { createHash } from "node:crypto";
import type { Span } from "@opentelemetry/api";
import { contextWithSpan, endSpan, markSpan, otelContext, startKindSpan, withKindSpan } from "../otel.js";
import { noteHitlShown, recordRunTrace, type RunTrace } from "../trace/store.js";

const sha16 = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v ?? null)).digest("hex").slice(0, 16);

/** Active runs by thread, so POST /api/agui/stop can abort the CLI even when the proxy keeps the socket open. */
const active = new Map<string, AbortController>();
export function stopRun(threadId: string): boolean {
  const ac = active.get(threadId);
  if (!ac) return false;
  ac.abort();
  return true;
}

interface RunInput {
  threadId?: string;
  runId?: string;
  messages?: { role?: string; content?: unknown }[];
  state?: Partial<AgentState> & { hitl?: boolean; rerank?: boolean; imagePath?: string; opsPhase?: string; worseCandidate?: boolean };
  forwardedProps?: Record<string, unknown>;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}

export type Send = (event: Record<string, unknown>) => void;

const stripMcp = (n: string) => n.replace(/^mcp__[a-z0-9_-]+?__/i, "");

/** One AG-UI run: owns message/tool-call bookkeeping, role steps and state diffs. */
export class AguiRun {
  private msgId: string | null = null;
  private starts = new Map<string, { name: string; input: unknown; t0: number; blocked: GuardEvent[]; span?: Span | null }>();
  /** The turn's trace (null when tracing is off): HITL proposals remember it so the decision lands on this trace. */
  runTrace: RunTrace | null = null;
  /** Per-turn sums for the closing budget span. */
  llmInput = 0;
  llmCacheRead = 0;
  private lastSent: Record<string, string> = {};
  private openStep: string | null = null;
  /** The role whose step is currently open, so a caller can avoid re-opening it. */
  get openStepName(): string | null {
    return this.openStep;
  }
  /** The exact stepName sent in STEP_STARTED: the agent's tier can change mid-run, so STEP_FINISHED must echo it verbatim. */
  private openStepLabel: string | null = null;
  /** When true, streamed prose is also collected as the draft answer the Critic checks. */
  trackDraft = false;
  draftText = "";
  /** TEXT_MESSAGE ids that carried the draft answer (a badge / superseded mark attaches to these). */
  draftIds: string[] = [];
  /** Role that usage is attributed to. */
  role: string | null = null;
  producedText = false;
  producedAny = false;

  constructor(
    readonly send: Send,
    readonly ctx: ThreadCtx,
    readonly sessionId: string,
    readonly plane: Plane = "shopper",
  ) {}

  get state() {
    return this.ctx.state;
  }

  snapshot() {
    this.send({ type: "STATE_SNAPSHOT", snapshot: this.state });
    this.lastSent = Object.fromEntries(Object.entries(this.state).map(([k, v]) => [k, JSON.stringify(v)]));
  }

  /** Emit a JSON-Patch STATE_DELTA for top-level keys that changed. */
  pushState() {
    const t0 = Date.now();
    const delta: { op: "add"; path: string; value: unknown }[] = [];
    for (const [k, v] of Object.entries(this.state)) {
      const s = JSON.stringify(v);
      if (this.lastSent[k] !== s) {
        delta.push({ op: "add", path: `/${k}`, value: v });
        this.lastSent[k] = s;
      }
    }
    if (delta.length) this.send({ type: "STATE_DELTA", delta });
    // Wave 0: the storefront subscribes to the same session; mirror agent-side changes there.
    if (delta.length && this.plane === "shopper") publishSession(this.sessionId, "agent", "agent run");
    if (delta.length) {
      const span = startKindSpan("state delta", "state", { "sparky.state.keys": delta.map((d) => d.path.slice(1)), "sparky.state.key_count": delta.length, "sparky.state.bytes": delta.reduce((n, d) => n + (this.lastSent[d.path.slice(1)]?.length ?? 0), 0), "sparky.state.storefront_sync": this.plane === "shopper" }, { startTime: t0 });
      endSpan(span, { "sparky.state.sync_ms": Date.now() - t0 });
    }
  }

  token(text: string) {
    if (!text) return;
    if (!this.msgId) {
      this.msgId = randomUUID();
      this.send({ type: "TEXT_MESSAGE_START", messageId: this.msgId, role: "assistant" });
      if (this.trackDraft) this.draftIds.push(this.msgId);
    }
    if (this.trackDraft) this.draftText += text;
    this.producedText = this.producedAny = true;
    this.send({ type: "TEXT_MESSAGE_CONTENT", messageId: this.msgId, delta: text });
  }

  /** A Planner/Critic/CaMeL role's own output, streamed into the run timeline (not the answer). */
  roleDelta(role: string, delta: string) {
    if (delta) this.send({ type: "CUSTOM", name: "role_stream", value: { role, delta } });
  }

  closeText() {
    if (this.msgId) this.send({ type: "TEXT_MESSAGE_END", messageId: this.msgId });
    this.msgId = null;
  }

  /** AG-UI STEP_STARTED for an agent role; also marks it running in state.agents. */
  startStep(name: string, tier: Tier, model?: string) {
    if (this.openStep) this.finishStep(this.openStep);
    this.closeText();
    this.openStep = name;
    this.role = name;
    this.openStepLabel = `${name} · ${tier}`;
    this.send({ type: "STEP_STARTED", stepName: this.openStepLabel });
    const a = this.state.agents.find((x) => x.name === name);
    if (a) Object.assign(a, { status: "running", tier, ...(model ? { model } : {}) });
    else this.state.agents.push({ name, tier, status: "running", ...(model ? { model } : {}) });
    this.pushState();
  }

  finishStep(name: string, status: "done" | "blocked" | "skipped" = "done", note?: string) {
    const a = this.state.agents.find((x) => x.name === name);
    if (a) Object.assign(a, { status, ...(note ? { note } : {}) });
    this.send({ type: "STEP_FINISHED", stepName: this.openStep === name && this.openStepLabel ? this.openStepLabel : `${name} · ${a?.tier ?? "—"}` });
    if (this.openStep === name) {
      this.openStep = null;
      this.openStepLabel = null;
    }
    this.pushState();
  }

  finishOpenStep() {
    if (this.openStep) this.finishStep(this.openStep);
  }

  private emitToolCall(id: string, name: string, args: unknown) {
    const parentMessageId = randomUUID();
    this.send({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name, parentMessageId });
    this.send({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args ?? {}) });
    this.send({ type: "TOOL_CALL_END", toolCallId: id });
  }

  /**
   * Note the call and let it proceed. Enforcement now happens inside policy-mcp, which is
   * the CLI's only MCP server: a refused call never reaches the tool, and its refusal
   * arrives here as a blocked tool RESULT. What this method contributes is the plan and
   * the pre-check note in the trace, not the decision.
   */
  toolUse(id: string, rawName: string, input: unknown): boolean {
    this.closeText();
    this.producedAny = true;
    if (this.plane === "ops") {
      const name = stripMcp(rawName);
      const m = opsToolMeta(name);
      if (this.openStep !== m.agent) this.startStep(m.agent, m.tier);
      markOpsActive(this.state, name);
      this.starts.set(id, { name, input, t0: Date.now(), blocked: [], span: this.toolSpan(name, input, m.tier) });
      this.emitToolCall(id, name, input);
      this.pushState();
      return true;
    }
    const name = shortTool(stripMcp(rawName));
    const price = this.ctx.prices.get(String((input as any)?.product_id ?? ""))?.price;
    const verdict = this.ctx.guard.checkCall(name, input, this.state, price);
    // Observability only. policy-mcp has already refused anything this would object to,
    // before the tool ran; this note just shows the BFF saw the same thing.
    const events = verdict.events.map((e) => ({ ...e, severity: "warn" as const, source: "bff" as const, message: `Pre-check (enforced at policy-mcp): ${e.message}` }));
    this.starts.set(id, { name, input, t0: Date.now(), blocked: verdict.events, span: this.toolSpan(name, input, null, verdict.events.length) });
    this.emitToolCall(id, name, input);
    if (advancePlan(this.state.beat, this.state.plan, name) || events.length) {
      this.state.guard_events.push(...events);
      this.pushState();
    }
    return true;
  }

  /** A `tool` span per MCP call the CLI made (started at tool_use, ended at tool_result). Args are hashed, never stored raw. */
  private toolSpan(name: string, input: unknown, tier: string | null, precheckEvents = 0) {
    const keys = input && typeof input === "object" ? Object.keys(input as object).sort() : [];
    return startKindSpan(`tool ${name}`, "tool", {
      "gen_ai.tool.name": name,
      "gen_ai.operation.name": "execute_tool",
      "sparky.tool.plane": this.plane,
      "sparky.tool.tier": tier,
      "sparky.tool.arg_keys": keys,
      "sparky.tool.args.sha256_16": sha16(input),
      "sparky.tool.precheck_events": precheckEvents,
      "sparky.tool.via": "claude-cli -> policy-mcp",
    });
  }

  pushGuard(events: GuardEvent[]) {
    const have = new Set(this.state.guard_events.map((g) => g.id));
    const fresh = events.filter((e) => !have.has(e.id));
    if (!fresh.length) return;
    this.state.guard_events.push(...fresh);
    const guardAgent = this.state.agents.find((a) => a.name === "Guard");
    if (guardAgent && fresh.some((e) => e.severity === "block")) Object.assign(guardAgent, { status: "blocked", note: fresh[fresh.length - 1].message });
    const step = this.state.plan.find((s) => /gate|cart/i.test(s.label));
    if (step && fresh.some((e) => e.severity === "block")) step.status = "blocked";
  }

  async toolResult(id: string, content: string, isError: boolean) {
    const start = this.starts.get(id);
    const name = start?.name ?? "tool";
    let data: any = null;
    try {
      data = JSON.parse(content);
      // FastMCP wraps a str-returning tool as {"result": "<json>"}; unwrap it.
      if (data && typeof data === "object" && Object.keys(data).length === 1 && typeof data.result === "string") {
        data = JSON.parse(data.result);
      }
    } catch {
      data = data && typeof data === "object" ? data : null;
    }
    this.send({ type: "TOOL_CALL_RESULT", messageId: randomUUID(), toolCallId: id, content: content.slice(0, 4000) || "(empty)", role: "tool" });
    this.state.trace.push({ id, tool: name, args: start?.input ?? {}, latency_ms: start ? Date.now() - start.t0 : 0, ok: !isError && !data?.error && !data?.blocked });
    if (start?.span) {
      const err = isError || data?.error ? String(data?.error ?? "tool error").slice(0, 200) : null;
      endSpan(start.span, {
        "sparky.tool.latency_ms": Date.now() - start.t0,
        "sparky.tool.result_chars": content.length,
        "sparky.tool.blocked": Boolean(data?.blocked),
        "sparky.tool.rule": data?.rule ? String(data.rule) : null,
        "sparky.tool.refused_by": data?.refused_by ? String(data.refused_by) : null,
        "sparky.tool.result_count": typeof data?.count === "number" ? data.count : Array.isArray(data?.results) ? data.results.length : null,
      }, data?.blocked ? null : err);
      if (err && !data?.blocked) {
        markSpan(`error tool ${name}`, "error", { "sparky.error.source": "tool", "sparky.error.tool": name, "sparky.error.unavailable": Boolean(data?.service_unavailable), "sparky.error.timeout": /timeout|timed out/i.test(err) }, contextWithSpan(start.span), err);
      }
    }

    if (this.plane === "ops") {
      if (data) {
        applyOpsResult(this.state, name, data);
        const hint = hintOf(data);
        if (hint) this.surface(hint, data);
      }
      this.pushState();
      return;
    }

    if (data?.blocked && data?.rule === "hitl.needs_approval") {
      // Wave 0b HITL: not a violation. The cart change becomes a proposal the shopper approves.
      const pid = String((start?.input as any)?.product_id ?? data.detail?.proposal?.product_id ?? "");
      const price = this.ctx.prices.get(pid)?.price ?? null;
      const title = this.ctx.prices.get(pid)?.title ?? this.state.cart.find((l) => l.product_id === pid)?.title ?? pid;
      const act = recordProposal(this.sessionId, { kind: name === "remove_from_cart" ? "cart_remove" : "cart_add", product_id: pid, title, qty: Number((start?.input as any)?.qty ?? 1) || 1, price, proposed_by: "agent", reason: "proposed by Compass in chat" });
      noteHitlShown(`action:${act.id}`, this.runTrace, "cart_proposal");
      this.pushState();
      return;
    }
    if (data?.blocked && data?.refused_by === "policy-mcp") {
      // The proxy refused before forwarding: the underlying tool never ran, nothing changed.
      const rule = String(data.rule ?? "policy");
      this.pushGuard([
        {
          id: randomUUID(),
          kind: (["injection", "qty_jump", "budget"].includes(rule) ? rule : rule.startsWith("capability") ? "capability" : "tool_denied") as GuardEvent["kind"],
          severity: "block",
          tool: name,
          source: "policy-mcp",
          rule,
          message: `Refused at policy-mcp before execution: ${data.reason}`,
        },
      ]);
    } else if (data?.blocked) {
      const evs: any[] = data.guard?.events ?? [{ id: `gd_${id}`, kind: "tool_denied", reason: data.reason }];
      this.pushGuard(evs.map((e) => ({ id: String(e.id), kind: (["injection", "qty_jump", "budget"].includes(e.kind) ? e.kind : "tool_denied") as GuardEvent["kind"], severity: "block", tool: name, source: "shop-mcp", message: `Blocked in tool path: ${e.reason}` })));
    }

    if (data) {
      this.state.guard_events.push(...this.ctx.guard.observeResult(name, data));
      applyToolResult(this.ctx, name, data);
      onAgentTool(this.sessionId, name, start?.input, data);
      if (name === "create_checkout_mandate" && data.mandate) {
        const co = this.state.agents.find((a) => a.name === "Checkout");
        if (co) co.note = "mandate pending human approval (T2)";
        if (data.mandate.id) noteHitlShown(`mandate:${data.mandate.id}`, this.runTrace, "checkout_mandate");
      }
      if (name === "plan_meal") {
        const plan = planFromMealTool(data);
        if (plan) await onPlanTool(this.sessionId, plan);
      }
      if (name === "compare_products" && Array.isArray(data.product_ids) && data.product_ids.length >= 2) {
        // Wave 0b compare mode: enrich with live quotes (price, stock), size + unit price and a recommendation.
        const rich: any = await compareFor(this.sessionId, data.product_ids.slice(0, 4)).catch(() => null);
        if (rich && rich.ok) {
          this.surface("compare_table", rich);
          this.pushState();
          return;
        }
      }
      const hint = hintOf(data);
      if (hint) this.surface(hint, data);
    }
    this.pushState();
  }

  surface(hint: NonNullable<ReturnType<typeof hintOf>>, data: any) {
    const surfaceId = `${hint}-${randomUUID().slice(0, 8)}`;
    const messages = (OPS_UI_HINTS as string[]).includes(hint) ? buildOpsA2ui(hint as any, data, surfaceId) : buildA2ui(hint, data, surfaceId);
    this.closeText();
    this.send({ type: "CUSTOM", name: "a2ui", value: { surfaceId, hint, messages } });
    const tcId = `a2ui_${surfaceId}`;
    this.emitToolCall(tcId, "render_a2ui", { surfaceId, hint, messages });
    this.send({ type: "TOOL_CALL_RESULT", messageId: randomUUID(), toolCallId: tcId, content: `rendered ${hint}`, role: "tool" });
  }

  usage(input: number, output: number, costUsd: number | null, role = this.role, cacheRead = 0) {
    this.llmInput += input;
    this.llmCacheRead += cacheRead;
    const cost = costUsd ?? (input * 3 + output * 15) / 1e6;
    this.state.tokens = { input: this.state.tokens.input + input, output: this.state.tokens.output + output };
    this.state.cost_usd = Math.round((this.state.cost_usd + cost) * 1e5) / 1e5;
    const a = role ? this.state.agents.find((x) => x.name === role) : undefined;
    if (a) {
      a.tokens = { input: (a.tokens?.input ?? 0) + input, output: (a.tokens?.output ?? 0) + output };
      a.cost_usd = Math.round(((a.cost_usd ?? 0) + cost) * 1e5) / 1e5;
    }
    this.pushState();
  }
}

function sse(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  return {
    send: (e: Record<string, unknown>) => reply.raw.write(`data: ${JSON.stringify({ ...e, timestamp: Date.now() })}\n\n`),
    end: () => reply.raw.end(),
  };
}

/** One tool-less, single-turn role call (Planner / Critic). Streams into the timeline; returns the result text or null. */
async function roleCall(run: AguiRun, role: string, model: string, systemPrompt: string, prompt: string, signal: AbortSignal): Promise<string | null> {
  let text: string | null = null;
  const res = await runClaudeCode({
    prompt,
    systemPrompt,
    model,
    maxTurns: 1,
    streamPartial: true,
    tools: "",
    role,
    thinking: false,
    signal,
    idleTimeoutMs: 60_000,
    sink: (e) => {
      if (e.type === "token") run.roleDelta(role, e.text);
      else if (e.type === "usage") {
        text = e.resultText;
        run.usage(e.input, e.output, e.costUsd, role, e.cacheRead);
      }
    },
  });
  return res.ok || text ? text : null;
}

async function shopperLive(run: AguiRun, question: string, client: NonNullable<RunInput["state"]>, threadId: string, signal: AbortSignal): Promise<{ ok: boolean; reason?: any; stderr?: string }> {
  const { ctx } = run;
  const s = ctx.state;
  const split = config.roleMode === "split";
  const policySince = policyMark();
  s.agents = rolesFor(s.beat);
  if (s.budget != null) void jfetch(`${config.shopHttpUrl}/sessions/${encodeURIComponent(threadId)}/budget`, { method: "POST", body: JSON.stringify({ budget: s.budget }) });

  // 0. Session budget (graceful degradation) and the rules-first intent router: no model call for either.
  const budget = budgetState(s.cost_usd, config.sessionCostBudgetUsd);
  if (budget.mode !== "normal") run.send({ type: "CUSTOM", name: "budget", value: budget });
  if (budget.mode === "exhausted") {
    for (const a of s.agents) if (a.status === "idle") Object.assign(a, { status: "skipped", note: "session model budget used" });
    run.pushState();
    run.token(`⏸️ ${budget.message}`);
    return { ok: true };
  }
  const economy = budget.mode === "economy";
  const tRoute = Date.now();
  const route = config.optimise.router ? routeIntent(question, s.beat) : { intent: "complex" as const, skipPlanner: false, tools: null, tier: "default" as const, reason: "router off" };
  endSpan(startKindSpan("router", "router", {
    "sparky.router.route": route.intent,
    "sparky.router.reason": route.reason,
    "sparky.router.enabled": config.optimise.router,
    "sparky.router.tier": route.tier,
    "sparky.router.planner_skipped": !(split && !route.skipPlanner && !economy),
    "sparky.router.critic_gate": config.optimise.criticGate ? "deferred: decided after the worker from the cart diff (see verifier span)" : "off: critic always considered",
    "sparky.router.allow_list_size": route.tools ? route.tools.length : -1,
    "sparky.router.economy": economy,
    "sparky.budget.mode": budget.mode,
  }, { startTime: tRoute }));
  setRunIntent(route.intent);
  run.send({ type: "CUSTOM", name: "role_summary", value: { role: "Router", text: `${route.intent}: ${route.reason}${economy ? " · economy mode" : ""}` } });
  const llmPlanner = split && !route.skipPlanner && !economy;

  // 1. Planner (T1, no tools)
  run.startStep("Planner", "T1", llmPlanner ? config.models.planner : "deterministic");
  if (llmPlanner) {
    const out = await roleCall(run, "Planner", config.models.planner, PLANNER_SYSTEM, plannerPrompt(question, s), signal);
    const plan = out ? parseJsonObject<{ steps?: string[]; constraints?: { key: string; value: string }[]; budget?: number | null }>(out) : null;
    applyPlannerLedger(s, plan);
    run.send({ type: "CUSTOM", name: "role_summary", value: { role: "Planner", text: plan?.steps?.length ? plan.steps.join(" → ") : s.plan.map((p) => p.label).join(" → ") } });
    if (!out) {
      const a = s.agents.find((x) => x.name === "Planner");
      if (a) a.note = "LLM planner unavailable; deterministic plan used";
    }
  } else {
    run.send({ type: "CUSTOM", name: "role_summary", value: { role: "Planner", text: `(deterministic${route.skipPlanner ? `, ${route.intent} intent` : economy ? ", economy mode" : ""}) ${s.plan.map((p) => p.label).join(" → ")}` } });
    const a = s.agents.find((x) => x.name === "Planner");
    if (a && (route.skipPlanner || economy)) Object.assign(a, { model: "deterministic", note: route.skipPlanner ? `skipped: ${route.reason}` : "economy mode" });
  }
  run.finishStep("Planner");

  // 2. Shopper, or Checkout (T2) on the mandate beat. Its only MCP server is policy-mcp,
  //    started in the matching role so it exposes only the tools that role may use.
  const worker = s.beat === 4 ? "Checkout" : "Shopper";
  const workerModel = route.tier === "cheap" || economy ? config.models.critic : config.models.shopper;
  run.startStep(worker, ROLE_TIERS[worker], workerModel);
  run.trackDraft = true;
  const cartBefore = cartKey(s.cart);
  const mcp = writePolicyMcpConfig(worker === "Checkout" ? "checkout" : "shopper", { hitl: Boolean(client.hitl), tools: route.tools });
  const pending: Promise<void>[] = [];
  const t0 = Date.now();
  const res = await runClaudeCode({
    prompt: buildPrompt(question, s, { rerank: client.rerank, imagePath: client.imagePath, sessionId: threadId, storeId: getSession(threadId).store_id, siteActivity: takeSiteActivity(threadId), extraContext: [
      ...memoryPromptLines(assistFor(threadId).memory),
      languageInstruction(detectLang(question)),
      ...(client.hitl ? ["Cart changes need the shopper's approval: add_to_cart/remove_from_cart return blocked=true with rule hitl.needs_approval. That is NOT an error: tell the shopper the change is proposed and waiting for their Approve click in the chat, and do not retry."] : []),
    ], diet: config.optimise.diet }),
    systemPrompt: SYSTEM_PROMPT,
    model: workerModel,
    role: worker,
    tools: client.imagePath ? "Read" : "",
    signal,
    // help needs no tools at all: no MCP server is started
    mcpConfigPath: route.tools && !route.tools.length ? undefined : mcp.path,
    allowedTools: route.tools ? [...route.tools.map((t) => `mcp__policy__${t}`), ...(client.imagePath ? ["Read"] : [])] : [...POLICY_TOOLS, ...(client.imagePath ? ["Read"] : [])],
    sink: (e: CliEvent) => {
      if (e.type === "token") run.token(e.text);
      else if (e.type === "tool_use") run.toolUse(e.id, e.name, e.input);
      else if (e.type === "tool_result") pending.push(run.toolResult(e.id, e.content, e.isError));
      else if (e.type === "usage") {
        run.usage(e.input, e.output, e.costUsd, worker, e.cacheRead);
        // A real sample for the FinOps router: wall clock plus the CLI's own cost figure.
        metrics.record("claude", { ms: Date.now() - t0, costUsd: e.costUsd ?? 0, inputTokens: e.input, outputTokens: e.output, label: `beat ${s.beat} ${worker}` });
      }
    },
  });
  await Promise.all(pending);
  mcp.cleanup();
  run.trackDraft = false;
  run.closeText();
  if (!(res.ok || run.producedAny) || !(run.draftText || s.trace.length || (route.tools && !route.tools.length))) {
    return { ok: false, reason: res.reason, stderr: res.stderrTail };
  }
  // Refusals policy-mcp recorded during this run. The CLI is the MCP client, so a call the
  // proxy refused may never have streamed past the BFF; the decision log closes that gap.
  run.pushGuard(toGuardEvents(readPolicyEvents({ sessionId: threadId, since: policySince })));
  // Blocks shop-mcp's own guard wrote to SQLite (a second, independent record).
  const g = await jfetch(`${config.shopHttpUrl}/guard/events/${encodeURIComponent(threadId)}`);
  if (g.ok && Array.isArray(g.data?.events)) {
    run.pushGuard(g.data.events.map((e: any) => ({ id: String(e.id), kind: ["injection", "qty_jump", "budget"].includes(e.kind) ? e.kind : "tool_denied", severity: "block", tool: e.tool, source: "shop-mcp", message: `Blocked in tool path: ${e.reason}` })));
  }
  const guard = s.agents.find((a) => a.name === "Guard");
  if (guard && guard.status === "idle") guard.status = "done";
  run.finishStep(worker, worker === "Checkout" && s.mandate?.status === "pending_approval" ? "blocked" : "done", worker === "Checkout" && s.mandate ? "awaiting human approval of the mandate" : undefined);

  // B09: the runtime session verifier checks the real cart against every stated constraint
  // (chat or site) and says what could not be done, before the Critic and the answer.
  try {
    await withKindSpan("verifier session", "verifier", { "sparky.verifier.stage": "session_verifier" }, async (span) => {
      const v = await runVerifier(threadId);
      if (v.could_not.length) run.surface("could_not_do", { could_not: v.could_not, verdict: v.verdict });
      endSpan(span, { "sparky.verifier.verdict": String(v.verdict), "sparky.verifier.could_not_do": v.could_not.length, "sparky.verifier.constraints": s.constraints.length });
      run.pushState();
    });
  } catch {
    /* verifier facts unavailable: the Critic still runs on the ledger */
  }

  // 3. Critic (T1, no tools) checks the cart and the streamed answer. Its verdict becomes a badge on
  //    that answer; a failed check keeps the draft visible as superseded and streams a revision below.
  const gate = config.optimise.criticGate ? criticNeeded({ cartBefore, cartAfter: cartKey(s.cart), answer: run.draftText, cartLines: s.cart.length, beat: s.beat, knownAmounts: cartAmounts(s.cart, s.cart_total, s.budget) }) : null;
  const v = await critic(run, question, split && !economy, signal, gate);
  const messageIds = [...run.draftIds];
  if (!v) {
    run.send({ type: "CUSTOM", name: "answer_verdict", value: { messageIds, verdict: "unchecked", note: gate && !gate.needed ? gate.reason : "no cart to check" } });
  } else if (v.verdict === "pass") {
    run.send({ type: "CUSTOM", name: "answer_verdict", value: { messageIds, verdict: "checked", note: v.note, issues: v.issues } });
  } else {
    run.send({ type: "CUSTOM", name: "answer_verdict", value: { messageIds, verdict: "revised", note: v.note, issues: v.issues } });
    if (!signal.aborted) await revise(run, question, v, signal);
  }
  return { ok: true };
}

/** Critic said fail: stream a corrected answer (no tools, it may not change the cart) below the superseded draft. */
async function revise(run: AguiRun, question: string, v: { note: string; issues: string[]; omissions: string[] }, signal: AbortSignal) {
  const s = run.state;
  run.startStep("Shopper", "T1", config.models.shopper);
  run.closeText();
  const before = new Set(run.draftIds);
  run.trackDraft = true;
  run.draftText = "";
  const cart = s.cart.map((l) => ({ id: l.product_id, title: l.title, qty: l.qty, price: l.price, sponsored: l.sponsored }));
  const t0 = Date.now();
  await runClaudeCode({
    prompt: [
      `Goal: ${question}`,
      `Constraint ledger: ${JSON.stringify(s.constraints)}; budget ${s.budget ?? "none"}; cart total $${s.cart_total.toFixed(2)}.`,
      `Cart now: ${JSON.stringify(cart)}`,
      `The Critic rejected your previous answer: ${v.note}`,
      ...(v.issues.length ? [`Issues:\n${v.issues.map((i) => `- ${i}`).join("\n")}`] : []),
      ...(v.omissions.length ? [`Omissions to state:\n${v.omissions.map((i) => `- ${i}`).join("\n")}`] : []),
      `Write the corrected answer for the shopper now, briefly. You have no tools and cannot change the cart: say plainly what is wrong and what they should change. Do not invent products or prices.`,
    ].join("\n"),
    systemPrompt: SYSTEM_PROMPT,
    model: config.models.shopper,
    maxTurns: 1,
    tools: "",
    role: "Shopper revision",
    signal,
    sink: (e) => {
      if (e.type === "token") run.token(e.text);
      else if (e.type === "usage") {
        run.usage(e.input, e.output, e.costUsd, "Shopper", e.cacheRead);
        metrics.record("claude", { ms: Date.now() - t0, costUsd: e.costUsd ?? 0, inputTokens: e.input, outputTokens: e.output, label: `beat ${s.beat} revision` });
      }
    },
  });
  run.trackDraft = false;
  run.closeText();
  run.send({ type: "CUSTOM", name: "answer_revised", value: { messageIds: run.draftIds.filter((id) => !before.has(id)) } });
  run.finishStep("Shopper");
}

async function critic(run: AguiRun, question: string, split: boolean, signal?: AbortSignal, gate?: { needed: boolean; reason: string } | null) {
  const s = run.state;
  const needed = gate ? gate.needed : s.cart.length > 0 || s.beat === 1 || s.beat === 7;
  if (!needed) {
    markSpan("verifier critic", "verifier", { "sparky.verifier.stage": "critic", "sparky.verifier.skipped": true, "sparky.verifier.skip_reason": gate?.reason ?? "no cart to check" });
    const a = s.agents.find((x) => x.name === "Critic");
    if (a) Object.assign(a, { status: "skipped", note: gate?.reason ?? "no cart to check" });
    run.send({ type: "CUSTOM", name: "role_summary", value: { role: "Critic", text: `skipped: ${gate?.reason ?? "no cart to check"}` } });
    run.pushState();
    return null;
  }
  run.startStep("Critic", "T1", split && signal ? config.models.critic : "deterministic");
  const criticSpan = startKindSpan("verifier critic", "verifier", { "sparky.verifier.stage": "critic", "sparky.verifier.skipped": false, "sparky.verifier.llm": Boolean(split && signal), "sparky.verifier.gate_reason": gate?.reason ?? null });
  const det = deterministicCritic(s);
  let llm = null;
  if (split && signal) {
    const out = await otelContext.with(contextWithSpan(criticSpan), () => roleCall(run, "Critic", config.models.critic, CRITIC_SYSTEM, criticPrompt(question, s, run.draftText), signal));
    llm = out ? parseJsonObject(out) : null;
  }
  const v = mergeVerdicts(det, llm);
  if (v.omissions.length) s.omissions = [...new Set([...s.omissions, ...v.omissions])];
  endSpan(criticSpan, { "sparky.verifier.verdict": v.verdict, "sparky.verifier.violations": v.issues.length, "sparky.verifier.omissions": v.omissions.length, "sparky.verifier.deterministic_violations": det.issues?.length ?? null, "sparky.verifier.llm_parsed": Boolean(llm), "sparky.verifier.revision": v.verdict !== "pass" && !signal?.aborted });
  run.send({ type: "CUSTOM", name: "role_summary", value: { role: "Critic", text: `${v.verdict}: ${v.note}${v.issues.length ? ` (${v.issues.join("; ")})` : ""}` } });
  run.finishStep("Critic", v.verdict === "pass" ? "done" : "blocked", v.note);
  return v;
}

export function aguiBridgeFor(plane: Plane) {
  return (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as RunInput;
    body.runId ??= randomUUID();
    return withRun(body.runId, () => aguiBridge(req, reply, plane), plane);
  };
}

export async function aguiBridge(req: FastifyRequest, reply: FastifyReply, plane: Plane = "shopper"): Promise<void> {
  const body = (req.body ?? {}) as RunInput;
  const threadId = body.threadId ?? randomUUID();
  const runId = body.runId ?? randomUUID();
  const ctx = getThread(threadId, plane);
  const client = body.state ?? {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const question = messageText([...messages].reverse().find((m) => m.role === "user")?.content).trim();

  // Beat + options come from the web's shared state.
  const beat = Number(client.beat ?? ctx.state.beat ?? (plane === "ops" ? 9 : 1)) || 1;
  ctx.state.beat = beat;
  ctx.state.plane = plane;
  ctx.state.plan = plane === "ops" ? [] : planFor(beat);
  if (plane === "shopper") {
    const before = ctx.state.constraints;
    const { constraints: parsed, budget } = constraintsFrom(question, ctx.state.constraints);
    const constraints = mergeConstraints(parsed, detectConstraints(question));
    noteConstraints(threadId, before, constraints, "chat", question);
    // Wave 0b memory: dietary needs said in chat are quarantined candidates, never memorised without confirmation.
    const mem = assistFor(threadId);
    const beforeMem = mem.memory.length;
    const had = new Set(before.map((c) => `${c.key}:${c.value}`));
    for (const c of inferFromConstraints(constraints.filter((x) => !had.has(`${x.key}:${x.value}`)))) mem.memory = addInferred(mem.memory, c.key, c.value, question);
    if (mem.memory.length !== beforeMem) saveSoon();
    ctx.state.constraints = constraints;
    if (budget != null) ctx.state.budget = budget;
  } else {
    ctx.state.ops.worse_candidate = Boolean(client.worseCandidate);
  }
  ctx.state.refusal = undefined;
  ctx.state.mode = "live";

  const ch = sse(reply);
  const run = new AguiRun(ch.send, ctx, threadId, plane);
  // Turn root span: every span of this turn (bff, policy-mcp, search-svc) shares its traceId.
  const turn = startKindSpan(`turn ${plane}`, "turn", {
    "sparky.session": threadId,
    "sparky.run_id": runId,
    "sparky.surface": plane,
    "sparky.layout": typeof (client as any).layout === "string" ? (client as any).layout : typeof body.forwardedProps?.layout === "string" ? (body.forwardedProps.layout as string) : "unreported",
    "sparky.beat": beat,
    "sparky.hitl": Boolean(client.hitl),
    "sparky.question.sha256_16": question ? sha16(question) : null,
    "sparky.question.chars": question.length,
  });
  const turnCtx = contextWithSpan(turn);
  ch.send({ type: "RUN_STARTED", threadId, runId });
  if (turn) {
    const { traceId, spanId } = turn.spanContext();
    run.runTrace = { runId, traceId, spanId, threadId, plane, beat, ts: new Date().toISOString() };
    recordRunTrace({ runId, traceId, spanId, threadId, plane, beat });
    const replayRunId = (req as any).replayRunId as string | undefined;
    if (replayRunId && replayRunId !== runId) recordRunTrace({ runId: replayRunId, traceId, spanId, threadId, plane, beat });
    turn.setAttribute("sparky.replay_run_id", replayRunId ?? "");
    ch.send({ type: "CUSTOM", name: "trace", value: { traceId, spanId, runId, replayRunId: replayRunId ?? null } });
  }
  run.snapshot();

  const ac = new AbortController();
  active.get(threadId)?.abort();
  active.set(threadId, ac);
  const hard = setTimeout(() => ac.abort(), config.hardTimeoutMs);
  // Abort only when the SSE client disconnects (req.raw "close" fires once the body is read).
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) ac.abort();
  });

  try {
   await otelContext.with(turnCtx, async () => {
    // ---- Health gate. Nothing is substituted when a dependency is missing: the beat refuses
    //      and names the service, its port and the command that fixes it.
    const outages = outagesFor(plane, await diag());
    if (question && outages.length) {
      const lines = outages.map(outageLine);
      ctx.state.mode = "refused";
      ctx.state.refusal = {
        reason: "service-unavailable",
        message: `This beat needs ${outages.map((o) => o.name).join(", ")}.`,
        outages,
      };
      run.pushState();
      run.token(
        [
          `⛔ **Cannot run this beat.** ${outages.length} required service ${outages.length === 1 ? "is" : "are"} unavailable:`,
          ...lines.map((l) => `- ${l}`),
          "",
          "Nothing was substituted — every number in this demo comes from a live service, so the run stops here rather than showing you something invented.",
        ].join("\n"),
      );
    } else if (!question) {
      run.token(plane === "ops" ? "Pick an ops beat (8a / 8b / 8c) or ask about drift, evals or releases." : "Pick a beat on the left or ask me to shop for something.");
    } else if (plane === "ops") {
      await runOps(run, question, client, ac.signal, req);
    } else if (beat === 7) {
      // Trust & safety runs on the CaMeL path: a privileged planner that never reads the
      // seller text, a quarantined extractor with no tools, and an executor that calls
      // policy-mcp. The planted injection is refused at the proxy, not flagged afterwards.
      await shopperCamel(run, question, threadId, ac.signal);
    } else {
      const r = await shopperLive(run, question, client, threadId, ac.signal);
      if (!r.ok) {
        ctx.state.mode = "refused";
        ctx.state.refusal = { reason: (r.reason ?? "empty-output") as any, message: `The Claude CLI did not complete this run (${r.reason ?? "empty output"}).`, outages: [] };
        req.log.warn({ reason: r.reason, stderr: r.stderr }, "claude-code run failed; refusing (there is no substitute path)");
        run.pushState();
        run.token(`\n\n⛔ **Run refused.** The Claude CLI did not complete: \`${r.reason ?? "empty output"}\`. ${r.stderr ? `\n\n\`${r.stderr.slice(0, 300)}\`` : ""}\n\nThere is no substitute path, so nothing is shown rather than something invented.`);
      }
    }
    run.finishOpenStep();
    run.closeText();
    finishPlan(ctx.state.plan);
    if (ctx.state.mode === "refused") {
      markSpan("error refusal", "error", { "sparky.error.source": "turn", "sparky.error.reason": String(ctx.state.refusal?.reason ?? "refused"), "sparky.error.outages": ctx.state.refusal?.outages?.length ?? 0, "sparky.error.timeout": ctx.state.refusal?.reason === "timeout" }, undefined, String(ctx.state.refusal?.reason ?? "refused"));
    }
    const left = config.sessionCostBudgetUsd != null ? Math.round((Number(config.sessionCostBudgetUsd) - ctx.state.cost_usd) * 1e5) / 1e5 : null;
    markSpan("budget turn", "budget", {
      "sparky.budget.mode": budgetState(ctx.state.cost_usd, config.sessionCostBudgetUsd).mode,
      "sparky.budget.left_usd": left,
      "sparky.budget.session_cost_usd": ctx.state.cost_usd,
      "sparky.cache.read_ratio": run.llmInput ? Math.round((run.llmCacheRead / run.llmInput) * 1000) / 1000 : null,
      "sparky.cache.read_tokens": run.llmCacheRead,
      "sparky.cache.input_tokens": run.llmInput,
      "sparky.cache.response_hit": false,
      "sparky.cache.response_cache": "not used on the turn path (follow-ups/starters/compare only)",
    });
    run.snapshot();
    ch.send({ type: "RUN_FINISHED", threadId, runId });
   });
  } catch (err) {
    req.log.error(err, "agui run failed");
    markSpan("error run", "error", { "sparky.error.source": "bridge", "sparky.error.aborted": ac.signal.aborted }, turnCtx, String((err as Error)?.message ?? err));
    run.closeText();
    ch.send({ type: "RUN_ERROR", message: String((err as Error)?.message ?? err) });
  } finally {
    endSpan(turn, { "sparky.mode": String(ctx.state.mode), "sparky.aborted": ac.signal.aborted, "sparky.cost_usd_session": ctx.state.cost_usd, "sparky.trace_rows": ctx.state.trace.length, "sparky.answer_chars": run.draftText.length || null });
    clearTimeout(hard);
    if (active.get(threadId) === ac) active.delete(threadId);
    ch.end();
  }
}

/**
 * Ops plane. Every tool call goes through policy-mcp in the `ops` role, which applies the
 * tier limits (a T2 tool needs a human approval recorded in ops-http) before forwarding.
 * Beat 8c is a deterministic router by design and is computed here from measured numbers.
 */
async function runOps(run: AguiRun, question: string, client: NonNullable<RunInput["state"]>, signal: AbortSignal, req: FastifyRequest) {
  const s = run.state;
  const phase = client.opsPhase;
  const worse = Boolean(client.worseCandidate);
  const policySince = policyMark();

  if (s.beat === 10) {
    // FinOps router: no LLM on this path. The numbers are measured in finops.ts or refused.
    const id = `call_${randomUUID().slice(0, 12)}`;
    run.startStep("FinOps Router", "T1", "deterministic");
    run.toolUse(id, "finops_router", { sample_size: 24 });
    const r = await finopsRouter({ sampleSize: 24 });
    await run.toolResult(id, JSON.stringify(r), Boolean(r.error));
    if (r.blocked) run.token(`\n⛔ ${r.error}\n`);
    run.finishStep("FinOps Router", r.blocked ? "blocked" : "done");
    return;
  }

  const mcp = writePolicyMcpConfig("ops");
  const pending: Promise<void>[] = [];
  const t0 = Date.now();
  const res = await runClaudeCode({
    prompt: buildOpsPrompt(question, s, { phase, worse }),
    systemPrompt: OPS_SYSTEM_PROMPT,
    model: config.models.ops,
    role: "Ops Copilot",
    tools: "",
    signal,
    mcpConfigPath: mcp.path,
    allowedTools: POLICY_TOOLS,
    sink: (e: CliEvent) => {
      if (e.type === "token") run.token(e.text);
      else if (e.type === "tool_use") run.toolUse(e.id, e.name, e.input);
      else if (e.type === "tool_result") pending.push(run.toolResult(e.id, e.content, e.isError));
      else if (e.type === "usage") {
        run.usage(e.input, e.output, e.costUsd, run.role ?? "Ops Copilot", e.cacheRead);
        metrics.record("claude", { ms: Date.now() - t0, costUsd: e.costUsd ?? 0, inputTokens: e.input, outputTokens: e.output, label: `ops beat ${s.beat}` });
      }
    },
  });
  await Promise.all(pending);
  mcp.cleanup();
  run.pushGuard(toGuardEvents(readPolicyEvents({ since: policySince })));

  if (!((res.ok || run.producedAny) && s.trace.length > 0)) {
    s.mode = "refused";
    s.refusal = { reason: (res.reason ?? "no-tools") as any, message: "The Ops Copilot run did not complete.", outages: [] };
    req.log.warn({ reason: res.reason, stderr: res.stderrTail }, "ops run failed; refusing (there is no substitute path)");
    run.pushState();
    run.token(`\n\n⛔ **Run refused.** ops tools did not complete: \`${res.reason ?? "no output"}\`.${res.stderrTail ? ` \n\n\`${res.stderrTail.slice(0, 300)}\`` : ""}\n\nNothing was simulated in its place.`);
  }
}

/**
 * Beat 7 on the CaMeL path (technique 36). See agents/camel.ts: the privileged planner
 * never sees untrusted text, the quarantined extractor has no tools, and every call the
 * executor makes goes through policy-mcp, which refuses before the tool runs.
 */
async function shopperCamel(run: AguiRun, question: string, threadId: string, signal: AbortSignal) {
  const s = run.state;
  s.agents = [
    { name: "Privileged planner", tier: "T1", status: "idle", model: config.models.planner, note: "never reads untrusted text" },
    { name: "Quarantined LLM", tier: "T0", status: "idle", model: config.models.critic, note: "no tools at all" },
    { name: "Executor", tier: "T1", status: "idle", model: "deterministic" },
    { name: "Guard", tier: "—", status: "idle", model: "policy-mcp (pre-execution)" },
  ];
  run.pushState();
  if (s.budget != null) void jfetch(`${config.shopHttpUrl}/sessions/${encodeURIComponent(threadId)}/budget`, { method: "POST", body: JSON.stringify({ budget: s.budget }) });

  run.startStep("Privileged planner", "T1", config.models.planner);
  const t0 = Date.now();
  const result = await runCamel({
    question,
    sessionId: threadId,
    state: s,
    role: "shopper",
    signal,
    onDelta: (role, delta) => run.roleDelta(role, delta),
    onUsage: (i, o, c, role) => {
      run.usage(i, o, c, role === "Privileged planner" ? "Privileged planner" : "Quarantined LLM");
      metrics.record("claude", { ms: Date.now() - t0, costUsd: c ?? 0, inputTokens: i, outputTokens: o, label: `camel ${role}` });
    },
    onCall: async (tool, args, res) => {
      if (run.openStepName !== "Executor") run.startStep("Executor", "T1", "deterministic");
      const id = `camel_${randomUUID().slice(0, 12)}`;
      run.toolUse(id, tool, args);
      await run.toolResult(id, JSON.stringify(res), Boolean(res?.error));
    },
  });

  s.camel = result.trace;
  run.pushGuard(result.guardEvents);
  const guard = s.agents.find((a) => a.name === "Guard");
  if (guard) Object.assign(guard, { status: result.blocked ? "blocked" : "done", note: result.blocked ? `${result.blocked} call(s) refused at policy-mcp` : "no refusal needed" });
  for (const name of ["Privileged planner", "Quarantined LLM", "Executor"]) {
    const a = s.agents.find((x) => x.name === name);
    if (a && a.status !== "done") a.status = "done";
  }
  run.finishOpenStep();
  run.token(`\n\n${result.summary}\n`);
  run.pushState();
}

/** Save an uploaded photo (data URL) to a temp file so Claude can Read it. */
export function saveUpload(dataUrl: string, name = "photo"): string {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new Error("expected base64 image data URL");
  const ext = m[1].split("/")[1].replace("jpeg", "jpg").replace(/\+.*/, "");
  mkdirSync(config.uploadsDir, { recursive: true });
  const safe = name.replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "photo";
  const path = `${config.uploadsDir}/${Date.now()}-${safe}.${ext}`;
  writeFileSync(path, Buffer.from(m[2], "base64"), { mode: 0o600 });
  return path;
}
