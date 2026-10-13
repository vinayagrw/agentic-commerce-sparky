/**
 * Provenance chips.
 *
 * Every number this app shows came from a service, over an endpoint, at a moment. The
 * chip says which, and `<Stat>` makes it structurally impossible to render a figure
 * without one: the prop is `Measured<T>`, so a bare number is a type error rather than
 * something a reviewer has to catch.
 *
 *   <Stat label="NDCG@10" value={measured(0.603, "search-svc", "POST /eval/ndcg")} />
 *
 * `provenanceOf` lifts the loose `{source, service, endpoint, ...}` shape that tool
 * results carry into the strict type, so card components can require it too.
 */
import type * as React from "react";
import type { Measured, Provenance } from "@sparky/shared";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

export function provenanceOf(raw: any, fallbackService = "unknown"): Provenance {
  const p = raw?.provenance ?? raw ?? {};
  return {
    service: String(p.service ?? p.source ?? fallbackService),
    endpoint: String(p.endpoint ?? p.tool ?? p.source ?? "—"),
    timestamp: String(p.timestamp ?? new Date().toISOString()),
    ...(p.note || p.method ? { note: String(p.note ?? p.method) } : {}),
  };
}

/**
 * Strict variant: only returns a provenance when the payload actually carries one. Tool results
 * from ops-mcp stamp `{service, source, ts}` (epoch seconds); BFF endpoints stamp
 * `{service, endpoint, timestamp}`. A missing time is reported as missing, never as "now".
 */
export function provenanceIn(raw: any): Provenance | null {
  const p = raw?.provenance;
  if (!p || typeof p !== "object") return null;
  const service = p.service ?? (typeof p.source === "string" ? p.source : null);
  if (!service) return null;
  const ts = p.timestamp ?? p.iso ?? (typeof p.ts === "number" ? new Date(p.ts * 1000).toISOString() : null);
  const note = [p.note, p.method, p.source && p.service ? `source: ${p.source}` : null].filter(Boolean).join(" · ");
  return {
    service: String(service),
    endpoint: String(p.endpoint ?? p.tool ?? p.source ?? "tool result"),
    timestamp: ts ? String(ts) : "time not reported",
    ...(note ? { note } : {}),
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A number from a payload, or the honest reason there is none. The number only renders
 * through <Stat>, and only when the payload carries provenance.
 */
export function Metric({
  label,
  value,
  source,
  format,
  suffix,
  tone,
  size = "sm",
  missing,
  hideChip,
}: {
  label: string;
  value: unknown;
  /** The payload the value came from, or an explicit provenance. */
  source: any;
  format?: (v: number) => string;
  suffix?: string;
  tone?: "default" | "ok" | "warn" | "bad";
  size?: "sm" | "md" | "lg";
  /** Shown instead of the number when there is no value or no provenance. */
  missing: string;
  /** Only when the same provenance chip is already rendered once for the group (panel header). */
  hideChip?: boolean;
}) {
  const prov: Provenance | null = source && typeof source === "object" && "service" in source && "timestamp" in source ? (source as Provenance) : provenanceIn(source);
  if (!finite(value) || !prov) {
    return (
      <div className="flex min-w-[7rem] flex-col gap-1">
        <div className="text-2xs font-medium tracking-wide text-fg-subtle uppercase">{label}</div>
        <div className="text-sm text-fg-muted">{!prov && finite(value) ? "not shown: the payload carries no provenance" : missing}</div>
      </div>
    );
  }
  return <Stat label={label} value={{ value, provenance: prov }} format={format} suffix={suffix} tone={tone} size={size} hideChip={hideChip} />;
}

/** Wrap a value from a tool result together with where it came from. */
export function measuredFrom<T>(value: T, raw: any, fallbackService = "unknown"): Measured<T> {
  return { value, provenance: provenanceOf(raw, fallbackService) };
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fullTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * The chip. Dot + service + (endpoint) + time; the tooltip carries the full record.
 * It is focusable so keyboard users can read the provenance too.
 */
export function ProvenanceChip({ provenance: p, compact, className }: { provenance: Provenance; compact?: boolean; className?: string }) {
  const label = `Provenance: ${p.service}, ${p.endpoint}, ${fullTime(p.timestamp)}${p.note ? `. ${p.note}` : ""}`;
  return (
    <Tooltip
      content={
        <div className="grid gap-0.5">
          <div className="font-semibold">{p.service}</div>
          <div className="font-mono break-all">{p.endpoint}</div>
          <div className="opacity-75">{fullTime(p.timestamp)}</div>
          {p.note ? <div className="mt-1 opacity-90 whitespace-pre-wrap">{p.note}</div> : null}
        </div>
      }
    >
      <span
        tabIndex={0}
        aria-label={label}
        data-provenance={p.service}
        className={cn(
          "inline-flex max-w-full min-w-0 cursor-help items-center gap-1.5 rounded-full border border-line bg-surface-sunken align-middle whitespace-nowrap text-fg-muted",
          compact ? "h-[1.15rem] px-1.5 text-2xs" : "h-6 px-2 text-xs",
          className,
        )}
      >
        <span aria-hidden className="size-1.5 flex-none rounded-full bg-ok shadow-[0_0_0_2px_var(--ok-soft)]" />
        <span className="font-medium text-fg">{p.service}</span>
        {!compact && <span className="min-w-0 truncate font-mono text-[0.95em]">{p.endpoint}</span>}
        <span className="tabular">{shortTime(p.timestamp)}</span>
      </span>
    </Tooltip>
  );
}

/**
 * A figure with its provenance. There is deliberately no overload taking a plain number:
 * if you cannot say where a value came from, it does not get rendered.
 *
 * `format` is for units and presentation only. Do not use it to round away a sign or a
 * confidence interval.
 */
export function Stat<T extends string | number>({
  label,
  value,
  format,
  suffix,
  tone = "default",
  size = "md",
  hideChip,
  inline,
}: {
  label: string;
  value: Measured<T>;
  format?: (v: T) => string;
  suffix?: string;
  tone?: "default" | "ok" | "warn" | "bad";
  size?: "sm" | "md" | "lg";
  /** Only inside a <StatGroup>, which renders the shared chip once. */
  hideChip?: boolean;
  /** Table cell: the label becomes screen-reader only (the column header shows it). */
  inline?: boolean;
}) {
  if (inline)
    return (
      <span className={cn("tabular inline-flex items-center gap-1.5 font-medium", tone === "ok" && "text-ok", tone === "warn" && "text-warn", tone === "bad" && "text-bad")}>
        <span className="sr-only">{label}: </span>
        {format ? format(value.value) : String(value.value)}
        {suffix ? <span className="text-xs text-fg-muted">{suffix}</span> : null}
        {!hideChip && <ProvenanceChip provenance={value.provenance} compact />}
      </span>
    );
  return (
    <div className="flex min-w-[7rem] flex-col gap-1">
      <div className="text-2xs font-medium tracking-wide text-fg-subtle uppercase">{label}</div>
      <div
        className={cn(
          "tabular font-semibold tracking-[-0.02em]",
          size === "sm" ? "text-lg" : size === "lg" ? "text-3xl" : "text-2xl",
          tone === "ok" && "text-ok",
          tone === "warn" && "text-warn",
          tone === "bad" && "text-bad",
        )}
      >
        {format ? format(value.value) : String(value.value)}
        {suffix ? <span className="ml-1 text-sm font-medium text-fg-muted">{suffix}</span> : null}
      </div>
      {!hideChip && (
        <div>
          <ProvenanceChip provenance={value.provenance} compact />
        </div>
      )}
    </div>
  );
}

/** A row of stats that all share one provenance (e.g. every number on one tool result). */
export function StatGroup({ provenance, children, className }: { provenance: Provenance; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap gap-x-6 gap-y-3">{children}</div>
      <div>
        <ProvenanceChip provenance={provenance} />
      </div>
    </div>
  );
}
