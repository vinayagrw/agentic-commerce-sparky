"""MLOps top 10 (MLO1-MLO5). Stats helpers are checked on known inputs; each tool runs against temp data files,
a temp ops.db and a fake search-svc, so nothing touches data/ or the registry."""
import json
import random
import sqlite3

import pandas as pd
import pytest

from ops_mcp import db, mlops_top10 as m, search_client, tools
from test_ops import FakeSearch


# ------------------------------------------------------------------ pure helpers
def test_team_draft_is_a_fair_duplicate_free_merge():
    a, b = [f"a{i}" for i in range(10)], ["a0"] + [f"b{i}" for i in range(9)]
    mixed = m.team_draft(a, b, random.Random(1))
    docs = [d for d, _ in mixed]
    assert len(docs) == 10 and len(set(docs)) == 10
    teams = [t for _, t in mixed]
    assert abs(teams.count("A") - teams.count("B")) <= 1


def test_sign_test_and_welch():
    assert m.sign_test_p(10, 10) == 1.0
    assert m.sign_test_p(20, 2) < 0.001
    assert m.welch_p([0.0, 0.1] * 20, [1.0, 1.1] * 20) < 1e-6


def test_cuped_reduces_variance_with_a_correlated_covariate():
    rng = random.Random(3)
    x = [rng.random() for _ in range(400)]
    y = [xi + rng.gauss(0, 0.1) for xi in x]
    adj, theta = m.cuped(y, x)
    assert 0.8 < theta < 1.2
    assert pd.Series(adj).var() < 0.2 * pd.Series(y).var()


def test_msprt_stops_on_a_real_effect_and_not_on_the_null():
    rng = random.Random(5)
    order = [rng.randint(0, 1) for _ in range(600)]
    yc = [rng.gauss(0, 1) for _ in range(600)]
    yt_big = [rng.gauss(0.8, 1) for _ in range(600)]
    yt_null = [rng.gauss(0, 1) for _ in range(600)]
    _, stop = m.msprt_path(yc, yt_big, order, tau2=0.25, sigma2=1.0)
    assert stop is not None and stop < 200
    path, stop0 = m.msprt_path(yc, yt_null, order, tau2=0.25, sigma2=1.0)
    assert stop0 is None and all(p2 <= p1 for p1, p2 in zip(path, path[1:]))


def test_psi_and_ks():
    tr = [float(i % 50) for i in range(1000)]
    assert m.psi(tr, tr) < 1e-9 and m.ks_stat(tr, tr) == 0
    assert m.psi(tr, [v + 40 for v in tr]) > 0.2


# ------------------------------------------------------------------ tools on temp data
@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("OPS_DB_PATH", str(tmp_path / "ops.db"))
    fake = FakeSearch()
    monkeypatch.setattr(search_client, "call", fake.call)
    monkeypatch.setattr(m, "DATA", tmp_path)
    monkeypatch.setattr(m, "EVIDENCE", tmp_path / "evidence")
    for k in ("SESSIONS", "COMMERCE", "MLFLOW", "SLICES"):
        monkeypatch.setattr(m, k, tmp_path / {"SESSIONS": "online_sessions.jsonl", "COMMERCE": "commerce.db", "MLFLOW": "mlflow.db", "SLICES": "slices.json"}[k])
    qs = pd.DataFrame({"query_id": list(range(60)), "query": [f"q{i}" for i in range(60)], "split": ["test"] * 60})
    qs.to_parquet(tmp_path / "queries.parquet")
    qr = pd.DataFrame([(i, f"good{i}", "E", 3) for i in range(60)] + [(i, f"bad{i}", "I", 0) for i in range(60)], columns=["query_id", "product_id", "esci_label", "gain"])
    qr.to_parquet(tmp_path / "qrels_test.parquet")
    qr.iloc[:0].to_parquet(tmp_path / "qrels_dev.parquet")
    return fake, tmp_path


def _ranker(fake, good_mode):
    base = fake.call

    def call(method, path, body=None, timeout=900.0):
        if path == "/search":
            i = body["query"][1:]
            ids = [f"good{i}", f"bad{i}"] if body["mode"] == good_mode else [f"bad{i}", f"x{i}"]
            return {"results": [{"product_id": p} for p in ids]}
        return base(method, path, body, timeout)
    return call


def test_interleave_prefers_the_better_ranker_and_labels_clicks_simulated(env, monkeypatch):
    fake, _ = env
    monkeypatch.setattr(search_client, "call", _ranker(fake, "rrf_rerank"))
    r = m.interleave_rankers(n_queries=50)
    assert r["ui"] == "ops_insight" and r["tier"] == "T1" and r["n"] == 50
    assert r["result"]["wins_a"] == 50 and r["result"]["sign_test_p"] < 1e-6
    assert "SIMULATED" in json.dumps(r["facts"]) and "advance to A/B" in r["summary"]
    assert (m.EVIDENCE / "mlops_1_interleaving.json").exists()


def test_ab_sequential_cuped_and_msprt_on_logged_sessions(env, monkeypatch):
    fake, tmp = env
    monkeypatch.setattr(search_client, "call", _ranker(fake, "rrf_rerank"))
    with open(tmp / "online_sessions.jsonl", "w") as f:
        for i in range(120):
            q = i % 60
            f.write(json.dumps({"trace_id": f"t{i}", "query": f"q{q}", "ingested_at": i, "product_ids": [f"good{q}"] if q % 2 else [f"bad{q}"]}) + "\n")
    r = m.ab_sequential_test()
    res = r["result"]
    assert res["n_sessions"] == 120 and res["n_control"] + res["n_treatment"] == 120
    assert res["delta_cuped"] < 0 and res["msprt"]["stop_at_cuped"] is not None
    assert "re-randomised" in res["assignment"]


def test_skew_flags_opens_review_and_blocks_promote(env):
    fake, tmp = env
    pd.DataFrame({"product_id": [f"p{i}" for i in range(200)], "price": [10.0 + i % 10 for i in range(200)],
                  "stock_4108": [5] * 200, "stock_2231": [5] * 200, "stock_5360": [5] * 200}).to_parquet(tmp / "products.parquet")
    con = sqlite3.connect(tmp / "commerce.db")
    con.execute("CREATE TABLE cs_price (product_id TEXT, list_price REAL, price REAL, promo TEXT, override_price REAL, updated_at REAL)")
    con.execute("CREATE TABLE cs_inventory (product_id TEXT, store_id TEXT, qty INTEGER, override_qty INTEGER, updated_at REAL)")
    con.executemany("INSERT INTO cs_price VALUES(?,?,?,?,?,?)", [(f"p{i}", 1, 60.0 + i % 10, "null", None, 0) for i in range(200)])
    con.executemany("INSERT INTO cs_inventory VALUES(?,?,?,?,?)", [(f"p{i}", s, 5, None, 0) for i in range(200) for s in ("4108", "2231", "5360")])
    con.commit()
    con.close()
    r = m.skew_check("candidate")
    assert r["result"]["flagged"] == ["price"] and r["approval_id"] and "BLOCKED" in r["summary"]
    db.record_gate("v2", True, {})
    out = tools.promote("v2")
    assert out["error"] == "training_serving_skew_unreviewed" and out["approval_id"] == r["approval_id"]


def test_lineage_walks_registry_mlflow_and_gates(env):
    _, tmp = env
    (tmp / "registry.json").write_text(json.dumps({"champion": "v2", "candidate": "v2", "versions": {
        "v1": {"version": "v1", "config": {}}, "v2": {"version": "v2", "parent": "v1", "config": {}, "mlflow": {"run_id": "r2"}}}}))
    con = sqlite3.connect(tmp / "mlflow.db")
    con.execute("CREATE TABLE runs (run_uuid TEXT, name TEXT, status TEXT)")
    con.execute("CREATE TABLE model_versions (name TEXT, version INT, run_id TEXT, source TEXT)")
    con.execute("INSERT INTO runs VALUES('r2','v2','FINISHED')")
    con.execute("INSERT INTO model_versions VALUES('ranker',2,'r2','file:///a')")
    con.commit()
    con.close()
    db.record_gate("v2", True, {})
    r = m.lineage_query("champion")
    assert r["title"] == "Lineage: model:v2" and r["tier"] == "T0"
    up, down = set(r["result"]["upstream_nodes"]), set(r["result"]["downstream_nodes"])
    assert "model:v1" in up and {"run:r2", "mlflow:ranker/2"} <= down and any(n.startswith("gate#") for n in down)
    assert m.lineage_query("nope")["n"] == 0


def test_retrain_fast_profile_fires_and_never_promotes(env, monkeypatch):
    monkeypatch.setattr(m, "detect_label_profile", lambda: ("fast", 2.0))
    r = m.retrain_trigger()
    steps = {s["step"]: s["status"] for s in r["result"]["steps"]}
    assert r["result"]["fired"] and steps["build_candidate_gate"] == "handoff" and steps["promote"] == "requires_human"
    assert db.rows("SELECT * FROM alerts")


def test_retrain_delayed_profile_waits_for_human_signoff(env):
    r = m.retrain_trigger(label_profile="delayed")
    steps = {s["step"]: s["status"] for s in r["result"]["steps"]}
    assert steps["build_candidate_gate"] == "waiting_human" and r["approval_id"]
    assert db.approval_for("retrain_signoff", r["result"]["alert_id"])["status"] == "pending"


# ------------------------------------------------------------------ MLO6-MLO10
def test_exposure_shares_relevance_matched_baseline():
    live, rel = m.exposure_shares(["ad", "good"], {"ad": True}, {"good": 3})
    assert live > rel and rel == pytest.approx((1 / m.math.log2(3)) / (1 + 1 / m.math.log2(3)))
    assert m.exposure_shares([], {}, {}) == (0.0, 0.0)


def test_exposure_audit_flags_over_exposed_sponsored(env, monkeypatch):
    fake, tmp = env
    pd.DataFrame({"product_id": [f"bad{i}" for i in range(60)] + [f"good{i}" for i in range(60)], "sponsored": [True] * 60 + [False] * 60,
                  "brand": ["adco"] * 60 + ["b"] * 60}).to_parquet(tmp / "products.parquet")

    def call(method, path, body=None, timeout=900.0):  # live ranker puts the irrelevant sponsored item above the relevant one
        i = body["query"][1:]
        return {"results": [{"product_id": f"bad{i}"}, {"product_id": f"good{i}"}]}
    monkeypatch.setattr(search_client, "call", call)
    r = m.exposure_audit(n_queries=50)
    res = r["result"]
    assert r["tier"] == "T1" and r["n"] == 50 and res["skew_detected"] and res["exposure_gap"] > 0 and res["exposure_gap_ci95"][0] > 0
    assert "1P vs 3P" in json.dumps(r["findings"]) and (m.EVIDENCE / "mlops_6_exposure.json").exists()


def _cfg_env(tmp, monkeypatch, ledger):
    root = tmp / "repo"
    for f in m.CONFIG_FILES:
        (root / f).parent.mkdir(parents=True, exist_ok=True)
        (root / f).write_text('shopper: process.env.SHOPPER_MODEL ?? "sonnet",\n' if f.endswith("config.ts") else f"// {f} v1\n")
    monkeypatch.setattr(m, "CONFIG_ROOT", root)
    monkeypatch.setattr(m, "LEDGER", tmp / "token_ledger.jsonl")
    with open(tmp / "token_ledger.jsonl", "w") as fh:
        for r in ledger:
            fh.write(json.dumps(r) + "\n")
    return root


def _iso(t):
    import datetime
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def test_config_registry_eval_on_change_blocks_regression_and_rollback_needs_human(env, monkeypatch):
    import os
    _, tmp = env
    root = _cfg_env(tmp, monkeypatch, [])
    t1 = 1_000_000.0
    for f in m.CONFIG_FILES:
        os.utime(root / f, (t1, t1))
    r0 = m.prompt_registry_diff()
    assert r0["result"]["current"] == "cfg1" and "baseline version" in r0["result"]["verdict"] and r0["result"]["files_changed"] == []
    assert m.prompt_registry_diff()["result"]["registered_now"] is None  # unchanged -> no new version
    t2 = t1 + 1000
    (root / "bff/src/config.ts").write_text('shopper: process.env.SHOPPER_MODEL ?? "opus",\n')
    os.utime(root / "bff/src/config.ts", (t2, t2))
    ledger = [{"ts": _iso(t1 + 10 + i), "role": "Shopper", "ok": True, "cost_usd": 0.01, "total_ms": 1000} for i in range(30)]
    ledger += [{"ts": _iso(t2 + 10 + i), "role": "Shopper", "ok": True, "cost_usd": 0.05, "total_ms": 1000} for i in range(30)]
    _cfg_env(tmp, monkeypatch, ledger)
    (root / "bff/src/config.ts").write_text('shopper: process.env.SHOPPER_MODEL ?? "opus",\n')
    os.utime(root / "bff/src/config.ts", (t2, t2))
    for f in m.CONFIG_FILES[:2]:
        (root / f).write_text(f"// {f} v1\n")
        os.utime(root / f, (t1, t1))
    r = m.prompt_registry_diff()
    res = r["result"]
    assert res["current"] == "cfg2" and res["model_changes"] == {"shopper": ["sonnet", "opus"]}
    assert res["regressions"] == ["Shopper"] and r["approval_id"] and "BLOCKED" in res["verdict"]
    rb = m.prompt_registry_diff(action="rollback", to_version="cfg1")
    assert "awaiting human approval" in rb["result"]["verdict"] and "opus" in (root / "bff/src/config.ts").read_text()
    db.decide_approval(rb["approval_id"], True, "alice")
    done = m.prompt_registry_diff(action="rollback", to_version="cfg1")
    assert done["result"]["applied_rollback"] == "cfg3" and "sonnet" in (root / "bff/src/config.ts").read_text()


def test_slo_budget_exhaustion_freezes_promote_until_human_override(env, monkeypatch):
    fake, tmp = env
    _cfg_env(tmp, monkeypatch, [{"ts": _iso(1000 + i), "role": "Ops", "ok": True, "first_token_ms": 100} for i in range(20)])
    with open(tmp / "online_sessions.jsonl", "w") as f:
        for i in range(100):
            f.write(json.dumps({"query": "q", "ms": 400 if i % 5 == 0 else 80, "ingested_at": i}) + "\n")
    b = m.budget([True] * 95 + [False] * 5, 0.95)
    assert b["burn_rate"] == 1.0 and b["exhausted"]
    r = m.slo_budget_status()
    assert r["tier"] == "T2" and r["result"]["freeze_active"] and "search latency <= 150 ms" in r["result"]["exhausted"]
    db.record_gate("v2", True, {})
    out = tools.promote("v2")
    assert out["error"] == "release_freeze" and out["approval_id"] == r["approval_id"]
    db.decide_approval(r["approval_id"], True, "alice", "override")
    assert m.freeze_blocks() is None
    assert tools.promote("v2")["error"] == "awaiting_human_approval"


def test_golden_set_versioning_and_failure_diff(env, monkeypatch):
    fake, tmp = env
    monkeypatch.setattr(search_client, "call", _ranker(fake, "rrf_rerank"))
    r = m.golden_set_diff(n_queries=40)
    res = r["result"]
    assert res["new_dataset_version"] and res["previous_hash"] is None and res["newly_failing"] == 40 and res["regression"]
    assert m.golden_set_diff(n_queries=40)["result"]["new_dataset_version"] is False
    r2 = m.golden_set_diff(baseline="rrf", candidate="rrf_rerank", n_queries=30)
    assert r2["result"]["dataset_diff"]["queries_removed"] == 10 and r2["approval_id"] and r2["result"]["fixed"] == 30 and not r2["result"]["regression"]
    assert r2["result"]["golden_hash"] != res["golden_hash"]


def test_shadow_overlap_latency_and_no_shopper_impact(env, monkeypatch):
    fake, tmp = env
    (tmp / "registry.json").write_text(json.dumps({"champion": "v4", "candidate": "v2", "versions": {
        "v4": {"version": "v4", "config": {"reranker": True, "w_bm25": 0.7}}, "v2": {"version": "v2", "config": {"reranker": False}}}}))
    monkeypatch.setattr(m, "_registry_safe", lambda: json.loads((tmp / "registry.json").read_text()))
    with open(tmp / "online_sessions.jsonl", "w") as f:
        for i in range(20):
            f.write(json.dumps({"query": f"q{i}", "ingested_at": i, "product_ids": [f"good{i}", f"bad{i}"]}) + "\n")
    base = _ranker(fake, "rrf_rerank")

    def call(method, path, body=None, timeout=900.0):
        out = base(method, path, body, timeout)
        return {**out, "latency_ms": 100.0 if body["mode"] == "rrf_rerank" else 40.0} if path == "/search" else out
    monkeypatch.setattr(search_client, "call", call)
    before = (tmp / "online_sessions.jsonl").read_text()
    r = m.shadow_deploy_diff()
    res = r["result"]
    assert res["champion_mode"] == "rrf_rerank" and res["candidate_mode"] == "rrf" and res["params_not_applied"]["champion"] == {"w_bm25": 0.7}
    assert res["n_queries"] == 20 and res["overlap_at_10"] == pytest.approx(0.1) and res["latency_diff_mean_ms"] == -60.0
    assert res["shopper_impact"]["responses_returned_to_shoppers"] == 0 and (tmp / "online_sessions.jsonl").read_text() == before
    assert m.serving_mode({"reranker": False, "rerank_depth": 25}) == ("rrf", {})
