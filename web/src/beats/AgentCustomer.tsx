/**
 * Beat 5: an external shopper agent calls the catalog feed with a signed identity. The readiness
 * score and the feed response both come from shop-http, with provenance.
 */
import { useState } from "react";
import { BadgeCheck, BadgeHelp, Bot, FileWarning, ServerCrash } from "lucide-react";
import { getJson } from "../api";
import { usePoll } from "@/lib/usePoll";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Metric, provenanceIn, ProvenanceChip } from "@/components/Provenance";
import { ErrorState, KeyValue, PanelSkeleton } from "@/components/states";

function Gauge({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const angle = Math.PI * (1 - pct);
  const x = 60 + 50 * Math.cos(angle);
  const y = 60 - 50 * Math.sin(angle);
  const tone = score >= 80 ? "stroke-ok" : score >= 60 ? "stroke-warn" : "stroke-bad";
  return (
    <svg viewBox="0 0 120 66" className="w-40" aria-hidden>
      <path d="M10 60 A50 50 0 0 1 110 60" fill="none" className="stroke-surface-sunken" strokeWidth="11" strokeLinecap="round" />
      <path d={`M10 60 A50 50 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`} fill="none" className={tone} strokeWidth="11" strokeLinecap="round" />
    </svg>
  );
}

const VARIANTS = [
  { key: "verified", label: "Verified signature", icon: BadgeCheck },
  { key: "unverified", label: "Unverified", icon: BadgeHelp },
  { key: "tampered", label: "Tampered signature", icon: FileWarning },
] as const;

export function AgentCustomer() {
  const ready = usePoll<any>("/api/agent/readiness?category=Grocery");
  const [feed, setFeed] = useState<any>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const call = async (variant: string) => {
    setBusy(variant);
    setFeedError(null);
    try {
      setFeed(await getJson(`/api/agent/feed?variant=${variant}&category=Grocery`));
    } catch {
      setFeedError("The BFF did not answer /api/agent/feed");
    } finally {
      setBusy(null);
    }
  };
  const score = Number(ready.data?.score);
  const feedProv = feed ? provenanceIn(feed) : null;
  const unavailable = feed?.service_unavailable;

  return (
    <section aria-label="Agent as customer" className="grid gap-4 border-b border-line bg-surface p-4 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="grid content-start gap-3">
        <div className="flex items-start gap-3">
          <span aria-hidden className="grid size-10 flex-none place-items-center rounded-lg bg-accent-soft text-accent-soft-fg">
            <Bot className="size-5" />
          </span>
          <div>
            <h2 className="m-0 text-md font-semibold">External shopper agent → catalog feed</h2>
            <p className="m-0 text-sm text-fg-muted">Signed agent identity (Web Bot Auth-style HMAC demo). Verified agents get the full structured catalog and higher rate limits.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {VARIANTS.map((v) => (
            <Button key={v.key} variant="secondary" disabled={busy != null} onClick={() => call(v.key)}>
              <v.icon />
              {busy === v.key ? "Calling…" : v.label}
            </Button>
          ))}
        </div>

        {feedError && <ErrorState title="Feed call failed">{feedError}</ErrorState>}
        {unavailable && (
          <ErrorState title={`${unavailable.service} is down`} fix={unavailable.fix}>
            {feed.error}
          </ErrorState>
        )}
        {feed && !unavailable && (
          <div className="grid gap-3 rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={feed.status >= 400 ? "bad" : "ok"}>HTTP {feed.status}</Badge>
              <Badge tone="outline">tier: {feed.tier ?? "–"}</Badge>
              {feedProv && <ProvenanceChip compact provenance={feedProv} className="ml-auto" />}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              <Metric hideChip label="Items returned" value={feed.count ?? feed.items?.length} source={feed} missing="no items field" />
              <Metric hideChip label="Rate limit used" value={feed.rate_limit?.used} source={feed} format={(v) => `${v}/${feed.rate_limit?.limit_per_min ?? "?"}`} suffix="per min" missing="no rate limit reported" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid content-start gap-1.5">
                <span className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">Request headers</span>
                <KeyValue data={feed.request_headers} />
              </div>
              <div className="grid content-start gap-1.5">
                <span className="text-2xs font-semibold tracking-wide text-fg-subtle uppercase">{feed.error || feed.detail ? "Refusal" : "First item"}</span>
                {feed.error || typeof feed.detail === "string" ? <p className="m-0 text-sm text-bad">{String(feed.error ?? feed.detail)}</p> : <KeyValue data={feed.items?.[0] ?? null} limit={8} />}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex min-w-[12rem] flex-col items-center gap-1 rounded-lg border border-line bg-surface-sunken/50 px-4 py-3 text-center">
        {ready.loading ? (
          <PanelSkeleton rows={2} label="Loading readiness score" />
        ) : ready.error ? (
          <div className="grid justify-items-center gap-1 text-sm text-fg-muted">
            <ServerCrash className="size-5 text-bad" aria-hidden />
            Readiness score unavailable: {ready.error}
          </div>
        ) : (
          <>
            {Number.isFinite(score) && <Gauge score={score} />}
            <div className={cn("-mt-6", !Number.isFinite(score) && "mt-0")}>
              <Metric label="Agent readiness" value={score} source={ready.data} size="lg" tone={score >= 80 ? "ok" : score >= 60 ? "warn" : "bad"} missing="score not reported" />
            </div>
            <div className="text-xs text-fg-muted">
              {ready.data?.category ?? "Grocery"}
              {ready.data?.product_count ? ` · over ${ready.data.product_count} live products` : ""}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
