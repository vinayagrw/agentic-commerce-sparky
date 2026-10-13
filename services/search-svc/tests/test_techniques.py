"""SOTA techniques 8 (contextual retrieval), 9 (late interaction over text), 10 (routed GraphRAG).

These run against the real index, like tests/test_api.py. Technique 8's tests skip when the
enriched variant has not been built yet (scripts/contextual_enrich.py costs real money to run).
"""
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import app  # noqa: E402
from engine import DATA  # noqa: E402
from graph import anchor_span, route  # noqa: E402

VARIANT = "ctx_baby"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        assert c.get("/health").json()["index_loaded"], "run fetch_data.py + build_index.py first"
        yield c


def has_variant() -> bool:
    return (DATA / "variants" / VARIANT / "manifest.json").exists() and (DATA / "variants" / VARIANT / "emb.npy").exists()


needs_variant = pytest.mark.skipif(not has_variant(), reason="run scripts/contextual_enrich.py to build the ctx_baby variant")


def check_provenance(body: dict, endpoint: str):
    p = body["provenance"]
    assert p["service"] == "search-svc" and p["endpoint"] == endpoint
    assert p["timestamp"].endswith("Z") and p["index_variant"]


# ---------------------------------------------------------------- technique 8
def test_variant_null_is_byte_identical_to_the_baseline_search(client):
    """The measurement only means something if variant=null really is the current production path."""
    q = "gluten free pasta"
    a = client.post("/search", json={"query": q, "k": 10, "mode": "rrf_rerank"}).json()
    b = client.post("/search/variant", json={"query": q, "k": 10, "variant": None}).json()
    assert [x["product_id"] for x in a["results"]] == [x["product_id"] for x in b["results"]]
    assert b["variant"] == "baseline"
    check_provenance(b, "/search/variant")


def test_unknown_variant_is_404(client):
    assert client.post("/search/variant", json={"query": "x", "variant": "no_such_variant"}).status_code == 404


def test_variants_listing(client):
    body = client.get("/variants").json()
    assert isinstance(body["variants"], list)
    check_provenance(body, "/variants")


@needs_variant
def test_enriched_variant_changes_the_ranking_and_keeps_the_contract(client):
    q = "baby bottle drying rack"
    base = client.post("/search/variant", json={"query": q, "k": 10, "variant": None}).json()
    enr = client.post("/search/variant", json={"query": q, "k": 10, "variant": VARIANT}).json()
    assert enr["variant"] == VARIANT and len(enr["results"]) == 10
    for x in enr["results"]:
        assert "sponsored" in x and isinstance(x["stock"], dict) and x["rank_explain"]
    assert {x["product_id"] for x in enr["results"]} & {x["product_id"] for x in base["results"]}


@needs_variant
def test_every_indexed_context_still_passes_the_entity_check():
    """Re-run the verifier over what was actually indexed: no accepted context may carry a number or a
    capitalised entity absent from the real product text."""
    import pandas as pd

    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
    from contextual_enrich import product_text, verify

    ctx = json.loads((DATA / "variants" / VARIANT / "contexts.json").read_text())
    accepted = {i["product_id"]: i["context"] for i in ctx["items"] if i["accepted"]}
    p = pd.read_parquet(DATA / "products.parquet").set_index("product_id")
    bad = []
    for pid, c in list(accepted.items())[:300]:
        r = p.loc[pid].to_dict()
        r["title"] = p.at[pid, "title"]
        r["brand"] = p.at[pid, "brand"]
        reasons = verify(c, product_text(r))
        if reasons:
            bad.append((pid, reasons))
    assert not bad, f"indexed contexts failed the entity check: {bad[:3]}"


@needs_variant
def test_contexts_are_stored_with_their_lineage():
    man = json.loads((DATA / "variants" / VARIANT / "manifest.json").read_text())
    assert man["technique"] == 8 and man["generator"]["prompt_hash"]
    assert man["results"]["accepted"] > 0
    ctx = json.loads((DATA / "variants" / VARIANT / "contexts.json").read_text())
    assert ctx["generator_model"] and ctx["items"]
    accepted = [i for i in ctx["items"] if i["accepted"]]
    assert len(accepted) == man["results"]["accepted"]
    assert all(i["context"].strip() for i in accepted)


# ---------------------------------------------------------------- technique 9
def test_late_interaction_returns_maxsim_scores_and_disclaims_colpali(client):
    body = client.post("/search/late_interaction", json={"query": "stainless steel water bottle", "k": 8}).json()
    assert len(body["results"]) == 8
    scores = [x["scores"]["maxsim"] for x in body["results"]]
    assert scores == sorted(scores, reverse=True), "results must be ordered by MaxSim"
    assert "NOT run here" in body["method"]["colpali"]
    check_provenance(body, "/search/late_interaction")


def test_maxsim_is_the_colbert_formula():
    """score(q, d) = sum_i max_j <q_i, d_j>, checked against a hand-computed case."""
    import numpy as np

    from engine import Engine

    q = np.array([[1.0, 0.0], [0.0, 1.0]])
    d = np.array([[1.0, 0.0], [0.5, 0.5], [0.0, -1.0]])
    # query token 0 best matches doc token 0 (1.0); query token 1 best matches doc token 1 (0.5)
    assert Engine.maxsim(q, d) == pytest.approx(1.5)


def test_late_interaction_only_reorders_the_first_stage_candidates(client):
    """The first stage is the same RRF as the baseline: MaxSim must not invent documents."""
    q = "unscented baby wipes"
    li = client.post("/search/late_interaction", json={"query": q, "k": 10, "depth": 50}).json()
    base = client.post("/search/variant", json={"query": q, "k": 50, "variant": None, "rerank": False}).json()
    assert {x["product_id"] for x in li["results"]} <= {x["product_id"] for x in base["results"]}


# ---------------------------------------------------------------- technique 10
@pytest.mark.parametrize("query,expected", [
    ("cheaper alternative to the Keurig K-Mini", "graph_local"),
    ("what goes with the VEVOR dog grooming tub", "graph_local"),
    ("what else does Blue Buffalo make for dogs", "graph_local"),
    ("summarise the common themes across Gerber baby food", "graph_global"),
    ("gluten free pasta 16 oz", "hybrid"),
    ("unscented baby wipes sensitive skin", "hybrid"),
])
def test_router_rules(query, expected):
    assert route(query)["route"] == expected


def test_router_falls_back_to_hybrid_without_an_entity():
    assert route("cheaper alternative to something", has_entity=False)["route"] == "hybrid"


def test_anchor_span_recovers_an_entity_inside_the_matched_phrase():
    assert "Blue Buffalo" in anchor_span("what else does Blue Buffalo make for dogs")
    assert "Keurig" in anchor_span("cheaper alternative to the Keurig K-Mini coffee maker")


def test_graph_stats_are_built_from_the_real_catalogue(client):
    body = client.get("/graph/stats").json()
    g = body["graph"]
    assert g["nodes_by_kind"]["product"] == client.get("/health").json()["products"]
    for rel in ("brand", "category", "substitute", "complement", "co_intent"):
        assert g["edges_by_relation"][rel] > 0
    assert "ESCI" in g["source"]["relational_edges"]
    check_provenance(body, "/graph/stats")


def test_graph_route_cites_the_edge_it_traversed(client):
    body = client.post("/graph/route", json={"query": "cheaper alternative to the Keurig K-Mini coffee maker", "k": 5}).json()
    assert body["routing"]["route"] == "graph_local" and body["routing"]["intent"] == "cheaper_alternative"
    assert body["results"], "the Keurig K-Mini is a dense substitute node; traversal must return something"
    for r in body["results"]:
        assert r["graph"]["relation"] in ("substitute", "co_intent")
        assert r["graph"]["edge_weight"] >= 1 and r["graph"]["cited_esci_query_ids"]
        assert r["graph"]["price_delta_pct"] < 0, "cheaper_alternative must only return cheaper items"
    check_provenance(body, "/graph/route")


def test_hybrid_route_does_not_touch_the_graph(client):
    body = client.post("/graph/route", json={"query": "gluten free pasta 16 oz", "k": 5}).json()
    assert body["routing"]["route"] == "hybrid" and body["graph_hit"] is False
    assert body["results"] and all("graph" not in r for r in body["results"])


def test_graph_eval_reports_its_own_limits(client):
    body = client.get("/graph/eval").json()
    r = body["router"]["binary_graph_vs_hybrid"]
    assert 0 <= r["precision"] <= 1 and 0 <= r["recall"] <= 1
    assert r["tp"] + r["fp"] + r["fn"] + r["tn"] == body["eval_set"]["n_queries"] == 30
    assert 0 <= body["graph"]["hit_rate_on_graph_routed"] <= 1
    assert "HAND-LABELLED BY AN LLM" in body["eval_set"]["provenance"]["author"]
    assert "n=30" in body["confidence"]


def test_measured_results_file_matches_the_live_endpoints(client):
    """Every number the coverage board reads must be reproducible from this service."""
    f = Path(__file__).resolve().parents[1] / "SOTA_MEASURED.json"
    if not f.exists():
        pytest.skip("run scripts/measure_techniques.py")
    doc = json.loads(f.read_text())
    assert doc["status"] == "real-measured"
    rec = {x["id"]: x for x in doc["techniques"]}
    assert set(rec) >= {9, 10}
    for x in rec.values():
        assert x["status"] == "real-measured"
        assert x["how_computed"] and x["sample_size"]
    live = client.get("/graph/eval").json()
    assert rec[10]["measurements"]["router_precision"]["value"] == live["router"]["binary_graph_vs_hybrid"]["precision"]
    assert rec[10]["measurements"]["router_recall"]["value"] == live["router"]["binary_graph_vs_hybrid"]["recall"]
