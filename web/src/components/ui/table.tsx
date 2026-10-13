import * as React from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}
export const TableHeader = ({ className, ...p }: React.ComponentProps<"thead">) => <thead className={cn("[&_tr]:border-b [&_tr]:border-line", className)} {...p} />;
export const TableBody = ({ className, ...p }: React.ComponentProps<"tbody">) => <tbody className={cn("[&_tr:last-child]:border-0", className)} {...p} />;
export const TableRow = ({ className, ...p }: React.ComponentProps<"tr">) => <tr className={cn("border-b border-line transition-colors hover:bg-surface-hover/60", className)} {...p} />;
export const TableHead = ({ className, ...p }: React.ComponentProps<"th">) => <th className={cn("h-8 px-2 text-left align-middle text-2xs font-medium tracking-wide text-fg-subtle uppercase", className)} {...p} />;
export const TableCell = ({ className, ...p }: React.ComponentProps<"td">) => <td className={cn("px-2 py-2 align-top", className)} {...p} />;
