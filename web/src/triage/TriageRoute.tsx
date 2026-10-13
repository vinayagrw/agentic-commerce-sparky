/** /triage: operator view of zero-result records filed by storefront search. */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { EmptyState, ErrorState } from "@/components/states";
import { SearchX } from "lucide-react";
import { shop } from "@/store/session";
import { useAsync } from "@/store/ui";

type F = "all" | "open" | "acknowledged" | "resolved";

export function Component() {
  const [f, setF] = useState<F>("open");
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const res = useAsync(() => shop.triage(f === "all" ? undefined : f), [f, tick]);
  const set = async (id: string, status: string) => {
    setErr(null);
    try {
      await shop.setTriage(id, status, `${status} from triage view`);
      setTick((t) => t + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const items = res.data?.items ?? [];
  return (
    <main className="mx-auto grid w-full max-w-[80rem] content-start gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-2xl font-bold">Search triage</h1>
        <Segmented<F>
          label="Status filter"
          value={f}
          onValueChange={setF}
          items={(["open", "acknowledged", "resolved", "all"] as F[]).map((v) => ({ value: v, label: v, title: `Show ${v}` }))}
        />
      </div>
      <p className="m-0 text-sm text-fg-muted">Zero-result searches filed by the storefront, with the relaxation that was offered.</p>
      {(res.error || err) && <ErrorState title="Triage service error">{res.error ?? err}</ErrorState>}
      {!res.error && items.length === 0 && <EmptyState icon={SearchX}>{res.loading ? "Loading…" : "No records."}</EmptyState>}
      {items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-muted">
                {["When", "Query", "Filters", "Store", "Relaxation", "Status", "Actions"].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} data-testid="triage-row" className="border-b border-line align-top">
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{new Date(it.ts).toLocaleString()}</td>
                  <td className="px-3 py-2 font-medium">{it.query}</td>
                  <td className="px-3 py-2 font-mono text-2xs">{JSON.stringify(it.filters)}</td>
                  <td className="px-3 py-2">{it.store_id}</td>
                  <td className="px-3 py-2 text-xs">{it.relaxation ? `${it.relaxation.label} (${it.relaxation.count})` : "none found"}</td>
                  <td className="px-3 py-2">
                    <Badge tone={it.status === "open" ? "warn" : it.status === "resolved" ? "ok" : "info"}>{it.status}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <Button size="xs" disabled={it.status !== "open"} onClick={() => set(it.id, "acknowledged")} aria-label={`Acknowledge ${it.query}`}>
                        Acknowledge
                      </Button>
                      <Button size="xs" variant="primary" disabled={it.status === "resolved"} onClick={() => set(it.id, "resolved")} aria-label={`Resolve ${it.query}`}>
                        Resolve
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
