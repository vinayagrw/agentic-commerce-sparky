/**
 * Inspector content for a plane: live state (roster, plan, ledger, cart / approvals), the run
 * trace (tokens, cost, refusal, CaMeL, tool calls) and the policy-mcp guard feed.
 */
import type { AgentRole, AgentState } from "@sparky/shared";
import { Ban, Bot, CheckCircle2, Circle, CircleDashed, CircleSlash, Loader2, OctagonX, PauseCircle, ShieldAlert, ShoppingCart, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router";
import { emojiFor } from "../api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TraceDetailPanel } from "@/components/TraceInspector";
import { TokenStrip } from "@/components/TokenStrip";
import { runsStore } from "@/chat/runs";
import { useStore } from "@/store";
import { TierBadge } from "@/components/TierBadge";
import { EmptyState, SectionLabel } from "@/components/states";
import { PolicyEventsFeed, usePolicyBlockCount } from "@/components/PolicyEvents";

const STATUS: Record<string, { icon: LucideIcon; cls: string }> = {
  done: { icon: CheckCircle2, cls: "text-ok" },
  ok: { icon: CheckCircle2, cls: "text-ok" },
  running: { icon: Loader2, cls: "animate-spin text-accent motion-reduce:animate-none" },
  pending: { icon: Circle, cls: "text-fg-subtle" },
  idle: { icon: CircleDashed, cls: "text-fg-subtle" },
  blocked: { icon: OctagonX, cls: "text-bad" },
  violated: { icon: XCircle, cls: "text-bad" },
  unknown: { icon: CircleDashed, cls: "text-fg-subtle" },
  skipped: { icon: CircleSlash, cls: "text-fg-subtle" },
};

function StatusIcon({ status, label }: { status: string; label?: string }) {
  const s = STATUS[status] ?? STATUS.unknown;
  const Icon = s.icon;
  return <Icon className={cn("size-4 flex-none", s.cls)} aria-label={label ?? status} role="img" />;
}

function Section({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("grid gap-2.5 border-b border-line px-4 py-3.5 last:border-b-0", className)}>{children}</section>;
}

function Roster({ agents, ops }: { agents: AgentRole[]; ops: boolean }) {
  return (
    <Section>
      <SectionLabel icon={Bot}>Agents · {ops ? "Ops Copilot" : "Shopper plane"}</SectionLabel>
      {agents.length === 0 ? (
        <EmptyState icon={Bot}>Run a beat to see which agents take part.</EmptyState>
      ) : (
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {agents.map((a) => (
            <li
              key={a.name}
              title={a.note ?? ""}
              className={cn(
                "grid gap-0.5 rounded-md border px-2.5 py-2",
                a.status === "running" ? "border-highlight bg-highlight-soft/50" : a.status === "blocked" ? "border-bad/50 bg-bad-soft/40" : "border-line",
              )}
            >
              <div className="flex items-center gap-2">
                <StatusIcon status={a.status} />
                <span className="text-sm font-semibold">{a.name}</span>
                <TierBadge tier={a.tier} />
                <span className="ml-auto text-2xs text-fg-subtle">{a.status}</span>
              </div>
              {(a.model || a.tokens || a.cost_usd != null) && (
                <div className="tabular pl-6 text-xs text-fg-muted">
                  {[a.model, a.tokens ? `${a.tokens.input.toLocaleString()} in / ${a.tokens.output.toLocaleString()} out` : null, a.cost_usd != null ? `$${a.cost_usd.toFixed(4)} (claude-cli)` : null].filter(Boolean).join(" · ")}
                </div>
              )}
              {a.note && <div className="pl-6 text-xs text-fg-muted">{a.note}</div>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ShopperState({ s }: { s: AgentState }) {
  const over = s.budget != null && s.cart_total > s.budget;
  return (
    <>
      <Section>
        <SectionLabel>Plan · beat {s.beat}</SectionLabel>
        {s.plan.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">No plan yet. The Planner writes one when a beat runs.</p>
        ) : (
          <ol className="m-0 grid list-none gap-1 p-0">
            {s.plan.map((p) => (
              <li key={p.id} className={cn("flex items-start gap-2 text-sm", p.status === "pending" && "text-fg-muted")}>
                <StatusIcon status={p.status} />
                {p.label}
              </li>
            ))}
          </ol>
        )}
      </Section>
      <Section>
        <SectionLabel>Constraints</SectionLabel>
        <p className="m-0 text-sm text-fg-muted">
          {s.constraints.length} constraint(s). Constraints now live as removable chips with provenance in the{" "}
          <Link to="/shop?view=split" className="text-accent underline underline-offset-4">Store header and chat</Link>.
        </p>
      </Section>
      <Section>
        <SectionLabel icon={ShoppingCart} aside={<span className="tabular text-xs text-fg-muted">{s.cart.length} lines</span>}>
          Cart
        </SectionLabel>
        {s.cart.length === 0 ? (
          <EmptyState icon={ShoppingCart}>Empty. Run beat 1 to build a cart from a goal.</EmptyState>
        ) : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {s.cart.map((l) => (
              <li key={l.product_id} className="grid grid-cols-[2.75rem_1fr_auto] items-center gap-2.5 text-sm">
                {/* product glyph: content, not chrome */}
                <span className="text-center text-4xl leading-none" aria-hidden>
                  {emojiFor(l.title)}
                </span>
                <span className="min-w-0">
                  <span className="line-clamp-2">{l.title}</span>
                  <span className="text-xs text-fg-muted">
                    × {l.qty} {l.sponsored && <Badge size="sm" tone="highlight">Sponsored</Badge>}
                  </span>
                </span>
                <span className="tabular font-medium">${(l.price * l.qty).toFixed(2)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-baseline justify-between border-t border-line pt-2">
          <span className="text-sm font-semibold">Total</span>
          <span className="tabular text-md font-semibold">
            ${s.cart_total.toFixed(2)} {s.budget != null && <span className="text-xs font-normal text-fg-muted">of ${s.budget}</span>}
          </span>
        </div>
        {s.budget != null && (
          <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" role="meter" aria-valuemin={0} aria-valuemax={s.budget} aria-valuenow={s.cart_total} aria-label="Cart total against budget">
            <div className={cn("h-full rounded-full", over ? "bg-bad" : "bg-ok")} style={{ width: `${Math.min(100, (s.cart_total / s.budget) * 100)}%` }} />
          </div>
        )}
        {s.mandate && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2.5 py-2 text-sm">
            <span className="font-mono text-xs">{s.mandate.mandate_id}</span>
            <Badge size="sm" tone={s.mandate.status === "approved" ? "ok" : s.mandate.status === "rejected" ? "bad" : "warn"}>
              {s.mandate.status.replace("_", " ")}
            </Badge>
            <span className="ml-auto text-xs text-fg-muted">cap ${s.mandate.spend_cap}</span>
          </div>
        )}
      </Section>
    </>
  );
}

function OpsState({ s }: { s: AgentState }) {
  return (
    <>
      <Section>
        <SectionLabel icon={PauseCircle}>Approvals</SectionLabel>
        {s.ops.approvals.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">None requested. Beat 8b asks a human to approve a remediation and a promotion.</p>
        ) : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {s.ops.approvals.map((a) => (
              <li key={a.approval_id} className="flex flex-wrap items-center gap-2 text-sm">
                <StatusIcon status={a.status === "approved" ? "done" : a.status === "rejected" ? "violated" : "pending"} label={a.status} />
                <span className="font-medium">{a.kind}</span>
                <span className="font-mono text-2xs text-fg-subtle">{a.approval_id}</span>
                <Badge size="sm" tone={a.status === "approved" ? "ok" : a.status === "rejected" ? "bad" : "warn"} className="ml-auto">
                  {a.status}
                  {a.choice ? ` · ${a.choice}` : ""}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

/**
 * LLM observability for the current turn. The numbers and text come from the turn's spans
 * (`GET /api/traces/run/:runId?detail=full`); the refusal, CaMeL and guard blocks below stay on the
 * agent's shared state, which is where those facts are produced.
 */
function Trace({ s, agentId }: { s: AgentState; agentId: string }) {
  const runs = useStore(runsStore)[agentId] ?? [];
  const last = runs[runs.length - 1] ?? null;
  return (
    <>
      <TokenStrip state={s} agentId={agentId} />
      <TraceDetailPanel runId={last?.runId ?? null} verdict={last?.verdict?.verdict ?? null} />
      {s.refusal && (
        <Section>
          <div role="alert" className="grid gap-1.5 rounded-lg border border-bad/40 bg-bad-soft px-3 py-2.5 text-sm">
            <div className="flex items-center gap-2 font-semibold text-bad">
              <Ban className="size-4" aria-hidden />
              Run stopped: {s.refusal.reason}
            </div>
            <div>{s.refusal.message}</div>
            {s.refusal.outages.map((o) => (
              <div key={o.key} className="text-fg-muted">
                {o.name} down{o.port ? ` on :${o.port}` : ""}. Fix: <code className="rounded-sm bg-code-bg px-1 text-xs text-code-fg">{o.fix}</code>
              </div>
            ))}
            <div className="text-xs text-fg-muted">Nothing was substituted in its place.</div>
          </div>
        </Section>
      )}
      {s.camel && (
        <Section>
          <SectionLabel>CaMeL capability separation</SectionLabel>
          <p className="m-0 text-sm text-fg-muted">The privileged planner saw {s.camel.variables.length} variable name(s) and no untrusted text.</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>variable</TableHead>
                <TableHead>capability</TableHead>
                <TableHead>origin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.camel.variables.map((v) => (
                <TableRow key={v.name}>
                  <TableCell className="font-mono text-xs">{v.name}</TableCell>
                  <TableCell>
                    <Badge size="sm" tone={v.capability === "untrusted" ? "bad" : "ok"}>{v.capability}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-fg-muted">{v.origin}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>call</TableHead>
                <TableHead>policy-mcp</TableHead>
                <TableHead>rule</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.camel.decisions.map((d, i) => (
                <TableRow key={`${d.tool}${i}`}>
                  <TableCell className="font-mono text-xs">{d.tool}</TableCell>
                  <TableCell>
                    <Badge size="sm" tone={d.allowed ? "ok" : "bad"}>{d.allowed ? "forwarded" : "refused"}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-fg-muted">{d.rule ?? d.reason ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
      {s.guard_events.length > 0 && (
        <Section>
          <SectionLabel icon={ShieldAlert}>Guard events this run</SectionLabel>
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {s.guard_events.map((g) => (
              <li key={g.id} className={cn("grid gap-0.5 rounded-md border-l-4 px-2.5 py-2 text-sm", g.severity === "block" ? "border-l-bad bg-bad-soft" : "border-l-warn bg-warn-soft")}>
                <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                  <Badge size="sm" tone={g.severity === "block" ? "solidBad" : "warn"}>{g.severity === "block" ? "BLOCK" : "WARN"}</Badge>
                  {g.kind}
                  {g.source && <span className="font-normal text-fg-muted">· {g.source}</span>}
                  {g.rule && <code className="text-xs font-normal">{g.rule}</code>}
                </div>
                <div>{g.message}</div>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

export function PlaneInspector({ state: s }: { state: AgentState }) {
  const ops = s.plane === "ops";
  const blocks = usePolicyBlockCount();
  return (
    <Tabs defaultValue={ops ? "state" : "state"} className="flex min-h-0 flex-1 flex-col">
      <TabsList className="sticky top-0 z-10 flex w-full flex-none bg-surface px-2">
        <TabsTrigger value="state" className="flex-1 justify-center">
          State
        </TabsTrigger>
        <TabsTrigger value="trace" className="flex-1 justify-center">
          Trace
          {s.trace.length > 0 && <span className="tabular text-2xs text-fg-subtle">{s.trace.length}</span>}
        </TabsTrigger>
        <TabsTrigger value="guard" className="flex-1 justify-center">
          Guard
          {blocks > 0 && (
            <Badge size="sm" tone="solidBad" aria-label={`${blocks} blocked calls`}>
              {blocks}
            </Badge>
          )}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="state" className="min-h-0">
        <Roster agents={s.agents} ops={ops} />
        {ops ? <OpsState s={s} /> : <ShopperState s={s} />}
      </TabsContent>
      <TabsContent value="trace" className="min-h-0">
        <Trace s={s} agentId={ops ? "ops" : "default"} />
      </TabsContent>
      <TabsContent value="guard" className="min-h-0 px-4 py-3.5">
        <div className="mb-3 grid gap-1">
          <SectionLabel icon={ShieldAlert}>policy-mcp decisions</SectionLabel>
          <p className="m-0 text-xs text-fg-muted">Every tool call passes this proxy. Refusals are logged before the call executes.</p>
        </div>
        <PolicyEventsFeed compact emptyHint={ops ? "Ops beats log their tool calls here too." : undefined} />
      </TabsContent>
    </Tabs>
  );
}
