/**
 * A2UI v0.9 surface builder (public preview spec).
 *
 * For each tool result that carries a `ui` hint we emit the three-message set
 *   { version:"v0.9", createSurface   : { surfaceId, catalogId } }
 *   { version:"v0.9", updateComponents: { surfaceId, components: [...] } }   // flat, id-referenced, root id "root"
 *   { version:"v0.9", updateDataModel : { surfaceId, path:"/", value } }
 * using only Basic catalog components: List, Card, Column, Row, Image, Text, Button.
 * Dynamic values bind to the data model with { path }. Button actions use the
 * v0.9 shape { event: { name, context } }.
 *
 * Product "images" are emoji drawn into an SVG data URI so they stay spec-pure
 * Image components and render large (catalog image URLs are placeholders).
 */
import type { A2uiComponent, A2uiMessage, UiHint } from "@sparky/shared";
import { BASIC_CATALOG_ID, UI_HINTS } from "@sparky/shared";

type Json = Record<string, any>;

const EMOJI: [RegExp, string][] = [
  [/tortilla|taco/i, "🌮"], [/beef|meat/i, "🥩"], [/cheese(?! cracker)/i, "🧀"], [/salsa|tomato/i, "🍅"],
  [/season|spice/i, "🧂"], [/egg/i, "🥚"], [/banana/i, "🍌"], [/apple/i, "🍎"], [/oat|cereal/i, "🥣"],
  [/pasta sauce|marinara/i, "🥫"], [/pasta|penne/i, "🍝"], [/granola|bar\b|bars/i, "🍫"], [/trail mix|nut/i, "🥜"],
  [/milk/i, "🥛"], [/coffee/i, "☕"], [/cracker|snack/i, "🍘"], [/toilet|tissue|wipes/i, "🧻"],
  [/lunch/i, "🍱"], [/earbud|headphone/i, "🎧"], [/charger|cable/i, "🔌"], [/controller|game/i, "🎮"],
  [/\btvs?\b/i, "📺"], [/fryer|pan\b/i, "🍳"], [/sheet|bed/i, "🛏️"], [/blender/i, "🥤"], [/boot/i, "👢"],
  [/shirt|tee/i, "👕"], [/sneaker|shoe/i, "👟"], [/legging/i, "👖"], [/jacket/i, "🧥"], [/diaper/i, "🧷"],
  [/formula/i, "🍼"], [/car seat/i, "🚼"], [/pain|cold|allergy|sleep|tablet/i, "💊"], [/lighter/i, "🔥"],
  [/lubric/i, "🛠️"], [/laundry|detergent/i, "🧺"], [/lumber|stud/i, "🪵"], [/backpack|school|pencil|notebook/i, "🎒"],
];

export function emojiFor(p: Json): string {
  const hay = `${p.pt ?? ""} ${p.category ?? ""} ${p.title ?? ""}`;
  for (const [re, e] of EMOJI) if (re.test(hay)) return e;
  return "🛒";
}

export function emojiImage(emoji: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><text x="48" y="74" font-size="72" text-anchor="middle">${emoji}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const money = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(2)}` : "");

/** Accept the many shapes a tool might return a product list in. */
export function productsOf(data: Json): Json[] {
  if (!data || typeof data !== "object") return [];
  for (const k of ["results", "products", "items", "substitutes", "lines", "candidates"]) {
    if (Array.isArray(data[k])) return data[k];
  }
  if (Array.isArray(data.cart?.items)) return data.cart.items;
  if (Array.isArray(data.cart?.lines)) return data.cart.lines;
  if (data.product && typeof data.product === "object") return [data.product];
  if (data.product_id && data.title) return [data];
  return Array.isArray(data) ? data : [];
}

export function hintOf(result: unknown): UiHint | null {
  const r = result as Json | null;
  const h =
    typeof r?.ui === "string" ? r.ui : typeof r?.ui?.surface === "string" ? r.ui.surface : typeof r?.ui?.type === "string" ? r.ui.type : null;
  return h && (UI_HINTS as string[]).includes(h) ? (h as UiHint) : null;
}

class Builder {
  components: A2uiComponent[] = [];
  private n = 0;
  id(prefix: string) {
    return `${prefix}_${++this.n}`;
  }
  add(c: A2uiComponent) {
    this.components.push(c);
    return c.id;
  }
  text(text: A2uiComponent["text"], variant?: string) {
    return this.add({ id: this.id("t"), component: "Text", text, ...(variant ? { variant } : {}) });
  }
  image(url: A2uiComponent["url"], variant = "icon") {
    return this.add({ id: this.id("img"), component: "Image", url, variant });
  }
  row(children: string[], variant?: string) {
    return this.add({ id: this.id("row"), component: "Row", children, ...(variant ? { variant } : {}) });
  }
  col(children: string[], id?: string) {
    return this.add({ id: id ?? this.id("col"), component: "Column", children });
  }
  list(children: string[], variant?: string) {
    return this.add({ id: this.id("list"), component: "List", children, ...(variant ? { variant } : {}) });
  }
  card(child: string, variant?: string) {
    return this.add({ id: this.id("card"), component: "Card", child, ...(variant ? { variant } : {}) });
  }
  button(label: string, name: string, context: Record<string, string | number | boolean> = {}, variant = "primary") {
    const child = this.text(label);
    return this.add({ id: this.id("btn"), component: "Button", child, variant, action: { event: { name, context } } });
  }
}

function stockLabel(p: Json): string {
  const s = typeof p.in_stock_at_store === "boolean" ? p.in_stock_at_store : typeof p.in_stock === "boolean" ? p.in_stock : undefined;
  if (s !== undefined) return s ? "In stock at store" : "Out of stock at store";
  const st = p.stock;
  if (st && typeof st === "object" && typeof st["4108"] === "number") return st["4108"] > 0 ? `In stock at 4108 (${st["4108"]})` : "Out of stock at 4108";
  return "";
}

function productModel(p: Json) {
  const price = Number(p.price ?? p.unit_price ?? p.offers?.price);
  return {
    product_id: String(p.product_id ?? p.id ?? ""),
    title: String(p.title ?? p.name ?? "Unnamed product"),
    brand: p.brand ?? "",
    price: Number.isFinite(price) ? price : null,
    price_label: money(price),
    rating_label: p.rating ? `★ ${p.rating}` : "",
    badge: p.sponsored ? "Sponsored" : "",
    dietary_label: Array.isArray(p.dietary) ? p.dietary.join(" · ").replace(/_/g, " ") : "",
    stock_label: stockLabel(p),
    icon: emojiImage(emojiFor(p)),
    qty: Number(p.qty ?? p.quantity ?? 1),
    scores: p.scores ?? {},
    sub_score: p.sub_score,
    components: p.components,
    why: p.rank_explain ?? p.why ?? "",
  };
}

function productCard(b: Builder, i: number, base: string, actions: string[]) {
  const p = (k: string) => ({ path: `${base}/${i}/${k}` });
  const meta = b.row([b.text(p("price_label"), "h4"), b.text(p("rating_label"), "caption"), b.text(p("badge"), "badge")]);
  const body = b.col([b.text(p("title"), "h5"), meta, b.text(p("dietary_label"), "caption"), b.text(p("stock_label"), "caption"), ...actions]);
  return b.card(b.row([b.image(p("icon")), body]));
}

const fmt = (n: unknown) => (typeof n === "number" ? n.toFixed(3) : String(n ?? "–"));

export function buildA2ui(hint: UiHint, data: Json, surfaceId: string): A2uiMessage[] {
  const b = new Builder();
  let model: Json = {};
  const root: string[] = [];
  const items = productsOf(data).map(productModel);

  switch (hint) {
    case "product_grid": {
      const title = data.query ? `Results for “${data.query}”` : data.untrusted_content ? "Seller listing (quarantined)" : "Products";
      model = { title, note: data.untrusted_content ? "⚠ Untrusted seller text was quarantined and treated as data." : "", items };
      root.push(b.text({ path: "/title" }, "h3"));
      if (model.note) root.push(b.text({ path: "/note" }, "warning"));
      const cards = items.map((it, i) => productCard(b, i, "/items", [b.button("Add to cart", "add_to_cart", { product_id: it.product_id, qty: 1 })]));
      root.push(b.list(cards, "grid"));
      break;
    }
    case "compare_table": {
      if (Array.isArray(data.rows) && data.rows[0]?.product_id && "recommendation" in data) {
        // Wave 0b compare mode: live quotes + parsed size + unit price, with a recommendation and reason.
        const rows = data.rows as Json[];
        const rec = data.recommendation as Json | null;
        model = {
          title: "Compare",
          recommendation: rec ? `Recommended: ${rec.reason}` : "No recommendation: nothing compared is both in stock and priced.",
          label: String(data.synthetic_label ?? ""),
          rows: rows.map((r) => ({
            title: String(r.title).slice(0, 70),
            price: r.price != null ? money(r.price) : "price unavailable",
            size: r.size_label,
            unit: r.unit_price_label,
            dietary: Array.isArray(r.dietary) && r.dietary.length ? r.dietary.join(", ").replace(/_/g, " ") : "none tagged",
            rating: r.rating != null ? `★ ${r.rating}` : "no rating",
            stock: r.in_stock === true ? "In stock" : r.in_stock === false ? "Out of stock" : "stock unknown",
            pick: rec?.product_id === r.product_id ? "Recommended" : "",
          })),
        };
        root.push(b.text({ path: "/title" }, "h3"));
        root.push(b.row(["Product", "Price", "Size", "Unit price", "Dietary", "Rating", "Stock"].map((h) => b.text(h, "th")), "table"));
        rows.forEach((r, i) => {
          const p = (k: string) => ({ path: `/rows/${i}/${k}` });
          root.push(b.row([b.col([b.text(p("title"), rec?.product_id === r.product_id ? "strong" : undefined), b.text(p("pick"), "badge")]), b.text(p("price")), b.text(p("size")), b.text(p("unit")), b.text(p("dietary"), "caption"), b.text(p("rating"), "caption"), b.text(p("stock"), "caption")], "table"));
        });
        root.push(b.text({ path: "/recommendation" }, "strong"));
        root.push(b.text({ path: "/label" }, "caption"));
        if (rec) root.push(b.button("Add recommended to cart", "add_to_cart", { product_id: String(rec.product_id), qty: 1 }));
      } else if (Array.isArray(data.rows)) {
        const ids: string[] = data.product_ids ?? [];
        model = { title: "Compare and explain", cheapest: data.cheapest ? `Cheapest: ${data.cheapest}` : "" };
        root.push(b.text({ path: "/title" }, "h3"));
        root.push(b.row([b.text("Attribute", "th"), ...ids.map((id) => b.text(id, "th"))], "table"));
        for (const r of data.rows as Json[]) {
          const cells = ids.map((id) => {
            const v = r.values?.[id];
            return b.text(r.attribute === "sponsored" ? (v ? "Sponsored" : "Organic") : typeof v === "number" ? (r.attribute === "price" ? money(v) : fmt(v)) : String(v ?? "–"), r.differs ? "strong" : undefined);
          });
          root.push(b.row([b.text(String(r.attribute), "caption"), ...cells], "table"));
        }
        root.push(b.text({ path: "/cheapest" }, "caption"));
      } else {
        model = { title: "Compare and explain", items };
        root.push(b.text({ path: "/title" }, "h3"));
        root.push(b.row(["Product", "Price", "BM25", "Vector", "Rerank", "Placement"].map((h) => b.text(h, "th")), "table"));
        items.forEach((it, i) => {
          const s = it.scores as Json;
          root.push(
            b.row(
              [
                b.row([b.image({ path: `/items/${i}/icon` }, "icon-sm"), b.text({ path: `/items/${i}/title` })]),
                b.text({ path: `/items/${i}/price_label` }),
                b.text(fmt(s.bm25)),
                b.text(fmt(s.vector ?? s.dense)),
                b.text(fmt(s.rerank ?? s.rrf)),
                b.text(it.badge ? "Sponsored" : "Organic", it.badge ? "badge" : "caption"),
              ],
              "table",
            ),
          );
        });
      }
      break;
    }
    case "cart": {
      const total = Number(data.total ?? data.cart?.total ?? items.reduce((a, it) => a + (it.price ?? 0) * it.qty, 0));
      const check = data.cart?.budget_check;
      model = {
        title: data.goal ? `Plan: ${data.goal}` : "Cart",
        items,
        total_label: `Total ${money(total)}`,
        budget_label: check ? (typeof check === "string" ? check : JSON.stringify(check)) : data.budget ? `Budget $${data.budget}` : "",
        error: data.error ?? "",
      };
      root.push(b.text({ path: "/title" }, "h3"));
      if (data.error) root.push(b.text({ path: "/error" }, "warning"));
      items.forEach((it, i) => {
        root.push(b.row([b.image({ path: `/items/${i}/icon` }, "icon-sm"), b.text({ path: `/items/${i}/title` }), b.text(`× ${it.qty}`), b.text({ path: `/items/${i}/price_label` })], "line"));
      });
      root.push(b.row([b.text({ path: "/total_label" }, "h4"), b.text({ path: "/budget_label" }, "caption")]));
      break;
    }
    case "substitutes": {
      const origId = String(data.original?.product_id ?? data.product_id ?? "");
      model = { title: `${data.original?.title ?? origId ?? "Item"} is unavailable. Suggested substitutes:`, items };
      root.push(b.text({ path: "/title" }, "h3"));
      const cards = items.map((it, i) => {
        const c = it.components as Json | undefined;
        const why = c
          ? `score ${it.sub_score} · similarity ${c.similarity} · Δ$${c.price_delta} · diet ${c.dietary_match ? "✓" : "✗"} · ${c.in_stock ? "in stock" : "OOS"}`
          : `score ${it.sub_score ?? "n/a"}`;
        return productCard(b, i, "/items", [
          b.text(why, "caption"),
          b.row([
            b.button("Accept", "substitute_accept", { product_id: it.product_id, replaces: origId }),
            b.button("Reject", "substitute_reject", { product_id: it.product_id }, "secondary"),
          ]),
        ]);
      });
      root.push(b.list(cards));
      break;
    }
    case "mandate": {
      const body: Json = data.mandate ?? data;
      const id = String(body.mandate_id ?? data.mandate_id ?? body.id ?? "");
      const signed = { mandate: body, signature: data.signature, status: data.status };
      model = {
        title: data.error ? "Mandate could not be created" : "Checkout mandate awaiting your approval",
        summary: data.error
          ? String(data.error)
          : `Spend cap ${money(Number(body.spend_cap))} · cart ${money(Number(body.cart_total ?? body.total ?? body.amount))} · status ${data.status ?? "pending"} · no payment is ever taken`,
        json: JSON.stringify(signed, null, 2),
      };
      const kids = [b.text({ path: "/title" }, "h3"), b.text({ path: "/summary" }), b.text({ path: "/json" }, "code")];
      if (!data.error && id) {
        kids.push(b.row([b.button("Approve mandate", "mandate_approve", { mandate_id: id }), b.button("Reject", "mandate_reject", { mandate_id: id }, "secondary")]));
      }
      root.push(b.card(b.col(kids), "highlight"));
      break;
    }
    case "storefront": {
      const sections: Json[] = Array.isArray(data.sections) ? data.sections : items.length ? [{ title: "Featured", products: productsOf(data) }] : [];
      const tagline =
        data.score != null
          ? `Agent readiness score ${data.score}/100 across ${data.product_count} products (${data.category})`
          : data.tagline ?? "Composed by the agent from live catalog results";
      model = {
        hero: data.title ?? data.hero ?? (data.score != null ? "Agent readiness" : "Storefront"),
        tagline,
        breakdown: data.breakdown
          ? Object.entries(data.breakdown as Json).map(([k, v]: [string, any]) => `${k.replace(/_/g, " ")}: ${v.points}/${v.weight}`).join(" · ")
          : "",
        sections: sections.map((s) => ({ title: s.title, items: productsOf(s).map(productModel) })),
      };
      root.push(b.card(b.col([b.text({ path: "/hero" }, "h1"), b.text({ path: "/tagline" }), b.text({ path: "/breakdown" }, "caption")]), "hero"));
      (model.sections as Json[]).forEach((s, si) => {
        root.push(b.text({ path: `/sections/${si}/title` }, "h3"));
        const cards = (s.items as Json[]).map((it, i) => productCard(b, i, `/sections/${si}/items`, [b.button("Add", "add_to_cart", { product_id: it.product_id, qty: 1 })]));
        root.push(b.list(cards, "grid"));
      });
      break;
    }
    case "could_not_do": {
      // B09: what the session could not satisfy or verify this turn, from the runtime verifier.
      const rows: Json[] = Array.isArray(data.could_not) ? data.could_not : [];
      model = {
        title: "What I could not do",
        note: `Checked against your cart by the session verifier (${data.verdict ?? "unknown"}).`,
        items: rows.map((r) => ({ constraint: String(r.constraint ?? ""), reason: String(r.reason ?? "") })),
      };
      const kids = [b.text({ path: "/title" }, "h3"), b.text({ path: "/note" }, "caption")];
      rows.forEach((_, i) => kids.push(b.row([b.text({ path: `/items/${i}/constraint` }, "strong"), b.text({ path: `/items/${i}/reason` })], "line")));
      root.push(b.card(b.col(kids), "warning"));
      break;
    }
    case "agent_api": {
      const rl = data.rate_limit;
      model = {
        title: "Agent-facing catalog feed",
        tier: `Tier: ${data.tier ?? "unknown"}`,
        rate: typeof rl === "object" && rl ? `Rate limit ${rl.used}/${rl.limit_per_min} per min` : `Rate limit: ${rl ?? "n/a"}`,
        status: `HTTP ${data.status ?? 200}${data.error ? ` · ${data.error}` : ""} · ${data.count ?? items.length} items`,
        items,
      };
      root.push(b.text({ path: "/title" }, "h3"));
      root.push(b.row([b.text({ path: "/tier" }, "badge"), b.text({ path: "/rate" }, "caption"), b.text({ path: "/status" }, "caption")]));
      root.push(b.list(items.slice(0, 8).map((_, i) => b.row([b.image({ path: `/items/${i}/icon` }, "icon-sm"), b.text({ path: `/items/${i}/title` }), b.text({ path: `/items/${i}/price_label` })], "line"))));
      break;
    }
  }

  b.col(root, "root");
  return [
    { version: "v0.9", createSurface: { surfaceId, catalogId: BASIC_CATALOG_ID } },
    { version: "v0.9", updateComponents: { surfaceId, components: b.components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: model } },
  ];
}
