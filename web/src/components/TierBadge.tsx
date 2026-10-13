import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Autonomy tier (README): T0 observe, T1 recommend, T2 act with approval, T3 act within guardrails. */
const tierVariants = cva("inline-flex h-5 items-center rounded-sm px-1.5 font-mono text-2xs font-semibold leading-none", {
  variants: {
    tier: {
      T0: "bg-surface-sunken text-fg-muted ring-1 ring-line",
      T1: "bg-info-soft text-info",
      T2: "bg-warn-soft text-warn",
      T3: "bg-bad-soft text-bad",
      none: "bg-surface-sunken text-fg-subtle",
    },
  },
  defaultVariants: { tier: "none" },
});

const TIER_TITLE: Record<string, string> = {
  T0: "T0: observe",
  T1: "T1: recommend",
  T2: "T2: act with approval",
  T3: "T3: act within guardrails",
};

export function TierBadge({ tier, className }: { tier: string | null | undefined; className?: string }) {
  const t = tier === "T0" || tier === "T1" || tier === "T2" || tier === "T3" ? tier : "none";
  return (
    <span className={cn(tierVariants({ tier: t }), className)} title={TIER_TITLE[t] ?? "no tier"}>
      {t === "none" ? "—" : t}
    </span>
  );
}
