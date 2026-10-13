"""Ops Copilot top-10 (Phase 3). search-svc is faked; ops.db, the ledger, runs and slice report are temp files."""
import json
import time

import pytest

from ops_mcp import copilot, db, search_client
from test_ops import FakeSearch


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("OPS_DB_PATH", str(tmp_path / "ops.db"))
    monkeypatch.setenv("OPS_ARTIFACT_DIR", str(tmp_path / "artifacts"))
    fake = FakeSearch()
    monkeypatch.setattr(search_client, "call", fake.call)
    monkeypatch.setattr(copilot, "LEDGER", tmp_path / "ledger.jsonl")
    monkeypatch.setattr(copilot, "RUNS", tmp_path / "runs")
    slices = tmp_path / "slices.json"
    slices.write_text(json.dumps({"generated_at": "t", "n_total": 100, "fix": {"slice": "use_case", "applied": True, "description": "head-only BM25"},
                                  "per_slice": {"use_case": {"rrf_rerank": {"n": 40, "mean": 0.50, "ci95": [0.45, 0.55]}, "rrf": {"n": 40, "mean": 0.48, "ci95": [0.4, 0.5]}},
                                                "other": {"rrf_rerank": {"n": 60, "mean": 0.70, "ci95": [0.66, 0.74]}, "rrf": {"n": 60, "mean": 0.69, "ci95": [0.6, 0.7]}}}}))
    monkeypatch.setattr(copilot, "SLICES", slices)
    return fake


def _alert(p=0.003):
    db.execute("INSERT INTO alerts(alert_id,ts,kind,detail) VALUES(?,?,?,?)",
               ("alr-1", time.time(), "embedding_drift", json.dumps({"current": {"mmd2": 0.05, "p_value": p, "est_ndcg10_delta": -0.2}})))


def test_incident_triage_cites_alert_deploy_and_canary(env):
    db.audit("release-agent", "T3", "start_canary", "v2")
    time.sleep(0.01)
    _alert()
    env.breached = True
    r = copilot.incident_triage()
    assert r["ui"] == "ops_insight" and r["kind"] == "incident_triage"
    refs = {c["ref"] for c in r["citations"]}
    assert "alr-1" in refs and "/canary/status" in refs and any(x.startswith("audit#") for x in refs)
    assert r["findings"][0]["severity"] == "high"
    assert any("not proven causal" in f["finding"] for f in r["findings"])


def test_metric_query_registry_and_unknown():
    r = copilot.metric_query("NDCG@10")
    assert r["metric"] == "ndcg10" and {s["label"].split()[0] for s in r["chart"]["series"]} == {"v1", "v2"}
    u = copilot.metric_query("happiness")
    assert u["title"].startswith("Unknown metric") and u["n"] == 0


def test_t2_runbook_needs_approval_then_executes_once_with_audit(env):
    r = copilot.run_runbook("rerun_eval_gate")
    assert r["error"] == "awaiting_human_approval" and r["ui"] == "approval"
    db.decide_approval(r["approval_id"], True, "tester")
    done = copilot.execute_approved_runbook(r["approval_id"])
    assert done["ok"] is True and done["kind"] == "runbook_run"
    assert db.rows("SELECT * FROM audit WHERE approval_id=? AND action='runbook:rerun_eval_gate'", (r["approval_id"],))
    again = copilot.execute_approved_runbook(r["approval_id"])
    assert "already executed" in again["error"]


def test_t0_runbook_runs_immediately():
    r = copilot.run_runbook("canary_status_check")
    assert r["ok"] and any(f["label"] == "tier" and f["value"] == "T0" for f in r["facts"])


def test_unknown_runbook_lists_catalog():
    r = copilot.run_runbook("delete_everything")
    assert "unknown runbook" in r["error"] and r["table"]["rows"]


def test_release_notes_and_compare_use_registry_and_gate():
    db.record_gate("v2", True, {"n_queries": 200, "ndcg10": {"champion": 0.6027, "candidate": 0.6068, "delta": 0.0041, "ci95": [-0.001, 0.011], "wins_losses_ties": [16, 16, 168]}})
    n = copilot.release_notes("candidate", "champion")
    assert "no configuration change" in n["markdown"] and "PASS" in n["markdown"] and "gate#1" in {c["ref"] for c in n["citations"]}
    c = copilot.compare_versions()
    assert any(r[0].startswith("gate ΔNDCG") for r in c["table"]["rows"])
    assert any(r[0].startswith("slice use_case") for r in c["table"]["rows"])


def test_eval_clusters_proposal_only():
    r = copilot.eval_failure_clusters()
    worst = r["clusters"][0]
    assert worst["cluster"] == "use_case" and worst["status"] == "proposal only"
    assert worst["suggested_fix"].startswith("Existing fix already applied")


def test_token_cost_report_flags_anomaly(tmp_path):
    now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"
    lines = [{"ts": now, "role": "Critic", "model": "haiku", "run_id": f"r{i}", "cost_usd": 0.001, "input_tokens": 100, "output_tokens": 20} for i in range(8)]
    lines.append({"ts": now, "role": "Critic", "model": "haiku", "run_id": "boom", "cost_usd": 0.05, "input_tokens": 9000, "output_tokens": 900})
    copilot.LEDGER.write_text("\n".join(json.dumps(x) for x in lines))
    r = copilot.token_cost_report()
    assert r["n"] == 9 and r["anomalies"][0]["run_id"] == "boom"


def test_replay_summary_finds_errors_and_refusals():
    copilot.RUNS.mkdir()
    evs = [{"seq": 0, "t_ms": 0, "event": {"type": "RUN_STARTED"}},
           {"seq": 1, "t_ms": 5, "event": {"type": "TOOL_CALL_START", "toolCallId": "a", "toolCallName": "add_to_cart"}},
           {"seq": 2, "t_ms": 9, "event": {"type": "TOOL_CALL_RESULT", "toolCallId": "a", "content": json.dumps({"blocked": True, "rule": "budget"})}},
           {"seq": 3, "t_ms": 30000, "event": {"type": "RUN_ERROR", "message": "boom"}}]
    (copilot.RUNS / "run1.jsonl").write_text("\n".join(json.dumps(e) for e in evs))
    r = copilot.replay_summary("run1")
    whats = " | ".join(f["what"] for f in r["findings"])
    assert "refused" in whats and "RUN_ERROR" in whats and "no events" in whats


def test_watch_alerts_gate_drift_canary(env):
    db.record_gate("v2", False, {"checks": {"p95_latency_le_150ms": {"value": 200, "passed": False}}})
    _alert(0.001)
    env.breached = True
    r = copilot.watch_alerts()
    kinds = {n["kind"] for n in r["notifications"]}
    assert kinds == {"gate_red", "drift", "canary_breach"}
    assert all(n["next_action"] and n["prompt"] for n in r["notifications"])


def test_trace_summary_counts_kinds_and_cites_refusals(tmp_path, monkeypatch):
    monkeypatch.setattr(copilot, "TRACES", tmp_path / "traces")
    copilot.TRACES.mkdir()
    t = "e" * 32
    spans = [
        {"traceId": t, "spanId": "1" * 16, "parentId": None, "name": "turn shopper", "kind": "turn", "service": "sparky-bff", "start": 0, "end": 2000, "attrs": {"sparky.surface": "shopper"}, "status": "ok"},
        {"traceId": t, "spanId": "2" * 16, "parentId": "1" * 16, "name": "llm Shopper", "kind": "llm", "service": "sparky-bff", "start": 10, "end": 1900, "attrs": {"sparky.cost_usd": 0.01, "gen_ai.usage.input_tokens": 100, "sparky.llm.cache_read_tokens": 80}, "status": "ok"},
        {"traceId": t, "spanId": "3" * 16, "parentId": "2" * 16, "name": "policy add_to_cart", "kind": "policy", "service": "policy-mcp", "start": 100, "end": 120, "attrs": {"sparky.policy.decision": "refuse", "sparky.policy.tool": "add_to_cart", "sparky.policy.rule": "qty_jump"}, "status": "ok"},
    ]
    (copilot.TRACES / "2026-09-17.jsonl").write_text("\n".join(json.dumps(s) for s in spans))
    r = copilot.trace_summary("latest")
    assert r["trace_id"] == t and r["kind_counts"] == {"turn": 1, "llm": 1, "policy": 1}
    assert any("refused add_to_cart" in f["what"] for f in r["findings"])
    assert r["tier"] == "T0" and r["ui"] == "ops_insight"
    assert copilot.trace_summary("f" * 32)["n"] == 0
