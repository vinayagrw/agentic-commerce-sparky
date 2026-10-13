"""Storefront: search with facets/sort/pagination/relaxation, help answers (cited demo corpus), triage queue,
per-session store, lists, orders, set-qty and checkout revalidation. Catalogue = search-svc only."""
from __future__ import annotations

import hashlib
import json
import math
import re
import time
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import accounts, catalog_services as cs
from . import commerce, payments, search_client
from .db import ROOT, connect
from .search_client import SearchSvcUnavailable

HELP_CORPUS = ROOT / "data" / "help_corpus.json"
PRICE_BUCKETS = [("Under $5", 0, 5), ("$5 - $10", 5, 10), ("$10 - $25", 10, 25), ("$25 - $50", 25, 50), ("$50+", 50, None)]
RELAX_ORDER = ["in_stock", "brands", "exclude_terms", "price", "dietary"]
RELAX_LABEL = {"in_stock": "in stock only", "brands": "brand filter", "exclude_terms": "excluded terms",
               "price": "price range", "dietary": "dietary filter"}


def _iso(ts=None):
    return datetime.fromtimestamp(ts or time.time(), timezone.utc).isoformat(timespec="seconds")


def _prov(endpoint, **extra):
    return {"source": "search-svc", "service": "shop-mcp", "endpoint": endpoint, "timestamp": _iso(),
            "commerce_data": cs.SYNTHETIC_LABEL, **extra}


# ------------------------------------------------------------------ help
def _norm(s: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(ch))


STOP = set(("a an the is are was what how do does can i my me you your to of in on for with and or it this that "
            "when where which why be at by from policy please el la los las un una de del y o en que como mi mis "
            "su sus es por para con se lo al cual cuando donde puedo").split())


def _keys(text: str) -> set[str]:
    return {w[:5] for w in re.findall(r"[a-z0-9]+", _norm(text)) if w not in STOP and len(w) > 1}


def detect_lang(q: str) -> str:
    n = _norm(q)
    if re.search(r"[¿¡ñáéíóú]", q.lower()) or len(set(re.findall(r"[a-z]+", n)) &
                                                   {"como", "donde", "que", "puedo", "mi", "el", "la", "los", "un",
                                                    "una", "de", "horario", "pedido", "tienda", "devuelvo"}) >= 1:
        return "es"
    return "en"


def load_corpus() -> dict:
    return json.loads(Path(HELP_CORPUS).read_text())


def help_answer(query: str, lang: str | None = None) -> dict:
    corpus = load_corpus()
    lang = lang if lang in ("en", "es") else detect_lang(query)
    qk = _keys(query)
    scored = []
    for doc in corpus["docs"]:
        kw = set().union(*[_keys(k) for k in doc.get("keywords", [])]) if doc.get("keywords") else set()
        doc_bonus = len(qk & (kw | _keys(doc["title"])))
        for sec in doc["sections"]:
            s = doc_bonus * 2 + len(qk & _keys(sec["section"] + " " + sec["text"]))
            if s > 0:
                scored.append((s, sec["lang"] == lang, doc, sec))
    base = {"query": query, "lang": lang, "corpus_note": corpus["corpus_note"]}
    if not scored:
        return {**base, "matched": False, "citations": [],
                "answer": "No answer found in the demo help corpus." if lang == "en"
                else "No se encontró una respuesta en el corpus de ayuda de demostración."}
    best_doc = max(scored, key=lambda x: x[0])[2]
    secs = sorted([x for x in scored if x[2] is best_doc], key=lambda x: (-x[1], -x[0]))
    want = [x for x in secs if x[1]] or secs  # answer in the asked language when the doc has it
    chosen = want[:2]
    title = (best_doc.get("title_es") if lang == "es" and chosen[0][3]["lang"] == "es" else None) or best_doc["title"]
    return {**base, "matched": True, "answer": " ".join(x[3]["text"] for x in chosen),
            "answer_lang": chosen[0][3]["lang"],
            "citations": [{"doc_id": best_doc["doc_id"], "title": title, "section": x[3]["section"]} for x in chosen]}


# ------------------------------------------------------------------ search
def _whole_word(term: str, text: str) -> bool:
    return re.search(r"(?<![a-z0-9])" + re.escape(term.lower().strip()) + r"(?![a-z0-9])", text.lower()) is not None


def _local_pass(r: dict, f: dict, skip: str | None = None) -> bool:
    if skip != "brands" and f.get("brands") and r.get("brand") not in set(f["brands"]):
        return False
    if skip != "price":
        p = r.get("price")
        if f.get("min_price") is not None and (p is None or p < f["min_price"]):
            return False
        if f.get("max_price") is not None and (p is None or p > f["max_price"]):
            return False
    if skip != "in_stock" and f.get("in_stock") and not r.get("in_stock"):
        return False
    if skip != "exclude_terms" and any(t.strip() and _whole_word(t, r.get("title") or "") for t in f.get("exclude_terms") or []):
        return False
    return True


def _retrieve(query: str, store_id: str, f: dict, drop: str | None = None) -> tuple[list[dict], dict]:
    server = {"store_id": store_id}
    if drop != "dietary" and f.get("dietary"):
        server["dietary"] = f["dietary"]
    if drop != "price" and f.get("max_price") is not None:
        server["max_price"] = f["max_price"]
    data, _ = search_client.search(query, 100, "rrf_rerank", server)
    rows = [dict(r) for r in data.get("results", [])]
    services = cs.annotate(rows, store_id)
    for r in rows:
        q = r.pop("_quote")
        inv, el = q["inventory"], q["eligibility"]
        r.update(in_stock=inv["in_stock"], qty=inv["qty"], pickup_label=inv["pickup_label"],
                 snap_eligible=el["snap_eligible"], age_restricted=el["age_restricted"])
        r.setdefault("list_price", r.get("price"))
        r.setdefault("promo", None)
    return rows, services


def _card(r: dict) -> dict:
    keys = ("product_id", "title", "brand", "category", "rating", "dietary", "image", "sponsored", "label", "price",
            "list_price", "promo", "in_stock", "qty", "pickup_label", "snap_eligible", "age_restricted")
    return {k: r.get(k) for k in keys if k != "label" or r.get("label")}


def _facets(rows: list[dict], f: dict) -> dict:
    brands, diet = {}, {}
    for r in (x for x in rows if _local_pass(x, f, "brands")):
        if r.get("brand"):
            brands[r["brand"]] = brands.get(r["brand"], 0) + 1
    for r in (x for x in rows if _local_pass(x, f)):
        for d in r.get("dietary") or []:
            diet[d] = diet.get(d, 0) + 1
    in_price = [x for x in rows if _local_pass(x, f, "price") and x.get("price") is not None]
    price = [{"label": lab, "min": lo, "max": hi,
              "count": sum(1 for x in in_price if x["price"] >= lo and (hi is None or x["price"] < hi))}
             for lab, lo, hi in PRICE_BUCKETS]
    return {"brands": sorted(({"value": k, "count": v} for k, v in brands.items()), key=lambda x: (-x["count"], x["value"]))[:30],
            "price": price,
            "dietary": sorted(({"value": k, "count": v} for k, v in diet.items()), key=lambda x: -x["count"]),
            "in_stock": {"count": sum(1 for x in rows if _local_pass(x, f, "in_stock") and x.get("in_stock"))}}


def _active(f: dict, name: str) -> bool:
    if name == "price":
        return f.get("min_price") is not None or f.get("max_price") is not None
    return bool(f.get(name))


def file_triage(query, filters, store_id, session_id, relaxation) -> str:
    tid = "tri_" + uuid.uuid4().hex[:10]
    with connect() as c:
        # One record per distinct failure: re-renders, pagination and sort re-run the same
        # search, and an operator queue full of duplicates hides the real signal.
        # BEGIN IMMEDIATE makes check-then-insert atomic: two concurrent identical searches (a re-render while
        # the session loads) used to both miss the check and file two records.
        c.execute("BEGIN IMMEDIATE")
        dup = c.execute("SELECT id FROM triage WHERE query=? AND filters=? AND store_id=? AND COALESCE(session_id,'')=? AND ts>?",
                        (query, json.dumps(filters), store_id, session_id or "", time.time() - 600)).fetchone()
        if dup:
            return dup["id"]
        c.execute("INSERT INTO triage VALUES(?,?,?,?,?,?,?,?,?,?)",
                  (tid, time.time(), "zero_result", query, json.dumps(filters), store_id, session_id,
                   json.dumps(relaxation), "open", None))
    return tid


def triage_list(status: str | None = None) -> dict:
    with connect() as c:
        rows = c.execute("SELECT * FROM triage" + (" WHERE status=?" if status else "") + " ORDER BY ts DESC",
                         (status,) if status else ()).fetchall()
    return {"items": [{**dict(r), "ts": _iso(r["ts"]), "filters": json.loads(r["filters"] or "{}"),
                       "relaxation": json.loads(r["relaxation"] or "null")} for r in rows]}


def triage_update(tid: str, status: str, note: str | None) -> dict | None:
    if status not in ("open", "acknowledged", "resolved"):
        raise ValueError("status must be open|acknowledged|resolved")
    with connect() as c:
        n = c.execute("UPDATE triage SET status=?, note=? WHERE id=?", (status, note, tid)).rowcount
    return next((i for i in triage_list()["items"] if i["id"] == tid), None) if n else None


def _space_sponsored(items: list[dict], per: int = 8) -> list[dict]:
    """Keep the 1-in-8 disclosure rule on every page, not just overall: a sponsored listing
    is pushed down until at least `per` positions separate it from the previous one."""
    organic = [r for r in items if not r.get("sponsored")]
    queue = [r for r in items if r.get("sponsored")]
    out: list[dict] = []
    last = -per
    pos = {id(r): i for i, r in enumerate(items)}
    oi = 0
    while oi < len(organic) or queue:
        i = len(out)
        if queue and i - last >= per and (oi >= len(organic) or pos[id(queue[0])] <= pos[id(organic[oi])]):
            out.append(queue.pop(0))
            last = i
        elif oi < len(organic):
            out.append(organic[oi])
            oi += 1
        else:
            break  # remaining sponsored would violate spacing: dropped, not shown
    return out


def search(query: str, store_id: str = cs.DEFAULT_STORE, filters: dict | None = None, sort: str = "relevance",
           page: int = 1, page_size: int = 24, session_id: str | None = None) -> dict:
    f = {k: v for k, v in (filters or {}).items() if v not in (None, [], "")}
    store_id = store_id if store_id in cs.STORES else cs.DEFAULT_STORE
    page, page_size = max(1, int(page)), max(1, min(int(page_size), 100))
    try:
        intent = search_client.route_intent(query)
        if intent.get("route") == "help":
            return {"query": query, "kind": "help", "intent": intent, "help": help_answer(query),
                    "total": 0, "page": 1, "page_size": page_size, "pages": 0, "retrieved": 0, "facet_scope": None,
                    "results": [], "facets": {"brands": [], "price": [], "dietary": [], "in_stock": {"count": 0}},
                    "suggestions": {"did_you_mean": None, "related": []}, "zero_result": None,
                    "services": cs.service_status([]), "synthetic_label": cs.SYNTHETIC_LABEL,
                    "provenance": _prov("POST /route/intent", corpus="data/help_corpus.json (demo corpus, not any real retailer's policy)")}
        rows, services = _retrieve(query, store_id, f)
        filtered = [r for r in rows if _local_pass(r, f)]
        if sort == "price_asc":
            filtered.sort(key=lambda r: (r.get("price") is None, r.get("price") or 0))
        elif sort == "price_desc":
            filtered.sort(key=lambda r: (r.get("price") is None, -(r.get("price") or 0)))
        elif sort == "rating":
            filtered.sort(key=lambda r: -(r.get("rating") or 0))
        from .tools import cap_sponsored
        filtered = _space_sponsored(cap_sponsored(filtered))
        total = len(filtered)
        zero = None
        if total == 0:
            relaxation = None
            for name in RELAX_ORDER:
                if not _active(f, name):
                    continue
                if name in ("price", "dietary"):
                    alt, _ = _retrieve(query, store_id, f, drop=name)
                else:
                    alt = rows
                g = {k: v for k, v in f.items() if not (k == name or (name == "price" and k in ("min_price", "max_price")))}
                n = sum(1 for r in alt if _local_pass(r, g))
                if n > 0:
                    relaxation = {"dropped": [name], "label": f"No exact matches. Removing the {RELAX_LABEL[name]} gives {n} result(s).",
                                  "count": n}
                    break
            zero = {"relaxation": relaxation, "triage_id": file_triage(query, f, store_id, session_id, relaxation)}
        sug = search_client.suggest(query, 6)
        start = (page - 1) * page_size
        return {"query": query, "kind": "products", "intent": intent, "total": total, "page": page,
                "page_size": page_size, "pages": math.ceil(total / page_size) if total else 0, "retrieved": len(rows),
                "facet_scope": "top 100 retrieved (search-svc rrf_rerank, dietary/max_price applied server-side); "
                               "each facet counts with the other active filters applied",
                "results": [_card(r) for r in filtered[start:start + page_size]], "facets": _facets(rows, f),
                "suggestions": {"did_you_mean": sug.get("did_you_mean"),
                                "related": [c for c in sug.get("completions", []) if c != query.lower()][:5]},
                "zero_result": zero, "services": services, "synthetic_label": cs.SYNTHETIC_LABEL,
                "provenance": _prov("POST /search", k=100, mode="rrf_rerank", sponsored_policy="max 1 per 8 results, labelled")}
    except SearchSvcUnavailable as e:
        return e.as_result()


def suggest(q: str) -> dict:
    try:
        d = search_client.suggest(q, 8)
    except SearchSvcUnavailable as e:
        return e.as_result()
    return {"q": q, "completions": d.get("completions", []), "did_you_mean": d.get("did_you_mean")}


# ------------------------------------------------------------------ product detail
NUT_WORDS = ["peanut", "peanuts", "almond", "almonds", "cashew", "walnut", "pecan", "hazelnut", "pistachio", "nut", "nuts"]


def product_detail(pid: str, store_id: str = cs.DEFAULT_STORE) -> dict | None:
    p, _ = search_client.get_product(pid)
    if not p:
        return None
    p = dict(p)
    seller = p.pop("untrusted_seller_text", None)
    p["has_seller_listing"] = bool(seller)
    q = cs.quote(pid, store_id, product=p)
    src = "ESCI catalogue via search-svc"
    attrs = [{"name": n, "value": p.get(n), "tier": "T1", "source": src}
             for n in ("title", "brand", "category") if p.get(n)]
    if p.get("description"):
        attrs.append({"name": "description", "value": p["description"], "tier": "T1", "source": src})
    if p.get("bullets"):
        attrs.append({"name": "bullets", "value": p["bullets"], "tier": "T1", "source": src})
    syn = "synthetic/derived (demo)"
    attrs += [{"name": "dietary", "value": p.get("dietary") or [], "tier": "T2", "source": syn},
              {"name": "rating", "value": p.get("rating"), "tier": "T2", "source": syn},
              {"name": "price", "value": q["price"]["price"], "tier": "T2", "source": "price service (synthetic)"},
              {"name": "stock_qty", "value": q["inventory"]["qty"], "tier": "T2", "source": "inventory service (synthetic)"},
              {"name": "snap_eligible", "value": q["eligibility"]["snap_eligible"], "tier": "T2", "source": "eligibility rules (synthetic)"},
              {"name": "age_restricted", "value": q["eligibility"]["age_restricted"], "tier": "T2", "source": "eligibility rules (synthetic)"}]
    text = f"{p.get('title', '')} {p.get('description', '')} {' '.join(p.get('bullets') or [])}".lower()
    hit = next((w for w in NUT_WORDS if _whole_word(w, text)), None)
    if hit:
        attrs.append({"name": "may_contain_nuts", "value": f"inferred from keyword '{hit}' - unverified", "tier": "T3",
                      "source": "keyword inference (not a label)"})
    if seller:
        attrs.append({"name": "seller_listing", "value": "quarantined third-party seller text (not rendered as fact)",
                      "tier": "T3", "source": "3P marketplace seller (untrusted)"})
    return {"product": p, "quote": q, "attributes": attrs, "substitutes": substitutes(pid, store_id),
            "synthetic_label": cs.SYNTHETIC_LABEL, "provenance": _prov("GET /product", store_id=store_id)}


def substitutes(pid: str, store_id: str, k: int = 5) -> list[dict]:
    subs, _ = search_client.substitutes(pid, store_id, k)
    if not subs:
        return []
    qs = cs.quotes([s["product_id"] for s in subs], store_id, products={s["product_id"]: s for s in subs})
    out = []
    for s in subs:
        q = qs[s["product_id"]]
        out.append({"product_id": s["product_id"], "title": s.get("title"), "brand": s.get("brand"),
                    "price": q["price"]["price"] if q["price"]["status"] != "unavailable" else s.get("price"),
                    "in_stock": q["inventory"]["in_stock"], "sub_score": s.get("sub_score")})
    out.sort(key=lambda x: (x["in_stock"] is not True, -(x["sub_score"] or 0)))
    return out


# ------------------------------------------------------------------ session store, lists, orders, cart
def get_store(sid: str) -> dict:
    with connect() as c:
        r = c.execute("SELECT store_id FROM session_store WHERE session_id=?", (sid,)).fetchone()
    store_id = r["store_id"] if r else cs.DEFAULT_STORE
    return {"session_id": sid, "store_id": store_id, "store": cs.STORES[store_id]}


def set_store(sid: str, store_id: str) -> dict:
    if store_id not in cs.STORES:
        raise ValueError(f"unknown store {store_id}")
    with connect() as c:
        c.execute("INSERT INTO session_store VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET store_id=excluded.store_id,"
                  " updated_at=excluded.updated_at", (sid, store_id, time.time()))
    return get_store(sid)


def lists(sid: str) -> dict:
    with connect() as c:
        ls = c.execute("SELECT name, created_at FROM shopping_lists WHERE session_id=? ORDER BY created_at", (sid,)).fetchall()
        items = c.execute("SELECT name, product_id, title, added_at FROM shopping_list_items WHERE session_id=? ORDER BY added_at",
                          (sid,)).fetchall()
    return {"session_id": sid, "lists": [{"name": l["name"], "created_at": _iso(l["created_at"]),
                                          "items": [{"product_id": i["product_id"], "title": i["title"], "added_at": _iso(i["added_at"])}
                                                    for i in items if i["name"] == l["name"]]} for l in ls]}


def create_list(sid: str, name: str) -> dict:
    name = name.strip()
    if not name:
        raise ValueError("name required")
    with connect() as c:
        c.execute("INSERT OR IGNORE INTO shopping_lists VALUES(?,?,?)", (sid, name, time.time()))
    return lists(sid)


def add_list_item(sid: str, name: str, pid: str) -> dict:
    p, _ = search_client.get_product(pid)
    if not p:
        raise ValueError(f"unknown product {pid}")
    create_list(sid, name)
    with connect() as c:
        c.execute("INSERT OR IGNORE INTO shopping_list_items VALUES(?,?,?,?,?)", (sid, name, pid, p["title"], time.time()))
    return lists(sid)


def remove_list_item(sid: str, name: str, pid: str) -> dict:
    with connect() as c:
        c.execute("DELETE FROM shopping_list_items WHERE session_id=? AND name=? AND product_id=?", (sid, name, pid))
    return lists(sid)


def delete_list(sid: str, name: str) -> dict:
    with connect() as c:
        c.execute("DELETE FROM shopping_list_items WHERE session_id=? AND name=?", (sid, name))
        c.execute("DELETE FROM shopping_lists WHERE session_id=? AND name=?", (sid, name))
    return lists(sid)


def set_qty(sid: str, pid: str, qty: int) -> dict:
    if qty < 0 or qty > 20:
        raise ValueError("qty must be between 0 and 20")
    if qty == 0:
        return commerce.remove(sid, pid)
    with connect() as c:
        exists = c.execute("SELECT 1 FROM cart_items WHERE session_id=? AND product_id=?", (sid, pid)).fetchone()
        if exists:
            c.execute("UPDATE cart_items SET qty=? WHERE session_id=? AND product_id=?", (qty, sid, pid))
    if not exists:
        out = commerce.add(sid, pid, qty)
        out.pop("source", None)
        return out
    return commerce.cart(sid)


def create_order(sid: str, mandate_id: str) -> dict:
    m = commerce.get_mandate(mandate_id)
    if not m or m["mandate"]["session_id"] != sid:
        raise LookupError("unknown mandate for this session")
    with connect() as c:
        r = c.execute("SELECT body FROM orders WHERE mandate_id=?", (mandate_id,)).fetchone()
    if r:
        return {**_order_view(json.loads(r["body"])), "note": "order already exists for this mandate"}
    if m["status"] != "approved":
        raise ValueError(f"mandate status is {m['status']}; an approved mandate is required")
    body = m["mandate"]
    tender = body.get("tender") or []
    payment_block = None
    if tender:
        # A mandate that names a tender needs a completed simulated authorisation first. `authorize`
        # is the only thing that writes one, and it never executes a payment.
        attempt = commerce.latest_attempt(mandate_id)
        if not attempt or attempt["decision"] != "approved":
            raise ValueError("this mandate names a payment tender, so POST /mandates/{id}/authorize must "
                             "record a successful simulated authorisation before the order is confirmed")
        payment_block = _payment_block(attempt, tender)
    ct = commerce.cart(sid)
    if not ct["items"]:
        raise ValueError("cart is empty")
    now = time.time()
    # The mandate carries the account only when the caller named one. A session bound to a persona is
    # still that persona's order, so fall back to the binding rather than filing the order as a guest's.
    # Address is NOT inferred: an address nobody chose must not appear on a confirmation page.
    account_id = body.get("account_id") or accounts.get_session_account(sid).get("account_id")
    address_id = body.get("address_id")
    address_block = None
    if address_id:
        try:
            address_block = accounts.get_address(address_id)
        except LookupError:
            address_block = None
    order = {"order_id": "ord_" + uuid.uuid4().hex[:12], "session_id": sid, "mandate_id": mandate_id,
             "lines": ct["items"], "total": ct["total"], "store_id": get_store(sid)["store_id"],
             "created_at": _iso(now), "created_ts": now, "status": "placed", "payment_executed": False,
             "account_id": account_id, "address_id": address_id, "fulfilment_advanced_to": None,
             "note": "Demo order: no payment is executed.", "synthetic_label": cs.SYNTHETIC_LABEL}
    if payment_block:
        order["payment"] = payment_block
        order["auth_ref"] = payment_block["auth_ref"]
    if address_block:
        order["address"] = address_block
    with connect() as c:
        c.execute("INSERT INTO orders(order_id,session_id,mandate_id,body,created_at,status,account_id,address_id,auth_ref)"
                  " VALUES(?,?,?,?,?,?,?,?,?)",
                  (order["order_id"], sid, mandate_id, json.dumps(order), now, "placed", account_id, address_id,
                   order.get("auth_ref")))
        c.execute("DELETE FROM cart_items WHERE session_id=?", (sid,))
    return _order_view(order)


def _payment_block(attempt: dict, tender: list[dict]) -> dict:
    """Confirmation-time view of the simulated authorisation. Only ever a simulated authorisation."""
    # The mandate body's tender is what the client SENT: {pm_id, amount} and nothing else. The
    # instrument's brand/last4/label are resolved during authorisation and stored on the attempt, so
    # read them from there — otherwise the confirmation page can only say "pm_maya_visa", never
    # "Visa ending 4242". Fall back to the mandate rows if an older attempt has no detail.
    enriched = {}
    try:
        for row in (json.loads(attempt.get("detail") or "{}").get("tender") or []):
            if row.get("pm_id"):
                enriched[row["pm_id"]] = row
    except (ValueError, TypeError):
        enriched = {}
    merged = [{**t, **enriched.get(t.get("pm_id"), {}), "amount": t.get("amount")} for t in tender]
    return {"status": "simulated_authorisation_recorded", "auth_ref": attempt["auth_ref"],
            "amount": attempt["amount"], "currency": "USD",
            "tender": [{k: t.get(k) for k in ("pm_id", "kind", "brand", "last4", "amount", "label")} for t in merged],
            "split_tender": len(tender) > 1, "payment_executed": False,
            "authorised_at": _iso(attempt["created_at"]),
            "note": "This is a simulated authorisation recorded by the demo. No payment is executed, "
                    "no funds move and there is nothing to settle or refund.",
            "synthetic_label": payments.SYNTHETIC_LABEL}


# ------------------------------------------------------------------ fulfilment (simulated)
FULFILMENT_STAGES = ("placed", "preparing", "ready_for_pickup", "picked_up")
FULFILMENT_AFTER_S = (0, 120, 600, 1800)
FULFILMENT_LABEL = ("simulated fulfilment progress - derived from elapsed demo time or an explicit demo "
                    "control, never from a real store system (demo)")


def fulfilment_state(created_at: float, now_ts: float, advanced_to: str | None = None) -> dict:
    """PURE function of (created_at, now, advanced_to). No DB, no clock, no randomness."""
    elapsed = max(0.0, float(now_ts) - float(created_at))
    idx = max(i for i, after in enumerate(FULFILMENT_AFTER_S) if elapsed >= after)
    derived_from = "elapsed_time"
    if advanced_to in FULFILMENT_STAGES and FULFILMENT_STAGES.index(advanced_to) > idx:
        idx = FULFILMENT_STAGES.index(advanced_to)
        derived_from = "demo_control"
    nxt = FULFILMENT_STAGES[idx + 1] if idx + 1 < len(FULFILMENT_STAGES) else None
    return {"stage": FULFILMENT_STAGES[idx], "stage_index": idx, "stages": list(FULFILMENT_STAGES),
            "next_stage": nxt,
            "eta_seconds": None if nxt is None else max(0, int(FULFILMENT_AFTER_S[idx + 1] - elapsed)),
            "elapsed_seconds": int(elapsed), "derived_from": derived_from, "advanced_to": advanced_to,
            "thresholds_seconds": dict(zip(FULFILMENT_STAGES, FULFILMENT_AFTER_S)),
            "simulated": True, "label": FULFILMENT_LABEL, "payment_executed": False}


def _order_view(order: dict, created_at: float | None = None) -> dict:
    # Orders written before B16 have no created_ts in their body; the row's created_at stands in.
    created = order.get("created_ts")
    if created is None:
        created = created_at if created_at is not None else time.time()
    f = fulfilment_state(created, time.time(), order.get("fulfilment_advanced_to"))
    return {**order, "fulfilment": f, "status": f["stage"], "payment_executed": False}


def get_order(order_id: str) -> dict:
    with connect() as c:
        r = c.execute("SELECT body, created_at FROM orders WHERE order_id=?", (order_id,)).fetchone()
    if not r:
        raise LookupError(f"unknown order {order_id}")
    return _order_view(json.loads(r["body"]), r["created_at"])


def advance_fulfilment(order_id: str, stage: str | None = None) -> dict:
    """Demo control: jump the simulated stage forward. It can never move backwards."""
    with connect() as c:
        r = c.execute("SELECT body, created_at FROM orders WHERE order_id=?", (order_id,)).fetchone()
        if not r:
            raise LookupError(f"unknown order {order_id}")
        order = json.loads(r["body"])
        cur = _order_view(order, r["created_at"])["fulfilment"]
        if stage is None:
            idx = min(cur["stage_index"] + 1, len(FULFILMENT_STAGES) - 1)
            stage = FULFILMENT_STAGES[idx]
        if stage not in FULFILMENT_STAGES:
            raise ValueError(f"stage must be one of {FULFILMENT_STAGES}")
        if FULFILMENT_STAGES.index(stage) < cur["stage_index"]:
            raise ValueError(f"fulfilment cannot move backwards from {cur['stage']} to {stage}")
        order["fulfilment_advanced_to"] = stage
        c.execute("UPDATE orders SET body=?, status=? WHERE order_id=?", (json.dumps(order), stage, order_id))
    return get_order(order_id)


def orders(sid: str) -> dict:
    with connect() as c:
        rows = c.execute("SELECT body, created_at FROM orders WHERE session_id=? ORDER BY created_at DESC",
                         (sid,)).fetchall()
    return {"session_id": sid, "orders": [_order_view(json.loads(r["body"]), r["created_at"]) for r in rows]}


def account_orders(aid: str) -> dict:
    accounts.get_account(aid)
    with connect() as c:
        rows = c.execute("SELECT body, created_at FROM orders WHERE account_id=? ORDER BY created_at DESC",
                         (aid,)).fetchall()
    return {"account_id": aid, "orders": [_order_view(json.loads(r["body"]), r["created_at"]) for r in rows]}


# ------------------------------------------------------------------ tender preview / split tender
TENDER_LABEL = ("simulated tender plan - which demo instrument would cover which part of the basket. "
                "Nothing is authorised or executed by previewing it (demo)")


def _snap_reason(rules: list[dict]) -> str | None:
    """The reason a line is not SNAP eligible, quoted verbatim from the rule that decided it."""
    excluded = next((r["text"] for r in rules if r["rule"] != "snap_food_category" and r["applies"]), None)
    if excluded:
        return excluded
    food = next((r for r in rules if r["rule"] == "snap_food_category"), None)
    return food["text"] if food and not food["applies"] else None


def tender_hash(plan: list[dict]) -> str:
    """Stable under reordering: the plan is canonicalised by pm_id before hashing."""
    lines = sorted(({"pm_id": p["pm_id"], "amount": round(float(p["amount"]), 2)} for p in plan),
                   key=lambda x: x["pm_id"])
    return "sha256:" + hashlib.sha256(commerce._canon(lines)).hexdigest()


def tender_preview(sid: str, pm_ids: list[str], store_id: str | None = None) -> dict:
    """Plan how the selected demo instruments would cover the cart. Never authorises anything.

    SNAP coverage uses catalog_services.evaluate_eligibility - the same rule objects, quoted verbatim.
    If eligibility for ANY line is unavailable the plan refuses EBT outright rather than guessing.
    """
    store_id = store_id or get_store(sid)["store_id"]
    bound = accounts.get_session_account(sid)
    ct = commerce.cart(sid)
    if not ct["items"]:
        raise ValueError("cart is empty")
    instruments = accounts.resolve_tender(list(pm_ids), bound["account_id"])
    qs = cs.quotes([i["product_id"] for i in ct["items"]], store_id)

    lines, unverified, snap_subtotal = [], [], 0.0
    for item in ct["items"]:
        el = qs[item["product_id"]]["eligibility"]
        ok = el["status"] != "unavailable"
        snap = bool(el.get("snap_eligible")) if ok else None
        if ok and snap:
            snap_subtotal += item["line_total"]
        if not ok:
            unverified.append(item["product_id"])
        # Verbatim rule text from catalog_services.evaluate_eligibility - not paraphrased here.
        rules = [r for r in el.get("rules") or [] if r["rule"].startswith("snap_")]
        lines.append({"product_id": item["product_id"], "title": item["title"], "qty": item["qty"],
                      "line_total": item["line_total"], "snap_eligible": snap,
                      "eligibility_status": el["status"], "eligibility_error": el.get("error"),
                      "snap_rules": rules,
                      "snap_reason": _snap_reason(rules) if ok and not snap else None})
    snap_subtotal = round(snap_subtotal, 2)
    total = ct["total"]

    ebt = [i for i in instruments if i["kind"] == "ebt_snap"]
    other = [i for i in instruments if i["kind"] != "ebt_snap"]
    refusals: list[dict] = []
    plan: list[dict] = []

    if ebt and unverified:
        refusals.append({
            "kind": "eligibility_unverified", "blocking": True, "product_ids": unverified,
            "message": f"SNAP eligibility for {len(unverified)} cart line(s) could not be verified "
                       f"({qs[unverified[0]]['eligibility'].get('error')}), so EBT cannot be used. "
                       "The demo refuses rather than guessing which lines SNAP would cover."})
        ebt = []

    remaining = total
    for inst in ebt[:1]:
        covered = round(min(snap_subtotal, round(float(inst["balance"] or 0.0), 2)), 2)
        if covered > 0:
            plan.append({**inst, "amount": covered, "covers": "SNAP-eligible lines"})
            remaining = round(remaining - covered, 2)
        if snap_subtotal > round(float(inst["balance"] or 0.0), 2):
            refusals.append({"kind": "ebt_balance_short", "blocking": False, "product_ids": [],
                             "message": f"The demo EBT balance (${float(inst['balance'] or 0):.2f}) is lower "
                                        f"than the SNAP-eligible subtotal (${snap_subtotal:.2f}); "
                                        f"${round(snap_subtotal - float(inst['balance'] or 0), 2):.2f} of it "
                                        "needs a second instrument."})

    if remaining > 0.004:
        if other:
            plan.append({**other[0], "amount": remaining,
                         "covers": "remainder not covered by EBT" if plan else "whole basket"})
            remaining = 0.0
        else:
            for ln in lines:
                if ln["snap_eligible"] is False:
                    refusals.append({
                        "kind": "not_snap_eligible", "blocking": True, "product_ids": [ln["product_id"]],
                        "message": f"{ln['title']} cannot be covered by EBT: "
                                   f"{ln['snap_reason'] or 'this line is not SNAP eligible'}. "
                                   "Add a second payment instrument or remove the line."})
            if not any(r["kind"] == "not_snap_eligible" for r in refusals):
                refusals.append({"kind": "uncovered_remainder", "blocking": True, "product_ids": [],
                                 "message": f"${remaining:.2f} of this basket is not covered by the selected "
                                            "instrument(s). Add a second payment instrument."})

    covered_total = round(sum(p["amount"] for p in plan), 2)
    ok = not any(r["blocking"] for r in refusals) and abs(covered_total - total) < 0.005
    return {"session_id": sid, "store_id": store_id, "account_id": bound["account_id"],
            "total": total, "snap_subtotal": snap_subtotal, "covered_total": covered_total,
            "uncovered": round(total - covered_total, 2), "lines": lines,
            "plan": [{"pm_id": p["pm_id"], "kind": p["kind"], "brand": p["brand"], "last4": p["last4"],
                      "display": p["display"], "amount": p["amount"], "covers": p["covers"],
                      "label": p["label"]} for p in plan],
            "split_tender": len(plan) > 1,
            "split_tender_plan": [{"pm_id": p["pm_id"], "amount": p["amount"], "covers": p["covers"]}
                                  for p in plan] if len(plan) > 1 else None,
            "tender_hash": tender_hash(plan), "refusals": refusals, "ok": ok,
            "services": cs.service_status(list(qs.values())), "payment_executed": False,
            "eligibility_rule_source": "catalog_services.evaluate_eligibility (rule text quoted verbatim)",
            "label": TENDER_LABEL, "synthetic_label": cs.SYNTHETIC_LABEL}


def tender_eligibility_gate(preview: dict) -> dict:
    """The shape payments.authorize expects for its eligibility argument."""
    blocking = [r for r in preview.get("refusals") or [] if r["blocking"]]
    return {"ok": not blocking, "refusals": blocking,
            "message": blocking[0]["message"] if blocking else None}


def revalidate(sid: str, store_id: str | None = None) -> dict:
    """Fresh read (bypasses caches) of every cart line; applies current prices to the cart rows."""
    store_id = store_id or get_store(sid)["store_id"]
    ct = commerce.cart(sid)
    pids = [i["product_id"] for i in ct["items"]]
    qs = cs.quotes(pids, store_id, fresh=True) if pids else {}
    lines = []
    for item in ct["items"]:
        q = qs[item["product_id"]]
        pr, inv, el = q["price"], q["inventory"], q["eligibility"]
        issues, subs = [], []
        for name, blk in (("price", pr), ("inventory", inv), ("eligibility", el)):
            if blk["status"] == "unavailable":
                issues.append({"kind": "service_unavailable", "blocking": True,
                               "message": f"{name} could not be verified: {blk.get('error')}"})
        cur = pr["price"] if pr["status"] != "unavailable" else None
        changed = cur is not None and abs(cur - item["price"]) > 0.004
        if changed:
            issues.append({"kind": "price_changed", "blocking": False,
                           "message": f"Price changed from ${item['price']:.2f} to ${cur:.2f}; the current price applies"})
        avail = inv["qty"] if inv["status"] != "unavailable" else None
        if avail is not None:
            if avail <= 0:
                issues.append({"kind": "out_of_stock", "blocking": True, "message": f"Out of stock at store {store_id}"})
            elif avail < item["qty"]:
                issues.append({"kind": "insufficient_qty", "blocking": True,
                               "message": f"Only {avail} available at store {store_id}; cart has {item['qty']}"})
        if el["status"] != "unavailable":
            if el["region_blocked"]:
                issues.append({"kind": "region_blocked", "blocking": True,
                               "message": "; ".join(r["text"] for r in el["rules"] if r["applies"] and r["rule"][:3] in ("ca_", "tx_", "ar_"))})
            if el["age_restricted"]:
                issues.append({"kind": "age_restricted", "blocking": False,
                               "message": f"Age {el['min_age']}+ photo ID is checked at pickup or delivery"})
        if any(i["kind"] in ("out_of_stock", "insufficient_qty", "region_blocked") for i in issues):
            try:
                subs = substitutes(item["product_id"], store_id)
            except SearchSvcUnavailable as e:
                issues.append({"kind": "service_unavailable", "blocking": False, "message": f"substitutes: {e}"})
        if changed:
            with connect() as c:
                c.execute("UPDATE cart_items SET price=? WHERE session_id=? AND product_id=?", (cur, sid, item["product_id"]))
        lines.append({"product_id": item["product_id"], "title": item["title"], "qty": item["qty"],
                      "cart_price": item["price"], "current_price": cur, "price_changed": changed,
                      "qty_available": avail, "in_stock": inv["in_stock"], "issues": issues, "substitutes": subs})
    return {"ok": not any(i["blocking"] for l in lines for i in l["issues"]), "checked_at": _iso(), "store_id": store_id,
            "lines": lines, "services": cs.service_status(list(qs.values())), "cart": commerce.cart(sid),
            "synthetic_label": cs.SYNTHETIC_LABEL}
