/**
 * Local Claude Code provider, adapted from rnd-trust-graph bff/src/llm/claudeCode.ts.
 *
 * Spawns `claude -p --output-format stream-json --verbose --include-partial-messages`
 * with the prompt on STDIN, parses NDJSON from stdout and emits normalised events:
 *   token        text_delta from the streaming partial messages
 *   tool_use     an MCP tool call the model made (deduped by id)
 *   tool_result  the tool's result, paired by tool_use_id
 *   usage        tokens + cost from the terminal `result` event (exactly once)
 *
 * Gotchas carried over:
 *  - the canonical final answer only comes from `result`; assistant text blocks can
 *    repeat, so we never emit them as prose.
 *  - ENABLE_TOOL_SEARCH=false so MCP tools load up front as mcp__shop__* names.
 *  - ~/.local/bin is prepended to PATH in config.ts.
 * Never throws: resolves {ok:false, reason} so the caller can fall back.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { RefusalReason } from "@sparky/shared";
import { config } from "../config.js";
import { appendLedger, currentIntent } from "./ledger.js";
import { ATTR, captureContent, captureText, contextWithSpan, endSpan, markSpan, otelContext, redact, sha256_16, startKindSpan, textAttrs, traceparentOf, tracingActive } from "../otel.js";
import { TRACE_DIR } from "../trace/jsonl.js";

export type CliEvent =
  | { type: "token"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; isError: boolean }
  | {
      type: "usage";
      /** Total input incl. cache read + cache creation (what the prompt actually cost in tokens). */
      input: number;
      output: number;
      costUsd: number | null;
      resultText: string;
      /** Uncached input, cache hits and cache writes, as the CLI reports them. */
      uncachedInput?: number;
      cacheRead?: number;
      cacheCreation?: number;
      /** The CLI's terminal reason (stop_reason when present, else the result subtype). */
      stopReason?: string;
    };

export type Sink = (event: CliEvent) => void;

export interface CliLineState {
  produced: boolean;
  seenToolUse: Set<string>;
  seenToolResult: Set<string>;
}

export function newCliLineState(): CliLineState {
  return { produced: false, seenToolUse: new Set(), seenToolResult: new Set() };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("");
  }
  return "";
}

/** Handle ONE parsed stdout JSON event. Pure (no I/O), so it is unit-testable. */
export function handleCliLine(
  evt: any,
  opts: { sink: Sink; streamPartial?: boolean },
  state: CliLineState,
): void {
  const { sink, streamPartial } = opts;

  if (evt?.type === "stream_event") {
    if (!streamPartial) return;
    const inner = evt.event;
    if (inner?.type === "content_block_delta" && inner?.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
      state.produced = true;
      sink({ type: "token", text: inner.delta.text });
    }
    return;
  }

  if (evt?.type === "assistant" && Array.isArray(evt?.message?.content)) {
    for (const block of evt.message.content) {
      if (block?.type === "tool_use" && block.id && !state.seenToolUse.has(block.id)) {
        state.seenToolUse.add(block.id);
        sink({ type: "tool_use", id: String(block.id), name: String(block.name ?? ""), input: block.input ?? {} });
      }
    }
    return;
  }

  if (evt?.type === "user" && Array.isArray(evt?.message?.content)) {
    for (const block of evt.message.content) {
      if (block?.type === "tool_result" && block.tool_use_id && !state.seenToolResult.has(block.tool_use_id)) {
        state.seenToolResult.add(block.tool_use_id);
        sink({
          type: "tool_result",
          id: String(block.tool_use_id),
          content: toolResultText(block.content),
          isError: Boolean(block.is_error),
        });
      }
    }
    return;
  }

  if (evt?.type === "result" && evt?.subtype === "success" && typeof evt?.result === "string" && evt.result) {
    state.produced = true;
    if (!streamPartial) sink({ type: "token", text: evt.result });
    const u = evt.usage ?? {};
    sink({
      type: "usage",
      input:
        Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
      output: Number(u.output_tokens ?? 0),
      costUsd: typeof evt.total_cost_usd === "number" ? evt.total_cost_usd : null,
      resultText: evt.result,
      uncachedInput: Number(u.input_tokens ?? 0),
      cacheRead: Number(u.cache_read_input_tokens ?? 0),
      cacheCreation: Number(u.cache_creation_input_tokens ?? 0),
      stopReason: String(evt.stop_reason ?? evt.subtype ?? "success"),
    });
  }
}

export interface ClaudeCodeResult {
  ok: boolean;
  reason?: RefusalReason;
  stderrTail?: string;
  /** ms from spawn to the first streamed text token (null when nothing streamed). */
  firstTokenMs?: number | null;
  totalMs?: number;
}

export function classify(stderr: string, timedOut: boolean, hadTools: boolean): RefusalReason {
  const s = stderr.toLowerCase();
  if (/not recognized|command not found|cannot find|enoent|spawn error/.test(s)) return "spawn-failed";
  if (/not logged in|please run .*login|unauthorized|invalid api key|authentication/.test(s)) return "not-authenticated";
  if (hadTools && /mcp|uv|server.*fail|failed to connect|no such file/.test(s)) return "no-tools";
  if (timedOut) return "timeout";
  return "empty-output";
}

export interface ClaudeCodeRunOpts {
  prompt: string;
  sink: Sink;
  signal: AbortSignal;
  mcpConfigPath?: string;
  allowedTools?: string[];
  maxTurns?: number;
  idleTimeoutMs?: number;
  model?: string;
  streamPartial?: boolean;
  /** Built-in Claude Code tools to expose. Default "" = none (MCP tools only). */
  tools?: string;
  /** Replaces the (large) default Claude Code system prompt. */
  systemPrompt?: string;
  /** Ledger role (Planner, Shopper, Critic, followups, ...). */
  role?: string;
  /** Explicit run id for the ledger (otherwise the AsyncLocalStorage run context). */
  runId?: string;
  /** false = MAX_THINKING_TOKENS=0 (no extended thinking) for short JSON roles. Default: CLI default. */
  thinking?: boolean;
  /** Router intent for this turn, recorded on the span and the ledger line. */
  intent?: string;
}

/** Quote one arg for the shell only where we need a shell (Windows .cmd shim). */
const USE_SHELL = process.platform === "win32";
const q = (a: string) => (USE_SHELL ? JSON.stringify(a) : a);

/**
 * Build CLI args. Cost controls (a beat used ~343k input tokens / $0.41 before):
 *  --tools ""                 drop every built-in tool schema (Bash, Edit, Task, ...)
 *  --system-prompt            short role prompt instead of the default agent prompt
 *  --strict-mcp-config        only our MCP server (no user/plugin servers)
 *  --setting-sources ""       no user/project settings: no plugins, hooks, skills listing
 *  --disable-slash-commands   no skills catalogue in context
 *  --no-session-persistence   nothing written to ~/.claude/projects
 */
export function buildArgs(opts: Omit<ClaudeCodeRunOpts, "prompt" | "sink" | "signal">): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--max-turns", String(opts.maxTurns ?? config.maxTurns), "--model", opts.model ?? config.model];
  args.push("--tools", q(opts.tools ?? ""));
  if (opts.systemPrompt) args.push("--system-prompt", q(opts.systemPrompt));
  if (config.leanCli) args.push("--setting-sources", q(""), "--disable-slash-commands", "--no-session-persistence");
  if (opts.mcpConfigPath) args.push("--mcp-config", q(opts.mcpConfigPath), "--strict-mcp-config");
  else args.push("--strict-mcp-config");
  if (opts.allowedTools?.length) args.push("--allowedTools", q(opts.allowedTools.join(",")));
  if (opts.streamPartial ?? true) args.push("--include-partial-messages");
  return args;
}

/**
 * W3C trace context into the per-run MCP config. The CLI, not the BFF, is policy-mcp's MCP client,
 * so there is no request we could stamp `_meta.traceparent` on: policy-mcp is spawned per CLI run,
 * and TRACEPARENT in its env is the one propagation point that is real. Exported for tests.
 */
export function injectTraceparent(mcpConfigPath: string, traceparent: string) {
  try {
    const cfg = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
    for (const srv of Object.values<any>(cfg.mcpServers ?? {})) {
      srv.env = { ...(srv.env ?? {}), TRACEPARENT: traceparent, TRACE_FILE: "1", SPARKY_TRACE_DIR: TRACE_DIR, ...(captureContent() ? { OTEL_CAPTURE_CONTENT: "1" } : {}) };
    }
    writeFileSync(mcpConfigPath, JSON.stringify(cfg), { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* the run proceeds untraced below the CLI rather than failing over telemetry */
  }
}

export function runClaudeCode(opts: ClaudeCodeRunOpts): Promise<ClaudeCodeResult> {
  const role = opts.role ?? "unlabelled";
  const sysHash = opts.systemPrompt ? sha256_16(opts.systemPrompt) : null;
  const span = startKindSpan(`llm ${role}`, "llm", {
    [ATTR.operation]: "chat",
    [ATTR.providerName]: "anthropic",
    [ATTR.requestModel]: opts.model ?? config.model,
    "sparky.role": role,
    "sparky.llm.thinking": opts.thinking === false && config.optimise.thinkingOff ? "off" : "cli-default",
    "sparky.llm.max_turns": opts.maxTurns ?? config.maxTurns,
    "sparky.llm.tools_allowed": opts.allowedTools?.length ?? 0,
    "sparky.llm.system_prompt.sha256_16": sysHash,
    /** Content-addressed prompt version: there is no separate registry, the hash IS the version. */
    "sparky.llm.system_prompt.version": sysHash ? `sp-${sysHash.slice(0, 8)}` : null,
    "sparky.llm.system_prompt.chars": opts.systemPrompt?.length ?? null,
    ...(captureText() && opts.systemPrompt ? textAttrs("sparky.llm.system_prompt", opts.systemPrompt) : {}),
    "sparky.intent": opts.intent ?? currentIntent(),
    /** The Claude CLI does not report reasoning/thinking tokens. We record that fact; we never estimate them. */
    "sparky.llm.reasoning_tokens_available": false,
    "sparky.llm.capture_text": captureText(),
    ...redact(opts.prompt),
  });
  if (span && opts.mcpConfigPath) injectTraceparent(opts.mcpConfigPath, traceparentOf(span)!);
  if (!span) return runClaudeCodeInner(opts, null);
  // Spawn inside the span's context: the child's stdout callbacks (and so every sink event, tool spans included) inherit it.
  return otelContext.with(contextWithSpan(span), () => runClaudeCodeInner(opts, span));
}

function runClaudeCodeInner(opts: ClaudeCodeRunOpts, span: ReturnType<typeof startKindSpan>): Promise<ClaudeCodeResult> {
  const { prompt, sink, signal, mcpConfigPath, allowedTools } = opts;
  const hadTools = Boolean(allowedTools?.length);
  const idleMs = opts.idleTimeoutMs ?? config.idleTimeoutMs;
  const streamPartial = opts.streamPartial ?? true;

  return new Promise<ClaudeCodeResult>((resolve) => {
    const args = buildArgs({ ...opts, mcpConfigPath, allowedTools, streamPartial });

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.claudeBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: USE_SHELL,
        env: { ...process.env, ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH ?? "false", ...(opts.thinking === false && config.optimise.thinkingOff ? { MAX_THINKING_TOKENS: "0" } : {}) },
      });
    } catch {
      resolve({ ok: false, reason: "spawn-failed" });
      return;
    }

    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      /* close handler resolves */
    }

    const state = newCliLineState();
    const t0 = Date.now();
    let firstTokenMs: number | null = null;
    let usage: Extract<CliEvent, { type: "usage" }> | null = null;
    const tapped: Sink = (e) => {
      if (e.type === "token" && firstTokenMs == null) firstTokenMs = Date.now() - t0;
      if (e.type === "usage") usage = e;
      sink(e);
    };
    let settled = false;
    let timedOut = false;
    let buf = "";
    let stderr = "";

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      signal.removeEventListener("abort", onAbort);
      try {
        child.kill();
      } catch {
        /* gone */
      }
      const totalMs = Date.now() - t0;
      const u = usage as Extract<CliEvent, { type: "usage" }> | null;
      appendLedger({
        role: opts.role ?? "unlabelled",
        model: opts.model ?? config.model,
        input_tokens: u?.uncachedInput ?? 0,
        output_tokens: u?.output ?? 0,
        cache_read_input_tokens: u?.cacheRead ?? 0,
        cache_creation_input_tokens: u?.cacheCreation ?? 0,
        cost_usd: u?.costUsd ?? null,
        first_token_ms: firstTokenMs,
        total_ms: totalMs,
        ok: ok || Boolean(u),
        run_id: opts.runId,
        trace_id: span ? span.spanContext().traceId : null,
        span_id: span ? span.spanContext().spanId : null,
        intent: opts.intent ?? currentIntent(),
        tool_calls: state.seenToolUse.size,
      });
      if (span && tracingActive()) {
        const inTotal = u?.input ?? 0;
        const reason = ok ? null : classify(stderr, timedOut, hadTools);
        endSpan(span, {
          [ATTR.responseModel]: opts.model ?? config.model,
          [ATTR.inputTokens]: inTotal,
          [ATTR.outputTokens]: u?.output ?? 0,
          "sparky.llm.uncached_input_tokens": u?.uncachedInput ?? 0,
          "sparky.llm.cache_read_tokens": u?.cacheRead ?? 0,
          "sparky.llm.cache_creation_tokens": u?.cacheCreation ?? 0,
          "sparky.llm.cache_read_ratio": inTotal ? Math.round(((u?.cacheRead ?? 0) / inTotal) * 1000) / 1000 : null,
          "sparky.cost_usd": u?.costUsd ?? null,
          "sparky.llm.ttft_ms": firstTokenMs,
          "sparky.llm.stream_ms": firstTokenMs != null ? totalMs - firstTokenMs : null,
          "sparky.llm.total_ms": totalMs,
          "sparky.llm.stop_reason": u?.stopReason ?? (timedOut ? "timeout" : "no-result"),
          "sparky.llm.aborted": signal.aborted,
          "sparky.llm.timed_out": timedOut && !signal.aborted,
          "sparky.llm.tool_calls": state.seenToolUse.size,
          "sparky.llm.ok": ok || Boolean(u),
          "sparky.llm.error_reason": ok || u ? null : reason,
          /** Not reported by the Claude CLI's `result` usage. Never estimated. */
          "sparky.llm.reasoning_tokens_available": false,
          ...(captureText() && u?.resultText ? textAttrs("sparky.llm.output", u.resultText) : {}),
          ...(u?.resultText ? { "sparky.llm.output.sha256_16": sha256_16(u.resultText), "sparky.llm.output.chars": u.resultText.length } : {}),
        }, ok || u ? null : reason);
        if (!(ok || u)) {
          markSpan(`error llm ${opts.role ?? "unlabelled"}`, "error", {
            "sparky.error.source": "claude-cli",
            "sparky.error.reason": reason,
            "sparky.error.timeout": timedOut && !signal.aborted,
            "sparky.error.aborted": signal.aborted,
            "sparky.error.stderr_tail.sha256_16": stderr ? createHash("sha256").update(stderr).digest("hex").slice(0, 16) : null,
          }, contextWithSpan(span), reason);
        }
      }
      if (ok) return resolve({ ok: true, firstTokenMs, totalMs });
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      resolve({ ok: false, reason: classify(stderr, timedOut, hadTools), stderrTail: tail, firstTokenMs, totalMs });
    };

    let idle = setTimeout(() => {
      timedOut = true;
      finish(state.produced);
    }, idleMs);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        timedOut = true;
        finish(state.produced);
      }, idleMs);
    };
    const onAbort = () => {
      timedOut = true;
      finish(state.produced);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    child.stdout?.on("data", (c: Buffer) => {
      bump();
      buf += c.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let evt: unknown;
        try {
          evt = JSON.parse(t);
        } catch {
          continue;
        }
        handleCliLine(evt, { sink: tapped, streamPartial }, state);
      }
    });
    child.on("error", (err) => {
      stderr += `\nspawn error: ${String((err as Error)?.message ?? err)}`;
      finish(false);
    });
    child.on("close", () => finish(state.produced));
  });
}
