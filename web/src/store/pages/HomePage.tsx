import { ListChecks, Target } from "lucide-react";
import { Card } from "@/components/ui/card";
import { normaliseLists, shop } from "../session";
import { CATEGORIES } from "../types";
import { PageTitle, ProductImage, StoreLink, useAsync, useSession } from "../ui";

const MISSIONS = [
  { title: "Nut-free school lunches under $40", q: "nut free snacks" },
  { title: "Coffee and #4 cone filters", q: "ground coffee" },
  { title: "New puppy starter kit", q: "puppy food" },
  { title: "Work-from-home desk setup", q: "usb c hub" },
];

export function Component() {
  const s = useSession();
  const lists = useAsync(() => shop.lists(), [s?.session_id]);
  const saved = lists.data ? normaliseLists(lists.data) : [];
  return (
    <div className="grid gap-6">
      <PageTitle>Shop by category</PageTitle>
      <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-6">
        {CATEGORIES.map((c) => (
          <li key={c.id}>
            <StoreLink
              to={`/shop/search?q=${encodeURIComponent(c.query)}`}
              className="group grid gap-2 rounded-xl border border-line bg-surface p-3 text-fg no-underline shadow-xs transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-focus"
            >
              <ProductImage image={`placeholder:${c.id}:${c.emoji}:`} className="aspect-square w-full" />
              <span className="text-sm font-semibold group-hover:underline">{c.label}</span>
            </StoreLink>
          </li>
        ))}
      </ul>

      <section aria-labelledby="missions" className="grid gap-3">
        <h2 id="missions" className="m-0 flex items-center gap-2 text-lg font-semibold">
          <Target className="size-5 text-accent" aria-hidden />
          Missions
        </h2>
        <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-4">
          {MISSIONS.map((m) => (
            <li key={m.title}>
              <Card className="grid h-full gap-2 p-4">
                <span className="font-medium">{m.title}</span>
                <span className="text-xs text-fg-muted">Start with a search, or ask Compass to plan it with your constraints.</span>
                <StoreLink to={`/shop/search?q=${encodeURIComponent(m.q)}`} className="text-sm font-medium text-accent-soft-fg">
                  Search "{m.q}"
                </StoreLink>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="saved" className="grid gap-3">
        <h2 id="saved" className="m-0 flex items-center gap-2 text-lg font-semibold">
          <ListChecks className="size-5 text-accent" aria-hidden />
          Saved lists
        </h2>
        {lists.error ? (
          <p className="m-0 text-sm text-bad">Lists unavailable: {lists.error}</p>
        ) : saved.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">{lists.loading ? "Loading lists…" : "No saved lists yet. Use \"Save to list\" on any product."}</p>
        ) : (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {saved.map((l) => (
              <li key={l.name}>
                <StoreLink to="/shop/lists" className="inline-flex h-8 items-center gap-2 rounded-full border border-line bg-surface px-3 text-sm text-fg no-underline hover:bg-surface-hover">
                  {l.name} <span className="tabular text-xs text-fg-muted">{l.items.length}</span>
                </StoreLink>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
