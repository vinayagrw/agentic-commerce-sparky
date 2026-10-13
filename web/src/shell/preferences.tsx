/**
 * Theme (system | light | dark) and density (comfortable | presenter).
 * Stamped on <html> as data-theme / data-density (index.html applies the stored values
 * before first paint) and remembered in localStorage via safeStorage (never throws).
 */
import * as React from "react";
import { safeStorage } from "@/lib/utils";

export type ThemePref = "system" | "light" | "dark";
export type Density = "comfortable" | "presenter";

const readTheme = (): ThemePref => {
  const t = safeStorage.get("sparky.theme");
  return t === "light" || t === "dark" ? t : "system";
};
const readDensity = (): Density => (safeStorage.get("sparky.density") === "presenter" ? "presenter" : "comfortable");

interface Prefs {
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  density: Density;
  setDensity: (d: Density) => void;
}

const Ctx = React.createContext<Prefs | null>(null);

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<ThemePref>(readTheme);
  const [density, setDensityState] = React.useState<Density>(readDensity);

  React.useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    safeStorage.set("sparky.theme", theme);
  }, [theme]);

  React.useEffect(() => {
    document.documentElement.setAttribute("data-density", density);
    safeStorage.set("sparky.density", density);
  }, [density]);

  const value = React.useMemo(() => ({ theme, setTheme: setThemeState, density, setDensity: setDensityState }), [theme, density]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePreferences(): Prefs {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("usePreferences outside PreferencesProvider");
  return v;
}
