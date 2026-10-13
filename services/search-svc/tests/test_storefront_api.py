import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import app  # noqa: E402
from graph import route  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        assert c.get("/health").json()["index_loaded"]
        yield c


def test_suggest_completions_come_from_real_queries_and_correct_typos(client):
    import pandas as pd

    from engine import DATA

    real = set(pd.read_parquet(DATA / "queries.parquet")["query"].str.lower())
    body = client.get("/suggest", params={"q": "dog"}).json()
    assert body["completions"] and all(c in real for c in body["completions"])
    assert client.get("/suggest", params={"q": "peanut buttr"}).json()["did_you_mean"] == "peanut butter"
    assert client.get("/suggest", params={"q": "peanut butter"}).json()["did_you_mean"] is None


@pytest.mark.parametrize("q", ["what is your return policy", "¿cómo devuelvo un producto?",
                               "can I pay with EBT", "horario de la tienda", "where is my order"])
def test_help_intent_rules(q, client):
    assert route(q)["route"] == "help"
    assert client.post("/route/intent", json={"query": q}).json()["intent"] == "policy_help"


@pytest.mark.parametrize("q", ["peanut butter", "snap peas", "return address labels", "gluten free pasta 16 oz"])
def test_product_queries_are_not_help(q):
    assert route(q)["route"] != "help"
