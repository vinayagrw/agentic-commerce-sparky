import * as React from "react";
import { Separator as SeparatorPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export function Separator({ className, orientation = "horizontal", ...props }: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return <SeparatorPrimitive.Root orientation={orientation} className={cn("shrink-0 bg-line", orientation === "horizontal" ? "h-px w-full" : "h-4 w-px", className)} {...props} />;
}
