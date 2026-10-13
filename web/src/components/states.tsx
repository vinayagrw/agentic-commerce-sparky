/**
 * Designed states shared by every async panel: loading skeleton, empty (icon + one line + the
 * action that fills it), error (what failed + how to fix it), and a key/value view that
 * replaces raw JSON dumps.
 */
import type * as React from "react";
import type { LucideIcon } from "lucide-react";
import { AlertOctagon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export function PanelSkeleton({ rows = 3, chart, label = "Loading" }: { rows?: number; chart?: boolean; label?: string }) {
  return (
    <div className="grid gap-2" aria-busy="true" aria-label={label} role="status">
      {chart && <Skeleton className="h-40 w-full" />}
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", i % 3 === 2 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

export function EmptyState({ icon: Icon, children, action, className }: { icon: LucideIcon; children: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface-sunken/50 px-4 py-6 text-center", className)}>
      <span aria-hidden className="grid size-9 place-items-center rounded-full bg-surface text-fg-subtle shadow-xs">
        <Icon className="size-4.5" />
      </span>
      <p className="m-0 max-w-[40ch] text-sm text-fg-muted">{children}</p>
      {action}
    </div>
  );
}

export function ErrorState({ title, children, fix, className }: { title: string; children?: React.ReactNode; fix?: string; className?: string }) {
  return (
    <div role="alert" className={cn("grid gap-1.5 rounded-lg border border-bad/40 bg-bad-soft px-3 py-2.5 text-sm", className)}>
      <div className="flex items-center gap-2 font-semibold text-bad">
        <AlertOctagon className="size-4 flex-none" aria-hidden />
        {title}
      </div>
      {children && <div className="text-fg-muted">{children}</div>}
      {fix && (
        <div className="text-fg-muted">
          Fix: <code className="rounded-sm bg-code-bg px-1.5 py-0.5 text-xs text-code-fg">{fix}</code>
        </div>
      )}
    </div>
  );
}

function scalar(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length <= 4 && v.every((x) => typeof x !== "object") ? v.join(", ") : `${v.length} items`;
  const keys = Object.keys(v as object);
  return keys.length <= 3 ? keys.map((k) => `${k}: ${scalar((v as any)[k])}`).join(" · ") : `${keys.length} fields`;
}

/** Readable view of a structured payload: one row per field, nested values summarised. */
export function KeyValue({ data, className, limit = 24 }: { data: Record<string, unknown> | null | undefined; className?: string; limit?: number }) {
  const entries = Object.entries(data ?? {}).filter(([, v]) => v !== undefined);
  if (!entries.length) return <div className="text-sm text-fg-muted">No fields.</div>;
  return (
    <dl className={cn("m-0 grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-3 gap-y-1 text-sm", className)}>
      {entries.slice(0, limit).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-mono text-xs text-fg-subtle">{k}</dt>
          <dd className="m-0 min-w-0 break-words font-mono text-xs text-fg">{scalar(v)}</dd>
        </div>
      ))}
      {entries.length > limit && <dd className="col-span-2 m-0 text-xs text-fg-subtle">+{entries.length - limit} more fields</dd>}
    </dl>
  );
}

/** Small uppercase section heading used across inspector and dashboard panels. */
export function SectionLabel({ icon: Icon, children, aside, className }: { icon?: LucideIcon; children: React.ReactNode; aside?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-2", className)}>
      <h3 className="m-0 flex items-center gap-1.5 text-2xs font-semibold tracking-[0.08em] text-fg-muted uppercase">
        {Icon && <Icon className="size-3.5" aria-hidden />}
        {children}
      </h3>
      {aside}
    </div>
  );
}
