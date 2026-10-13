/** Small shared pieces of the Guide portal: deep-link anchors, maturity badges, breadcrumbs. */
import { useState } from "react";
import { Link } from "react-router";
import { Check, Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { MATURITY_TONE, MATURITY_WHY, type Maturity } from "./guideModel";

/** Copies the absolute URL of the section this button sits in. */
export function CopyLink({ anchor, label }: { anchor: string; label: string }) {
  const [done, setDone] = useState(false);
  const href = `${anchor}`;
  return (
    <button
      type="button"
      data-guide-chrome
      data-testid="guide-copy-link"
      data-anchor={anchor}
      aria-label={done ? `Link to ${label} copied` : `Copy link to ${label}`}
      className="inline-flex size-6 flex-none items-center justify-center rounded-md text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus"
      onClick={async () => {
        const url = `${window.location.origin}${window.location.pathname}${window.location.search}#${href}`;
        try {
          await navigator.clipboard?.writeText(url);
        } catch {
          /* clipboard blocked (no permission / insecure origin): the hash below still deep-links */
        }
        window.history.replaceState(null, "", `#${href}`);
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? <Check className="size-3.5" aria-hidden /> : <Link2 className="size-3.5" aria-hidden />}
    </button>
  );
}

/** A section heading that is deep-linkable and carries a copy-link button. */
export function Anchored({ id, title, children, className, as: As = "h2" }: { id: string; title: string; children?: React.ReactNode; className?: string; as?: "h2" | "h3" }) {
  return (
    <section id={id} data-guide-print-section className={cn("group grid scroll-mt-24 gap-2", className)}>
      <div className="flex items-center gap-1">
        <As className={cn("m-0 font-semibold tracking-[-0.01em]", As === "h2" ? "text-lg" : "text-base")}>{title}</As>
        <CopyLink anchor={id} label={title} />
      </div>
      {children}
    </section>
  );
}

export function MaturityBadge({ m, size = "sm" }: { m: Maturity; size?: "sm" | "md" }) {
  return (
    <Badge size={size} tone={MATURITY_TONE[m]} data-testid="guide-maturity" data-maturity={m} title={MATURITY_WHY[m]}>
      {m}
    </Badge>
  );
}

export function Breadcrumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" data-testid="guide-breadcrumbs" className="min-w-0">
      <ol className="m-0 flex min-w-0 flex-wrap items-center gap-1 p-0 text-xs text-fg-muted">
        {items.map((it, i) => (
          <li key={it.label} className="flex min-w-0 items-center gap-1">
            {i > 0 && <span aria-hidden>/</span>}
            {it.to ? (
              <Link to={it.to} className="truncate text-fg-muted no-underline hover:text-fg hover:underline">
                {it.label}
              </Link>
            ) : (
              <span aria-current="page" className="truncate text-fg">
                {it.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
