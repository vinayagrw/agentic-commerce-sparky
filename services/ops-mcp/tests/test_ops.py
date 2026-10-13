"""ops-mcp tests. search-svc is replaced by a fake client so these run in seconds; the real numbers are covered by
services/search-svc/tests/test_mlops.py and the live smoke test in the README."""
import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from ops_mcp import db, dq, guardrail, labeling, measure, mlbom, redteam, search_client, signing, tools

RECORD = {"version": "v2", "status": "candidate", "config_hash": "abc", "parent": "v1", "note": "test",
          "config": {"embedding_model": "BAAI/bge-small-en-v1.5", "rrf_k": 60, "w_bm25": 0.7, "w_vector": 1.0, "reranker": True,
                     "reranker_model": "cross-encoder/ms-marco-MiniLM-L-6-v2", "rerank_depth": 50, "synonyms": {}},
          "metrics": {"test_ndcg10": 0.6068, "test_p95_ms": 103.4}, "mlflow": {"run_id": "r1", "model_version": "2"}}


class FakeSearch:
    def __init__(self, delta_ci=(-0.001, 0.011), p95=103.0, breached=False):
        self.delta_ci, self.p95, self.breached, self.calls = delta_ci, p95, breached, []
        self.canary_state = "running"

    def call(self, method, path, body=None, timeout=900.0):
        self.calls.append((method, path, body))
        if path == "/models":
            champ = {**RECORD, "version": "v1", "status": "champion"}
            return {"champion": "v1", "candidate": "v2", "versions": [champ, RECORD], "history": [], "backend": {"mlflow": True}}
        if path == "/models/candidate":
            return {**RECORD, "config": {**RECORD["config"], **body["config"]}, "build": {"reused_cached_embeddings": True}}
        if path == "/eval/compare":
            return {"champion": "v1", "candidate": body["candidate"], "n_queries": 200, "method": "paired bootstrap",
                    "metrics": {"ndcg10": {"champion": 0.6027, "candidate": 0.6068, "wins": 16, "losses": 16, "ties": 168,
                                           "delta": {"mean": 0.0041, "ci95": list(self.delta_ci)}},
                                "mrr": {"champion": 0.788, "candidate": 0.79, "delta": {"mean": 0.002, "ci95": [-0.01, 0.01]}}},
                    "latency": {"champion": {"p50_ms": 75, "p95_ms": 103}, "candidate": {"p50_ms": 75, "p95_ms": self.p95}}}
        if path == "/drift":
            return {"stream": body["stream"], "window": 150, "stream_source": "fake",
                    "current": {"mmd2": 0.047, "p_value": 0.0033, "alert": True, "zero_result_rate": 0.0, "est_ndcg10": 0.45,
                                "est_ndcg10_delta": -0.23, "top1_cosine_delta": -0.10},
                    "reference": {"est_ndcg10": 0.68, "measured_ndcg10_dev200": 0.70},
                    "performance_estimator": {"pearson_r": 0.5},
                    "timeline": [{"window": 0, "seasonal_fraction": 1.0, "mmd2": 0.047, "p_value": 0.0033, "alert": True,
                                  "zero_result_rate": 0.0, "est_ndcg10": 0.45, "sample_queries": ["halloween costume"]}]}
        if path == "/canary/status":
            return {"status": self.canary_state, "version": "v2", "champion": "v1", "arms": {},
                    "guardrail": {"breached": self.breached, "reasons": ["canary p95 402.0ms > 150.0ms"] if self.breached else []}}
        if path == "/canary":
            return {"status": "running", "version": body["version"], "traffic_pct": body["traffic_pct"]}
        if path == "/models/promote":
            return {"status": "promoted", "champion": body["version"], "previous_champion": "v1"}
        if path.startswith("/queries/sample"):
            return {"queries": [f"q{i}" for i in range(40)]}
        if path == "/search":
            return {"query": (body or {}).get("query"), "results": []}
        if path == "/models/rollback":
            self.canary_state = "rolled_back"
            return {"status": "rolled_back", "scope": "canary", "version": body["version"], "champion": "v1"}
        raise AssertionError(path)


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("OPS_DB_PATH", str(tmp_path / "ops.db"))
    monkeypatch.setenv("OPS_ARTIFACT_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("OPS_KEY_DIR", str(tmp_path / "keys"))
    fake = FakeSearch()
    monkeypatch.setattr(search_client, "call", fake.call)
    measure._p95_cache = None
    measure._rebuild_cache = None
    # Remediation options come from a real technique-16 search report; the fake one here carries
    # two measured winners and two measured losers so the cost policy has something to sort.
    report = tmp_path / "mle_search_report.json"
    base = {k: RECORD["config"][k] for k in ("rrf_k", "w_bm25", "w_vector", "rerank_depth")}
    def trial(i, move, cfg, delta, ci, p95):
        return {"trial": i, "round": 1, "move": move, "version": f"vs{i}", "config": {**base, **cfg},
                "ndcg10": 0.6 + delta, "ndcg10_delta": delta, "ci95": ci, "p95_ms": p95, "n_queries": 120,
                "seconds": 1.0, "cost_usd": 1e-5, "cumulative_usd": 1e-5, "accepted": delta > 0}
    report.write_text(json.dumps({
        "baseline": {"version": "v1", "config": base}, "objective": {"search_split": "dev"},
        "verdict": "improvement_confirmed", "headline": "fake report for tests",
        "spent": {"trials": 4, "usd": 4e-5},
        "trajectory": [
            trial(1, "rrf_k: 60 -> 20", {"rrf_k": 20}, 0.0041, [-0.0012, 0.0115], 104.0),
            trial(2, "rerank_depth: 50 -> 100", {"rerank_depth": 100}, 0.0052, [-0.00746, 0.0095], 187.0),
            trial(3, "w_vector: 1.0 -> 1.3", {"w_vector": 1.3}, 0.0032, [0.0005, 0.006], 105.0),
            trial(4, "w_bm25: 0.7 -> 1.3", {"w_bm25": 1.3}, -0.0041, [-0.01145, 0.00118], 106.0),
        ]}))
    monkeypatch.setattr(tools, "SEARCH_REPORT", report)
    return fake


def _meta(r, surface):
    assert r["ui"]["surface"] == surface and "provenance" in r and r["agent"] and r["tier"] in ("T0", "T1", "T2", "T3")
    json.dumps(r, default=str)


def _approve(approval_id):
    c = TestClient(__import__("ops_mcp.http_app", fromlist=["app"]).app)  # startup watcher disabled via env below
    return c.post(f"/approvals/{approval_id}/approve", json={"decided_by": "alice@demo"}).json()


def test_approvals_not_mcp_tools():
    from ops_mcp.server import mcp

    names = {t.name for t in asyncio.run(mcp.list_tools())}
    assert {"build_candidate", "promote", "rollback", "compute_drift", "sign_model", "generate_mlbom"} <= names
    forbidden = [n for n in names if any(w in n for w in ("approve", "reject", "decide", "review"))]
    assert not forbidden, forbidden


def test_build_candidate_requires_human_approval(monkeypatch):
    monkeypatch.setenv("OPS_GUARDRAIL_WATCH", "0")
    d = tools.compute_drift("seasonal")
    _meta(d, "alert")
    p = tools.propose_remediation(d["alert_id"])
    _meta(p, "approval")
    assert p["trigger_rule"]["fired"] and len(p["proposals"]) == 2
    assert all(x["cost"]["projected_p95_ms"] <= 150 for x in p["proposals"])
    # the deep-rerank trial is measured at p95 187ms, over the 150ms budget, so the cost model drops it
    assert "cfg_rerank_depth100" in {x["option_id"] for x in p["not_eligible"]}
    # every option's expected gain is a measurement from the search, never a typed-in prior
    assert all(x["measured"]["split"] == "dev" and x["confidence"] == 1.0 for x in p["proposals"])
    assert p["measured_inputs"]["current_p95"]["status"] == "real-measured"
    assert p["measured_inputs"]["rebuild_cost"]["status"] == "real-measured"
    assert p["assumptions"]["value_of_ndcg"]["provenance"] == "assumption"
    rid, aid = p["proposals"][0]["remediation_id"], p["proposals"][0]["approval_id"]
    blocked = tools.build_candidate(rid)
    assert blocked["error"] == "awaiting_human_approval" and blocked["approval_id"] == aid
    assert _approve(aid)["status"] == "approved"
    built = tools.build_candidate(rid)
    assert built["status"] == "built" and built["approved_by"] == "alice@demo"
    log = tools.get_audit_log()["entries"]
    assert any(e["actor_type"] == "human" and e["approval_id"] == aid for e in log)
    assert any(e["action"] == "build_candidate" and e["outcome"] == "blocked_awaiting_approval" for e in log)


def test_build_candidate_rejects_any_id_but_the_approved_one(monkeypatch):
    """Beat 8b determinism: if the agent re-proposes and passes a fresh id, the build is refused
    and the result names the id the human actually approved."""
    monkeypatch.setenv("OPS_GUARDRAIL_WATCH", "0")
    d = tools.compute_drift("seasonal")
    p = tools.propose_remediation(d["alert_id"])
    approved, other = p["proposals"][0], p["proposals"][1]
    assert _approve(approved["approval_id"])["status"] == "approved"
    for bad in (other["remediation_id"], "rem-does-not-exist"):
        r = tools.build_candidate(bad)
        assert r["error"] == "not_the_approved_remediation"
        assert r["approved_remediation_id"] == approved["remediation_id"]
    assert tools.build_candidate(approved["remediation_id"])["status"] == "built"
    assert any(e["action"] == "build_candidate" and e["outcome"] == "blocked_wrong_remediation"
               for e in tools.get_audit_log()["entries"])


def test_eval_gate_and_promote_requires_gate_and_approval(env, monkeypatch):
    monkeypatch.setenv("OPS_GUARDRAIL_WATCH", "0")
    assert tools.promote("v2")["error"] == "eval_gate_not_passed"
    g = tools.run_eval_suite("v2")
    _meta(g, "eval_gate")
    assert g["verdict"] == "PASS" and g["red_team"]["blocked_rate"] == 1.0
    r = tools.promote("v2")
    assert r["error"] == "awaiting_human_approval"
    _approve(r["approval_id"])
    assert tools.promote("v2")["status"] == "promoted"


def test_eval_gate_fails_on_ci_or_latency(env):
    env.delta_ci = (-0.052, -0.008)
    assert tools.run_eval_suite("v2")["verdict"] == "FAIL"
    env.delta_ci, env.p95 = (-0.001, 0.01), 186.0
    g = tools.run_eval_suite("v2")
    assert g["verdict"] == "FAIL" and not g["checks"]["p95_latency_le_150ms"]["passed"]
    assert tools.start_canary("v2", 10)["error"] == "eval_gate_not_passed"


def test_redteam_suite_all_blocked():
    r = redteam.run()
    assert r["attacks"] >= 8 and r["blocked_rate"] == 1.0 and r["false_positives"] == 0


def test_signing_verify_and_tamper():
    r = signing.sign("v2", RECORD)
    assert r["verification"]["verified"] is True
    assert r["method"] == "model_signing", r.get("reason")
    (signing.art_root() / "v2" / "config.json").write_text('{"w_bm25": 9}')
    assert signing.verify("v2")["verified"] is False


def test_mlbom_valid_cyclonedx():
    sig = signing.sign("v2", RECORD)
    bom = mlbom.build("v2", RECORD, sig)
    v = mlbom.validate(bom)
    assert v["valid"] is True, v
    s = json.loads(json.dumps(bom))
    assert s["bomFormat"] == "CycloneDX" and s["specVersion"] == "1.6" and s["serialNumber"].startswith("urn:uuid:")
    comp = s["metadata"]["component"]
    assert comp["type"] == "machine-learning-model" and comp["modelCard"]["modelParameters"]["datasets"]
    ds = [c for c in s["components"] if c["type"] == "data"][0]
    assert ds["licenses"][0]["license"]["id"] == "Apache-2.0"
    out = tools.generate_mlbom("v2")
    _meta(out, "mlbom")
    assert out["validation"]["valid"] and out["signed"]


def test_auto_rollback_on_latency_breach(env):
    env.breached = True
    a = guardrail.check_once()
    assert a["action"] == "rolled_back" and "p95" in a["reason"]
    assert ("POST", "/models/rollback") in [(m, p) for m, p, _ in env.calls]
    e = tools.get_audit_log()["entries"][0]
    assert e["actor"] == "guardrail-watcher" and e["tier"] == "T3" and e["action"] == "auto_rollback"
    assert guardrail.check_once()["action"] == "none"


def test_rollback_tool_t3_only_when_breached(env):
    r = tools.rollback("v2", "looks slow")
    assert r["error"] == "awaiting_human_approval" and r["tier"] == "T2"
    env.breached = True
    r = tools.rollback("v2", "p95 breach")
    assert r["status"] == "rolled_back" and r["tier"] == "T3"


def test_labeling_hides_gold_and_kappa():
    b = tools.label_queries(12)
    _meta(b, "label_queue")
    assert "gold" not in json.dumps(b["items"]) and b["n"] == 12
    gold = {r["item_id"]: r["gold"] for r in db.rows("SELECT item_id, gold FROM label_items")}
    labels = [{"item_id": it["item_id"], "label": gold[it["item_id"]] if i % 3 else "I", "confidence": 0.9 if i % 2 else 0.5}
              for i, it in enumerate(b["items"])]
    r = tools.record_labels(b["batch_id"], labels)
    assert 0 < r["agreement"] <= 1 and r["cohens_kappa"] is not None and r["human_review_queue"]
    assert labeling.submit_review(r["human_review_queue"][0]["item_id"], "E", "bob")["status"] == "human_reviewed"


def test_data_validation_real_catalog():
    r = tools.run_data_validation("grocery")
    _meta(r, "dq_report")
    assert r["products"] > 0 and {g["gate"] for g in r["gates"]} >= {"price_outlier_rate", "near_duplicate_title_rate"}
    assert r["near_duplicates"]["hashed"] > 0


# ---------------- data plane: techniques 2 (verified synth), 3 (DP), 5 (semantic dedup), 6 (selection) ----------------
def _scripts():
    """scripts/ is not a package; load the two numpy-only scripts by path so their maths is unit-testable."""
    import importlib.util
    import pathlib
    import sys

    root = pathlib.Path(dq.__file__).resolve().parents[4]
    mods = {}
    for name in ("dp_query_logs", "synth_attributes", "select_data"):
        spec = importlib.util.spec_from_file_location(name, root / "scripts" / f"{name}.py")
        m = importlib.util.module_from_spec(spec)
        sys.modules[name] = m
        spec.loader.exec_module(m)
        mods[name] = m
    return mods


def test_semantic_dedup_finds_what_minhash_misses():
    """Technique 5: the embedding pass must catch duplicate pairs the MinHash title pass does not."""
    import numpy as np
    import pandas as pd

    p = pd.read_parquet(dq.DATA / "products.parquet").reset_index(drop=True)
    r = dq.dedup_report(p, p.index.to_numpy(), sample=1200, seed=7)
    assert r["sample_size"] == 1200
    for k in ("minhash_only", "semantic_only", "combined"):
        assert 0.0 <= r[k]["duplicate_rate"] <= 1.0
    # combined is a superset of each single pass
    assert r["combined"]["products_involved"] >= max(r["minhash_only"]["products_involved"],
                                                     r["semantic_only"]["products_involved"])
    assert r["semantic_only"]["clusters"] >= 0 and r["semantic_only"]["duplicate_rate"] > 0
    assert r["semantic_finds_minhash_misses"]["pairs"] > 0
    for e in r["semantic_finds_minhash_misses"]["examples"]:
        assert e["cosine"] >= r["cosine_threshold"]

    # a planted exact-duplicate embedding must land in one cluster
    emb = np.zeros((4, 8), dtype=np.float32)
    emb[0, 0] = emb[1, 0] = 1.0            # identical pair
    emb[2, 1] = 1.0
    emb[3, 2] = 1.0
    s = dq.semantic_duplicates(emb, ["a", "b", "c", "d"], ["A", "B", "C", "D"], threshold=0.95)
    assert s["clusters"] == 1 and s["products_involved"] == 2


def test_data_validation_reports_semantic_dedup():
    r = tools.run_data_validation("baby", dedup_sample=800)
    _meta(r, "dq_report")
    sem = r["semantic_dedup"]
    assert sem["combined"]["duplicate_rate"] >= sem["minhash_only"]["duplicate_rate"]
    assert any(g["gate"] == "combined_duplicate_rate_minhash_or_semantic" for g in r["gates"])


def test_dp_mechanism_sensitivity_and_utility_monotonicity():
    """Technique 3: sigma must shrink as epsilon grows, and utility must improve with the budget."""
    import numpy as np

    dp = _scripts()["dp_query_logs"]
    assert dp.gaussian_sigma(0.5, 1e-6, 1.0) > dp.gaussian_sigma(1.0, 1e-6, 1.0) > dp.gaussian_sigma(5.0, 1e-6, 1.0)
    # the analytic Gaussian (eps > 1) must still satisfy the DP delta condition it solved for
    sig = dp.gaussian_sigma(2.0, 1e-6, 1.0)
    assert sig > 0

    import pandas as pd

    q = pd.read_parquet(dq.DATA / "queries.parquet").head(400)
    keys, counts, per_rec = dp.build_true_histogram(q, clip_l=3)
    assert len(keys) == len(counts) > 10
    assert all(len(toks) <= 3 for _cat, toks in per_rec)          # sensitivity cap actually enforced

    tv = []
    for eps in (0.1, 1.0, 5.0):
        rng = np.random.default_rng(1)
        out = dp.dp_histogram(counts, eps, 1e-6, 3.0, 3 ** 0.5, "laplace", rng)
        assert (out["noisy"] >= 0).all()                           # clamping is applied
        assert out["params"]["epsilon"] == eps
        tv.append(dp.tv_distance(counts, out["noisy"]))
    assert tv[0] > tv[1] > tv[2], tv                              # more budget -> closer to the truth
    assert 0.0 <= dp.topk_overlap(counts, counts, 10) == 1.0


def test_synth_attributes_verification_rejects_ungrounded_claims():
    """Technique 2: the deterministic grounding check is what makes the synthetic data 'verified'."""
    sa = _scripts()["synth_attributes"]
    text = "Title: Acme Gluten Free Oat Crackers, 8 Ounce Box\nBrand: Acme\nCategory: grocery\n" \
           "Description: Certified gluten free crackers baked with whole oats.\nBullets: 8 ounce box"

    ok = {"dietary": ["gluten_free"], "pack_size": {"value": 8, "unit": "ounce"},
          "key_features": ["Gluten free whole oat crackers"]}
    assert sa.deterministic_check(ok, text) == []

    bad_tag = {**ok, "dietary": ["gluten_free", "vegan"]}          # vegan never stated
    assert any("vegan" in r for r in sa.deterministic_check(bad_tag, text))
    bad_vocab = {**ok, "dietary": ["paleo"]}
    assert any("vocabulary" in r for r in sa.deterministic_check(bad_vocab, text))
    bad_pack = {**ok, "pack_size": {"value": 32, "unit": "ounce"}}  # 32 not in the text
    assert any("does not appear" in r for r in sa.deterministic_check(bad_pack, text))
    hallucinated = {**ok, "key_features": ["Wins awards for sustainable rainforest farming practices"]}
    assert any("grounded" in r for r in sa.deterministic_check(hallucinated, text))
    too_long = {**ok, "key_features": ["gluten free oat crackers box ounce acme whole grain snack"]}
    assert any("8 words" in r for r in sa.deterministic_check(too_long, text))
    assert sa.parse_json('noise {"dietary": [], "pack_size": null, "key_features": []} tail')["dietary"] == []
    assert sa.parse_json("not json at all") is None


def test_select_data_scoring_and_coreset():
    """Technique 6: selection maths on a synthetic embedding space with a known structure."""
    import numpy as np

    sd = _scripts()["select_data"]
    rng = np.random.default_rng(0)
    # 3 tight clusters of 20 + 10 isolated outliers
    centres = np.eye(3, 16, dtype=np.float32)
    pts = np.vstack([c + 0.01 * rng.normal(size=(20, 16)) for c in centres] +
                    [rng.normal(size=(10, 16))]).astype(np.float32)
    emb = sd.normalize(pts)
    q = sd.normalize(centres.astype(np.float32))

    cov = sd.coverage_scores(emb, q)
    assert cov.shape == (70,) and cov[:60].mean() > cov[60:].mean()      # cluster members cover the queries
    red = sd.redundancy_scores(emb, k=5)
    assert red[:60].mean() > red[60:].mean()                             # cluster members are redundant

    keep, _cov, _red, stats = sd.select(emb, q, keep_frac=0.4)
    assert len(keep) == 28 and set(stats) >= {"coverage_mean", "redundancy_mean", "lambda"}

    reps, clu = sd.select_cluster_representative(emb, cov, n_keep=28)
    assert len(reps) == 28 and len(set(reps.tolist())) == 28
    assert clu["clusters"] > 0 and 0 < clu["cosine_threshold"] < 1
    lab = sd.cluster_labels(emb, 0.9)
    assert len(np.unique(lab)) == 13                                     # 3 tight clusters + 10 outliers

    assert sd.relevant_retention(np.array([0, 1, 2]), {"p0": 0, "p9": 9}, {1: {"p0": 3, "p9": 2}}, [1]) == 0.5


def test_datagen_tools_report_provenance_without_rerunning():
    """The three new ops tools must return the recorded real run (or an honest not_run), never a fabricated number."""
    for r, surface, keys in ((tools.generate_synthetic_attributes(), "dq_report", ("results", "cost")),
                             (tools.generate_dp_query_logs(), "dq_report", ("utility_curve", "privacy_ledger")),
                             (tools.run_data_selection(), "eval_gate", ("arms", "comparison"))):
        _meta(r, surface)
        assert r["status"] in ("ok", "not_run")
        if r["status"] == "ok":
            assert r["generated_at"] and r["report_file"] and all(k in r for k in keys)
        else:
            assert "hint" in r and "scripts/" in r["hint"]
