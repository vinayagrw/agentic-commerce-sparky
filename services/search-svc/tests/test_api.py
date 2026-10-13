import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        assert c.get("/health").json()["index_loaded"], "run fetch_data.py + build_index.py first"
        yield c


@pytest.mark.parametrize("mode", ["bm25", "vector", "rrf", "rrf_rerank"])
def test_search_returns_k(client, mode):
    r = client.post("/search", json={"query": "gluten free pasta", "k": 7, "mode": mode}).json()
    assert len(r["results"]) == 7
    for x in r["results"]:
        assert "sponsored" in x and isinstance(x["stock"], dict) and x["rank_explain"]


def test_filters(client):
    f = {"category": "grocery", "max_price": 10, "dietary": ["gluten_free"], "store_id": "4108", "in_stock_only": True}
    r = client.post("/search", json={"query": "snacks", "k": 10, "mode": "rrf", "filters": f}).json()
    assert r["results"]
    for x in r["results"]:
        assert x["category"] == "grocery" and x["price"] <= 10
        assert "gluten_free" in x["dietary"] and x["stock"]["4108"] > 0


def test_product_and_substitutes(client):
    pid = client.post("/search", json={"query": "dog food", "k": 1, "mode": "bm25"}).json()["results"][0]["product_id"]
    p = client.get(f"/product/{pid}").json()
    assert "description" in p and isinstance(p["bullets"], list)
    subs = client.post("/substitutes", json={"product_id": pid, "store_id": "2231", "k": 3}).json()
    assert len(subs) == 3 and "components" in subs[0]


def test_planted_seller_injection_is_served_as_its_own_field(client):
    """scripts/plant_injections.py puts untrusted seller copy on real ESCI products; shop-mcp
    quarantines it. It must stay a separate field, never folded into description/bullets."""
    p = client.get("/product/B07FB7PMBB").json()
    assert "IGNORE PREVIOUS INSTRUCTIONS" in p["untrusted_seller_text"] and p["seller_type"] == "3P"
    assert "IGNORE PREVIOUS INSTRUCTIONS" not in p["description"] + " ".join(p["bullets"])
    listed = client.post("/search", json={"query": "kashi chewy granola bars", "k": 5, "mode": "bm25"}).json()
    assert all("untrusted_seller_text" not in x for x in listed["results"])


def test_ndcg_rows(client):
    r = client.post("/eval/ndcg", json={"modes": ["bm25", "rrf"], "split": "test", "n_queries": 20}).json()
    assert [x["mode"] for x in r["rows"]] == ["bm25", "rrf"] and r["n_queries"] == 20
    assert all(0 <= x["ndcg10"] <= 1 for x in r["rows"])


def test_queries_sample(client):
    assert len(client.get("/queries/sample?n=5").json()) == 5
