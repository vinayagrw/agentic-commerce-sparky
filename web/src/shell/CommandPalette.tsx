import { useNavigate } from "react-router";
import { Activity, BookOpen, Monitor, Moon, Presentation, RefreshCw, Rows3, Server, ShoppingCart, Sun, TableProperties, TriangleAlert } from "lucide-react";
import { BEATS, SERVICES } from "@sparky/shared";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { usePoll } from "@/lib/usePoll";
import type { Feature } from "@/guide/guideModel";
import { useCoverage } from "@/coverage/useCoverage";
import { flagOf, FLAG_LABEL } from "@/coverage/model";
import { beatPath } from "./beats";
import { usePreferences } from "./preferences";
import { useShell } from "./context";

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const { setTheme, setDensity, theme, density } = usePreferences();
  const { gate } = useShell();
  const coverage = useCoverage();
  // The Guide's ⌘K search: feature names, story text and stack entries, fetched only while open.
  const guide = usePoll<{ features: Feature[] }>(open ? "/api/guide/features" : null, 0);
  const features = guide.data?.features ?? [];
  const go = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };
  const downNames = new Set([...(gate.diag?.outages?.shopper ?? []), ...(gate.diag?.outages?.ops ?? [])].map((o) => o.name));

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Jump to a beat, feature, technique or service…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Go to">
          <CommandItem value="go shopper plane" onSelect={() => go(() => navigate("/shopper/1"))}>
            <ShoppingCart /> Shopper plane
          </CommandItem>
          <CommandItem value="go ops copilot plane" onSelect={() => go(() => navigate("/ops/1"))}>
            <Activity /> Ops Copilot
          </CommandItem>
          <CommandItem value="go coverage board techniques" onSelect={() => go(() => navigate("/coverage"))}>
            <TableProperties /> Coverage board
          </CommandItem>
          <CommandItem value="go guide features tech stack user stories try it" onSelect={() => go(() => navigate("/guide"))}>
            <BookOpen /> Guide
          </CommandItem>
          <CommandItem value="go traces tracing waterfall spans" onSelect={() => go(() => navigate("/ops/traces"))}>
            <Activity /> Traces
          </CommandItem>
          <CommandItem value="coverage null negative results" onSelect={() => go(() => navigate("/coverage?results=null-negative"))}>
            <TriangleAlert /> Null and negative results
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Beats">
          {BEATS.map((b) => (
            <CommandItem key={b.id} value={`beat ${b.label} ${b.title} ${b.plane} ${b.blurb}`} onSelect={() => go(() => navigate(beatPath(b)))}>
              {b.plane === "ops" ? <Activity /> : <ShoppingCart />}
              <span className="w-7 font-mono text-xs text-fg-subtle">{b.label}</span>
              {b.title}
              <CommandShortcut>{b.plane}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Techniques">
          {coverage.status === "ready" ? (
            coverage.data.techniques.map((t) => {
              const f = flagOf(t);
              return (
                <CommandItem key={t.id} value={`technique ${t.id} ${t.name} ${t.stage} ${f ? FLAG_LABEL[f] : ""}`} onSelect={() => go(() => navigate(`/coverage/${t.id}`))}>
                  <TableProperties />
                  <span className="w-7 font-mono text-xs text-fg-subtle">#{t.id}</span>
                  <span className="truncate">{t.name}</span>
                  {f && <span className={f === "null" ? "text-2xs font-semibold text-warn uppercase" : "text-2xs font-semibold text-bad uppercase"}>{FLAG_LABEL[f]}</span>}
                  <CommandShortcut>{t.status}</CommandShortcut>
                </CommandItem>
              );
            })
          ) : (
            <CommandItem disabled value="techniques unavailable">
              <TableProperties />
              {coverage.status === "refused" ? "Coverage board unavailable" : "Loading techniques…"}
            </CommandItem>
          )}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Guide features">
          {features.length ? (
            features.map((f) => (
              <CommandItem
                key={f.id}
                data-testid="palette-feature"
                data-feature-id={f.id}
                value={`feature ${f.name} ${f.area} ${f.id} ${f.summary} ${f.stack.join(" ")} ${f.stories.map((st) => `${st.id} ${st.given} ${st.when} ${st.then}`).join(" ")}`}
                onSelect={() => go(() => navigate(`/guide/${encodeURIComponent(f.id)}`))}
              >
                <BookOpen />
                <span className="truncate">{f.name}</span>
                <CommandShortcut>{f.area}</CommandShortcut>
              </CommandItem>
            ))
          ) : (
            <CommandItem disabled value="guide features unavailable">
              <BookOpen />
              {guide.error ? "Guide features unavailable" : "Loading features…"}
            </CommandItem>
          )}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Services">
          {SERVICES.map((s) => (
            <CommandItem key={s.key} value={`service ${s.name} ${s.port ?? ""} health recheck`} onSelect={() => go(() => void gate.refresh(true))}>
              <Server />
              <span className="font-mono">{s.name}</span>
              <span className={downNames.has(s.name) ? "text-xs text-bad" : "text-xs text-fg-subtle"}>{!gate.diag ? "checking" : downNames.has(s.name) ? `down · ${s.fix}` : "up"}</span>
              <CommandShortcut>re-check</CommandShortcut>
            </CommandItem>
          ))}
          <CommandItem value="recheck all services health" onSelect={() => go(() => void gate.refresh(true))}>
            <RefreshCw /> Re-check all services
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Display">
          <CommandItem value="theme system" onSelect={() => go(() => setTheme("system"))}>
            <Monitor /> System theme {theme === "system" && <CommandShortcut>current</CommandShortcut>}
          </CommandItem>
          <CommandItem value="theme light" onSelect={() => go(() => setTheme("light"))}>
            <Sun /> Light theme {theme === "light" && <CommandShortcut>current</CommandShortcut>}
          </CommandItem>
          <CommandItem value="theme dark" onSelect={() => go(() => setTheme("dark"))}>
            <Moon /> Dark theme {theme === "dark" && <CommandShortcut>current</CommandShortcut>}
          </CommandItem>
          <CommandItem value="density dense comfortable hands-on" onSelect={() => go(() => setDensity("comfortable"))}>
            <Rows3 /> Dense density {density === "comfortable" && <CommandShortcut>current</CommandShortcut>}
          </CommandItem>
          <CommandItem value="density presenter projector large" onSelect={() => go(() => setDensity("presenter"))}>
            <Presentation /> Presenter density {density === "presenter" && <CommandShortcut>current</CommandShortcut>}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
