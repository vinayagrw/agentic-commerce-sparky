import { CircleDashed, CircleOff, FileCode2, Gauge, ShieldAlert, TrendingDown, Equal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { CoverageStatus } from "./types";
import { FLAG_LABEL, STATUS_LABEL, type ResultFlag } from "./model";

const STATUS_TONE = { "real-measured": "ok", "real-no-metric": "info", "script-ready-not-executed": "warn", absent: "outline" } as const;
const STATUS_ICON = { "real-measured": Gauge, "real-no-metric": CircleDashed, "script-ready-not-executed": FileCode2, absent: CircleOff } as const;

export function StatusChip({ status, size = "md" }: { status: CoverageStatus; size?: "sm" | "md" | "lg" }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={STATUS_TONE[status]} size={size} title={status}>
      <Icon aria-hidden />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

const FLAG_ICON = { open: ShieldAlert, negative: TrendingDown, null: Equal } as const;
const FLAG_TONE = { open: "solidBad", negative: "bad", null: "warn" } as const;

/** Null / negative / open results. Uppercase and iconned on purpose: they are never softened. */
export function FlagChip({ flag, size = "md" }: { flag: ResultFlag; size?: "sm" | "md" | "lg" }) {
  const Icon = FLAG_ICON[flag];
  return (
    <Badge tone={FLAG_TONE[flag]} size={size} className="font-semibold tracking-wide uppercase">
      <Icon aria-hidden />
      {FLAG_LABEL[flag]}
    </Badge>
  );
}
