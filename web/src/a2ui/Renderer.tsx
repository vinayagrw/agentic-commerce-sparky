/**
 * Minimal A2UI v0.9 renderer for the Basic catalog subset we emit
 * (List, Card, Column, Row, Image, Text, Button).
 *
 * Why our own: the installed CopilotKit v2 (2.0.0-next.1, the version trust-graph
 * pins) ships no A2UI renderer; `createA2UIMessageRenderer` / `a2ui` provider
 * support only exist in later react-core builds. Surfaces arrive as AG-UI CUSTOM
 * "a2ui" events (and mirrored in a `render_a2ui` tool call so they render inline).
 *
 * Button actions produce the v0.9 A2UIUserAction shape
 * { name, surfaceId, sourceComponentId, timestamp, context } and go to onAction.
 *
 * Styling contract: the server sends free-form `variant` strings. They are mapped HERE, at the
 * boundary, onto cva variants built from design tokens. Unknown variants are ignored (they fall
 * back to the component's default look); a variant string never becomes a CSS class.
 */
import { useMemo, useState } from "react";
import { cva } from "class-variance-authority";
import { Bot } from "lucide-react";
import type { A2uiComponent, A2uiDynamic, A2uiMessage } from "@sparky/shared";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TierBadge } from "@/components/TierBadge";
import { KeyValue } from "@/components/states";

export interface A2uiUserAction {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

interface Built {
  surfaceId: string;
  components: Map<string, A2uiComponent>;
  data: any;
}

export function applyMessages(messages: A2uiMessage[]): Built {
  let surfaceId = "";
  const components = new Map<string, A2uiComponent>();
  let data: any = {};
  for (const m of messages) {
    if ("createSurface" in m) surfaceId = m.createSurface.surfaceId;
    else if ("updateComponents" in m) for (const c of m.updateComponents.components) components.set(c.id, c);
    else if ("updateDataModel" in m) {
      const { path, value } = m.updateDataModel;
      if (!path || path === "/") data = value;
      else setPointer(data, path, value);
    }
  }
  return { surfaceId, components, data };
}

function pointer(obj: any, path: string): unknown {
  return path
    .split("/")
    .filter(Boolean)
    .reduce((acc: any, k) => (acc == null ? undefined : acc[decodeURIComponent(k)]), obj);
}

function setPointer(obj: any, path: string, value: unknown) {
  const keys = path.split("/").filter(Boolean);
  let cur = obj;
  keys.slice(0, -1).forEach((k) => {
    cur[k] ??= {};
    cur = cur[k];
  });
  cur[keys[keys.length - 1]] = value;
}

const resolve = (v: A2uiDynamic | undefined, data: any): unknown => (v && typeof v === "object" && "path" in v ? pointer(data, v.path) : v);

/* ---------------- variant maps (server string -> cva variant) ---------------- */

/** Pick the first known key; anything else yields undefined (= default look). */
function known<K extends string>(raw: string | undefined, keys: readonly K[]): K | undefined {
  const parts = (raw ?? "").split(/\s+/).filter(Boolean);
  return keys.find((k) => parts.join(" ") === k) ?? keys.find((k) => parts.includes(k));
}

const rowV = cva("flex min-w-0 flex-row items-center gap-2.5", {
  variants: {
    v: {
      default: "flex-wrap",
      table: "flex-nowrap border-b border-line py-1 text-sm [&>*]:min-w-[5.5rem] [&>*]:flex-1 [&>*]:basis-0",
      line: "flex-nowrap text-sm [&>:nth-child(2)]:flex-1",
      head: "flex-nowrap items-center",
    },
  },
  defaultVariants: { v: "default" },
});
const ROW_KEYS = ["table", "line", "head"] as const;

const listV = cva("", { variants: { v: { default: "flex flex-col gap-2", grid: "grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-2" } }, defaultVariants: { v: "default" } });

const cardV = cva("min-w-0 rounded-lg border p-3", {
  variants: {
    v: {
      default: "border-line bg-surface",
      highlight: "border-highlight bg-highlight-soft/60 ring-2 ring-highlight/40",
      hero: "border-transparent bg-gradient-to-br from-accent to-accent-hover text-accent-fg [&_[data-a2=caption]]:text-accent-fg/80",
      ok: "border-ok/50 bg-surface",
      danger: "border-bad/60 bg-bad-soft/40 ring-2 ring-bad/25",
      option: "border-line bg-surface p-2",
    },
  },
  defaultVariants: { v: "default" },
});
const CARD_KEYS = ["highlight", "hero", "ok", "danger", "option"] as const;

const textV = cva("", {
  variants: {
    v: {
      default: "text-sm",
      h1: "m-0 text-2xl font-semibold tracking-[-0.02em]",
      h3: "m-0 text-md font-semibold",
      h4: "text-base font-semibold",
      h5: "text-sm font-semibold",
      caption: "text-xs text-fg-muted",
      th: "text-2xs font-semibold tracking-wide text-fg-subtle uppercase",
      strong: "text-sm font-semibold",
      warning: "text-sm font-medium text-warn",
      code: "rounded-md bg-code-bg px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-code-fg",
      badge: "inline-flex h-5 items-center rounded-sm bg-highlight px-1.5 text-2xs font-semibold text-highlight-fg",
      chip: "inline-flex h-6 items-center rounded-full border border-line bg-surface-sunken px-2.5 text-xs font-medium text-fg",
      "chip ok": "inline-flex h-6 items-center rounded-full border border-ok/50 bg-ok-soft px-2.5 text-xs font-medium text-ok",
      "chip bad": "inline-flex h-6 items-center rounded-full border border-bad/50 bg-bad-soft px-2.5 text-xs font-medium text-bad",
      pass: "inline-flex h-6 items-center rounded-sm bg-ok-soft px-2 text-xs font-bold tracking-wide text-ok ring-1 ring-ok/40",
      fail: "inline-flex h-6 items-center rounded-sm bg-bad-soft px-2 text-xs font-bold tracking-wide text-bad ring-1 ring-bad/40",
      warnbadge: "inline-flex h-6 items-center rounded-sm bg-warn-soft px-2 text-xs font-bold tracking-wide text-warn ring-1 ring-warn/40",
    },
  },
  defaultVariants: { v: "default" },
});
const TEXT_KEYS = ["chip ok", "chip bad", "h1", "h3", "h4", "h5", "caption", "th", "strong", "warning", "code", "badge", "chip", "pass", "fail", "warnbadge"] as const;
const INLINE_TEXT = new Set(["badge", "chip", "chip ok", "chip bad", "pass", "fail", "warnbadge", "strong", "caption"]);

const imgV = cva("flex-none", {
  variants: {
    v: {
      icon: "size-[4.5rem] object-contain",
      "icon-sm": "size-12 object-contain",
      chart: "h-auto w-full max-w-[36rem] rounded-md border border-line bg-surface p-1",
    },
  },
  defaultVariants: { v: "icon" },
});
const IMG_KEYS = ["icon-sm", "icon", "chart"] as const;

/** JSON text variant: show fields, not a raw dump. */
function JsonText({ text }: { text: string }) {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON: shown as text below */
  }
  return (
    <details className="group rounded-md border border-line bg-surface-sunken/60 px-2.5 py-1.5">
      <summary className="cursor-pointer text-xs font-medium text-fg-muted select-none">Details</summary>
      <div className="mt-2">
        {parsed && typeof parsed === "object" && !Array.isArray(parsed) ? <KeyValue data={parsed as Record<string, unknown>} /> : <p className="m-0 text-xs break-words text-fg-muted">{text.slice(0, 600)}</p>}
      </div>
    </details>
  );
}

export function A2uiSurface({ messages, onAction, disabled }: { messages: A2uiMessage[]; onAction: (a: A2uiUserAction) => void; disabled?: boolean }) {
  const built = useMemo(() => applyMessages(messages), [messages]);
  const [clicked, setClicked] = useState<string | null>(null);

  const render = (id: string, depth = 0): React.ReactNode => {
    const c = built.components.get(id);
    if (!c || depth > 40) return null;
    const kids = Array.isArray(c.children) ? c.children : [];
    const v = typeof c.variant === "string" ? c.variant : "";
    switch (c.component) {
      case "Column":
        return (
          <div key={id} className="flex min-w-0 flex-col gap-2">
            {kids.map((k) => render(k, depth + 1))}
          </div>
        );
      case "Row":
        return (
          <div key={id} className={rowV({ v: known(v, ROW_KEYS) })}>
            {kids.map((k) => render(k, depth + 1))}
          </div>
        );
      case "List":
        return (
          <div key={id} className={listV({ v: known(v, ["grid"] as const) })} role="list">
            {kids.map((k) => (
              <div key={k} role="listitem" className="min-w-0">
                {render(k, depth + 1)}
              </div>
            ))}
          </div>
        );
      case "Card":
        return (
          <div key={id} className={cardV({ v: known(v, CARD_KEYS) })}>
            <div className="flex min-w-0 flex-col gap-2 [&>.flex-row]:flex-nowrap [&>.flex-row]:items-start">{c.child ? render(c.child, depth + 1) : null}</div>
          </div>
        );
      case "Image": {
        const url = String(resolve(c.url, built.data) ?? "");
        const iv = known(v, IMG_KEYS);
        return url ? <img key={id} className={imgV({ v: iv })} src={url} alt={iv === "chart" ? "Chart" : ""} /> : null;
      }
      case "Text": {
        const t = resolve(c.text, built.data);
        if (t === "" || t == null) return null;
        if (v === "json") return <JsonText key={id} text={String(t)} />;
        if (v === "avatar")
          return (
            <span key={id} aria-hidden className="grid size-11 flex-none place-items-center rounded-lg bg-accent-soft text-accent-soft-fg">
              <Bot className="size-6" />
            </span>
          );
        const tier = /\btier-(T[0-3])\b/.exec(v)?.[1];
        if (tier) return <TierBadge key={id} tier={tier} />;
        const tv = known(v, TEXT_KEYS);
        const Tag = tv && INLINE_TEXT.has(tv) ? "span" : "div";
        return (
          <Tag key={id} data-a2={tv ?? "text"} className={cn(textV({ v: tv }), "min-w-0 break-words")}>
            {String(t)}
          </Tag>
        );
      }
      case "Button": {
        const ev = c.action?.event;
        const busy = disabled || clicked !== null;
        return (
          <Button
            key={id}
            size="sm"
            variant={v === "secondary" ? "secondary" : "primary"}
            disabled={busy}
            aria-pressed={clicked === id}
            onClick={() => {
              if (!ev) return;
              const context = Object.fromEntries(Object.entries(ev.context ?? {}).map(([k, val]) => [k, resolve(val, built.data)]));
              setClicked(id);
              onAction({ name: ev.name, surfaceId: built.surfaceId, sourceComponentId: id, timestamp: new Date().toISOString(), context });
            }}
          >
            {c.child ? render(c.child, depth + 1) : ev?.name}
          </Button>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="my-2 max-w-full overflow-x-auto rounded-xl border border-line bg-surface p-3 text-fg shadow-xs" data-surface={built.surfaceId}>
      {render("root")}
    </div>
  );
}
