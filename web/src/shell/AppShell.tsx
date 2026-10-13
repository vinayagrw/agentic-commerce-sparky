import { Suspense, useEffect, useMemo, useState } from "react";
import { Outlet } from "react-router";
import { useHealthGate } from "@/components/HealthGate";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CopilotHost } from "@/components/ChatPane";
import { ShellContext } from "./context";
import { TopBar } from "./TopBar";
import { CommandPalette } from "./CommandPalette";

function RouteFallback() {
  return (
    <div className="grid flex-1 gap-3 p-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

/**
 * Top bar + one routed view. Exactly one plane is mounted at a time; the CopilotKit host sits
 * above the outlet so each agent's thread and messages survive switching planes.
 */
export function AppShell() {
  const gate = useHealthGate();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    // capture: CopilotChat's input must not swallow the palette shortcut
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const ctx = useMemo(() => ({ gate, paletteOpen, openPalette: () => setPaletteOpen(true) }), [gate, paletteOpen]);

  return (
    <ShellContext.Provider value={ctx}>
      <TooltipProvider delayDuration={250}>
        <CopilotHost>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
          Skip to content
        </a>
        <div className="flex h-full flex-col lg:overflow-hidden">
          <TopBar />
          <div id="main" className="flex min-h-0 flex-1 flex-col">
            <Suspense fallback={<RouteFallback />}>
              <Outlet />
            </Suspense>
          </div>
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        </CopilotHost>
      </TooltipProvider>
    </ShellContext.Provider>
  );
}
