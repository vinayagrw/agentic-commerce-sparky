import { NavLink, useLocation } from "react-router";
import { Activity, BookOpen, Database, Monitor, Moon, Presentation, Rows3, Search, ShoppingCart, SlidersHorizontal, Store, Sun, TableProperties } from "lucide-react";
import { SERVICES } from "@sparky/shared";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { Tooltip } from "@/components/ui/tooltip";
import { usePreferences, type Density, type ThemePref } from "./preferences";
import { useShell } from "./context";

const NAV = [
  { to: "/shopper/1", match: "/shopper", label: "Shopper", icon: ShoppingCart },
  { to: "/shop", match: "/shop", label: "Store", icon: Store },
  { to: "/ops/1", match: "/ops", label: "Ops Copilot", icon: Activity },
  { to: "/coverage", match: "/coverage", label: "Coverage", icon: TableProperties },
  { to: "/guide", match: "/guide", label: "Guide", icon: BookOpen },
] as const;

function BrandMark() {
  return (
    <span aria-hidden className="grid size-7 flex-none place-items-center rounded-md bg-accent shadow-sm">
      <svg viewBox="0 0 24 24" className="size-4">
        <path d="M12 2.5l2.1 6.4 6.4 2.1-6.4 2.1L12 19.5l-2.1-6.4L3.5 11l6.4-2.1z" fill="var(--highlight)" />
      </svg>
    </span>
  );
}

export function ThemeControl({ size = "md" }: { size?: "sm" | "md" }) {
  const { theme, setTheme } = usePreferences();
  return (
    <Segmented<ThemePref>
      label="Theme"
      size={size}
      value={theme}
      onValueChange={setTheme}
      items={[
        { value: "system", label: <Monitor />, title: "System theme" },
        { value: "light", label: <Sun />, title: "Light theme" },
        { value: "dark", label: <Moon />, title: "Dark theme" },
      ]}
    />
  );
}

export function DensityControl({ size = "md" }: { size?: "sm" | "md" }) {
  const { density, setDensity } = usePreferences();
  return (
    <Segmented<Density>
      label="Density"
      size={size}
      value={density}
      onValueChange={setDensity}
      items={[
        { value: "comfortable", label: <><Rows3 /><span className="hidden xl:inline">Dense</span></>, title: "Dense: hands-on" },
        { value: "presenter", label: <><Presentation /><span className="hidden xl:inline">Presenter</span></>, title: "Presenter: readable on a projector" },
      ]}
    />
  );
}

function ServiceStatus() {
  const { gate } = useShell();
  const { diag, checking, refresh } = gate;
  const down = new Map<string, { plane: string[]; detail?: string }>();
  for (const plane of ["shopper", "ops"] as const) {
    for (const o of diag?.outages?.[plane] ?? []) {
      const e = down.get(o.name) ?? { plane: [], detail: o.detail };
      e.plane.push(plane);
      down.set(o.name, e);
    }
  }
  const state = !diag ? "checking" : down.size ? "down" : "live";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 items-center gap-2 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
            state === "live" && "border-line bg-surface text-fg hover:bg-surface-hover",
            state === "down" && "border-transparent bg-bad-soft text-bad hover:brightness-95",
            state === "checking" && "border-line bg-surface text-fg-muted",
          )}
          aria-label={state === "live" ? "All services live" : state === "down" ? `${down.size} services down` : "Checking services"}
        >
          <span className={cn("relative size-2 rounded-full", state === "live" ? "bg-ok" : state === "down" ? "bg-bad" : "bg-fg-subtle")}>
            {state === "live" && <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-40 motion-reduce:hidden" />}
          </span>
          <span className="hidden sm:inline">{state === "live" ? "Live" : state === "down" ? `${down.size} down` : "Checking"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
          <div className="text-sm font-semibold">Services</div>
          <Button size="xs" variant="ghost" onClick={() => void refresh(true)} disabled={checking}>
            {checking ? "Checking" : "Re-check"}
          </Button>
        </div>
        <ul className="m-0 list-none p-1.5">
          {SERVICES.map((s) => {
            const d = down.get(s.name);
            return (
              <li key={s.key} className="flex items-start gap-2.5 rounded-md px-2 py-1.5">
                <span className={cn("mt-1.5 size-2 flex-none rounded-full", !diag ? "bg-fg-subtle" : d ? "bg-bad" : "bg-ok")} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-mono font-medium">{s.name}</span>
                    {s.port ? <span className="font-mono text-2xs text-fg-muted">:{s.port}</span> : null}
                    <span className={cn("ml-auto text-xs", d ? "text-bad" : "text-fg-subtle")}>{!diag ? "…" : d ? `down · blocks ${d.plane.join(", ")}` : "up"}</span>
                  </div>
                  {d?.detail ? <div className="truncate text-xs text-fg-muted">{d.detail}</div> : null}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-line px-3 py-2 text-xs text-fg-muted">Polled from GET /api/diag every 20s. A beat never runs while a service it needs is down.</div>
      </PopoverContent>
    </Popover>
  );
}

export function TopBar() {
  const { openPalette } = useShell();
  const { pathname } = useLocation();
  return (
    <header className="sticky top-0 z-30 flex h-[var(--shell-top)] items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur-md sm:gap-3 sm:px-4">
      <NavLink to="/shopper/1" className="flex items-center gap-2 rounded-md text-fg no-underline focus-visible:outline-2 focus-visible:outline-focus" aria-label="Compass home">
        <BrandMark />
        <span className="hidden text-md font-semibold whitespace-nowrap tracking-[-0.02em] md:inline">Compass</span>
      </NavLink>
      <span aria-hidden className="hidden h-5 w-px bg-line md:block" />
      <nav aria-label="Primary" className="flex flex-none items-center gap-0.5">
        {NAV.map(({ to, match, label, icon: Icon }) => {
          const active = pathname === match || pathname.startsWith(`${match}/`);
          return (
            <NavLink
              key={match}
              to={to}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-sm font-medium no-underline transition-colors focus-visible:outline-2 focus-visible:outline-focus sm:px-2.5",
                active ? "bg-surface-sunken text-fg shadow-[inset_0_-2px_0_var(--accent)]" : "text-fg-muted hover:bg-surface-hover hover:text-fg",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {/* Below sm the label is visually hidden, not removed: the icon is aria-hidden, so
                  `hidden` here left the link with no accessible name at 390px (axe link-name). */}
              <span className="sr-only sm:not-sr-only">{label}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="flex-1" />

      <button
        type="button"
        onClick={openPalette}
        className="inline-flex h-8 items-center gap-2 rounded-md border border-line bg-surface-sunken px-2 text-sm text-fg-muted transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-2 focus-visible:outline-focus sm:w-44 lg:w-56 min-w-0 shrink presenter:lg:w-44"
        aria-label="Open command palette"
      >
        <Search className="size-4" aria-hidden />
        <span className="hidden sm:inline">Jump to…</span>
        <span className="ml-auto hidden items-center gap-0.5 sm:flex">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <Tooltip content="Queries and products are the public Amazon ESCI shopping dataset. Prices, stock and store IDs are synthetic. No real retailer's data.">
        <span tabIndex={0} className="hidden flex-none items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-2xs font-medium text-fg-muted focus-visible:outline-2 focus-visible:outline-focus 2xl:inline-flex presenter:hidden!">
          <Database className="size-3" aria-hidden />
          Public dataset · Amazon ESCI
        </span>
      </Tooltip>

      <ServiceStatus />

      <div className="hidden items-center gap-2 lg:flex">
        <DensityControl />
        <ThemeControl />
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Display settings">
            <SlidersHorizontal />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="grid w-64 gap-3">
          <div className="grid gap-1.5">
            <div className="text-xs font-medium text-fg-muted">Density</div>
            <DensityControl />
          </div>
          <div className="grid gap-1.5">
            <div className="text-xs font-medium text-fg-muted">Theme</div>
            <ThemeControl />
          </div>
        </PopoverContent>
      </Popover>
    </header>
  );
}
