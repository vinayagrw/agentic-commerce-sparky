/**
 * The health gate.
 *
 * On load (and after every run) the app asks /api/diag which services are up. Each one
 * that is not gets a red banner naming the service, the port and the command that fixes
 * it. Beats do not run while a required service is down — the BFF refuses too, so this is
 * the visible half of a rule enforced on both sides.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, LockKeyhole, RefreshCw, ServerCrash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Plane, ServiceOutage } from "@sparky/shared";
import { getJson } from "../api";

export interface DiagState {
  outages: { shopper: ServiceOutage[]; ops: ServiceOutage[] };
  banners: { shopper: string[]; ops: string[] };
  claude?: { found: boolean; authenticated: boolean; version: string | null; authDetail: string | null };
  policyMcp?: { ok: boolean; shopperTools: string[]; opsTools: string[]; roleSeparationHolds: boolean; error?: string };
  live?: boolean;
}

export function useHealthGate(pollMs = 20_000) {
  const [diag, setDiag] = useState<DiagState | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const refresh = useCallback(async (fresh = false) => {
    setChecking(true);
    try {
      setDiag(await getJson<DiagState>(`/api/diag${fresh ? "?fresh=1" : ""}`));
    } catch {
      // The BFF itself is down: that is an outage too, and the one banner we can infer.
      setDiag({
        outages: { shopper: [{ key: "searchSvc", name: "bff", port: 8787, fix: "make dev", detail: "the BFF did not answer /api/diag" }], ops: [{ key: "searchSvc", name: "bff", port: 8787, fix: "make dev" }] },
        banners: { shopper: ["bff down on :8787 — run `make dev`"], ops: ["bff down on :8787 — run `make dev`"] },
      });
    } finally {
      setCheckedAt(new Date());
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  // The coverage board needs only the BFF, and /api/coverage refuses on its own if the data is missing.
  const outagesFor = useCallback((plane: Plane) => (plane === "coverage" ? [] : diag?.outages?.[plane] ?? []), [diag]);

  return { diag, checking, checkedAt, refresh, outagesFor, ready: Boolean(diag) };
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked: the command is still visible and selectable */
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md border border-line bg-code-bg py-0.5 pr-0.5 pl-2.5 text-code-fg">
      <span aria-hidden className="font-mono text-xs text-fg-subtle select-none">$</span>
      <code className="min-w-0 flex-1 truncate font-mono text-sm select-all">{command}</code>
      <button
        type="button"
        onClick={copy}
        className="inline-flex size-7 items-center justify-center rounded-sm text-code-fg/70 hover:bg-white/10 hover:text-code-fg focus-visible:outline-2 focus-visible:outline-focus"
        aria-label={copied ? "Copied" : `Copy command: ${command}`}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/**
 * The health gate as a deliberate interrupt. It is the visible proof that nothing is
 * fabricated: while a required service is down the beats are locked, and this says exactly
 * which service, on which port, and the command that brings it back.
 */
export function HealthBanners({
  outages,
  onRetry,
  checking,
  checkedAt,
  planeLabel,
}: {
  outages: ServiceOutage[];
  onRetry: () => void;
  checking?: boolean;
  checkedAt?: Date | null;
  planeLabel?: string;
}) {
  if (!outages.length) return null;
  const n = outages.length;
  return (
    <section
      role="alert"
      aria-live="assertive"
      className="health-gate relative overflow-hidden rounded-xl border border-bad/40 bg-surface shadow-md"
    >
      <div aria-hidden className="absolute inset-y-0 left-0 w-1 bg-bad" />
      <div className="flex flex-wrap items-start gap-4 border-b border-line bg-bad-soft px-5 py-4">
        <span aria-hidden className="grid size-10 flex-none place-items-center rounded-lg bg-bad text-bad-fg shadow-sm">
          <LockKeyhole className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-lg font-semibold tracking-[-0.01em] text-fg">
              {planeLabel ? `${planeLabel} beats are locked` : "Beats are locked"}
            </h2>
            <Badge tone="solidBad" size="sm">
              {n} required service{n === 1 ? "" : "s"} down
            </Badge>
          </div>
          <p className="m-0 mt-1 max-w-[62ch] text-sm text-fg-muted">
            Nothing is substituted. Every number in this demo comes from a live service, so no beat runs until the services below answer again. The BFF refuses these runs too.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {checkedAt && (
            <span className="tabular text-xs text-fg-subtle">
              checked {checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
          <Button variant="primary" size="md" onClick={onRetry} disabled={checking}>
            <RefreshCw className={checking ? "animate-spin" : undefined} />
            {checking ? "Checking" : "Re-check now"}
          </Button>
        </div>
      </div>
      <ul className="m-0 list-none divide-y divide-line p-0">
        {outages.map((o) => (
          <li key={`${o.key}${o.name}`} className="health-banner grid gap-2 px-5 py-3 sm:grid-cols-[minmax(10rem,14rem)_1fr_minmax(12rem,20rem)] sm:items-center">
            <div className="flex items-center gap-2">
              <ServerCrash aria-hidden className="size-4 flex-none text-bad" />
              <span className="font-mono text-sm font-semibold text-fg">{o.name}</span>
              {o.port ? <Badge size="sm" className="font-mono">:{o.port}</Badge> : null}
            </div>
            <div className="min-w-0 text-sm text-fg-muted">{o.detail ?? "not answering"}</div>
            <CopyCommand command={o.fix} />
          </li>
        ))}
      </ul>
    </section>
  );
}
