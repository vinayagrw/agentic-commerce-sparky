import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Small status label. `tone` is semantic, never a raw colour. */
export const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-sm border font-medium leading-none [&_svg]:size-[1.05em] [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-line bg-surface-sunken text-fg-muted",
        accent: "border-transparent bg-accent-soft text-accent-soft-fg",
        ok: "border-transparent bg-ok-soft text-ok",
        warn: "border-transparent bg-warn-soft text-warn",
        bad: "border-transparent bg-bad-soft text-bad",
        info: "border-transparent bg-info-soft text-info",
        highlight: "border-transparent bg-highlight text-highlight-fg",
        solidBad: "border-transparent bg-bad text-bad-fg",
        outline: "border-line-strong bg-transparent text-fg",
      },
      size: {
        sm: "h-5 px-1.5 text-2xs",
        md: "h-6 px-2 text-xs",
        lg: "h-7 px-2.5 text-sm",
      },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  },
);

export function Badge({ className, tone, size, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}
