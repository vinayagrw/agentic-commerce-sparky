import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/** Single-choice segmented control (theme, density, status filter). Always has a value. */
export function Segmented<T extends string>({
  value,
  onValueChange,
  items,
  label,
  className,
  size = "md",
}: {
  value: T;
  onValueChange: (v: T) => void;
  items: { value: T; label: React.ReactNode; title?: string }[];
  label: string;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      aria-label={label}
      onValueChange={(v) => v && onValueChange(v as T)}
      className={cn("inline-flex items-center gap-0.5 rounded-md border border-line bg-surface-sunken p-0.5", className)}
    >
      {items.map((it) => (
        <ToggleGroupPrimitive.Item
          key={it.value}
          value={it.value}
          title={it.title}
          aria-label={it.title}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 rounded-sm font-medium text-fg-muted transition-colors hover:text-fg data-[state=on]:bg-surface data-[state=on]:text-fg data-[state=on]:shadow-sm focus-visible:outline-2 focus-visible:outline-focus [&_svg]:size-[1.1em]",
            size === "sm" ? "h-6 px-1.5 text-xs" : "h-7 px-2.5 text-sm",
          )}
        >
          {it.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}
