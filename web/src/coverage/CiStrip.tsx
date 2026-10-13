import { cn } from "@/lib/utils";
import { raw } from "./model";

/**
 * A one-line forest plot: the point estimate and its 95% CI, with zero marked whenever the
 * measurement is a delta or the interval crosses zero. Colour says what the interval says:
 * straddles zero = null (warn), wholly below = negative (bad), wholly above = positive (ok).
 */
export function CiStrip({ value, ci, label, className, compact }: { value: number; ci: [number, number]; label: string; className?: string; compact?: boolean }) {
  const [lo, hi] = ci;
  const isDelta = /delta/i.test(label) || lo < 0;
  let min = Math.min(lo, value, isDelta ? 0 : lo);
  let max = Math.max(hi, value, isDelta ? 0 : hi);
  const span = max - min || Math.abs(max) || 1;
  min -= span * 0.12;
  max += span * 0.12;
  const x = (v: number) => ((v - min) / (max - min)) * 100;
  const verdict = !isDelta ? "neutral" : lo <= 0 && hi >= 0 ? "null" : hi < 0 ? "negative" : "positive";
  const tone = verdict === "null" ? "var(--warn)" : verdict === "negative" ? "var(--bad)" : verdict === "positive" ? "var(--ok)" : "var(--accent)";
  const desc =
    verdict === "null"
      ? "interval straddles zero"
      : verdict === "negative"
        ? "interval wholly below zero"
        : verdict === "positive"
          ? "interval wholly above zero"
          : "95% interval";
  return (
    <div className={cn("grid gap-1", className)}>
      <svg viewBox="0 0 100 14" preserveAspectRatio="none" className="h-3.5 w-full overflow-visible" role="img" aria-label={`${label}: ${raw(value)}, 95% CI ${raw(lo)} to ${raw(hi)}, ${desc}`}>
        <line x1="0" x2="100" y1="7" y2="7" stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {isDelta && <line x1={x(0)} x2={x(0)} y1="0" y2="14" stroke="var(--fg-muted)" strokeWidth="1" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />}
        <rect x={x(lo)} width={Math.max(0.6, x(hi) - x(lo))} y="4" height="6" rx="1" fill={tone} opacity="0.28" />
        <line x1={x(lo)} x2={x(lo)} y1="3" y2="11" stroke={tone} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <line x1={x(hi)} x2={x(hi)} y1="3" y2="11" stroke={tone} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <line x1={x(value)} x2={x(value)} y1="1" y2="13" stroke={tone} strokeWidth="3" vectorEffect="non-scaling-stroke" />
      </svg>
      {!compact && (<div className="flex justify-between gap-2 font-mono text-2xs text-fg-subtle tabular">
        <span>{raw(lo)}</span>
        {isDelta && !compact && <span className={cn(verdict === "null" && "text-warn", verdict === "negative" && "text-bad", verdict === "positive" && "text-ok")}>{desc}</span>}
        <span>{raw(hi)}</span>
      </div>)}
    </div>
  );
}
