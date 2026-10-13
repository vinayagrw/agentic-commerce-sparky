import pytest

from shop_mcp import catalog_services as cs
from shop_mcp import commerce, search_client, storefront
from shop_mcp.search_client import SearchSvcUnavailable


@pytest.fixture(autouse=True)
def svc(monkeypatch):
    def route(q):
        if "return" in q.lower() or "devuelvo" in q.lower():
            return {"route": "help", "intent": "policy_help", "rule": "HELP", "by": "rule"}
        return {"route": "hybrid", "intent": "factoid", "rule": None, "by": "default"}
    monkeypatch.setattr(search_client, "route_intent", route)
    monkeypatch.setattr(search_client, "suggest", lambda q, n=8: {"q": q, "completions": [q + " 12ct"], "did_you_mean": None})


def test_facets_sort_pagination():
    r = storefront.search("tortillas", page_size=2, sort="price_asc")
    assert r["kind"] == "products" and r["total"] == 3 and r["pages"] == 2 and len(r["results"]) == 2
    prices = [x["price"] for x in r["results"]]
    assert prices == sorted(prices)
    assert {"value": "Acme", "count": 3} in r["facets"]["brands"]
    assert r["facets"]["dietary"][0] == {"value": "gluten_free", "count": 2}
    assert sum(b["count"] for b in r["facets"]["price"]) == 3
    assert r["services"]["price"] == "ok" and r["synthetic_label"] == cs.SYNTHETIC_LABEL
    p2 = storefront.search("tortillas", page_size=2, page=2, sort="price_asc")
    assert len(p2["results"]) == 1 and p2["results"][0]["price"] >= prices[-1]
    instock = storefront.search("tortillas", filters={"in_stock": True})
    assert all(x["in_stock"] for x in instock["results"]) and instock["total"] == 2


def test_exclude_terms_whole_word():
    r = storefront.search("tortillas", filters={"exclude_terms": ["corn"]})
    assert [x["title"] for x in r["results"]] == ["Mission Flour Tortillas 10ct"]
    assert storefront.search("tortillas", filters={"exclude_terms": ["tort"]})["total"] == 3


def test_zero_result_relaxation_files_triage():
    r = storefront.search("tortillas", filters={"brands": ["Nope"], "in_stock": True})
    assert r["total"] == 0 and r["results"] == []
    z = r["zero_result"]
    assert z["relaxation"]["dropped"] == ["brands"] and z["relaxation"]["count"] == 2
    items = storefront.triage_list("open")["items"]
    assert items[0]["id"] == z["triage_id"] and items[0]["query"] == "tortillas"
    assert storefront.triage_update(z["triage_id"], "resolved", "added synonym")["status"] == "resolved"


def test_help_routing_answers_with_citations():
    r = storefront.search("what is your return policy")
    assert r["kind"] == "help" and r["results"] == []
    h = r["help"]
    assert h["matched"] and h["citations"][0]["doc_id"] == "returns" and "NOT any real retailer's policy" in h["corpus_note"]
    es = storefront.help_answer("¿cómo devuelvo un producto?")
    assert es["lang"] == "es" and es["citations"][0]["doc_id"] == "returns" and es["answer_lang"] == "es"
    assert storefront.help_answer("zzzz qqqq")["matched"] is False


def test_search_svc_down_is_explicit(monkeypatch):
    def boom(q):
        raise SearchSvcUnavailable("connection refused")
    monkeypatch.setattr(search_client, "route_intent", boom)
    r = storefront.search("tortillas")
    assert "service_unavailable" in r and "results" not in r


def test_lists_orders_store_setqty():
    sid = "s-lo"
    assert storefront.get_store(sid)["store_id"] == "4108"
    assert storefront.set_store(sid, "2231")["store_id"] == "2231"
    storefront.add_list_item(sid, "weekly", "W-900003")
    assert storefront.lists(sid)["lists"][0]["items"][0]["product_id"] == "W-900003"
    assert storefront.remove_list_item(sid, "weekly", "W-900003")["lists"][0]["items"] == []
    assert storefront.delete_list(sid, "weekly")["lists"] == []

    storefront.set_qty(sid, "W-900003", 3)
    assert commerce.cart(sid)["item_count"] == 3
    storefront.set_qty(sid, "W-900003", 2)
    assert commerce.cart(sid)["item_count"] == 2
    m = commerce.create_mandate(sid, 50)["mandate"]
    with pytest.raises(ValueError):
        storefront.create_order(sid, m["mandate_id"])
    commerce.approve_mandate(m["mandate_id"], True)
    o = storefront.create_order(sid, m["mandate_id"])
    assert o["total"] == 5.94 and o["store_id"] == "2231" and o["payment_executed"] is False
    assert commerce.cart(sid)["items"] == []
    assert storefront.orders(sid)["orders"][0]["order_id"] == o["order_id"]
    storefront.set_qty(sid, "W-900005", 1)
    assert storefront.set_qty(sid, "W-900005", 0)["items"] == []


def test_http_endpoints_smoke():
    from fastapi.testclient import TestClient

    from shop_mcp.http_app import app
    c = TestClient(app)
    assert len(c.get("/stores").json()["stores"]) == 3
    assert c.post("/catalog-services/quotes", json={"product_ids": ["W-900003"], "store_id": "4108"}).json()["quotes"]["W-900003"]["price"]["price"] == 2.97
    assert c.post("/storefront/search", json={"query": "tortillas", "filters": {"in_stock": True}}).json()["total"] == 2
    assert c.delete("/sessions/x/budget").json() == {"session_id": "x", "budget": None}
    assert c.get("/sessions/x/store").json()["store_id"] == "4108"
