"""MLOps plane tests on the real ESCI index: drift, paired compare gate, registry, canary guardrail + rollback."""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as app_module  # noqa: E402
from mlops import MLOps  # noqa: E402


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    with TestClient(app_module.app) as c:
        assert c.get("/health").json()["index_loaded"], "run fetch_data.py + build_index.py first"
        app_module._mlops = MLops_isolated = MLOps(app_module.engine(), root=tmp_path_factory.mktemp("mlops"))
        yield c
        MLops_isolated.canary_stop("test teardown")
        app_module._mlops = None


def test_registry_bootstrap_and_mlflow(client):
    r = client.get("/models").json()
    assert r["champion"] == "v1" and r["versions"][0]["config"]["reranker"] is True
    assert r["backend"]["mlflow"] is True and r["versions"][0]["mlflow"]["model_version"]


def test_drift_seasonal_alerts(client):
    d = client.post("/drift", json={"stream": "seasonal", "window": 150, "n_windows": 4}).json()
    assert d["current"]["alert"] and d["current"]["p_value"] < 0.05
    assert d["current"]["est_ndcg10_delta"] < 0
    assert len(d["timeline"]) == 4 and d["timeline"][0]["seasonal_fraction"] == 0.0


def test_drift_in_distribution_no_alert(client):
    d = client.post("/drift", json={"stream": "in_distribution", "window": 150, "n_windows": 4}).json()
    assert not d["current"]["alert"] and d["current"]["p_value"] >= 0.05
    assert abs(d["current"]["est_ndcg10_delta"]) < 0.03


def test_compare_reranker_off_fails_gate(client):
    v = client.post("/models/candidate", json={"config": {"reranker": False}, "note": "reranker off"}).json()
    c = client.post("/eval/compare", json={"candidate": v["version"], "n_queries": 120}).json()
    assert c["n_queries"] >= 100
    assert c["metrics"]["ndcg10"]["delta"]["ci95"][0] < -0.005
    assert c["gate"]["passed"] is False and c["gate"]["checks"]["ndcg_ci_lower_ge_floor"] is False


def test_compare_equal_config_passes_gate(client):
    v = client.post("/models/candidate", json={"config": {}, "note": "same as champion"}).json()
    assert v["build"]["reused_cached_embeddings"]
    c = client.post("/eval/compare", json={"candidate": v["version"], "n_queries": 120}).json()
    assert c["metrics"]["ndcg10"]["delta"]["ci95"][0] >= -0.005
    assert c["gate"]["passed"] is True


def test_canary_latency_guardrail_and_rollback(client):
    v = client.post("/models/candidate", json={"config": {"w_bm25": 0.7}, "note": "canary test"}).json()["version"]
    s = client.post("/canary", json={"version": v, "traffic_pct": 50, "background": False}).json()
    assert s["status"] == "running"
    s = client.post("/canary/traffic", json={"n": 40}).json()
    assert s["arms"]["canary"]["requests"] > 0 and not s["guardrail"]["breached"]
    client.post("/debug/inject_latency", json={"ms": 250})
    s = client.post("/canary/traffic", json={"n": 60}).json()
    assert s["guardrail"]["breached"] and "p95" in s["guardrail"]["reasons"][0]
    rb = client.post("/models/rollback", json={"version": v, "reason": "p95 breach", "actor": "test"}).json()
    assert rb["status"] == "rolled_back" and rb["scope"] == "canary" and rb["champion"] == "v1"
    client.post("/debug/inject_latency", json={"ms": 0})
    assert client.get("/canary/status").json()["status"] == "rolled_back"


def test_promote_and_rollback_champion(client):
    v = client.post("/models/candidate", json={"config": {"rrf_k": 61}, "note": "promote test"}).json()["version"]
    p = client.post("/models/promote", json={"version": v, "actor": "test"}).json()
    assert p["status"] == "promoted" and client.get("/models").json()["champion"] == v
    rb = client.post("/models/rollback", json={"version": v, "reason": "test"}).json()
    assert rb["scope"] == "champion" and rb["champion"] == "v1"
