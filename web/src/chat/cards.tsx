/**
 * Inline chat cards (Wave 0b). Every card is bound to live data: session state from the bff SSE
 * stream, the AG-UI run timeline, or a bff response. Nothing is filled in client-side.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Activity, AlertTriangle, Check, ChevronDown, Clock, ExternalLink, ListChecks, Loader2, RotateCcw, ShieldCheck, ThumbsDown, ThumbsUp, Undo2, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { api, getSessionId } from "@/store/session";
import type { MissionPlan, PendingAction } from "@/store/types";
import { money } from "@/store/ui";
import type { RunRecord } from "./runs";

export const SYNTHETIC = "synthetic commerce data (ESCI has no price or stock)";
const S = () => `/api/session/${encodeURIComponent(getSessionId())}`;

export function announce(text: string) {
  const el = document.getElementById("sparky-chat-announcer");
  if (el) {
    el.textContent = "";
    window.setTimeout(() => (el.textContent = text), 30);
  }
}

function CardShell({ title, icon, children, className, testid, tone = "default" }: { title: React.ReactNode; icon?: React.ReactNode; children: React.ReactNode; className?: string; testid?: string; tone?: "default" | "warn" | "accent" }) {
  return (
    <section
      data-testid={testid}
      className={cn(
        "grid gap-2 rounded-xl border bg-surface p-3 text-sm shadow-xs",
        tone === "warn" ? "border-warn/50" : tone === "accent" ? "border-accent/40" : "border-line",
        className,
      )}
    >
      <h3 className="m-0 flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

/* ---------------- 1. run timeline ---------------- */

export function RunTimeline({ run, dense }: { run: RunRecord; dense?: boolean }) {
  const [open, setOpen] = useState(false);
  const ms = (run.finishedAt ?? Date.now()) - run.startedAt;
  const live = run.roles?.[run.roles.length - 1];
  const id = `tl-${run.runId}`;
  return (
    <div data-testid="run-timeline" className="grid gap-1 text-xs">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex w-fit items-center gap-1.5 rounded-full border border-line bg-surface-sunken px-2.5 py-1 font-medium text-fg-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        {run.agentId === "ops" ? "How Ops Copilot worked" : "How Compass worked"}
        <span className="font-mono" data-testid="run-latency">
          · {(ms / 1000).toFixed(1)}s
        </span>
        <span className="font-mono" data-testid="run-cost">
          · {run.costUsd != null ? `$${run.costUsd.toFixed(4)}` : run.status === "running" ? "cost pending" : "cost n/a"}
        </span>
        {run.tools.length > 0 && <span>· {run.tools.length} tool call{run.tools.length === 1 ? "" : "s"}</span>}
        {run.firstTokenAt != null && (
          <span className="font-mono" data-testid="run-first-token">
            · first token {((run.firstTokenAt - run.startedAt) / 1000).toFixed(1)}s
          </span>
        )}
      </button>
      {run.traceId && (
        <Link data-testid="view-trace" to={`/ops/traces/${run.traceId}`} className="inline-flex w-fit items-center gap-1 text-2xs font-medium text-accent-soft-fg underline-offset-4 hover:underline">
          <Activity className="size-3" aria-hidden />
          View trace
        </Link>
      )}
      {run.status === "running" && live && (
        <p data-testid="role-stream" className="m-0 truncate font-mono text-2xs text-fg-muted" aria-hidden>
          {live.role}: {live.summary ?? live.text.replace(/\s+/g, " ").slice(-140)}
        </p>
      )}
      {open && (
        <div id={id} className={cn("grid gap-2 rounded-lg border border-line bg-surface p-2.5", dense && "text-sm")}>
          {!!run.roles?.length && (
            <ul className="m-0 grid list-none gap-1 p-0" aria-label="Role output">
              {run.roles.map((r, i) => (
                <li key={i} data-testid="timeline-role" className="grid gap-0.5 rounded-md bg-surface-sunken p-2">
                  <span className="font-semibold">{r.role}</span>
                  {r.summary && <span>{r.summary}</span>}
                  {r.text && <pre className="m-0 max-h-32 overflow-auto font-mono text-2xs whitespace-pre-wrap text-fg-muted">{r.text}</pre>}
                </li>
              ))}
            </ul>
          )}
          <ol className="m-0 grid list-none gap-1 p-0" aria-label="Plan steps">
            {run.steps.map((s, i) => (
              <li key={i} className="flex items-center gap-2">
                <ListChecks className="size-3.5 text-accent" aria-hidden />
                <span className="font-medium">{s.name}</span>
                <span className="font-mono text-fg-muted">{s.ms != null ? `${(s.ms / 1000).toFixed(1)}s` : "running"}</span>
              </li>
            ))}
          </ol>
          {run.tools.length > 0 && (
            <ul className="m-0 grid list-none gap-1.5 p-0" aria-label="Tool calls">
              {run.tools.map((t) => (
                <li key={t.id} className="grid gap-0.5 rounded-md bg-surface-sunken p-2" data-testid="timeline-tool">
                  <div className="flex items-center gap-2">
                    <Wrench className="size-3.5" aria-hidden />
                    <span className="font-mono font-semibold">{t.name}</span>
                    <span className="font-mono text-fg-muted">{t.ms != null ? `${t.ms} ms` : "…"}</span>
                    {t.ok === false && <span className="font-semibold text-bad">refused / error</span>}
                  </div>
                  <details>
                    <summary className="cursor-pointer text-fg-muted">args and result</summary>
                    <pre className="m-0 mt-1 max-h-40 overflow-auto rounded bg-code-bg p-1.5 font-mono text-2xs whitespace-pre-wrap text-code-fg">{`args ${t.args}\nresult ${t.result.slice(0, 1200)}`}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="size-3.5" aria-hidden />
            <span data-testid="critic-verdict">Critic: {run.critic ? `${run.critic.verdict}${run.critic.note ? ` · ${run.critic.note}` : ""}` : "not run this turn"}</span>
            {run.tokens && (
              <span className="font-mono text-fg-muted">
                {run.tokens.input} in / {run.tokens.output} out tokens
              </span>
            )}
          </div>
          <Link to={`/ops/replay/${encodeURIComponent(run.runId)}`} className="inline-flex w-fit items-center gap-1 text-accent underline-offset-4 hover:underline">
            <ExternalLink className="size-3.5" aria-hidden />
            Open operator replay for this run
          </Link>
        </div>
      )}
    </div>
  );
}

/* ---------------- 4. citations ---------------- */

interface Claim {
  product_id: string;
  attribute: string;
  tier: "T1" | "T2" | "T3";
  source: string;
  text: string;
  uncertain: boolean;
  href: string;
}

const tierTone: Record<string, string> = { T1: "border-ok/50 bg-ok-soft", T2: "border-info/50 bg-info-soft", T3: "border-warn/60 bg-warn-soft" };

export function Citations({ productIds }: { productIds: string[] }) {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = productIds.slice(0, 2).join(",");
  useEffect(() => {
    let live = true;
    Promise.all(productIds.slice(0, 2).map((p) => api.get<{ claims: Claim[] }>(`${S()}/citations/${encodeURIComponent(p)}`)))
      .then((rs) => live && setClaims(rs.flatMap((r) => r.claims.filter((c) => c.attribute !== "bullets").slice(0, 3))))
      .catch((e) => live && setErr(String(e.message ?? e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (err) return <p className="m-0 text-xs text-bad">Sources unavailable: {err}</p>;
  if (!claims) return <p className="m-0 text-xs text-fg-muted">Loading sources…</p>;
  if (!claims.length) return null;
  return (
    <div className="grid gap-1" data-testid="citations">
      <span className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">Grounded in the product pages</span>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {claims.map((c, i) => (
          <li key={i}>
            <Link
              to={c.href}
              data-testid="claim-chip"
              data-tier={c.tier}
              title={`${c.tier} · ${c.source}`}
              className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-fg no-underline hover:underline focus-visible:outline-2 focus-visible:outline-focus", tierTone[c.tier])}
            >
              <span className="font-mono font-semibold">{c.tier}</span>
              <span className={cn(c.uncertain && "italic")}>{c.text.slice(0, 70)}</span>
              <span className="sr-only">. Source: {c.source}. Opens product attribute.</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------- 7. HITL approvals ---------------- */

export function ApprovalCard({ a }: { a: PendingAction }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (d: "approve" | "reject" | "undo") => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`${S()}/actions/${a.id}/${d}`);
      announce(d === "approve" ? `Approved: ${a.title}` : d === "reject" ? `Rejected: ${a.title}` : `Undone: ${a.title}`);
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const verb = a.kind === "cart_remove" ? "Remove from cart" : "Add to cart";
  const short = a.title.slice(0, 60);
  return (
    <CardShell testid="approval-card" tone={a.status === "pending" ? "accent" : "default"} icon={<ShieldCheck className="size-4 text-accent" aria-hidden />} title={a.status === "pending" ? `${a.proposed_by === "reorder" ? "Reorder" : "Compass"} proposes: ${verb}` : `${verb}: ${a.status}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {short} × {a.qty}
        </span>
        <span className="font-mono">{a.price != null ? money(a.price * a.qty) : "price unverified"}</span>
      </div>
      <p className="m-0 text-xs text-fg-muted">
        {a.reason} · {SYNTHETIC}
      </p>
      {err && (
        <p role="alert" className="m-0 text-xs text-bad">
          {err}
        </p>
      )}
      <div className="flex flex-wrap gap-2" data-status={a.status}>
        {a.status === "pending" && (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => act("approve")} aria-label={`Approve: ${verb} ${short}`}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}Approve
            </Button>
            <Button size="sm" disabled={busy} onClick={() => act("reject")} aria-label={`Reject: ${verb} ${short}`}>
              <X aria-hidden />
              Reject
            </Button>
          </>
        )}
        {a.status === "approved" && (
          <Button size="sm" disabled={busy} onClick={() => act("undo")} aria-label={`Undo: ${verb} ${short}`}>
            <Undo2 aria-hidden />
            Undo
          </Button>
        )}
        {a.status === "failed" && <span className="text-xs text-bad">Could not apply: {a.note}</span>}
      </div>
    </CardShell>
  );
}

/* ---------------- 6. mission planner ---------------- */

export function PlanCard({ plan }: { plan: MissionPlan }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [alts, setAlts] = useState<Record<string, { product_id: string; title: string; price: number | null }[]>>({});
  const call = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      announce(msg);
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(null);
    }
  };
  const total = plan.lines.reduce((a, l) => a + (l.price ?? 0) * l.qty, 0);
  const v = plan.verifier;
  return (
    <CardShell testid="plan-card" tone="accent" icon={<ListChecks className="size-4 text-accent" aria-hidden />} title={`Mission plan: ${plan.goal}`}>
      <p className="m-0 text-xs text-fg-muted">
        From {plan.source}. Edit, swap or remove lines before anything reaches your cart. {SYNTHETIC}.
      </p>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {plan.lines.map((l) => (
          <li key={l.id} data-testid="plan-line" className="grid gap-1 rounded-lg border border-line p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium" title={l.title}>
                <span className="text-fg-muted">{l.ingredient}: </span>
                {l.title}
              </span>
              <span className="font-mono">{money(l.price)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-xs">
                Qty
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={l.qty}
                  disabled={plan.status !== "draft" || busy != null}
                  aria-label={`Quantity for ${l.ingredient}`}
                  onChange={(e) => {
                    const q = Number(e.target.value);
                    if (q >= 1 && q <= 5) void call(l.id, () => api.put(`${S()}/plan/lines/${l.id}`, { qty: q }), `Quantity for ${l.ingredient} set to ${q}; verifier re-ran`);
                  }}
                  className="h-7 w-14 rounded-md border border-line bg-surface-raised px-1.5 text-fg"
                />
              </label>
              {alts[l.id] ? (
                <label className="flex items-center gap-1 text-xs">
                  Swap to
                  <select
                    aria-label={`Swap ${l.ingredient} for`}
                    defaultValue=""
                    disabled={busy != null}
                    className="h-7 max-w-[14rem] rounded-md border border-line bg-surface-raised px-1 text-fg"
                    onChange={(e) => e.target.value && void call(l.id, () => api.put(`${S()}/plan/lines/${l.id}`, { product_id: e.target.value }), `Swapped ${l.ingredient}; verifier re-ran`)}
                  >
                    <option value="">choose…</option>
                    {alts[l.id].map((a) => (
                      <option key={a.product_id} value={a.product_id}>
                        {a.title.slice(0, 50)} {a.price != null ? `$${a.price.toFixed(2)}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <Button size="xs" disabled={plan.status !== "draft" || busy != null} onClick={() =>
                    void call(
                      l.id,
                      () => api.get<{ alternatives: { product_id: string; title: string; price: number | null }[] }>(`${S()}/plan/lines/${l.id}/alternatives`).then((r) => setAlts((p) => ({ ...p, [l.id]: r.alternatives }))),
                      `Alternatives loaded for ${l.ingredient}`,
                    )
                  }
                >
                  Swap
                </Button>
              )}
              <Button size="xs" variant="ghost" disabled={plan.status !== "draft" || busy != null} aria-label={`Remove ${l.ingredient} from plan`} onClick={() => void call(l.id, () => api.del(`${S()}/plan/lines/${l.id}`), `Removed ${l.ingredient}; verifier re-ran`)}>
                Remove
              </Button>
              {busy === l.id && <Loader2 className="size-3.5 animate-spin" aria-label="saving" />}
            </div>
          </li>
        ))}
      </ul>
      {plan.omissions.length > 0 && <p className="m-0 text-xs text-warn">Not found: {plan.omissions.map((o) => `${o.ingredient} (${o.reason})`).join("; ")}</p>}
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="plan-verifier" data-verdict={v.verdict} data-edits={plan.edits}>
        <ShieldCheck className="size-3.5" aria-hidden />
        <span>
          B09 verifier: <strong>{v.verdict}</strong> after {plan.edits} edit{plan.edits === 1 ? "" : "s"}
          {v.checked_at ? ` · ${new Date(v.checked_at).toLocaleTimeString()}` : ""}
        </span>
        {v.could_not.map((c, i) => (
          <span key={i} className="rounded bg-warn-soft px-1.5 py-0.5">
            {c.constraint}: {c.reason}
          </span>
        ))}
      </div>
      {err && (
        <p role="alert" className="m-0 text-xs text-bad">
          {err}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono font-semibold">Plan total {money(total)}</span>
        {plan.status === "draft" ? (
          <Button size="sm" variant="primary" disabled={!plan.lines.length || busy != null} onClick={() => void call("cart", () => api.post(`${S()}/plan/add-to-cart`), "Plan added to cart")}>
            Add plan to cart
          </Button>
        ) : (
          <span className="text-xs text-ok">Added to cart</span>
        )}
      </div>
    </CardShell>
  );
}

/* ---------------- 2. photo -> products ---------------- */

export interface PhotoResult {
  items: { name: string; attributes: string[]; query: string; results: { product_id: string; title: string; price: number | null; in_stock: boolean }[] }[];
  matching: string;
  cost_usd: number | null;
  latency_ms: number;
  model: string;
}

export function PhotoCard({ preview, state, onAdd }: { preview: string; state: { status: "running"; items?: PhotoResult["items"]; chars?: number } | { status: "error"; error: string; retry: () => void } | { status: "done"; r: PhotoResult }; onAdd: (text: string) => void }) {
  return (
    <CardShell testid="photo-card" title="Photo to products" icon={<img src={preview} alt="" className="size-8 rounded object-cover" />}>
      <p data-testid="photo-matching-note" className="m-0 text-xs text-warn">
        Text-based matching: Claude describes what it sees, then the catalogue is searched with that text. ESCI has no product images, so nothing is matched visually.
      </p>
      {state.status === "running" && (
        <div className="grid gap-1.5" aria-busy="true" data-testid="photo-streaming">
          {(state.items ?? []).length > 0 ? (
            <PhotoItems items={state.items!} />
          ) : (
            <>
              <div className="h-4 w-2/3 animate-pulse rounded bg-surface-sunken motion-reduce:animate-none" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-surface-sunken motion-reduce:animate-none" />
            </>
          )}
          <span className="text-xs text-fg-muted">
            {state.items?.length ? `${state.items.length} item(s) so far · Claude is still looking…` : state.chars ? `Claude is describing the photo (${state.chars} characters so far)…` : "Claude is looking at the photo…"}
          </span>
        </div>
      )}
      {state.status === "error" && (
        <div role="alert" className="flex items-center gap-2 text-xs text-bad">
          <AlertTriangle className="size-4" aria-hidden />
          {state.error}
          <Button size="xs" onClick={state.retry}>
            <RotateCcw aria-hidden />
            Retry
          </Button>
        </div>
      )}
      {state.status === "done" && (
        <>
          {state.r.items.length === 0 && <p className="m-0">No shoppable products recognised in this photo.</p>}
          <PhotoItems items={state.r.items} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
            <span data-testid="photo-cost">
              {state.r.model} · {(state.r.latency_ms / 1000).toFixed(1)}s · {state.r.cost_usd != null ? `$${state.r.cost_usd.toFixed(4)}` : "cost n/a"} · {SYNTHETIC}
            </span>
            {state.r.items.length > 0 && (
              <Button size="xs" onClick={() => onAdd(`From my photo, help me buy: ${state.r.items.map((i) => i.query).join("; ")}`)}>
                Ask Compass to shop these
              </Button>
            )}
          </div>
        </>
      )}
    </CardShell>
  );
}

function PhotoItems({ items }: { items: PhotoResult["items"] }) {
  return (
  <ul className="m-0 grid list-none gap-2 p-0">
    {items.map((it, i) => (
      <li key={i} data-testid="photo-item" className="grid gap-1">
        <span>
          <strong>{it.name}</strong> <span className="text-fg-muted">{it.attributes.join(" · ")}</span>
        </span>
        <span className="text-xs text-fg-muted">searched: “{it.query}”</span>
        <ul className="m-0 grid list-none gap-1 p-0">
          {it.results.map((p) => (
            <li key={p.product_id} className="flex items-center gap-2 text-xs">
              <Link to={`/shop/p/${p.product_id}`} className="min-w-0 flex-1 truncate text-accent">
                {p.title}
              </Link>
              <span className="font-mono">{money(p.price)}</span>
              <span className={p.in_stock ? "text-ok" : "text-bad"}>{p.in_stock ? "in stock" : "out of stock"}</span>
            </li>
          ))}
        </ul>
      </li>
    ))}
  </ul>
  );
}

/* ---------------- 9. follow-ups + clarifying question ---------------- */

export interface FollowUpState {
  status: "loading" | "done" | "error";
  clarify?: { question: string; options: string[] } | null;
  followups?: string[];
  cost_usd?: number | null;
  model?: string;
  cached?: boolean;
  error?: string;
}

export function FollowUps({ f, onPick }: { f: FollowUpState; onPick: (t: string) => void }) {
  if (f.status === "loading" && !f.followups?.length) return <p className="m-0 text-xs text-fg-muted">Thinking of follow-ups…</p>;
  if (f.status === "error") return null;
  return (
    <div className="grid gap-1.5">
      {f.clarify && (
        <div data-testid="clarify-question" role="group" aria-label={f.clarify.question} className="grid gap-1.5 rounded-lg border border-accent/40 bg-accent-soft p-2">
          <span className="text-sm font-medium">{f.clarify.question}</span>
          <div className="flex flex-wrap gap-1.5">
            {f.clarify.options.map((o) => (
              <Button key={o} size="xs" data-testid="clarify-option" onClick={() => onPick(o)}>
                {o}
              </Button>
            ))}
          </div>
        </div>
      )}
      {!!f.followups?.length && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested follow-ups">
          {f.followups.map((o) => (
            <button key={o} type="button" data-testid="followup-chip" onClick={() => onPick(o)} className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-fg hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus">
              {o}
            </button>
          ))}
        </div>
      )}
      {f.status === "loading" && <span className="text-2xs text-fg-muted">more suggestions streaming…</span>}
      {f.cost_usd != null && (
        <span className="text-2xs text-fg-muted">
          suggestions: {f.model ?? "haiku"}
          {f.cached ? " · cached" : ""} · ${f.cost_usd.toFixed(4)}
        </span>
      )}
    </div>
  );
}

/* ---------------- feedback ---------------- */

const REASONS = ["Wrong product", "Not grounded", "Ignored my constraint", "Too slow", "Other"];

export function Feedback({ messageId, question, answer, runId }: { messageId: string; question: string; answer: string; runId?: string }) {
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async (r: "up" | "down", reason?: string) => {
    try {
      await api.post(`${S()}/feedback`, { message_id: messageId, rating: r, reason, question, answer, run_id: runId });
      setSent(true);
      announce("Thanks, feedback saved as an online-eval sample");
    } catch (e: any) {
      setErr(String(e.message ?? e));
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="feedback">
      <Button size="icon-sm" variant="ghost" aria-pressed={rating === "up"} aria-label="Helpful" disabled={sent} onClick={() => (setRating("up"), void send("up"))}>
        <ThumbsUp aria-hidden />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-pressed={rating === "down"} aria-label="Not helpful" disabled={sent} onClick={() => setRating("down")}>
        <ThumbsDown aria-hidden />
      </Button>
      {rating === "down" && !sent && (
        <div role="group" aria-label="Why was it not helpful?" className="flex flex-wrap gap-1">
          {REASONS.map((r) => (
            <Button key={r} size="xs" onClick={() => void send("down", r)}>
              {r}
            </Button>
          ))}
        </div>
      )}
      {sent && (
        <span className="text-2xs text-fg-muted" data-testid="feedback-saved">
          Saved (online-eval sample)
        </span>
      )}
      {err && <span className="text-2xs text-bad">{err}</span>}
    </div>
  );
}

/** Critic verdict on a streamed answer: "checked ✓" (pass) or "revised" (the draft above is superseded). */
export function VerdictBadge({ v }: { v: NonNullable<RunRecord["verdict"]> }) {
  if (v.verdict === "unchecked") return null;
  const ok = v.verdict === "checked";
  return (
    <span
      data-testid="answer-verdict"
      data-verdict={v.verdict}
      title={v.note}
      className={cn("inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold", ok ? "bg-ok-soft text-ok" : "bg-warn-soft text-fg")}
    >
      {ok ? <Check className="size-3" aria-hidden /> : <RotateCcw className="size-3" aria-hidden />}
      {ok ? "checked ✓" : "revised"}
      <span className="sr-only">{ok ? " by the Critic" : `: the Critic rejected the first answer. ${v.note ?? ""}`}</span>
    </span>
  );
}

/** Blinking caret at the end of streaming text (static under reduced motion). */
export function StreamCursor() {
  return <span data-testid="stream-cursor" aria-hidden className="ml-0.5 inline-block h-[1em] w-[0.45em] translate-y-[0.15em] animate-pulse rounded-[1px] bg-accent motion-reduce:animate-none" />;
}

export function StreamingSkeleton() {
  return (
    <div className="grid gap-1.5" aria-hidden data-testid="streaming-skeleton">
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <Clock className="size-3.5 animate-pulse" />
        Compass is planning and searching…
      </div>
      <div className="h-3.5 w-3/4 animate-pulse rounded bg-surface-sunken" />
      <div className="h-3.5 w-1/2 animate-pulse rounded bg-surface-sunken" />
    </div>
  );
}
