"""'Agent as customer' API: Web-Bot-Auth-style signed agent header (demo HMAC), tiers, rate limits,
and an agent-readiness score computed over the LIVE catalogue served by search-svc.

The readiness score used to be a constant (78). It is now a measurement: every dimension is
counted across the real indexed products for the category, and the dimensions this dataset
genuinely lacks (GTIN, returns/shipping policy) score zero and show up as the top gaps. A low
score is the honest answer, not a bug.
"""
from __future__ import annotations

import hashlib
import hmac
import time

from . import search_client
from .commerce import DEMO_KEY
from .db import connect

BLOCKED_AGENTS = {"bad-scraper-bot", "price-scraper-9000"}
LIMITS = {"verified": 60, "unverified": 5}  # calls per minute
UNVERIFIED_FIELDS = ["product_id", "title", "category", "price"]

WEIGHTS = {
    "attribute_completeness": 25,   # brand + description + >=2 bullets
    "gtin_presence": 20,            # a resolvable global trade item number
    "structured_price": 15,         # a number, not a string in prose
    "structured_stock": 15,         # per-store quantities an agent can act on
    "policy_fields": 15,            # returns / shipping terms an agent must read before buying
    "media": 10,                    # at least one image URL
}


def sign_agent_request(agent_id: str, category: str) -> str:
    """Demo stand-in for an HTTP Message Signature (RFC 9421 / Web Bot Auth)."""
    return hmac.new(DEMO_KEY, f"{agent_id}|{category}".encode(), hashlib.sha256).hexdigest()


def _tier(agent_id: str, category: str, signature: str | None) -> str:
    if agent_id in BLOCKED_AGENTS or "scraper" in agent_id.lower():
        return "blocked"
    if signature and hmac.compare_digest(sign_agent_request(agent_id, category), signature):
        return "verified"
    return "unverified"


def _rate(agent_id: str, tier: str) -> dict:
    now = time.time()
    with connect() as c:
        c.execute("DELETE FROM agent_calls WHERE ts < ?", (now - 60,))
        used = c.execute("SELECT COUNT(*) FROM agent_calls WHERE agent_id=?", (agent_id,)).fetchone()[0]
        allowed = used < LIMITS[tier]
        if allowed:
            c.execute("INSERT INTO agent_calls VALUES(?,?)", (agent_id, now))
    return {"limit_per_min": LIMITS[tier], "used": used + (1 if allowed else 0), "allowed": allowed}


def catalog_feed(category: str, agent_id: str, signature: str | None) -> dict:
    tier = _tier(agent_id, category, signature)
    if tier == "blocked":
        return {"tier": tier, "status": 403, "error": "agent blocked by policy", "items": []}
    rl = _rate(agent_id, tier)
    if not rl["allowed"]:
        return {"tier": tier, "status": 429, "rate_limit": rl, "items": []}
    products, src = search_client.catalog(category)
    items = []
    for p in products:
        if tier == "verified":
            items.append({"@type": "Product", "product_id": p["product_id"], "gtin": p.get("gtin"),
                          "title": p["title"], "brand": p.get("brand"), "category": p.get("category"),
                          "offers": {"price": p.get("price"), "priceCurrency": "USD",
                                     "availability": {s: ("InStock" if q > 0 else "OutOfStock")
                                                      for s, q in (p.get("stock") or {}).items()}},
                          "description": p.get("description"), "policy": p.get("policy"),
                          "sponsored": p.get("sponsored", False)})
        else:
            items.append({k: p.get(k) for k in UNVERIFIED_FIELDS})
    return {"tier": tier, "status": 200, "rate_limit": rl, "count": len(items), "items": items,
            "catalog_source": src,
            "notes": "unverified agents get a reduced field set and lower rate limit"}


def _dimension_scores(p: dict) -> dict[str, float]:
    bullets = p.get("bullets") or []
    have_attrs = sum([bool(p.get("brand")), bool(p.get("description")), len(bullets) >= 2])
    return {
        "attribute_completeness": have_attrs / 3,
        "gtin_presence": 1.0 if p.get("gtin") else 0.0,
        "structured_price": 1.0 if isinstance(p.get("price"), (int, float)) else 0.0,
        "structured_stock": 1.0 if isinstance(p.get("stock"), dict) and p["stock"] else 0.0,
        "policy_fields": 1.0 if p.get("policy") else 0.0,
        "media": 1.0 if p.get("image") else 0.0,
    }


def readiness_score(category: str) -> dict:
    """Measured over every indexed product in the category. No constants."""
    prods, src = search_client.catalog(category)
    if not prods:
        return {"category": category, "score": 0, "product_count": 0, "breakdown": {},
                "measured_over": {"source": src, "products": 0},
                "note": f"no indexed products matched category {category!r}"}
    agg = {k: 0.0 for k in WEIGHTS}
    gap_counts = {k: 0 for k in WEIGHTS}
    for p in prods:
        for dim, v in _dimension_scores(p).items():
            agg[dim] += v
            if v < 1.0:
                gap_counts[dim] += 1
    n = len(prods)
    breakdown = {k: {"weight": w, "coverage": round(agg[k] / n, 3), "points": round(w * agg[k] / n, 1),
                     "products_missing": gap_counts[k]}
                 for k, w in WEIGHTS.items()}
    top_gaps = [{"dimension": k, "products_missing": v, "share": round(v / n, 3)}
                for k, v in sorted(gap_counts.items(), key=lambda kv: -kv[1]) if v][:5]
    return {"category": category, "product_count": n,
            "score": round(sum(b["points"] for b in breakdown.values())),
            "breakdown": breakdown, "top_gaps": top_gaps,
            "measured_over": {"source": src, "endpoint": "GET /catalog", "products": n},
            "method": "per-product coverage of each dimension, weighted; computed at call time over the live index"}
