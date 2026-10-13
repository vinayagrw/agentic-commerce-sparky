import pytest

from shop_mcp import catalog_services as cs
from shop_mcp import commerce, storefront

S = "4108"


@pytest.fixture
def clock(monkeypatch):
    t = {"now": 1_800_000_000.0}
    monkeypatch.setattr(cs, "now", lambda: t["now"])
    return t


def test_seed_is_deterministic_from_search_record(clock):
    q = cs.quote("W-900002", S)
    assert q["price"]["status"] == "ok" and q["price"]["list_price"] == 2.98 and q["price"]["promo"] is None
    assert q["inventory"]["qty"] == cs.derive_qty({"product_id": "W-900002", "stock": {S: 12}}, S)
    assert q["synthetic_label"] == cs.SYNTHETIC_LABEL


def test_promos_are_deterministic_and_about_ten_percent(monkeypatch, clock):
    monkeypatch.setenv("SHOP_SYNTH_PROMOS", "1")
    hits = [cs.derive_promo(f"P{i}") for i in range(2000)]
    assert 0.07 < sum(1 for h in hits if h) / 2000 < 0.13
    assert cs.derive_promo("P1") == cs.derive_promo("P1")
    monkeypatch.setenv("SHOP_SYNTH_PROMOS", "0")
    assert cs.derive_promo("P1") is None


def test_ttl_read_through_refresh_and_stale_when_source_down(clock, monkeypatch):
    from shop_mcp import search_client
    cs.quote("W-900003", S)
    clock["now"] += cs.INVENTORY_TTL_S + 1
    # past TTL with the source up: refreshed on read
    assert cs.quote("W-900003", S)["inventory"]["status"] == "ok"
    clock["now"] += cs.PRICE_TTL_S + 1

    def down(pid):
        raise search_client.SearchSvcUnavailable("connection refused")
    monkeypatch.setattr(search_client, "get_product", down)
    # past TTL with the source down: the cached record is served and says it is stale
    q = cs.quote("W-900003", S)
    assert q["inventory"]["status"] == "stale" and q["price"]["status"] == "stale"
    assert q["price"]["price"] is not None
    # a fresh read (checkout revalidation) refuses to pass stale data off as current
    f = cs.quote("W-900003", S, fresh=True)
    assert f["inventory"]["status"] == "unavailable" and "fresh read failed" in f["inventory"]["error"]


def test_fault_is_partial_failure(clock):
    cs.set_fault("inventory", True)
    q = cs.quote("W-900005", S)
    assert q["inventory"]["status"] == "unavailable" and q["inventory"]["error"]
    assert q["price"]["status"] == "ok" and q["price"]["price"] == 3.12
    assert q["eligibility"]["status"] == "ok"
    cs.set_fault("inventory", False)
    cs.set_fault("price", True, seconds=10)
    assert cs.quote("W-900005", S)["price"]["status"] == "unavailable"
    clock["now"] += 11
    assert cs.quote("W-900005", S)["price"]["status"] == "ok"


@pytest.mark.parametrize("title,category,snap,age,min_age", [
    ("Jif Creamy Peanut Butter 16oz", "grocery", True, False, None),
    ("Nature Made Vitamin D3 Softgels", "grocery", False, False, None),
    ("Barefoot Pinot Grigio White Wine 750ml", "grocery", False, True, 21),
    ("Stemless Wine Glasses Set of 4", "home_kitchen", False, False, None),
    ("BIC Classic Lighter 5 pack", "home_kitchen", False, True, 18),
    ("Rotisserie Chicken Hot Food", "grocery", False, False, None),
    ("Kitchen Knife Sharpener", "home_kitchen", False, False, None),
])
def test_eligibility_rules(title, category, snap, age, min_age):
    e = cs.evaluate_eligibility({"title": title, "category": category}, S)
    assert (e["snap_eligible"], e["age_restricted"], e["min_age"]) == (snap, age, min_age)
    assert all({"rule", "applies", "text"} <= set(r) for r in e["rules"])


def test_region_blocks():
    p = {"title": "Tito's Handmade Vodka 750ml", "category": "grocery"}
    assert cs.evaluate_eligibility(p, "4108")["region_blocked"] is True   # AR rule
    assert cs.evaluate_eligibility(p, "2231")["region_blocked"] is False  # TX
    assert cs.evaluate_eligibility({"title": "Butane Refill 300ml", "category": "home_kitchen"}, "5360")["region_blocked"]


def test_pickup_eta_rule():
    assert cs.pickup_eta(0)[0] is None and cs.pickup_eta(12)[0] == 60 and cs.pickup_eta(4)[0] == 120 and cs.pickup_eta(1)[0] == 240


def test_revalidation_oos_gives_substitutes_and_price_change_applies(clock):
    sid = "s-rv"
    commerce.add(sid, "W-900002", 2)
    commerce.add(sid, "W-900011", 1)
    cs.adjust_inventory("W-900002", S, 0, "test: shelf empty")
    cs.set_price("W-900011", 3.99, "test: supplier increase")
    assert cs.quote("W-900011", S)["price"]["price"] == 3.24  # cached until fresh read
    r = storefront.revalidate(sid, S)
    by = {l["product_id"]: l for l in r["lines"]}
    oos = by["W-900002"]
    assert r["ok"] is False and any(i["kind"] == "out_of_stock" and i["blocking"] for i in oos["issues"])
    assert oos["substitutes"] and oos["substitutes"][0]["product_id"] != "W-900002"
    ch = by["W-900011"]
    assert ch["price_changed"] and ch["current_price"] == 3.99 and ch["cart_price"] == 3.24
    assert {i["product_id"]: i["price"] for i in r["cart"]["items"]}["W-900011"] == 3.99


def test_revalidation_reports_service_unavailable(clock):
    commerce.add("s-f", "W-900003", 1)
    cs.set_fault("eligibility", True)
    r = storefront.revalidate("s-f", S)
    assert r["ok"] is False and r["services"]["eligibility"] == "unavailable"
    assert r["lines"][0]["issues"][0]["kind"] == "service_unavailable"
