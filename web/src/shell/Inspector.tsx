import type * as React from "react";
import { PanelRight } from "lucide-react";

/** Right-hand inspector column on plane routes. Hosts PlaneInspector. */
export function Inspector({ children }: { children: React.ReactNode }) {
  return (
    <aside aria-label="Inspector" className="flex min-h-0 flex-col border-line bg-surface max-xl:border-t xl:border-l">
      <div className="flex h-9 flex-none items-center gap-2 border-b border-line px-3 text-2xs font-medium tracking-[0.08em] text-fg-subtle uppercase">
        <PanelRight className="size-3.5" aria-hidden />
        Inspector
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </aside>
  );
}
