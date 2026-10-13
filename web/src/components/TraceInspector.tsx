/**
 * LLM observability panel for one turn — the Inspector's Trace tab.
 *
 * Everything is read from `GET /api/traces/run/:runId?detail=full`, i.e. from the spans the turn
 * actually wrote (docs/TRACING.md). Nothing is estimated or back-filled: a value no span reported
 * renders as "not reported", and reasoning tokens always read "not reported by the CLI" with the
 * thinking setting beside them, because the Claude CLI does not report them.
 *
 * The column is ~440px on the plane routes and can be 390px on a phone, so every row is a stacked
 * grid rather than a wide table, and long text collapses behind a "Show" toggle with a copy button.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, Check, ChevronRight, Clock, Copy, Database, Eye, EyeOff, Gavel, ScrollText, ShieldCheck, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, KeyValue, SectionLabel } from "@/components/states";
import { ProvenanceChip } from "@/components/Provenance";
import { fetchRunDetail, fetchTracingConfig, setCapture, type Generation, type OtherSpan, type RunDetail, type ToolCall, type TracingStatus } from "@/lib/traceDetail";

// ------------------------------------------------------------------ small shared pieces

const nfmt = (v: number | null | undefined) => (v == null ? null : v.toLocaleString());
const ms = (v: number | null | undefined) => (v == null ? null : `${Math.round(v).toLocaleString()} ms`);
const usd = (v: number | null | undefined) => (v == null ? null : `$${v < 0.01 ? v.toFixed(5) : v.toFixed(4)}`);

/** One label/value pair. A null value renders the honest reason, never a zero. */
function Field({ label, value, missing = "not reported", tone, testId }: { label: string; value: string | null; missing?: string; tone?: "ok" | "warn" | "bad"; testId?: string }) {
  return (
    <div className="grid min-w-0 gap-0.5" data-testid={testId}>
      <span className="text-2xs font-medium tracking-wide text-fg-muted uppercase">{label}</span>
      <span className={cn("tabular truncate text-xs font-semibold", value == null && "font-normal text-fg-muted", tone === "ok" && "text-ok", tone === "warn" && "text-warn", tone === "bad" && "text-bad")} title={value ?? missing}>
        {value ?? missing}
      </span>
    </div>
  );
}

function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      data-testid={testId}
      aria-label={done ? `${label} copied` : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {done ? <Check aria-hidden className="text-ok" /> : <Copy aria-hidden />}
    </Button>
  );
}

/** Long text: collapsed by default, expandable, always copyable. */
function LongText({ text, label, chars, truncated, testId }: { text: string; label: string; chars?: number | null; truncated?: boolean; testId?: string }) {
  const [open, setOpen] = useState(text.length <= 400);
  return (
    <div className="grid gap-1.5" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-2xs font-medium tracking-wide text-fg-muted uppercase">{label}</span>
        <span className="tabular text-2xs text-fg-muted">{(chars ?? text.length).toLocaleString()} chars</span>
        {truncated && (
          <Badge size="sm" tone="warn" title={`Only the first part was stored (${text.length.toLocaleString()} chars kept).`}>
            truncated
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-1">
          {text.length > 400 && (
            <Button size="xs" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? "Collapse" : "Show"}
            </Button>
          )}
          <CopyButton text={text} label={label} />
        </span>
      </div>
      <pre className={cn("m-0 overflow-x-auto rounded-md bg-code-bg px-2 py-1.5 font-mono text-2xs break-words whitespace-pre-wrap text-code-fg", !open && "line-clamp-4")}>{text}</pre>
    </div>
  );
}

const statusTone = (s: { status: string; ok?: boolean | null }) => (s.status === "error" || s.ok === false ? "bad" : "ok");

function OkDot({ ok, label }: { ok: boolean; label: string }) {
  return <span aria-label={label} role="img" title={label} className={cn("size-2 flex-none rounded-full", ok ? "bg-ok" : "bg-bad")} />;
}

// ------------------------------------------------------------------ generations

const GEN_TABS = [
  { id: "prompt", label: "Prompt" },
  { id: "output", label: "Output" },
  { id: "tokens", label: "Tokens & cost" },
  { id: "meta", label: "Metadata" },
] as const;

function GenerationRow({ g, traceId, index }: { g: Generation; traceId: string; index: number }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<(typeof GEN_TABS)[number]["id"]>("prompt");
  const ok = g.ok !== false && g.status !== "error";
  return (
    <li className={cn("grid gap-1.5 rounded-md border px-2.5 py-2", ok ? "border-line" : "border-bad/50 bg-bad-soft/40")} data-testid="trace-generation">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="trace-generation-toggle"
        className="grid w-full gap-1 text-left"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ChevronRight aria-hidden className={cn("size-3.5 flex-none text-fg-subtle transition-transform", open && "rotate-90")} />
          <OkDot ok={ok} label={ok ? "call succeeded" : "call failed"} />
          <span className="text-xs font-semibold" data-testid="trace-generation-role">
            {index + 1}. {g.role ?? g.name}
          </span>
          <code className="truncate text-2xs text-fg-muted">{g.model ?? "model not reported"}</code>
          <span className="tabular ml-auto text-2xs text-fg-muted">{usd(g.cost_usd) ?? "cost n/r"}</span>
        </span>
        <span className="tabular flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-2xs text-fg-muted" data-testid="trace-generation-tokens">
          <span>in {nfmt(g.tokens.input) ?? "n/r"}</span>
          <span>out {nfmt(g.tokens.output) ?? "n/r"}</span>
          <span>cache {nfmt(g.tokens.cache_read) ?? "n/r"}</span>
          <span>ttft {ms(g.ttft_ms) ?? "n/r"}</span>
          <span>{ms(g.duration_ms)}</span>
          <span className="truncate">{g.stop_reason ?? "stop n/r"}</span>
        </span>
      </button>
      {open && (
        <div className="grid gap-2 border-t border-line pt-2">
          <div role="tablist" aria-label={`Call ${index + 1} detail`} className="flex flex-wrap gap-1">
            {GEN_TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={tab === t.id}
                data-testid={`trace-gen-tab-${t.id}`}
                onClick={() => setTab(t.id)}
                className={cn("rounded-full px-2 py-0.5 text-2xs font-medium", tab === t.id ? "bg-accent text-accent-fg" : "bg-surface-sunken text-fg-muted hover:text-fg")}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === "prompt" && (
            <div className="grid gap-2" data-testid="trace-gen-prompt">
              {g.prompt.text ? (
                <LongText text={g.prompt.text} label="Rendered prompt" chars={g.prompt.chars} truncated={g.prompt.truncated} testId="trace-prompt-text" />
              ) : (
                <p className="m-0 text-xs text-fg-muted">
                  Prompt text was not captured for this call{g.prompt.sha256_16 ? <> · sha256_16 <code className="text-2xs">{g.prompt.sha256_16}</code>{g.prompt.chars != null ? ` · ${g.prompt.chars.toLocaleString()} chars` : ""}</> : null}.
                </p>
              )}
              {g.system_prompt.text ? (
                <LongText text={g.system_prompt.text} label={`System prompt · ${g.system_prompt.version ?? "version n/r"}`} chars={g.system_prompt.chars} truncated={g.system_prompt.truncated} testId="trace-system-prompt" />
              ) : (
                <div className="flex flex-wrap items-center gap-1.5 text-2xs text-fg-muted" data-testid="trace-system-prompt">
                  <span className="font-medium">System prompt</span>
                  <code>{g.system_prompt.version ?? "version n/r"}</code>
                  {g.system_prompt.sha256_16 && <code>sha {g.system_prompt.sha256_16}</code>}
                </div>
              )}
            </div>
          )}
          {tab === "output" &&
            (g.output.text ? (
              <LongText text={g.output.text} label="Output" chars={g.output.chars} truncated={g.output.truncated} testId="trace-output-text" />
            ) : (
              <p className="m-0 text-xs text-fg-muted" data-testid="trace-output-text">
                Output text was not captured for this call{g.output.sha256_16 ? <> · sha256_16 <code className="text-2xs">{g.output.sha256_16}</code></> : null}.
              </p>
            ))}
          {tab === "tokens" && (
            <div className="grid grid-cols-2 gap-2" data-testid="trace-gen-tokens">
              <Field label="Input (total)" value={nfmt(g.tokens.input)} />
              <Field label="Output" value={nfmt(g.tokens.output)} />
              <Field label="Uncached input" value={nfmt(g.tokens.uncached_input)} />
              <Field label="Cache read" value={nfmt(g.tokens.cache_read)} />
              <Field label="Cache creation" value={nfmt(g.tokens.cache_creation)} />
              <Field label="Cache read share" value={g.tokens.cache_read_ratio == null ? null : `${Math.round(g.tokens.cache_read_ratio * 100)}%`} />
              <Field label="Cost" value={usd(g.cost_usd)} />
              <Field label="TTFT" value={ms(g.ttft_ms)} />
              <Field label="Stream" value={ms(g.stream_ms)} />
              <Field label="Total" value={ms(g.total_ms ?? g.duration_ms)} />
              <div className="col-span-2" data-testid="trace-reasoning-row">
                <Field label="Reasoning tokens" value={g.reasoning_tokens_available ? null : "not reported by the CLI"} />
                <p className="m-0 text-2xs text-fg-muted">
                  Extended thinking: <span className="font-medium">{g.thinking ?? "not reported"}</span>. The Claude CLI's usage does not break out reasoning tokens, so none are shown — nothing is estimated.
                </p>
              </div>
            </div>
          )}
          {tab === "meta" && (
            <div className="grid gap-2" data-testid="trace-gen-meta">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Role" value={g.role} />
                <Field label="Intent" value={g.intent} />
                <Field label="Request model" value={g.model} />
                <Field label="Response model" value={g.response_model} />
                <Field label="Stop reason" value={g.stop_reason} />
                <Field label="Tool calls" value={nfmt(g.tool_calls)} />
                <Field label="Service" value={g.service} />
                <Field label="Status" value={g.ok === false || g.status === "error" ? (g.error_reason ?? "error") : "ok"} tone={statusTone(g)} />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-2xs text-fg-muted">span</span>
                <code className="text-2xs break-all">{g.span_id}</code>
                <Link to={`/ops/traces/${traceId}`} className="text-2xs font-medium text-accent underline-offset-4 hover:underline" data-testid="trace-gen-span-link">
                  open in waterfall
                </Link>
              </div>
              <KeyValue data={g.attrs} limit={40} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ tool + other spans

function ToolRow({ t, traceId }: { t: ToolCall; traceId: string }) {
  const [open, setOpen] = useState(false);
  const ok = t.status !== "error" && t.blocked !== true;
  return (
    <li className={cn("grid gap-1 rounded-md border px-2.5 py-1.5", ok ? "border-line" : "border-bad/50 bg-bad-soft/40")} data-testid="trace-tool-row">
      <button type="button" className="grid w-full gap-0.5 text-left" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ChevronRight aria-hidden className={cn("size-3.5 flex-none text-fg-subtle transition-transform", open && "rotate-90")} />
          <OkDot ok={ok} label={ok ? "tool ok" : "tool blocked or failed"} />
          <code className="truncate text-2xs font-semibold">{t.name}</code>
          <span className="tabular ml-auto text-2xs text-fg-muted">{ms(t.latency_ms ?? t.duration_ms)}</span>
        </span>
        <span className="tabular flex flex-wrap gap-x-2 pl-5 text-2xs text-fg-muted">
          <span>{t.service}</span>
          {t.result_count != null && <span>{t.result_count} results</span>}
          {t.result_bytes != null && <span>{t.result_bytes.toLocaleString()} B</span>}
          {t.tier && <span>tier {t.tier}</span>}
          {t.blocked === true && <span className="text-bad">blocked{t.rule ? ` · ${t.rule}` : ""}</span>}
        </span>
      </button>
      {open && (
        <div className="grid gap-1.5 border-t border-line pt-1.5">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Latency" value={ms(t.latency_ms)} />
            <Field label="Span duration" value={ms(t.duration_ms)} />
            <Field label="Result count" value={nfmt(t.result_count)} />
            <Field label="Result bytes" value={nfmt(t.result_bytes)} />
            <Field label="Refused by" value={t.refused_by} missing="not refused" />
            <Field label="Error" value={t.error} missing="none" tone={t.error ? "bad" : undefined} />
          </div>
          {t.args_text ? (
            <LongText text={t.args_text} label="Arguments" testId="trace-tool-args" />
          ) : (
            <div className="grid gap-0.5 text-2xs text-fg-muted" data-testid="trace-tool-args">
              <span className="font-medium tracking-wide text-fg-muted uppercase">Arguments</span>
              <span>
                {Array.isArray(t.arg_keys) ? `keys: ${(t.arg_keys as string[]).join(", ")}` : typeof t.arg_keys === "string" ? `keys: ${t.arg_keys}` : "argument keys not reported"}
                {t.args_sha256_16 ? ` · sha256_16 ${t.args_sha256_16}` : ""}
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <code className="text-2xs break-all">{t.span_id}</code>
            <Link to={`/ops/traces/${traceId}`} className="text-2xs font-medium text-accent underline-offset-4 hover:underline" data-testid="trace-tool-span-link">
              open span
            </Link>
          </div>
        </div>
      )}
    </li>
  );
}

const ATTR_HINTS: Record<string, string[]> = {
  retrieval: ["sparky.retrieval.mode", "sparky.retrieval.k", "sparky.retrieval.rerank_count", "sparky.retrieval.zero_result"],
  policy: ["sparky.policy.tool", "sparky.policy.decision", "sparky.policy.rule", "sparky.policy.injection_flag"],
  hitl: ["sparky.hitl.subject", "sparky.hitl.decision", "sparky.hitl.wait_ms", "sparky.hitl.outcome"],
  verifier: ["sparky.verifier.stage", "sparky.verifier.verdict", "sparky.verifier.skipped", "sparky.verifier.revision"],
};

function SpanRows({ spans, kind, icon: Icon, title, traceId }: { spans: OtherSpan[]; kind: string; icon: LucideIcon; title: string; traceId: string }) {
  if (!spans.length) return null;
  const keys = ATTR_HINTS[kind] ?? [];
  return (
    <section className="grid gap-1.5 border-b border-line px-4 py-3 last:border-b-0">
      <SectionLabel icon={Icon} aside={<span className="tabular text-2xs text-fg-muted">{spans.length}</span>}>
        {title}
      </SectionLabel>
      <ul className="m-0 grid list-none gap-1 p-0">
        {spans.map((s) => (
          <li key={s.span_id} className="grid gap-0.5 rounded-md border border-line px-2.5 py-1.5" data-testid={`trace-${kind}-row`}>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <OkDot ok={s.status !== "error"} label={s.status} />
              <code className="truncate text-2xs font-semibold">{s.name}</code>
              <span className="tabular ml-auto text-2xs text-fg-muted">{ms(s.duration_ms)}</span>
            </span>
            <span className="flex flex-wrap gap-x-2 pl-3.5 text-2xs text-fg-muted">
              <span>{s.service}</span>
              {keys.filter((k) => s.attrs[k] != null).map((k) => (
                <span key={k}>
                  {k.split(".").pop()} {String(s.attrs[k])}
                </span>
              ))}
              <Link to={`/ops/traces/${traceId}`} className="font-medium text-accent underline-offset-4 hover:underline">
                span
              </Link>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ capture banner

function CaptureBanner({ tracing, onChange }: { tracing: TracingStatus | null; onChange: (t: TracingStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const on = tracing?.capture_text ?? false;
  return (
    <div className="grid gap-1 border-b border-line bg-surface-sunken px-4 py-2.5" data-testid="trace-capture-banner">
      <div className="flex flex-wrap items-center gap-2">
        {on ? <Eye aria-hidden className="size-4 text-accent" /> : <EyeOff aria-hidden className="size-4 text-fg-muted" />}
        <span className="text-xs font-semibold">Prompt & output capture {on ? "on" : "off"}</span>
        <Button
          size="xs"
          variant={on ? "secondary" : "primary"}
          disabled={busy}
          data-testid="trace-capture-toggle"
          aria-pressed={on}
          onClick={() => {
            setBusy(true);
            setErr(null);
            void setCapture(!on)
              .then((r) => {
                if (r?.ok && r.tracing) onChange(r.tracing);
                else setErr(r?.error ?? "the bff refused the change");
              })
              .catch((e) => setErr(String(e?.message ?? e)))
              .finally(() => setBusy(false));
          }}
          className="ml-auto"
        >
          {on ? "Turn off" : "Turn on"}
        </Button>
      </div>
      <p className="m-0 text-2xs text-fg-muted">
        {on
          ? `Text is masked (emails, long digit runs, secret-like tokens) and capped at ${((tracing?.capture_text_max_bytes ?? 8192) / 1024).toFixed(0)} KB per field before it is written to data/traces. It never reaches data/token_ledger.jsonl. Turning it off applies to the next turn; text already captured stays in the trace store.`
          : "Spans keep only a sha256_16 and a character count for prompts and outputs. Turn capture on to read the exact text of the next turn."}
      </p>
      {err && (
        <p className="m-0 text-2xs text-bad" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ panel

export function TraceDetailPanel({ runId, verdict }: { runId: string | null; verdict?: string | null }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [tracing, setTracing] = useState<TracingStatus | null>(null);
  const [prov, setProv] = useState<{ service: string; endpoint: string; timestamp: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchTracingConfig()
      .then((r) => {
        if (r?.ok) setTracing(r.tracing);
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    if (!runId) return;
    setLoading(true);
    fetchRunDetail(runId)
      .then((r) => {
        if (r?.ok && r.detail) {
          setDetail(r.detail);
          setErr(null);
          if (r.tracing) setTracing(r.tracing);
          if (r.provenance) setProv(r.provenance);
        } else setErr(r?.error ?? "no trace detail for this run");
      })
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [runId]);

  // Spans are flushed at the end of the turn, so poll briefly while the detail is still thin.
  useEffect(() => {
    setDetail(null);
    setErr(null);
    if (!runId) return;
    load();
    const t = setInterval(load, 4000);
    const stop = setTimeout(() => clearInterval(t), 30_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [runId, load]);

  // The capture switch is a setting, not a property of a run: it is shown before the first turn too.
  if (!runId)
    return (
      <div className="grid" data-testid="trace-panel">
        <CaptureBanner tracing={tracing} onChange={setTracing} />
        <div className="px-4 py-3.5">
          <EmptyState icon={ScrollText}>Run a turn to see its LLM calls, prompts, tokens and cost here.</EmptyState>
        </div>
      </div>
    );

  const t = detail?.totals;
  const turnAttrs = detail?.turn?.attrs ?? {};
  const router = detail?.router?.[0]?.attrs ?? {};
  const intent = (router["sparky.router.route"] as string) ?? detail?.generations.find((g) => g.intent)?.intent ?? null;
  const reason = (router["sparky.router.reason"] as string) ?? null;

  return (
    <div className="grid" data-testid="trace-panel">
      <CaptureBanner tracing={tracing} onChange={setTracing} />
      <section className="grid gap-2 border-b border-line px-4 py-3" data-testid="trace-turn-header">
        <SectionLabel
          icon={Clock}
          aside={
            detail ? (
              <Badge size="sm" tone={t && t.errors > 0 ? "bad" : "ok"}>
                {t && t.errors > 0 ? `${t.errors} error(s)` : "ok"}
              </Badge>
            ) : null
          }
        >
          This turn
        </SectionLabel>
        {err && !detail && (
          <p className="m-0 text-xs text-fg-muted" role="status" data-testid="trace-detail-error">
            {loading ? "Loading trace…" : err}
          </p>
        )}
        {detail && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Intent" value={intent} testId="trace-intent" />
              <Field label="Verdict" value={verdict ?? ((detail.verifier[0]?.attrs["sparky.verifier.verdict"] as string) ?? null)} testId="trace-verdict" />
              <Field label="Tokens in" value={nfmt(t?.input_tokens)} testId="trace-tokens-in" />
              <Field label="Tokens out" value={nfmt(t?.output_tokens)} testId="trace-tokens-out" />
              <Field label="Cache read" value={t?.cache_read_tokens == null ? null : `${nfmt(t.cache_read_tokens)}${t.cache_read_ratio != null ? ` · ${Math.round(t.cache_read_ratio * 100)}%` : ""}`} testId="trace-tokens-cache" />
              <Field label="Cost" value={usd(t?.cost_usd)} testId="trace-cost" />
              <Field label="TTFT" value={ms(t?.ttft_ms)} testId="trace-ttft" />
              <Field label="Total" value={ms(t?.total_ms)} testId="trace-total-ms" />
            </div>
            {reason && <p className="m-0 text-2xs text-fg-muted" data-testid="trace-route-reason">Route: {reason}</p>}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-2xs text-fg-muted">trace</span>
              <code className="min-w-0 flex-1 truncate text-2xs" data-testid="trace-id" title={detail.trace_id}>
                {detail.trace_id}
              </code>
              <CopyButton text={detail.trace_id} label="trace id" testId="trace-copy-id" />
              <Link to={`/ops/traces/${detail.trace_id}`} className="text-2xs font-medium text-accent underline-offset-4 hover:underline" data-testid="trace-view-link">
                View trace
              </Link>
            </div>
            <p className="m-0 text-2xs text-fg-muted" data-testid="trace-span-count">
              {detail.span_count} spans · {Object.entries(detail.kind_counts).map(([k, n]) => `${n} ${k}`).join(" · ")}
              {turnAttrs["sparky.surface"] ? ` · ${String(turnAttrs["sparky.surface"])}` : ""}
            </p>
            {prov && (
              <div>
                <ProvenanceChip provenance={{ service: prov.service, endpoint: prov.endpoint, timestamp: prov.timestamp, note: "assembled from the spans this turn wrote" }} compact />
              </div>
            )}
          </>
        )}
      </section>
      {detail && (
        <section className="grid gap-1.5 border-b border-line px-4 py-3">
          <SectionLabel icon={ScrollText} aside={<span className="tabular text-2xs text-fg-muted">{detail.generations.length} calls</span>}>
            Generations
          </SectionLabel>
          {detail.generations.length === 0 ? (
            <EmptyState icon={ScrollText}>No model call was recorded on this trace.</EmptyState>
          ) : (
            <ul className="m-0 grid list-none gap-1.5 p-0" data-testid="trace-generations">
              {detail.generations.map((g, i) => (
                <GenerationRow key={g.span_id} g={g} index={i} traceId={detail.trace_id} />
              ))}
            </ul>
          )}
          <p className="m-0 text-2xs text-fg-muted" data-testid="trace-reasoning-note">
            Reasoning tokens: not reported by the CLI · thinking {t?.thinking ?? "not reported"}
          </p>
        </section>
      )}
      {detail && detail.tools.length > 0 && (
        <section className="grid gap-1.5 border-b border-line px-4 py-3">
          <SectionLabel icon={Wrench} aside={<span className="tabular text-2xs text-fg-muted">{detail.tools.length}</span>}>
            Tool calls
          </SectionLabel>
          <ul className="m-0 grid list-none gap-1 p-0">
            {detail.tools.map((tc) => (
              <ToolRow key={tc.span_id} t={tc} traceId={detail.trace_id} />
            ))}
          </ul>
        </section>
      )}
      {detail && (
        <>
          <SpanRows spans={detail.retrieval} kind="retrieval" icon={Database} title="Retrieval" traceId={detail.trace_id} />
          <SpanRows spans={detail.policy} kind="policy" icon={ShieldCheck} title="Policy decisions" traceId={detail.trace_id} />
          <SpanRows spans={detail.hitl} kind="hitl" icon={Gavel} title="Human decisions" traceId={detail.trace_id} />
          <SpanRows spans={detail.verifier} kind="verifier" icon={Check} title="Verifier & Critic" traceId={detail.trace_id} />
          {detail.errors.length > 0 && <SpanRows spans={detail.errors} kind="error" icon={AlertTriangle} title="Errors" traceId={detail.trace_id} />}
        </>
      )}
    </div>
  );
}
