"""B15 catalogue services: price + promo, per-store inventory, eligibility. ALL SYNTHETIC.

ESCI has no price, stock or eligibility data. These services derive them deterministically from the
search-svc product record (its synthetic base price and per-store stock) and persist them in
commerce.db, so they behave like real downstream services:

* price    - TTL 300s. list_price = search-svc base price; promo for a deterministic ~10% of products
             (hash of product_id + promo week), disable with SHOP_SYNTH_PROMOS=0. Operator override.
* inventory- TTL 60s. qty = search-svc stock, minus a deterministic "sales" drift per 60s time bucket,
             or an audited operator override. A cached record older than its TTL is served with
             refreshed on read from search-svc; served with status "stale" only if that refresh fails.
* eligibility - explicit, readable rule tables below (SNAP, age restriction, region blocks).
* faults   - any service can be marked down (optionally for N seconds): it answers
             status "unavailable" + error while the other services keep answering.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone

from . import search_client
from .db import connect
from .search_client import SearchSvcUnavailable

SYNTHETIC_LABEL = "synthetic commerce data (ESCI has no price or stock)"
SERVICES = ("price", "promo", "inventory", "eligibility")
PRICE_TTL_S = 300
INVENTORY_TTL_S = 60
INVENTORY_BUCKET_S = 60
PROMO_PERIOD_S = 7 * 24 * 3600

STORES = {
    "4108": {"store_id": "4108", "name": "Bentonville Supercenter", "city": "Bentonville", "region": "AR",
             "hours": "6:00-23:00", "synthetic": True},
    "2231": {"store_id": "2231", "name": "Dallas Supercenter", "city": "Dallas", "region": "TX",
             "hours": "6:00-23:00", "synthetic": True},
    "5360": {"store_id": "5360", "name": "San Jose Supercenter", "city": "San Jose", "region": "CA",
             "hours": "6:00-23:00", "synthetic": True},
}
DEFAULT_STORE = "4108"


def now() -> float:  # patched in tests
    return time.time()


def _iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds") if ts else None


def _h(*parts) -> int:
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:12], 16)


def _audit(c, kind: str, detail: dict):
    c.execute("INSERT INTO audit VALUES(?,?,?)", (now(), kind, json.dumps(detail)))


# ------------------------------------------------------------------ faults
def set_fault(service: str, down: bool, seconds: int | None = None) -> dict:
    if service not in SERVICES:
        raise ValueError(f"unknown service {service!r}; one of {SERVICES}")
    until = now() + seconds if (down and seconds) else None
    with connect() as c:
        c.execute("INSERT INTO cs_faults VALUES(?,?,?,?) ON CONFLICT(service) DO UPDATE SET down=excluded.down,"
                  " until=excluded.until, updated_at=excluded.updated_at", (service, int(down), until, now()))
        _audit(c, "catalog_fault", {"service": service, "down": down, "seconds": seconds})
    return faults()


def faults(c=None) -> dict:
    def read(conn):
        rows = {r["service"]: r for r in conn.execute("SELECT * FROM cs_faults")}
        out = {}
        for s in SERVICES:
            r = rows.get(s)
            down = bool(r and r["down"] and (r["until"] is None or r["until"] > now()))
            out[s] = {"down": down, "until": _iso(r["until"]) if down and r["until"] else None}
        return out
    if c is not None:
        return read(c)
    with connect() as conn:
        return {"faults": read(conn)}


def _down(fs: dict, service: str) -> bool:
    return fs[service]["down"]


def _unavail(service: str) -> str:
    return f"{service} service unavailable (fault injected)"


# ------------------------------------------------------------------ eligibility rules (synthetic)
SNAP_EXCLUDED = [  # (rule id, title keywords, human text)
    ("snap_supplements", ["vitamin", "vitamins", "multivitamin", "supplement", "supplements", "capsules", "softgels",
                          "gummies vitamin", "probiotic", "protein powder", "melatonin"],
     "Vitamins and supplements are not SNAP eligible"),
    ("snap_alcohol", ["beer", "wine", "vodka", "whiskey", "whisky", "bourbon", "tequila", "rum", "liquor", "gin",
                      "hard seltzer", "champagne"], "Alcohol is not SNAP eligible"),
    ("snap_hot_foods", ["hot food", "rotisserie", "hot prepared", "heated"], "Hot prepared foods are not SNAP eligible"),
    ("snap_tobacco", ["tobacco", "cigarette", "cigar", "nicotine"], "Tobacco and nicotine are not SNAP eligible"),
]
AGE_RULES = [  # (rule id, keywords, min_age, text)
    ("age_alcohol", ["beer", "wine", "vodka", "whiskey", "whisky", "bourbon", "tequila", "rum", "liquor", "gin",
                     "hard seltzer", "champagne"], 21, "Alcohol requires age 21+ with photo ID"),
    ("age_tobacco_nicotine", ["tobacco", "cigarette", "cigarettes", "cigar", "cigars", "nicotine", "vape", "e-cig",
                              "e-cigarette"], 21, "Tobacco and nicotine require age 21+ with photo ID"),
    ("age_lighters_butane", ["lighter", "lighters", "butane"], 18, "Lighters and butane require age 18+"),
    ("age_knives", ["knife", "knives", "dagger", "machete", "switchblade"], 18, "Knives require age 18+"),
]
# Accessory words that mean the keyword names the use, not the product ("wine glasses", "knife sharpener").
ACCESSORY_WORDS = ["glass", "glasses", "opener", "rack", "aerator", "stopper", "tumbler", "decanter", "koozie", "chiller",
                   "sharpener", "block", "holder", "sign", "mug", "cake", "flavored candy", "plastic", "toy", "costume",
                   "sheath", "stand", "case", "sticker", "shirt", "book", "novel"]
REGION_RULES = [  # (region, rule id, keywords, text)
    ("CA", "ca_flavored_nicotine", ["vape", "e-cig", "e-cigarette", "nicotine pouch", "flavored tobacco"],
     "Synthetic region rule: flavored nicotine products are not sold at the CA demo store"),
    ("CA", "ca_butane_refill", ["butane"], "Synthetic region rule: butane refills are not sold at the CA demo store"),
    ("TX", "tx_fireworks", ["firework", "fireworks", "sparkler", "sparklers"],
     "Synthetic region rule: fireworks are not sold at the TX demo store"),
    ("AR", "ar_spirits", ["vodka", "whiskey", "whisky", "bourbon", "tequila", "liquor", "gin", "rum"],
     "Synthetic region rule: spirits are not sold at the AR demo store (grocery beer/wine licence only)"),
]


def _has_word(text: str, kw: str) -> bool:
    return re.search(r"(?<![a-z0-9])" + re.escape(kw) + r"(?![a-z0-9])", text) is not None


def _kw_hit(text: str, kws: list[str]) -> str | None:
    return next((k for k in kws if _has_word(text, k)), None)


def evaluate_eligibility(product: dict, store_id: str) -> dict:
    """Pure rule evaluation. Readable on purpose; every rule is reported with applies true/false."""
    title = str(product.get("title") or "").lower()
    category = str(product.get("category") or "").lower()
    accessory = _kw_hit(title, ACCESSORY_WORDS)
    region = STORES.get(store_id, STORES[DEFAULT_STORE])["region"]
    rules = []

    is_food = category == "grocery"
    rules.append({"rule": "snap_food_category", "applies": is_food,
                  "text": "SNAP covers food: products in the grocery category" + ("" if is_food else " (this is not grocery)")})
    snap = is_food
    for rid, kws, text in SNAP_EXCLUDED:
        hit = _kw_hit(title, kws)
        applies = bool(hit) and is_food and not (rid == "snap_alcohol" and accessory)
        rules.append({"rule": rid, "applies": applies, "text": text + (f" (matched '{hit}')" if applies else "")})
        snap = snap and not applies

    min_age = None
    for rid, kws, age, text in AGE_RULES:
        hit = _kw_hit(title, kws)
        applies = bool(hit) and not accessory
        rules.append({"rule": rid, "applies": applies, "text": text + (f" (matched '{hit}')" if applies else "")})
        if applies:
            min_age = max(min_age or 0, age)

    blocked = False
    for reg, rid, kws, text in REGION_RULES:
        if reg != region:
            continue
        hit = _kw_hit(title, kws)
        applies = bool(hit) and not accessory
        rules.append({"rule": rid, "applies": applies, "text": text + (f" (matched '{hit}')" if applies else "")})
        blocked = blocked or applies
    return {"snap_eligible": snap, "age_restricted": min_age is not None, "min_age": min_age,
            "region": region, "region_blocked": blocked, "rules": rules}


# ------------------------------------------------------------------ derivations
def promos_enabled() -> bool:
    return os.environ.get("SHOP_SYNTH_PROMOS", "1") != "0"


def derive_promo(pid: str) -> dict | None:
    if not promos_enabled():
        return None
    period = int(now() // PROMO_PERIOD_S)
    h = _h("promo", pid, period)
    if h % 10 != 0:  # ~10% of products per promo week
        return None
    pct = (10, 15, 20, 25)[(h // 10) % 4]
    return {"promo_id": f"PR-{period}-{h % 100000:05d}", "label": f"Rollback {pct}% off", "pct_off": pct,
            "ends_at": _iso((period + 1) * PROMO_PERIOD_S)}


def derive_qty(product: dict, store_id: str) -> int:
    base = int((product.get("stock") or {}).get(store_id, 0) or 0)
    if base < 3:
        return base
    bucket = int(now() // INVENTORY_BUCKET_S)
    return max(0, base - _h("inv", product["product_id"], store_id, bucket) % 3)  # simulated sales drift


def pickup_eta(qty: int) -> tuple[int | None, str]:
    """Rule: deep stock is picked fast; low stock needs a shelf check first."""
    if qty <= 0:
        return None, "Out of stock at this store"
    if qty >= 10:
        return 60, "Pickup today, ready in about 1 hr"
    if qty >= 3:
        return 120, "Pickup today, ready in about 2 hrs"
    return 240, f"Only {qty} left, ready in about 4 hrs"


# ------------------------------------------------------------------ record I/O
def _status(updated_at: float, ttl: int) -> str:
    return "stale" if now() - updated_at > ttl else "ok"


def _write_price(c, pid: str, product: dict):
    row = c.execute("SELECT override_price FROM cs_price WHERE product_id=?", (pid,)).fetchone()
    override = row["override_price"] if row else None
    list_price = round(float(override if override is not None else product["price"]), 2)
    promo = derive_promo(pid)
    price = round(list_price * (1 - promo["pct_off"] / 100), 2) if promo else list_price
    c.execute("INSERT INTO cs_price VALUES(?,?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET list_price=excluded.list_price,"
              " price=excluded.price, promo=excluded.promo, updated_at=excluded.updated_at",
              (pid, list_price, price, json.dumps(promo), override, now()))


def _write_inventory(c, pid: str, product: dict):
    for sid in STORES:
        row = c.execute("SELECT override_qty FROM cs_inventory WHERE product_id=? AND store_id=?", (pid, sid)).fetchone()
        override = row["override_qty"] if row else None
        qty = override if override is not None else derive_qty(product, sid)
        c.execute("INSERT INTO cs_inventory VALUES(?,?,?,?,?) ON CONFLICT(product_id,store_id) DO UPDATE SET"
                  " qty=excluded.qty, updated_at=excluded.updated_at", (pid, sid, qty, override, now()))


def _price_block(c, pid, fs) -> dict:
    base = {"currency": "USD", "ttl_s": PRICE_TTL_S}
    if _down(fs, "price"):
        return {**base, "status": "unavailable", "list_price": None, "price": None, "promo": None,
                "updated_at": None, "error": _unavail("price")}
    r = c.execute("SELECT * FROM cs_price WHERE product_id=?", (pid,)).fetchone()
    if not r:
        return {**base, "status": "unavailable", "list_price": None, "price": None, "promo": None,
                "updated_at": None, "error": "no price record (search-svc product record unavailable)"}
    out = {**base, "status": _status(r["updated_at"], PRICE_TTL_S), "list_price": r["list_price"], "price": r["price"],
           "promo": json.loads(r["promo"]) if r["promo"] else None, "updated_at": _iso(r["updated_at"]),
           "promo_status": "ok"}
    if _down(fs, "promo"):
        out.update(price=r["list_price"], promo=None, promo_status="unavailable",
                   promo_error=_unavail("promo") + "; showing list price")
    return out


def _inventory_block(c, pid, store_id, fs) -> dict:
    base = {"ttl_s": INVENTORY_TTL_S}
    if _down(fs, "inventory"):
        return {**base, "status": "unavailable", "qty": None, "in_stock": None, "pickup_eta_minutes": None,
                "pickup_label": "Stock unavailable", "other_stores": {}, "updated_at": None, "error": _unavail("inventory")}
    rows = {r["store_id"]: r for r in c.execute("SELECT * FROM cs_inventory WHERE product_id=?", (pid,))}
    r = rows.get(store_id)
    if not r:
        return {**base, "status": "unavailable", "qty": None, "in_stock": None, "pickup_eta_minutes": None,
                "pickup_label": "Stock unavailable", "other_stores": {}, "updated_at": None,
                "error": "no inventory record (search-svc product record unavailable)"}
    eta, label = pickup_eta(r["qty"])
    others = {s: x["qty"] for s, x in rows.items() if s != store_id}
    if r["qty"] <= 0 and any(q > 0 for q in others.values()):
        label += f"; in stock at {sum(1 for q in others.values() if q > 0)} other store(s)"
    return {**base, "status": _status(r["updated_at"], INVENTORY_TTL_S), "qty": r["qty"], "in_stock": r["qty"] > 0,
            "pickup_eta_minutes": eta, "pickup_label": label, "other_stores": others,
            "updated_at": _iso(r["updated_at"])}


def _eligibility_block(c, pid, product, store_id, fs) -> dict:
    region = STORES.get(store_id, STORES[DEFAULT_STORE])["region"]
    if _down(fs, "eligibility"):
        return {"status": "unavailable", "snap_eligible": None, "age_restricted": None, "min_age": None,
                "region": region, "region_blocked": None, "rules": [], "error": _unavail("eligibility")}
    if product is None:
        r = c.execute("SELECT body FROM cs_eligibility WHERE product_id=?", (pid,)).fetchone()
        product = json.loads(r["body"]) if r else None
    if product is None:
        return {"status": "unavailable", "snap_eligible": None, "age_restricted": None, "min_age": None,
                "region": region, "region_blocked": None, "rules": [],
                "error": "no eligibility record (search-svc product record unavailable)"}
    return {"status": "ok", **evaluate_eligibility(product, store_id)}


def _seed_needed(c, pid) -> bool:
    p = c.execute("SELECT 1 FROM cs_price WHERE product_id=?", (pid,)).fetchone()
    i = c.execute("SELECT 1 FROM cs_inventory WHERE product_id=? LIMIT 1", (pid,)).fetchone()
    e = c.execute("SELECT 1 FROM cs_eligibility WHERE product_id=?", (pid,)).fetchone()
    return not (p and i and e)


def _expired(c, pid) -> bool:
    p = c.execute("SELECT updated_at FROM cs_price WHERE product_id=?", (pid,)).fetchone()
    i = c.execute("SELECT MIN(updated_at) AS u FROM cs_inventory WHERE product_id=?", (pid,)).fetchone()
    return bool((p and now() - p["updated_at"] > PRICE_TTL_S) or (i and i["u"] and now() - i["u"] > INVENTORY_TTL_S))


def _write_all(c, pid, product):
    _write_price(c, pid, product)
    _write_inventory(c, pid, product)
    c.execute("INSERT INTO cs_eligibility VALUES(?,?,?) ON CONFLICT(product_id) DO UPDATE SET body=excluded.body,"
              " updated_at=excluded.updated_at",
              (pid, json.dumps({k: product.get(k) for k in ("product_id", "title", "category")}), now()))


def quotes(product_ids: list[str], store_id: str = DEFAULT_STORE, *, products: dict[str, dict] | None = None,
           fresh: bool = False) -> dict[str, dict]:
    """Quote many products. Cached records are served (possibly "stale"); missing ones are seeded from the
    search-svc record. fresh=True bypasses the cache: re-reads search-svc and rewrites every record."""
    products = dict(products or {})
    store_id = store_id if store_id in STORES else DEFAULT_STORE
    out = {}
    with connect() as c:
        fs = faults(c)
        for pid in product_ids:
            prod = products.get(pid)
            fetch_error = None
            # Read-through: a record past its TTL is refreshed from the source on read. It is served
            # with status "stale" only when that refresh cannot happen (search-svc unreachable).
            if fresh or _seed_needed(c, pid) or _expired(c, pid):
                if prod is None or fresh:
                    try:
                        prod, _ = search_client.get_product(pid)
                    except SearchSvcUnavailable as e:
                        prod, fetch_error = None, str(e)
                        if not fresh:
                            fetch_error = None  # cached record served; _status() reports it "stale"
                if prod:
                    _write_all(c, pid, prod)
            q = {"product_id": pid, "store_id": store_id,
                 "price": _price_block(c, pid, fs),
                 "inventory": _inventory_block(c, pid, store_id, fs),
                 "eligibility": _eligibility_block(c, pid, prod, store_id, fs),
                 "synthetic_label": SYNTHETIC_LABEL}
            if fetch_error:
                for k in ("price", "inventory", "eligibility"):
                    if fresh and q[k]["status"] != "unavailable":
                        q[k].update(status="unavailable", error=f"fresh read failed: {fetch_error}")
                    elif q[k]["status"] == "unavailable" and "error" in q[k]:
                        q[k]["error"] += f": {fetch_error}"
            out[pid] = q
    return out


def quote(pid: str, store_id: str = DEFAULT_STORE, product: dict | None = None, fresh: bool = False) -> dict:
    return quotes([pid], store_id, products={pid: product} if product else None, fresh=fresh)[pid]


def service_status(qs: list[dict]) -> dict:
    """Worst status per service across quotes (unavailable > stale > ok); fault table when no quotes."""
    rank = {"ok": 0, "stale": 1, "unavailable": 2}
    if not qs:
        fs = faults()["faults"]
        return {s: "unavailable" if fs[s]["down"] else "ok" for s in SERVICES}
    st = {}
    for s in SERVICES:
        vals = [q["price"].get("promo_status", "unavailable" if q["price"]["status"] == "unavailable" else "ok")
                if s == "promo" else q[s]["status"] for q in qs]
        st[s] = max(vals, key=lambda v: rank.get(v, 0))
    return st


# ------------------------------------------------------------------ operator writes (audited)
def adjust_inventory(pid: str, store_id: str, qty: int, reason: str) -> dict:
    if store_id not in STORES:
        raise ValueError(f"unknown store {store_id}")
    if qty < 0:
        raise ValueError("qty must be >= 0")
    q = quote(pid, store_id)  # make sure the records exist
    with connect() as c:
        c.execute("UPDATE cs_inventory SET qty=?, override_qty=?, updated_at=? WHERE product_id=? AND store_id=?",
                  (qty, qty, now(), pid, store_id))
        _audit(c, "inventory_adjust", {"product_id": pid, "store_id": store_id, "qty": qty, "reason": reason,
                                       "previous_qty": q["inventory"].get("qty")})
    return {"adjusted": True, "reason": reason, "quote": quote(pid, store_id)}


def set_price(pid: str, list_price: float | None, reason: str) -> dict:
    """Operator/test list-price override (None clears it). Takes effect on the next fresh read."""
    quote(pid)
    with connect() as c:
        c.execute("UPDATE cs_price SET override_price=? WHERE product_id=?", (list_price, pid))
        _audit(c, "price_override", {"product_id": pid, "list_price": list_price, "reason": reason})
    return {"product_id": pid, "override_price": list_price, "reason": reason,
            "note": "applies on the next fresh read (checkout revalidation) or after the price TTL"}


def annotate(results: list[dict], store_id: str) -> dict:
    """Overlay effective price/promo/stock on search results in place. Returns service statuses."""
    if not results:
        return service_status([])
    qs = quotes([r["product_id"] for r in results], store_id, products={r["product_id"]: r for r in results})
    for r in results:
        q = qs[r["product_id"]]
        pr, inv, el = q["price"], q["inventory"], q["eligibility"]
        if pr["status"] != "unavailable":
            r["list_price"], r["price"], r["promo"] = pr["list_price"], pr["price"], pr["promo"]
        if inv["status"] != "unavailable":
            r["in_stock_at_store"] = inv["in_stock"]
        r["commerce_services"] = {"price": pr["status"], "inventory": inv["status"], "eligibility": el["status"],
                                  "label": SYNTHETIC_LABEL}
        r["_quote"] = q
    return service_status(list(qs.values()))
