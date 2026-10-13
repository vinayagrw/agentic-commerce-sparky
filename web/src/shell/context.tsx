import * as React from "react";
import type { useHealthGate } from "@/components/HealthGate";

export interface ShellCtx {
  gate: ReturnType<typeof useHealthGate>;
  openPalette: () => void;
  paletteOpen: boolean;
}

export const ShellContext = React.createContext<ShellCtx | null>(null);

export function useShell(): ShellCtx {
  const v = React.useContext(ShellContext);
  if (!v) throw new Error("useShell outside AppShell");
  return v;
}
