"""Technique 10: ROUTED GraphRAG over the real ESCI catalogue.

Two parts, both real:

1. A `networkx` product graph built from the data that is actually in this repo - no LLM extraction,
   no invented relations:
     product -[brand]->    brand          (25,003 products, from products.parquet)
     product -[category]-> category
     product <-[substitute]->  product    from ESCI's own label structure: for a judged query, every
                                          product labelled S ("substitute") is a substitute for every
                                          product labelled E ("exact") on that query. Edge weight =
                                          how many distinct queries support it; every edge keeps the
                                          supporting query ids as its citation.
     product -[complement]->   product    same construction from ESCI's C ("complement") label.
     product <-[co_intent]->   product    co-occurrence: two products both labelled E for the same
                                          query satisfy the same shopper intent. Capped per query so
                                          one broad query cannot dominate the graph.

2. A ROUTER that decides, per query, whether to use the graph or the normal hybrid retrieval path.
   Rules first, exactly as the playbook prescribes, with entity linking against the live index.

HONESTY NOTES that belong next to every number this module produces:
  * The substitute/complement/co_intent edges are derived from the SAME ESCI relevance labels that
    the NDCG eval scores against. The multi-hop eval set is hand-written and separate, so there is
    no leakage into the router/hit-rate numbers - but a graph-vs-hybrid NDCG comparison on the ESCI
    queries themselves would be circular, and this module therefore does not make one.
  * The multi-hop eval set (`graph_eval_set.json`) is HAND-LABELLED BY AN LLM (Claude) from the real
    catalogue. It is small. Router precision/recall computed on ~30 queries has wide, essentially
    uninformative confidence intervals; treat it as a smoke test of the routing rules, not evidence
    that the router generalises to Sparky traffic.
"""
from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVAL_SET = HERE / "graph_eval_set.json"

# ---------------------------------------------------------------- router rules
# Rules-first router (playbook section 10, "Query router: rules first, classifier fallback").
CHEAPER = re.compile(r"\b(cheaper|cheapest|less expensive|budget|affordable|lower priced|"
                     r"alternative to|alternatives to|instead of|substitute for|swap for|replacement for|"
                     r"similar to|like .{2,40} but)\b", re.I)
GOES_WITH = re.compile(r"\b(goes with|go with|pairs? with|pair with|compatible|works with|work with|fits?|"
                       r"accessor(?:y|ies) for|what else do i need|to use with|use with|bundle with|"
                       r"along with|complet(?:e|es) the)\b", re.I)
SAME_BRAND = re.compile(r"\b(same brand|same maker|same manufacturer|other .{0,25}(?:by|from) |"
                        r"more from|else does .{2,30} make|made by the same)\b", re.I)
GLOBAL = re.compile(r"\b(themes?|overall|most common|summar(?:ise|ize|y)|trends?|across (?:all|the)|"
                    r"what do (?:people|shoppers|reviewers)|in general)\b", re.I)

# Rules-first NON-PRODUCT intent: store policy / help questions (English + Spanish). Checked before every
# product rule. Patterns are phrase-level on purpose so product queries ("return address labels",
# "snap peas", "delivery truck toy") do not match.
HELP_EN = re.compile(
    r"\b(return policy|refund|refunds|how (?:do|can|to) (?:i )?return|return (?:an?|my|this) (?:item|order|product|purchase)|"
    r"returns? window|store hours|what time (?:does|do|is) .{0,30}(?:open|close)|(?:is|are) (?:the )?stores? open|"
    r"how does (?:curbside )?pickup work|pickup (?:policy|order|window|hours)|pick up my order|"
    r"delivery (?:fee|fees|policy|options|window|windows|times?)|how does delivery work|"
    r"order status|where is my order|track (?:my )?order|status of my order|"
    r"(?:use|accept|accepts|pay with|using) (?:my )?(?:snap|ebt)|(?:snap|ebt) (?:eligible|eligibility|benefits|card|payments?)|food stamps|"
    r"age[- ]restricted|(?:id|age) (?:check|verification)|substitution (?:policy|preferences?)|"
    r"(?:how do|what are) substitutions|price (?:adjustment|match|matching)|privacy policy|"
    r"(?:what does )?sponsored (?:mean|listings? mean|label)|accessibility (?:options|help|features)|"
    r"coupons? policy)\b", re.I)
HELP_ES = re.compile(
    r"(devoluci[oó]n|devoluciones|devolver|devuelvo|reembolso|horarios?\b|a qu[eé] hora (?:abre|cierra)|"
    r"recoger (?:mi |un |el )?pedido|recogida en tienda|entrega a domicilio|costo de (?:la )?entrega|"
    r"estado de mi pedido|d[oó]nde est[aá] mi pedido|cupones|con (?:snap|ebt)|cupones de alimentos|"
    r"restricci[oó]n de edad|sustituci[oó]n|sustituciones|ajuste de precio|privacidad|accesibilidad)", re.I)
HELP_RULES = (("HELP_EN", HELP_EN), ("HELP_ES", HELP_ES))

INTENTS = {"cheaper_alternative": CHEAPER, "goes_with": GOES_WITH, "same_brand": SAME_BRAND}
ROUTES = ("hybrid", "graph_local", "graph_global")

# Words stripped when guessing the entity span an intent phrase refers to.
ANCHOR_SPLIT = re.compile(r"\b(?:to|for|with|than|as|of|like|instead of|from)\b", re.I)
STOP = {"a", "an", "the", "my", "this", "that", "some", "any", "what", "which", "is", "are", "do", "i",
        "need", "else", "and", "or", "buy", "get", "me", "it", "them", "cheaper", "cheapest", "alternative",
        "alternatives", "substitute", "goes", "go", "with", "for", "to", "same", "brand", "other", "more",
        "compatible", "works", "work", "fits", "fit", "accessory", "accessories", "use", "using", "please",
        "show", "find", "something", "similar", "but", "less", "expensive", "budget", "than", "of", "in"}


def route(query: str, has_entity: bool = True) -> dict:
    """Rules-first route decision. Returns the route, the intent and the rule that fired."""
    for name, rx in HELP_RULES:
        m = rx.search(query)
        if m:
            return {"route": "help", "intent": "policy_help", "rule": f"{name}:{m.group(0).strip().lower()}",
                    "by": "rule"}
    if GLOBAL.search(query):
        return {"route": "graph_global", "intent": "global_theme", "rule": "GLOBAL", "by": "rule"}
    for intent, rx in INTENTS.items():
        m = rx.search(query)
        if m:
            if not has_entity:
                return {"route": "hybrid", "intent": intent, "rule": rx.pattern[:24],
                        "by": "rule", "note": "relational phrase matched but no entity could be linked"}
            return {"route": "graph_local", "intent": intent, "rule": m.group(0).strip().lower(), "by": "rule"}
    return {"route": "hybrid", "intent": "factoid", "rule": None, "by": "default"}


def anchor_span(query: str) -> str:
    """The part of the query that names the entity, e.g. 'cheaper alternative to the graco snugride'
    -> 'graco snugride'. Deliberately crude: it is a rule router, and the fallback is the whole query."""
    def content(s: str) -> list[str]:
        parts = [p for p in ANCHOR_SPLIT.split(s) if p.strip()]
        s = max(parts, key=len) if parts else s
        return [w for w in re.findall(r"[A-Za-z0-9'&\-]+", s) if w.lower() not in STOP]

    for rx in (CHEAPER, GOES_WITH, SAME_BRAND):
        m = rx.search(query)
        if m:
            words = content(query[m.end():]) or content(query[: m.start()])
            # Some phrasings put the entity INSIDE the match ("what else does Blue Buffalo make"),
            # so a thin tail means the split was wrong: fall back to the whole query.
            return " ".join(words) if len(words) >= 2 else " ".join(content(query)) or query
    return " ".join(content(query)) or query


# ---------------------------------------------------------------- graph
class ProductGraph:
    """networkx MultiDiGraph over the real catalogue + ESCI label structure."""

    CO_INTENT_CAP = 10   # max E-products per query used for co_intent pairs (stops broad queries dominating)

    def __init__(self, engine):
        import networkx as nx

        t0 = time.perf_counter()
        self.e = engine
        self.nx = nx
        g = nx.MultiDiGraph()
        p = engine.products
        self.brand_of, self.cat_of = {}, {}
        for pid, brand, cat in zip(p["product_id"], p["brand"], p["category"]):
            pn = f"p:{pid}"
            bn, cn = f"b:{brand}", f"c:{cat}"
            g.add_node(pn, kind="product", product_id=pid)
            g.add_node(bn, kind="brand", name=str(brand))
            g.add_node(cn, kind="category", name=str(cat))
            g.add_edge(pn, bn, key="brand", rel="brand")
            g.add_edge(bn, pn, key="brand_of", rel="brand_of")
            g.add_edge(pn, cn, key="category", rel="category")
            g.add_edge(cn, pn, key="category_of", rel="category_of")
            self.brand_of[pid] = str(brand)
            self.cat_of[pid] = str(cat)

        known = set(engine.pos)
        pair: dict[tuple, list] = defaultdict(list)     # (rel, a, b) -> supporting query ids
        qrels_used = []
        for split, qr in engine.qrels.items():
            qrels_used.append(split)
            for qid, grp in qr.groupby("query_id"):
                lab = dict(zip(grp.product_id, grp.esci_label))
                ex = [i for i, l in lab.items() if l == "E" and i in known]
                sub = [i for i, l in lab.items() if l == "S" and i in known]
                comp = [i for i, l in lab.items() if l == "C" and i in known]
                for a in ex:
                    for b in sub:
                        pair[("substitute", a, b)].append(int(qid))
                    for b in comp:
                        pair[("complement", a, b)].append(int(qid))
                capped = ex[: self.CO_INTENT_CAP]
                for n, a in enumerate(capped):
                    for b in capped[n + 1:]:
                        pair[("co_intent", a, b)].append(int(qid))

        counts = defaultdict(int)
        for (rel, a, b), qids in pair.items():
            an, bn = f"p:{a}", f"p:{b}"
            w = len(qids)
            g.add_edge(an, bn, key=rel, rel=rel, weight=w, queries=qids[:8])
            counts[rel] += 1
            if rel in ("substitute", "co_intent"):      # symmetric relations
                back = "substitute" if rel == "substitute" else "co_intent"
                g.add_edge(bn, an, key=back, rel=back, weight=w, queries=qids[:8])
                counts[rel] += 1
            else:                                        # complement: keep the direction, add the inverse
                g.add_edge(bn, an, key="complement_of", rel="complement_of", weight=w, queries=qids[:8])
                counts["complement_of"] += 1

        self.g = g
        self._communities = None
        self.stats = {
            "nodes": g.number_of_nodes(), "edges": g.number_of_edges(),
            "nodes_by_kind": {"product": len(p), "brand": int(p["brand"].nunique()), "category": int(p["category"].nunique())},
            "edges_by_relation": {"brand": len(p), "brand_of": len(p), "category": len(p), "category_of": len(p),
                                  **{k: v for k, v in sorted(counts.items())}},
            "source": {"nodes": "data/products.parquet (25,003 real ESCI products)",
                       "relational_edges": f"ESCI E/S/C labels in qrels_{{{','.join(sorted(qrels_used))}}}.parquet",
                       "co_intent_cap_per_query": self.CO_INTENT_CAP},
            "caveat": ("substitute/complement/co_intent edges come from the same ESCI relevance labels the NDCG eval "
                       "scores against, so no graph-vs-hybrid NDCG number is reported on ESCI queries"),
            "build_seconds": round(time.perf_counter() - t0, 2),
        }

    # ---------------- entity linking ----------------
    def link(self, query: str, k: int = 3) -> list[dict]:
        """Link the query's anchor span to real catalogue nodes: exact brand match first, then the
        live hybrid retriever (the graph never invents an entity)."""
        span = anchor_span(query)
        out = []
        low = span.lower()
        for brand in self.e.products["brand"].unique():
            b = str(brand).lower()
            if len(b) > 3 and b in low:
                out.append({"node": f"b:{brand}", "kind": "brand", "name": str(brand), "via": "exact brand match"})
                break
        order, _, _ = self.e.rank_variant(span, k=k, rerank=True)
        for i in order:
            pid = self.e.ids[i]
            out.append({"node": f"p:{pid}", "kind": "product", "product_id": pid,
                        "title": self.e.products.at[i, "title"], "price": round(float(self.e.price[i]), 2),
                        "brand": self.brand_of[pid], "via": "hybrid retrieval on the anchor span"})
        return out

    # ---------------- traversal ----------------
    def _neighbours(self, node: str, rels: tuple[str, ...]) -> list[tuple[str, dict]]:
        if node not in self.g:
            return []
        out = []
        for _, dst, key, d in self.g.out_edges(node, keys=True, data=True):
            if key in rels and dst.startswith("p:"):
                out.append((dst, d))
        return out

    def _hit(self, node: str, path: list[str], rel: str, d: dict, extra: dict | None = None) -> dict:
        pid = node[2:]
        i = self.e.pos[pid]
        r = self.e.product(i)
        r["graph"] = {"path": path, "relation": rel, "edge_weight": int(d.get("weight", 1)),
                      "cited_esci_query_ids": d.get("queries", [])}
        if extra:
            r["graph"].update(extra)
        return r

    def local(self, query: str, intent: str, k: int = 5) -> dict:
        ents = self.link(query)
        prod = next((x for x in ents if x["kind"] == "product"), None)
        brand_ent = next((x for x in ents if x["kind"] == "brand"), None)
        hits: list[dict] = []
        if intent == "same_brand":
            bn = brand_ent["node"] if brand_ent else (f"b:{self.brand_of[prod['product_id']]}" if prod else None)
            if bn and bn in self.g:
                anchor_pid = prod["product_id"] if prod else None
                for _, dst, key, d in self.g.out_edges(bn, keys=True, data=True):
                    if key == "brand_of" and dst[2:] != anchor_pid:
                        hits.append(self._hit(dst, [bn, "brand_of", dst], "brand_of", d))
                hits.sort(key=lambda r: -r["rating"])
        elif prod:
            pn = prod["node"]
            base_price = prod["price"]
            rels = {"cheaper_alternative": ("substitute", "co_intent"),
                    "goes_with": ("complement", "complement_of", "co_intent")}[intent]
            seen = set()
            for dst, d in self._neighbours(pn, rels):
                if dst in seen:
                    continue
                seen.add(dst)
                h = self._hit(dst, [pn, d["rel"], dst], d["rel"], d)
                if intent == "cheaper_alternative":
                    if h["price"] >= base_price:
                        continue
                    h["graph"]["price_delta_pct"] = round((h["price"] - base_price) / max(base_price, 0.01) * 100, 1)
                hits.append(h)
            if intent == "cheaper_alternative":
                hits.sort(key=lambda r: (-r["graph"]["edge_weight"], r["price"]))
            else:
                hits.sort(key=lambda r: (-(r["graph"]["relation"].startswith("complement")), -r["graph"]["edge_weight"]))
        return {"entities": ents[:4], "anchor_span": anchor_span(query), "intent": intent,
                "hops": 2 if intent == "same_brand" else 1, "results": hits[:k], "graph_hit": bool(hits)}

    def communities(self):
        """Louvain communities over the relational (non-taxonomy) subgraph only."""
        if self._communities is None:
            t0 = time.perf_counter()
            rel = self.nx.Graph()
            for a, b, key, d in self.g.edges(keys=True, data=True):
                if key in ("substitute", "co_intent", "complement"):
                    rel.add_edge(a, b, weight=d.get("weight", 1))
            comms = self.nx.community.louvain_communities(rel, seed=20260915) if rel.number_of_edges() else []
            member = {}
            for n, c in enumerate(comms):
                for node in c:
                    member[node] = n
            self._communities = {"members": member, "sizes": [len(c) for c in comms], "n": len(comms),
                                 "subgraph": {"nodes": rel.number_of_nodes(), "edges": rel.number_of_edges()},
                                 "seconds": round(time.perf_counter() - t0, 2),
                                 "method": "networkx louvain_communities on substitute+co_intent+complement edges, seed 20260915"}
        return self._communities

    def global_search(self, query: str, k: int = 8) -> dict:
        ents = self.link(query)
        prod = next((x for x in ents if x["kind"] == "product"), None)
        c = self.communities()
        if not prod or f"p:{prod['product_id']}" not in c["members"]:
            return {"entities": ents[:4], "anchor_span": anchor_span(query), "intent": "global_theme",
                    "results": [], "graph_hit": False, "community": None, "communities": {k2: v for k2, v in c.items() if k2 != "members"}}
        cid = c["members"][f"p:{prod['product_id']}"]
        nodes = [n for n, m in c["members"].items() if m == cid]
        deg = sorted(nodes, key=lambda n: -self.g.degree(n))
        brands = defaultdict(int)
        cats = defaultdict(int)
        for n in nodes:
            pid = n[2:]
            brands[self.brand_of.get(pid, "?")] += 1
            cats[self.cat_of.get(pid, "?")] += 1
        top = []
        for n in deg[:k]:
            r = self.e.product(self.e.pos[n[2:]])
            r["graph"] = {"community": cid, "degree": int(self.g.degree(n))}
            top.append(r)
        return {"entities": ents[:4], "anchor_span": anchor_span(query), "intent": "global_theme",
                "results": top, "graph_hit": bool(top),
                "community": {"id": cid, "size": len(nodes),
                              "top_brands": dict(sorted(brands.items(), key=lambda kv: -kv[1])[:6]),
                              "categories": dict(sorted(cats.items(), key=lambda kv: -kv[1]))},
                "communities": {k2: v for k2, v in c.items() if k2 != "members"}}

    # ---------------- routed answer ----------------
    def answer(self, query: str, k: int = 5) -> dict:
        t0 = time.perf_counter()
        ents = self.link(query, k=3)
        dec = route(query, has_entity=bool(ents))
        if dec["route"] == "graph_local":
            body = self.local(query, dec["intent"], k)
        elif dec["route"] == "graph_global":
            body = self.global_search(query, k)
        else:
            order, scores, _ = self.e.rank_variant(query, k=k, rerank=True)
            body = {"entities": [], "anchor_span": None, "intent": dec["intent"],
                    "results": [self.e.result(i, scores[i], "rrf_rerank") for i in order],
                    "graph_hit": False}
        if dec["route"].startswith("graph") and not body.get("graph_hit"):
            order, scores, _ = self.e.rank_variant(query, k=k, rerank=True)
            body["fallback"] = "graph returned no path; answered from the hybrid retrieval path"
            body["results"] = [self.e.result(i, scores[i], "rrf_rerank") for i in order]
        return {"query": query, "routing": dec, **body, "latency_ms": round((time.perf_counter() - t0) * 1000, 1)}

    # ---------------- eval ----------------
    def evaluate(self, path: Path = EVAL_SET) -> dict:
        """Router precision/recall and graph hit rate on the hand-labelled multi-hop set."""
        spec = json.loads(Path(path).read_text())
        rows, t0 = [], time.perf_counter()
        for q in spec["queries"]:
            a = self.answer(q["query"], k=5)
            r = a["routing"]["route"]
            rows.append({"id": q["id"], "query": q["query"], "gold_route": q["gold_route"], "predicted_route": r,
                         "gold_intent": q.get("gold_intent"), "predicted_intent": a["routing"]["intent"],
                         "graph_hit": bool(a.get("graph_hit")), "n_results": len(a.get("results", [])),
                         "rule": a["routing"].get("rule"), "justification": q["justification"]})
        gold_graph = [r for r in rows if r["gold_route"] != "hybrid"]
        pred_graph = [r for r in rows if r["predicted_route"] != "hybrid"]
        tp = sum(1 for r in rows if r["gold_route"] != "hybrid" and r["predicted_route"] != "hybrid")
        fp = len(pred_graph) - tp
        fn = len(gold_graph) - tp
        tn = len(rows) - tp - fp - fn
        prec = tp / len(pred_graph) if pred_graph else None
        rec = tp / len(gold_graph) if gold_graph else None
        exact = sum(1 for r in rows if r["gold_route"] == r["predicted_route"]) / len(rows)
        hit_rows = [r for r in rows if r["predicted_route"] != "hybrid"]
        confusion = {g: {p: 0 for p in ROUTES} for g in ROUTES}
        for r in rows:
            confusion[r["gold_route"]][r["predicted_route"]] += 1
        return {
            "eval_set": {"path": str(Path(path).name), "n_queries": len(rows),
                         "graph_labelled": len(gold_graph), "hybrid_labelled": len(rows) - len(gold_graph),
                         "provenance": spec["provenance"]},
            "router": {
                "binary_graph_vs_hybrid": {
                    "precision": round(prec, 4) if prec is not None else None,
                    "recall": round(rec, 4) if rec is not None else None,
                    "f1": round(2 * prec * rec / (prec + rec), 4) if prec and rec else None,
                    "tp": tp, "fp": fp, "fn": fn, "tn": tn},
                "three_class_exact_route_accuracy": round(exact, 4),
                "confusion_gold_by_predicted": confusion,
                "method": "rules-first router (playbook section 10); entity linking by exact brand match then live hybrid retrieval"},
            "graph": {"hit_rate_on_graph_routed": round(sum(r["graph_hit"] for r in hit_rows) / len(hit_rows), 4) if hit_rows else None,
                      "graph_routed_queries": len(hit_rows),
                      "definition": "fraction of graph-routed queries for which traversal returned >=1 product reached over a real edge"},
            "confidence": ("n=%d hand-labelled queries. A 95%% Wilson interval on a proportion at this sample size is "
                           "roughly +/-0.15-0.20 wide, so these numbers are a smoke test of the routing rules, not "
                           "evidence of generalisation." % len(rows)),
            "rows": rows,
            "seconds": round(time.perf_counter() - t0, 2),
        }
