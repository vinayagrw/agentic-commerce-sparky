"""Ops Copilot top-10 capabilities (Phase 3), computed over data the ops plane already has.

Every function reads real records - ops.db (audit, alerts, gates, approvals), search-svc (/models, /drift,
/canary/status), data/slice_report.json, data/seasonal_queries.parquet, data/token_ledger.jsonl and the
recorded AG-UI runs in data/agui_runs - and returns ONE generic "ops_insight" surface:

    {title, kind, summary, facts:[{label, value, cite}], table:{columns, rows}, chart:{type, unit, series:[{label, value}]},
     citations:[{source, ref}], findings:[...], actions:[{label, name, context}], n}

Nothing here invents a number: a source that is missing is reported as missing (facts say "no data"),
never filled. Suggested fixes are proposals only; nothing in this module changes the registry.
"""
from __future__ import annotations

import importlib.util
import json
import statistics
import time
from collections import Counter, defaultdict
from pathlib import Path

from . import db, search_client
from .db import DATA, ROOT

LEDGER = Path(DATA) / "token_ledger.jsonl"
RUNS = Path(DATA) / "agui_runs"
SLICES = Path(DATA) / "slice_report.json"


def _insight(kind: str, title: str, summary: str, *, agent: str, tier: str, source: str, **body) -> dict:
    return {"kind": kind, "title": title, "summary": summary, "facts": body.pop("facts", []), "citations": body.pop("citations", []),
            **body, "ui": "ops_insight", "agent": agent, "tier": tier,
            "provenance": {"service": "ops-mcp", "source": source, "timestamp": time.time()}}


def _ts(t: float | None) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t)) if t else "-"


def _search(method: str, path: str, body: dict | None = None, timeout: float = 60):
    try:
        return search_client.call(method, path, body, timeout=timeout) if body is not None else search_client.call(method, path, timeout=timeout)
    except Exception as e:  # SearchUnavailable or HTTP error: reported, not substituted
        return {"_unavailable": str(e)}


def _registry() -> dict:
    return _search("GET", "/models")


def _version(reg: dict, v: str) -> dict | None:
    vid = reg.get(v) if v in ("champion", "candidate") else v
    return next((x for x in reg.get("versions", []) if x.get("version") == vid), None)


def _gates(version: str | None = None, limit: int = 50) -> list[dict]:
    q = "SELECT * FROM gates" + (" WHERE version=?" if version else "") + " ORDER BY id DESC LIMIT ?"
    out = db.rows(q, (version, limit) if version else (limit,))
    for g in out:
        g["passed"] = bool(g["passed"])
        try:
            g["detail"] = json.loads(g["detail"] or "{}")
        except Exception:
            g["detail"] = {}
    return out


def _latest_alert() -> dict | None:
    r = db.rows("SELECT * FROM alerts ORDER BY ts DESC LIMIT 1")
    if not r:
        return None
    a = r[0]
    try:
        a["detail"] = json.loads(a["detail"] or "{}")
    except Exception:
        a["detail"] = {}
    return a


# ======================================================================= 1. incident triage / RCA
DEPLOY_ACTIONS = ("promote", "rollback", "auto_rollback", "start_canary", "build_candidate", "run_eval_suite", "gate_preregistered_candidate")


def incident_triage(hours: float = 72.0) -> dict:
    since = time.time() - hours * 3600
    alert = _latest_alert()
    deploys = db.rows(f"SELECT id,ts,actor,tier,action,subject,approval_id,outcome FROM audit WHERE ts>=? AND action IN ({','.join('?' * len(DEPLOY_ACTIONS))}) ORDER BY ts DESC LIMIT 25",
                      (since, *DEPLOY_ACTIONS))
    canary = _search("GET", "/canary/status", timeout=10)
    gates = [g for g in _gates(limit=10) if g["ts"] >= since]
    findings, cites = [], []
    if alert and alert["ts"] >= since:
        cur = alert["detail"].get("current", {})
        cites.append({"source": "ops.db alerts", "ref": alert["alert_id"]})
        findings.append({"severity": "high" if cur.get("p_value", 1) < 0.01 else "medium",
                         "finding": f"Embedding drift alert {alert['alert_id']} at {_ts(alert['ts'])}: MMD² {cur.get('mmd2')}, p={cur.get('p_value')}, "
                                    f"estimated NDCG@10 change {cur.get('est_ndcg10_delta')}",
                         "cite": alert["alert_id"]})
        before = [d for d in deploys if d["ts"] <= alert["ts"]]
        if before:
            d = before[0]
            cites.append({"source": "ops.db audit", "ref": f"audit#{d['id']}"})
            findings.append({"severity": "medium", "finding": f"Closest change BEFORE the alert: {d['action']} {d['subject']} by {d['actor']} at {_ts(d['ts'])} ({d['outcome']}). "
                                                            f"Correlated in time only; not proven causal.", "cite": f"audit#{d['id']}"})
        else:
            findings.append({"severity": "info", "finding": f"No deploy/canary/gate action in the {hours:.0f}h before the alert: the shift is in the query stream, not a release.", "cite": alert["alert_id"]})
    if "_unavailable" in canary:
        findings.append({"severity": "unknown", "finding": f"Canary status unavailable (search-svc): {canary['_unavailable']}", "cite": "search-svc /canary/status"})
    else:
        cites.append({"source": "search-svc", "ref": "/canary/status"})
        g = canary.get("guardrail") or {}
        if canary.get("status") == "running" and g.get("breached"):
            findings.append({"severity": "high", "finding": f"Canary {canary.get('version')} is breaching its guardrail: {'; '.join(g.get('reasons', []))}", "cite": "/canary/status"})
        else:
            findings.append({"severity": "info", "finding": f"Canary status: {canary.get('status')}" + (f" ({canary.get('version')}, no breach)" if canary.get("status") == "running" else ""), "cite": "/canary/status"})
    for g in gates:
        if not g["passed"]:
            cites.append({"source": "ops.db gates", "ref": f"gate#{g['id']}"})
            failed = [k for k, v in (g["detail"].get("checks") or {}).items() if not v.get("passed")]
            findings.append({"severity": "medium", "finding": f"Eval gate RED for {g['version']} at {_ts(g['ts'])}: failed {', '.join(failed) or 'checks'}", "cite": f"gate#{g['id']}"})
    for d in deploys:
        if d["action"] == "auto_rollback":
            cites.append({"source": "ops.db audit", "ref": f"audit#{d['id']}"})
            findings.append({"severity": "high", "finding": f"Guardrail watcher auto-rolled back {d['subject']} at {_ts(d['ts'])}", "cite": f"audit#{d['id']}"})
    sev_rank = {"high": 0, "medium": 1, "unknown": 2, "info": 3}
    findings.sort(key=lambda f: sev_rank.get(f["severity"], 9))
    top = findings[0] if findings else None
    rows = [[_ts(d["ts"])[5:16], f"{d['action']} ({d['tier']})", str(d["subject"])[:28], d["outcome"], f"audit#{d['id']}"] for d in deploys[:12]]
    next_actions = []
    if alert and alert["ts"] >= since:
        next_actions.append({"label": "Explain the drift", "prompt": "Explain the drift: which query slices moved?"})
    if any(f["severity"] == "high" and "Canary" in f["finding"] for f in findings):
        next_actions.append({"label": "Roll back the canary (runbook, T2)", "prompt": "Run the rollback_candidate runbook."})
    return _insight("incident_triage", "Incident triage", (top["finding"] if top else f"No incidents in the last {hours:.0f}h."),
                    agent="drift-monitor-agent", tier="T0", source="ops.db alerts+audit+gates, search-svc /canary/status",
                    findings=findings, citations=cites, next_actions=next_actions,
                    table={"columns": ["time", "action (tier)", "subject", "outcome", "record"], "rows": rows},
                    facts=[{"label": "window", "value": f"{hours:.0f}h"}, {"label": "deploy/gate actions", "value": len(deploys), "cite": "ops.db audit"},
                           {"label": "latest alert", "value": alert["alert_id"] if alert else "none", "cite": "ops.db alerts"}],
                    n=len(deploys))


# ======================================================================= 2. natural-language metric queries
METRICS = {
    "ndcg10": "registry test_ndcg10 per version (search-svc /models)",
    "p95_ms": "registry test_p95_ms per version",
    "mrr": "registry test_mrr per version",
    "gate_ndcg_delta": "eval gate NDCG@10 delta with 95% CI per gated version (ops.db gates)",
    "gate_p95_ms": "eval gate candidate p95 latency (ops.db gates)",
    "drift_p_value": "drift alert p-values over time (ops.db alerts)",
    "drift_mmd2": "drift alert MMD² over time (ops.db alerts)",
    "online_agreement": "online eval judge agreement (ops-mcp online_eval.agreement)",
    "slice_ndcg": "offline NDCG@10 by query type for the production path (data/slice_report.json)",
    "token_cost": "Claude cost per role from data/token_ledger.jsonl",
}


def metric_query(metric: str, versions: list[str] | None = None, limit: int = 12) -> dict:
    m = (metric or "").lower().replace("@", "").replace(" ", "_")
    alias = {"ndcg": "ndcg10", "ndcg_10": "ndcg10", "latency": "p95_ms", "p95": "p95_ms", "p_value": "drift_p_value", "drift": "drift_p_value",
             "cost": "token_cost", "tokens": "token_cost", "slices": "slice_ndcg", "agreement": "online_agreement"}
    m = alias.get(m, m)
    if m not in METRICS:
        return _insight("metric_query", f"Unknown metric '{metric}'", "Pick one of the metrics below.", agent="eval-agent", tier="T0", source="catalog",
                        table={"columns": ["metric", "source"], "rows": [[k, v] for k, v in METRICS.items()]}, n=0)
    series, rows, cols, unit, cites, ctype = [], [], [], "", [], "bar"
    if m in ("ndcg10", "p95_ms", "mrr"):
        reg = _registry()
        if "_unavailable" in reg:
            return _insight("metric_query", METRICS[m], f"search-svc unavailable: {reg['_unavailable']}", agent="eval-agent", tier="T0", source="search-svc /models", n=0)
        key = {"ndcg10": "test_ndcg10", "p95_ms": "test_p95_ms", "mrr": "test_mrr"}[m]
        vs = [v for v in reg["versions"] if (not versions or v["version"] in versions) and isinstance((v.get("metrics") or {}).get(key), (int, float))]
        vs = vs[-limit:]
        for v in vs:
            series.append({"label": v["version"] + (" ★" if v["version"] == reg.get("champion") else ""), "value": v["metrics"][key]})
            rows.append([v["version"], v.get("status"), v["metrics"][key], v.get("note", "")[:60]])
        cols, unit = ["version", "status", key, "note"], "ms" if m == "p95_ms" else ""
        cites.append({"source": "search-svc", "ref": "/models"})
    elif m in ("gate_ndcg_delta", "gate_p95_ms"):
        gs = [g for g in _gates(limit=200) if not versions or g["version"] in versions][:limit][::-1]
        for g in gs:
            d = g["detail"]
            if m == "gate_ndcg_delta":
                val, ci = (d.get("ndcg10") or {}).get("delta"), (d.get("ndcg10") or {}).get("ci95")
                if val is None:
                    continue
                series.append({"label": f"{g['version']}#{g['id']}", "value": val, "ci": ci})
                rows.append([g["version"], "PASS" if g["passed"] else "FAIL", val, json.dumps(ci), _ts(g["ts"]), f"gate#{g['id']}"])
            else:
                val = ((d.get("latency") or {}).get("candidate") or {}).get("p95_ms")
                if val is None:
                    continue
                series.append({"label": f"{g['version']}#{g['id']}", "value": val})
                rows.append([g["version"], "PASS" if g["passed"] else "FAIL", val, "", _ts(g["ts"]), f"gate#{g['id']}"])
        cols, unit = ["version", "gate", "value", "ci95", "time", "record"], "ms" if m == "gate_p95_ms" else "ΔNDCG"
        cites.append({"source": "ops.db", "ref": "gates"})
    elif m in ("drift_p_value", "drift_mmd2"):
        k = "p_value" if m == "drift_p_value" else "mmd2"
        al = db.rows("SELECT alert_id, ts, detail FROM alerts ORDER BY ts DESC LIMIT ?", (limit,))[::-1]
        for a in al:
            cur = json.loads(a["detail"] or "{}").get("current", {})
            if cur.get(k) is None:
                continue
            series.append({"label": _ts(a["ts"])[5:16], "value": cur[k]})
            rows.append([a["alert_id"], _ts(a["ts"]), cur[k]])
        cols, ctype = ["alert", "time", k], "line"
        cites.append({"source": "ops.db", "ref": "alerts"})
    elif m == "online_agreement":
        try:
            from . import online_eval
            ag = online_eval.agreement()
        except Exception as e:
            return _insight("metric_query", METRICS[m], f"online eval agreement unavailable: {e}", agent="eval-agent", tier="T0", source="online_eval", n=0)
        for k, v in ag.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                series.append({"label": k, "value": v})
                rows.append([k, v])
        cols = ["field", "value"]
        cites.append({"source": "ops-mcp", "ref": "online_eval.agreement"})
    elif m == "slice_ndcg":
        if not SLICES.exists():
            return _insight("metric_query", METRICS[m], "data/slice_report.json not found", agent="eval-agent", tier="T0", source="slice_report", n=0)
        sr = json.loads(SLICES.read_text())
        for cls, modes in sr["per_slice"].items():
            p = modes.get("rrf_rerank")
            if p and p.get("n"):
                series.append({"label": cls, "value": p["mean"], "ci": p.get("ci95")})
                rows.append([cls, p["n"], p["mean"], json.dumps(p.get("ci95"))])
        cols = ["query type", "n", "NDCG@10 (rrf_rerank)", "ci95"]
        cites.append({"source": "data/slice_report.json", "ref": sr.get("generated_at", "")})
    elif m == "token_cost":
        calls = _ledger()
        by = defaultdict(float)
        for c in calls:
            by[c.get("role", "?")] += float(c.get("cost_usd") or 0)
        for role, cost in sorted(by.items(), key=lambda x: -x[1]):
            series.append({"label": role, "value": round(cost, 5)})
            rows.append([role, round(cost, 5), sum(1 for c in calls if c.get("role") == role)])
        cols, unit = ["role", "cost_usd", "calls"], "$"
        cites.append({"source": "data/token_ledger.jsonl", "ref": f"{len(calls)} calls"})
    summary = f"{METRICS[m]}: {len(series)} point(s)." if series else f"No data yet for {METRICS[m]}."
    return _insight("metric_query", METRICS[m], summary, agent="eval-agent", tier="T0", source=cites[0]["source"] if cites else m,
                    chart={"type": ctype, "unit": unit, "series": series} if series else None,
                    table={"columns": cols, "rows": rows}, citations=cites, metric=m, n=len(series))


# ======================================================================= 3. runbook executor (T0-T3 + HITL)
RUNBOOKS = {
    "drift_recheck": {"tier": "T0", "title": "Re-check drift on the live query stream", "effect": "read-only; may record an alert"},
    "canary_status_check": {"tier": "T0", "title": "Read canary status and guardrail", "effect": "read-only"},
    "verify_champion_signature": {"tier": "T0", "title": "Verify the champion's model signature", "effect": "read-only"},
    "draft_remediation": {"tier": "T1", "title": "Draft remediation options for the latest drift alert", "effect": "recommendation only; requests an approval"},
    "clear_injected_latency": {"tier": "T3", "title": "Clear injected canary latency (guardrail-safe)", "effect": "resets a debug knob to 0 ms"},
    "rerun_eval_gate": {"tier": "T2", "title": "Re-run the eval gate on the current candidate", "effect": "spends eval compute; writes a gate record"},
    "rollback_candidate": {"tier": "T2", "title": "Roll back the current candidate", "effect": "changes the model registry"},
}


def list_runbooks() -> dict:
    return _insight("runbooks", "Runbooks", f"{len(RUNBOOKS)} runbooks. T0/T1/T3 run immediately within their tier; T2 needs a human approval first.",
                    agent="remediation-agent", tier="T0", source="ops-mcp copilot.RUNBOOKS",
                    table={"columns": ["runbook", "tier", "what it does", "effect"], "rows": [[k, v["tier"], v["title"], v["effect"]] for k, v in RUNBOOKS.items()]},
                    n=len(RUNBOOKS))


def _execute_runbook(rid: str) -> dict:
    from . import tools
    if rid == "drift_recheck":
        return tools.compute_drift()
    if rid == "canary_status_check":
        return tools.get_canary_status()
    if rid == "verify_champion_signature":
        return tools.verify_model_signature("champion")
    if rid == "draft_remediation":
        return tools.propose_remediation("latest")
    if rid == "clear_injected_latency":
        return search_client.call("POST", "/debug/inject_latency", {"ms": 0.0})
    if rid == "rerun_eval_gate":
        reg = _registry()
        return tools.run_eval_suite(reg["candidate"])
    if rid == "rollback_candidate":
        reg = _registry()
        return tools.rollback(reg["candidate"], "runbook rollback_candidate approved by a human")
    raise KeyError(rid)


def _compact(r) -> dict:
    if not isinstance(r, dict):
        return {"result": str(r)[:300]}
    keep = {k: v for k, v in r.items() if k not in ("timeline", "example_queries_latest_window", "provenance", "checks") and not isinstance(v, (list, dict))}
    return dict(list(keep.items())[:12])


def run_runbook(runbook_id: str) -> dict:
    rb = RUNBOOKS.get(runbook_id)
    if not rb:
        return {**list_runbooks(), "error": f"unknown runbook {runbook_id}"}
    tier = rb["tier"]
    if tier == "T2":
        appr = db.approval_for("runbook", runbook_id)
        if not appr or appr["status"] not in ("pending", "approved") or (appr["status"] == "approved" and _runbook_done(appr["approval_id"])):
            appr = db.request_approval("runbook", runbook_id, "runbook-executor", f"Runbook {runbook_id} ({tier}): {rb['title']}. Effect: {rb['effect']}.")
            if appr["status"] == "approved" and _runbook_done(appr["approval_id"]):
                db.execute("UPDATE approvals SET status='executed' WHERE approval_id=?", (appr["approval_id"],))
                appr = db.request_approval("runbook", runbook_id, "runbook-executor", f"Runbook {runbook_id} ({tier}): {rb['title']}. Effect: {rb['effect']}.")
        if appr["status"] != "approved":
            db.audit("runbook-executor", tier, "run_runbook", runbook_id, appr["approval_id"], outcome="blocked_awaiting_approval")
            return {"error": "awaiting_human_approval", "title": f"Approve runbook: {rb['title']}", "approval_id": appr["approval_id"], "kind": "runbook",
                    "subject": runbook_id, "status": appr["status"], "requires": f"{tier} human approval", "summary": appr["summary"],
                    "ui": "approval", "agent": "remediation-agent", "tier": "T2",
                    "provenance": {"service": "ops-mcp", "source": "ops.db approvals", "timestamp": time.time()}}
        return execute_approved_runbook(appr["approval_id"])
    t0 = time.time()
    try:
        res = _execute_runbook(runbook_id)
        ok = not (isinstance(res, dict) and res.get("error"))
    except Exception as e:
        res, ok = {"error": str(e)}, False
    rec = db.audit("runbook-executor", tier, f"runbook:{runbook_id}", runbook_id, outcome="ok" if ok else "error", detail=_compact(res))
    return _runbook_result(runbook_id, rb, res, ok, rec, None, time.time() - t0)


def _runbook_done(approval_id: str) -> bool:
    return bool(db.rows("SELECT id FROM audit WHERE approval_id=? AND action LIKE 'runbook:%'", (approval_id,)))


def execute_approved_runbook(approval_id: str) -> dict:
    """Called by ops-http after a human approved a T2 runbook (and by run_runbook when already approved)."""
    r = db.rows("SELECT * FROM approvals WHERE approval_id=? AND kind='runbook'", (approval_id,))
    if not r:
        return {"error": f"no runbook approval {approval_id}"}
    appr = r[0]
    rb = RUNBOOKS.get(appr["subject"])
    if not rb:
        return {"error": f"unknown runbook {appr['subject']}"}
    if appr["status"] != "approved":
        return {"error": f"approval {approval_id} is {appr['status']}, not approved"}
    if _runbook_done(approval_id):
        return {"error": f"runbook approval {approval_id} was already executed (single use)"}
    t0 = time.time()
    try:
        res = _execute_runbook(appr["subject"])
        ok = not (isinstance(res, dict) and res.get("error"))
    except Exception as e:
        res, ok = {"error": str(e)}, False
    rec = db.audit("runbook-executor", rb["tier"], f"runbook:{appr['subject']}", appr["subject"], approval_id, outcome="ok" if ok else "error", detail=_compact(res))
    return _runbook_result(appr["subject"], rb, res, ok, rec, appr, time.time() - t0)


def _runbook_result(rid: str, rb: dict, res, ok: bool, rec: dict, appr: dict | None, secs: float) -> dict:
    audit_row = db.rows("SELECT id FROM audit WHERE ts=? AND action=? ORDER BY id DESC LIMIT 1", (rec["ts"], rec["action"]))
    ref = f"audit#{audit_row[0]['id']}" if audit_row else "audit"
    facts = [{"label": "tier", "value": rb["tier"]}, {"label": "outcome", "value": "ok" if ok else "error"}, {"label": "seconds", "value": round(secs, 2)},
             {"label": "audit entry", "value": ref, "cite": ref}]
    if appr:
        facts.append({"label": "approved by", "value": f"{appr.get('decided_by')} ({appr['approval_id']})", "cite": appr["approval_id"]})
    return _insight("runbook_run", f"Runbook {rid}", f"{rb['title']}: {'done' if ok else 'failed'} ({rb['tier']}).", agent="remediation-agent", tier=rb["tier"],
                    source="ops-mcp runbook executor", facts=facts, citations=[{"source": "ops.db audit", "ref": ref}],
                    table={"columns": ["field", "value"], "rows": [[k, json.dumps(v)[:120] if not isinstance(v, str) else v[:120]] for k, v in _compact(res).items()]},
                    runbook=rid, ok=ok, n=1)


# ======================================================================= 4. release notes + model card
def release_notes(version: str = "candidate", against: str = "champion") -> dict:
    reg = _registry()
    if "_unavailable" in reg:
        return _insight("release_notes", "Release notes", f"search-svc unavailable: {reg['_unavailable']}", agent="release-agent", tier="T0", source="search-svc /models", n=0)
    v, base = _version(reg, version), _version(reg, against)
    if not v or not base:
        return _insight("release_notes", "Release notes", f"Unknown version {version if not v else against}.", agent="release-agent", tier="T0", source="search-svc /models", n=0)
    diff = [[k, json.dumps(base["config"].get(k)), json.dumps(v["config"].get(k))] for k in sorted(set(v["config"]) | set(base["config"])) if v["config"].get(k) != base["config"].get(k)]
    gate = next(iter(_gates(v["version"], 1)), None)
    from .signing import art_root
    bom_path = art_root() / f"{v['version']}.cdx.json"
    bom = json.loads(bom_path.read_text()) if bom_path.exists() else None
    mv, mb = v.get("metrics") or {}, base.get("metrics") or {}
    lines = [f"## {v['version']} vs {base['version']} ({against})", "", f"Status: {v.get('status')}. {v.get('note', '')}", "", "### Changes"]
    lines += [f"- `{k}`: {a} → {b}" for k, a, b in diff] or ["- no configuration change"]
    lines += ["", "### Evaluation"]
    for key in ("test_ndcg10", "test_mrr", "test_p95_ms"):
        if key in mv:
            lines.append(f"- {key}: {mv[key]} (vs {mb.get(key, 'n/a')})")
    if gate:
        nd = gate["detail"].get("ndcg10") or {}
        lines.append(f"- eval gate #{gate['id']} {'PASS' if gate['passed'] else 'FAIL'} at {_ts(gate['ts'])}: ΔNDCG {nd.get('delta')} CI95 {nd.get('ci95')}, n={gate['detail'].get('n_queries')}")
    else:
        lines.append("- no eval gate recorded for this version")
    lines += ["", "### Model card", f"- embedding: {v['config'].get('embedding_model')}; reranker: {v['config'].get('reranker_model') if v['config'].get('reranker') else 'off'}",
              f"- training/eval data: Amazon ESCI (public); config hash {v.get('config_hash')}; MLflow run {(v.get('mlflow') or {}).get('run_id')}",
              f"- ML-BOM: {'CycloneDX ' + bom['specVersion'] + ' at ' + str(bom_path.relative_to(ROOT)) if bom else 'not generated yet (generate_mlbom)'}",
              "- limitations: synthetic prices/stock; offline NDCG on ESCI test split; query-type classifier not validated against human labels"]
    cites = [{"source": "search-svc", "ref": "/models"}] + ([{"source": "ops.db gates", "ref": f"gate#{gate['id']}"}] if gate else []) + ([{"source": "ML-BOM", "ref": str(bom_path.relative_to(ROOT))}] if bom else [])
    return _insight("release_notes", f"Release notes: {v['version']}", f"{len(diff)} config change(s); gate {'PASS' if gate and gate['passed'] else 'FAIL' if gate else 'not run'}.",
                    agent="release-agent", tier="T0", source="search-svc /models + ops.db gates + ML-BOM", markdown="\n".join(lines), citations=cites,
                    table={"columns": ["config key", against, v["version"]], "rows": diff}, version=v["version"], n=len(diff))


# ======================================================================= 5. compare runs / models
def compare_versions(a: str = "champion", b: str = "candidate") -> dict:
    reg = _registry()
    if "_unavailable" in reg:
        return _insight("compare_versions", "Compare models", f"search-svc unavailable: {reg['_unavailable']}", agent="eval-agent", tier="T0", source="search-svc /models", n=0)
    va, vb = _version(reg, a), _version(reg, b)
    if not va or not vb:
        return _insight("compare_versions", "Compare models", f"Unknown version {a if not va else b}: registry versions are {', '.join(v['version'] for v in reg.get('versions', [])[-8:])}.",
                        agent="eval-agent", tier="T0", source="search-svc /models", citations=[{"source": "search-svc", "ref": "/models"}], n=0)
    rows = []
    for key in sorted(set(va.get("metrics") or {}) | set(vb.get("metrics") or {})):
        x, y = (va.get("metrics") or {}).get(key), (vb.get("metrics") or {}).get(key)
        rows.append([key, x, y, round(y - x, 5) if isinstance(x, (int, float)) and isinstance(y, (int, float)) else ""])
    for k in sorted(set(va["config"]) | set(vb["config"])):
        if va["config"].get(k) != vb["config"].get(k):
            rows.append([f"config.{k}", json.dumps(va["config"].get(k)), json.dumps(vb["config"].get(k)), "changed"])
    gate = next(iter(_gates(vb["version"], 1)), None)
    ci = None
    cites = [{"source": "search-svc", "ref": "/models"}]
    if gate:
        nd = gate["detail"].get("ndcg10") or {}
        ci = nd.get("ci95")
        rows.append(["gate ΔNDCG@10 (paired, CI95)", nd.get("champion"), nd.get("candidate"), f"{nd.get('delta')} {json.dumps(ci)}"])
        rows.append(["gate wins/losses/ties", "", "", json.dumps(nd.get("wins_losses_ties"))])
        cites.append({"source": "ops.db gates", "ref": f"gate#{gate['id']}"})
    slices = []
    if SLICES.exists():
        sr = json.loads(SLICES.read_text())
        mode = lambda v: "rrf_rerank" if v["config"].get("reranker") else "rrf"
        for cls, modes in sr["per_slice"].items():
            pa, pb = modes.get(mode(va)), modes.get(mode(vb))
            if pa and pb and pa.get("n"):
                slices.append([f"slice {cls} (n={pa['n']}, {mode(va)} vs {mode(vb)})", pa["mean"], pb["mean"], f"{round(pb['mean'] - pa['mean'], 4)} CI_a {json.dumps(pa.get('ci95'))} CI_b {json.dumps(pb.get('ci95'))}"])
        cites.append({"source": "data/slice_report.json", "ref": "per_slice by retrieval mode (offline)"})
    series = [{"label": va["version"], "value": (va.get("metrics") or {}).get("test_ndcg10")}, {"label": vb["version"], "value": (vb.get("metrics") or {}).get("test_ndcg10"), "ci": ci}]
    return _insight("compare_versions", f"Compare {va['version']} vs {vb['version']}", "Registry metrics side by side; the paired CI is from the latest eval gate; slices are offline by retrieval mode.",
                    agent="eval-agent", tier="T0", source="search-svc /models + ops.db gates + slice_report",
                    table={"columns": ["metric", va["version"], vb["version"], "delta / CI"], "rows": rows + slices},
                    chart={"type": "bar", "unit": "NDCG@10", "series": [s for s in series if isinstance(s["value"], (int, float))]}, citations=cites, n=len(rows) + len(slices))


# ======================================================================= 6. drift explainer
def _classifier():
    p = ROOT / "services" / "search-svc" / "query_types.py"
    spec = importlib.util.spec_from_file_location("sparky_query_types", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod.classify


def drift_explain(window: int = 150) -> dict:
    import pandas as pd

    classify = _classifier()
    seasonal = pd.read_parquet(Path(DATA) / "seasonal_queries.parquet")
    ref = pd.read_parquet(Path(DATA) / "queries.parquet")
    ref = ref[ref["split"] == "dev"] if "dev" in set(ref["split"]) else ref
    d = _search("POST", "/drift", {"stream": "seasonal", "window": window, "n_windows": 6}, timeout=120)
    latest = (d.get("timeline") or [{}])[-1].get("sample_queries") if "_unavailable" not in d else None
    # The /drift response carries only a handful of sample queries per window; the distribution is measured on the
    # latest `window` queries of the seasonal stream itself (the same stream /drift reads), the samples are cited.
    cur_q = seasonal["query"].tolist()[-window:]
    cur = Counter(classify(q) for q in cur_q)
    base = Counter(classify(q) for q in ref["query"].tolist())
    nc, nb = sum(cur.values()) or 1, sum(base.values()) or 1
    rows, series = [], []
    ex_pool = seasonal["query"].tolist()
    by_cls = defaultdict(list)
    for q in ex_pool:
        c = classify(q)
        if len(by_cls[c]) < 3:
            by_cls[c].append(q)
    for c in sorted(set(cur) | set(base), key=lambda c: -abs(cur[c] / nc - base[c] / nb)):
        pc, pb = cur[c] / nc, base[c] / nb
        rows.append([c, f"{pb:.1%}", f"{pc:.1%}", f"{(pc - pb) * 100:+.1f} pts", "; ".join(by_cls.get(c, []))[:70]])
        series.append({"label": c, "value": round((pc - pb) * 100, 1)})
    lex = Counter(w for q in cur_q for w in str(q).lower().split() if len(w) > 3)
    lexb = Counter(w for q in ref["query"].tolist() for w in str(q).lower().split() if len(w) > 3)
    rising = sorted(((w, n / nc - lexb[w] / nb) for w, n in lex.items() if n >= 3), key=lambda x: -x[1])[:8]
    cur_stats = d.get("current", {}) if "_unavailable" not in d else {}
    top = rows[0] if rows else None
    summary = (f"Largest slice shift: {top[0]} {top[3]} ({top[1]} → {top[2]}). Rising terms: {', '.join(w for w, _ in rising[:5])}." if top else "No queries to compare.")
    return _insight("drift_explain", "Drift explainer: which query slices moved", summary, agent="drift-monitor-agent", tier="T0",
                    source="search-svc /drift + query_types.classify + seasonal_queries.parquet",
                    table={"columns": ["query type", "reference share", "current share", "shift", "examples (seasonal_queries)"], "rows": rows},
                    chart={"type": "bar", "unit": "pts", "series": series},
                    facts=[{"label": "current window n", "value": nc, "cite": "seasonal_queries.parquet (latest window)"},
                           {"label": "/drift sample queries", "value": "; ".join(map(str, (latest or [])[:5])) or "n/a", "cite": "search-svc /drift"},
                           {"label": "reference n (ESCI dev)", "value": nb, "cite": "queries.parquet"},
                           {"label": "MMD²", "value": cur_stats.get("mmd2", "n/a")}, {"label": "p-value", "value": cur_stats.get("p_value", "n/a")},
                           {"label": "rising terms", "value": ", ".join(f"{w} (+{d_:.1%})" for w, d_ in rising[:5])}],
                    citations=[{"source": "search-svc", "ref": "/drift"}, {"source": "data/seasonal_queries.parquet", "ref": f"{len(seasonal)} queries"},
                               {"source": "services/search-svc/query_types.py", "ref": "classify (rules, not validated against human labels)"}],
                    n=nc)


# ======================================================================= 7. eval failure clustering
FIX_PROPOSALS = {
    "use_case": "Purpose-clause-aware lexical query (strip 'for …'/gift words from the BM25 leg); gate on query_types.classify.",
    "attribute": "Attribute-aware boosting: parse number+unit and colour/material tokens into structured filters before BM25.",
    "model_number": "Exact-match SKU/model token field with higher BM25 weight; skip dense retrieval rewrite for alnum tokens.",
    "abbreviation": "Acronym expansion synonyms (usb, hdmi, led, spf) on the lexical leg only.",
    "compatibility": "Extract the target device ('for iphone 12') and require it in title/bullets as a filter.",
    "non_product": "Route question phrasing to help/FAQ retrieval instead of the product ranker.",
    "product_type": "Category-intent classifier to constrain the candidate pool for 1–2 token queries.",
    "other": "Brand-entity recognition to weight brand matches in BM25.",
}


def eval_failure_clusters() -> dict:
    if not SLICES.exists():
        return _insight("eval_clusters", "Eval failure clusters", "data/slice_report.json not found (run scripts/slice_report.py).", agent="eval-agent", tier="T1", source="slice_report", n=0)
    sr = json.loads(SLICES.read_text())
    per = sr["per_slice"]
    overall = (per.get("ALL") or {}).get("rrf_rerank", {}).get("mean")
    if overall is None:
        vals = [(m["rrf_rerank"]["mean"], m["rrf_rerank"]["n"]) for c, m in per.items() if m.get("rrf_rerank", {}).get("n")]
        overall = sum(a * n for a, n in vals) / max(1, sum(n for _, n in vals))
    rows, series, clusters = [], [], []
    fix = sr.get("fix") or {}
    for cls, modes in per.items():
        p = modes.get("rrf_rerank") or {}
        if cls == "ALL" or not p.get("n"):
            continue
        gap = p["mean"] - overall
        ci = p.get("ci95") or [None, None]
        significant = ci[1] is not None and ci[1] < overall
        series.append({"label": cls, "value": round(gap, 4)})
        if gap < 0:
            already = fix.get("slice") == cls and fix.get("applied")
            proposal = FIX_PROPOSALS.get(cls, "Investigate failing queries in this slice.")
            clusters.append({"cluster": cls, "n": p["n"], "ndcg10": p["mean"], "gap": round(gap, 4), "ci95": ci, "significant": significant,
                             "suggested_fix": ("Existing fix already applied: " + fix.get("description", "")[:160]) if already else proposal, "status": "proposal only"})
        rows.append([cls, p["n"], p["mean"], f"{gap:+.4f}{' (CI below)' if significant else ''}", FIX_PROPOSALS.get(cls, "") if gap < 0 else ""])
    rows.sort(key=lambda r: float(str(r[3]).split(" ")[0]))
    clusters.sort(key=lambda c: c["gap"])
    worst = clusters[0] if clusters else None
    return _insight("eval_clusters", "Eval failures clustered by query type", (f"Worst cluster: {worst['cluster']} (n={worst['n']}, NDCG@10 {worst['ndcg10']}, {worst['gap']:+.4f} vs overall "
                    f"{overall:.4f}{', CI below overall' if worst['significant'] else ', CI overlaps overall'}). Suggested fixes are proposals only; nothing was changed.") if worst else "No slice below the overall mean.",
                    agent="eval-agent", tier="T1", source="data/slice_report.json (offline, ESCI test split)", clusters=clusters,
                    table={"columns": ["query type", "n", "NDCG@10", "vs overall", "suggested fix (proposal)"], "rows": rows},
                    chart={"type": "bar", "unit": "ΔNDCG vs overall", "series": series},
                    facts=[{"label": "overall NDCG@10", "value": round(overall, 4), "cite": "slice_report.json"}, {"label": "queries", "value": sr.get("n_total"), "cite": "slice_report.json"}],
                    citations=[{"source": "data/slice_report.json", "ref": sr.get("generated_at", "")}], n=sr.get("n_total"))


# ======================================================================= 8. cost & token dashboard
def _ledger() -> list[dict]:
    if not LEDGER.exists():
        return []
    out = []
    for line in LEDGER.read_text().splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def token_cost_report(hours: float = 168.0) -> dict:
    calls = _ledger()
    if not calls:
        return _insight("token_cost", "Cost & tokens", "data/token_ledger.jsonl has no calls yet.", agent="finops-agent", tier="T0", source="data/token_ledger.jsonl", n=0)
    import datetime as dt
    since = time.time() - hours * 3600
    def epoch(c):
        try:
            return dt.datetime.fromisoformat(str(c["ts"]).replace("Z", "+00:00")).timestamp()
        except Exception:
            return 0.0
    calls = [c for c in calls if epoch(c) >= since]
    by_role = defaultdict(lambda: {"calls": 0, "cost": 0.0, "in": 0, "out": 0, "cache": 0})
    by_hour = defaultdict(float)
    for c in calls:
        r = by_role[f"{c.get('role')} · {c.get('model')}"]
        inp = int(c.get("input_tokens") or 0) + int(c.get("cache_read_input_tokens") or 0) + int(c.get("cache_creation_input_tokens") or 0)
        r["calls"] += 1
        r["cost"] += float(c.get("cost_usd") or 0)
        r["in"] += inp
        r["out"] += int(c.get("output_tokens") or 0)
        r["cache"] += int(c.get("cache_read_input_tokens") or 0)
        by_hour[time.strftime("%m-%d %H:00", time.localtime(epoch(c)))] += float(c.get("cost_usd") or 0)
    anomalies = []
    per_role_costs = defaultdict(list)
    for c in calls:
        per_role_costs[c.get("role")].append(float(c.get("cost_usd") or 0))
    for c in calls:
        xs = per_role_costs[c.get("role")]
        if len(xs) < 5:
            continue
        med = statistics.median(xs)
        mad = statistics.median([abs(x - med) for x in xs]) or 1e-9
        z = (float(c.get("cost_usd") or 0) - med) / (1.4826 * mad)
        if z > 3.5 and float(c.get("cost_usd") or 0) > med * 2:
            anomalies.append({"ts": c["ts"], "role": c.get("role"), "run_id": c.get("run_id"), "cost_usd": c.get("cost_usd"), "median_role_cost": round(med, 5), "robust_z": round(z, 1)})
    anomalies.sort(key=lambda a: -a["robust_z"])
    total = sum(v["cost"] for v in by_role.values())
    tot_in = sum(v["in"] for v in by_role.values())
    rows = [[k, v["calls"], round(v["cost"], 5), v["in"], v["out"], f"{(v['cache'] / v['in']):.0%}" if v["in"] else "-"] for k, v in sorted(by_role.items(), key=lambda x: -x[1]["cost"])]
    ft = [c.get("first_token_ms") for c in calls if isinstance(c.get("first_token_ms"), (int, float))]
    return _insight("token_cost", "Cost & tokens", f"${total:.4f} over {len(calls)} model calls in the last {hours:.0f}h; {len(anomalies)} cost anomal{'y' if len(anomalies) == 1 else 'ies'}.",
                    agent="finops-agent", tier="T0", source="data/token_ledger.jsonl", anomalies=anomalies[:10],
                    table={"columns": ["role · model", "calls", "cost_usd", "input tokens", "output tokens", "cache hit"], "rows": rows},
                    chart={"type": "line", "unit": "$ / hour", "series": [{"label": h, "value": round(v, 5)} for h, v in sorted(by_hour.items())][-24:]},
                    facts=[{"label": "total cost", "value": f"${total:.4f}", "cite": "token_ledger.jsonl"}, {"label": "calls", "value": len(calls)},
                           {"label": "cache hit (all input)", "value": f"{(sum(v['cache'] for v in by_role.values()) / tot_in):.0%}" if tot_in else "-"},
                           {"label": "first token p50", "value": f"{statistics.median(ft):.0f} ms" if ft else "n/a"},
                           {"label": "anomaly rule", "value": "cost > 2× role median and robust z > 3.5 (n ≥ 5 per role)"}],
                    citations=[{"source": "data/token_ledger.jsonl", "ref": f"{len(calls)} calls"}], n=len(calls))


# ======================================================================= 9. replay "what went wrong"
def list_runs(limit: int = 20) -> list[dict]:
    if not RUNS.exists():
        return []
    files = sorted(RUNS.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    return [{"run_id": f.stem, "mtime": f.stat().st_mtime} for f in files]


def replay_summary(run_id: str = "latest") -> dict:
    runs = list_runs(200)
    if not runs:
        return _insight("replay_summary", "Replay summary", "No recorded runs in data/agui_runs.", agent="audit", tier="T0", source="data/agui_runs", n=0)
    rid = runs[0]["run_id"] if run_id in ("latest", "", None) else run_id
    path = RUNS / f"{rid}.jsonl"
    if not path.exists():
        return _insight("replay_summary", "Replay summary", f"No recorded run {rid}.", agent="audit", tier="T0", source="data/agui_runs",
                        table={"columns": ["recent run ids"], "rows": [[r["run_id"]] for r in runs[:10]]}, n=0)
    evs = []
    for line in path.read_text().splitlines():
        try:
            evs.append(json.loads(line))
        except Exception:
            pass
    wrong, steps, tools, gaps = [], {}, {}, []
    question, final, last_t, text = "", None, 0, ""
    for rec in evs:
        e, t = rec.get("event", {}), rec.get("t_ms", 0)
        if t - last_t > 20_000:
            gaps.append((last_t, t))
        last_t = t
        ty = e.get("type")
        if ty == "STEP_STARTED":
            steps[e.get("stepName")] = [t, None]
        elif ty == "STEP_FINISHED" and e.get("stepName") in steps:
            steps[e["stepName"]][1] = t
        elif ty == "TOOL_CALL_START":
            tools[e.get("toolCallId")] = {"name": e.get("toolCallName"), "t": t, "result": None}
        elif ty == "TOOL_CALL_RESULT" and e.get("toolCallId") in tools:
            tools[e["toolCallId"]]["result"] = str(e.get("content", ""))
            tools[e["toolCallId"]]["ms"] = t - tools[e["toolCallId"]]["t"]
        elif ty == "TEXT_MESSAGE_CONTENT":
            text += e.get("delta", "")
        elif ty == "RUN_ERROR":
            wrong.append({"what": f"RUN_ERROR: {e.get('message')}", "at_ms": t, "cite": f"{rid}#seq{rec.get('seq')}"})
        elif ty == "STATE_SNAPSHOT":
            final = e.get("snapshot")
    snap0 = next((r["event"].get("snapshot") for r in evs if r.get("event", {}).get("type") == "STATE_SNAPSHOT"), None)
    for tc_id, tc in tools.items():
        res = tc["result"]
        if tc["name"] == "render_a2ui":
            continue
        if res is None:
            wrong.append({"what": f"tool {tc['name']} never returned a result", "at_ms": tc["t"], "cite": f"{rid}:{tc_id}"})
        elif '"blocked": true' in res or '"blocked":true' in res:
            rule = "hitl.needs_approval" if "hitl.needs_approval" in res else "policy"
            wrong.append({"what": f"tool {tc['name']} was refused ({rule})" + (" - waiting for a human, not an error" if rule.startswith("hitl") else ""), "at_ms": tc["t"], "cite": f"{rid}:{tc_id}"})
        elif '"error"' in res:
            wrong.append({"what": f"tool {tc['name']} returned an error: {res[:140]}", "at_ms": tc["t"], "cite": f"{rid}:{tc_id}"})
        elif tc.get("ms", 0) > 15_000:
            wrong.append({"what": f"tool {tc['name']} was slow ({tc['ms'] / 1000:.1f}s)", "at_ms": tc["t"], "cite": f"{rid}:{tc_id}"})
    for a, b in gaps:
        wrong.append({"what": f"no events for {(b - a) / 1000:.1f}s (model thinking or a stalled tool)", "at_ms": a, "cite": f"{rid}@{a}ms"})
    if final:
        if final.get("mode") == "refused":
            wrong.append({"what": f"run refused: {(final.get('refusal') or {}).get('message')}", "at_ms": last_t, "cite": f"{rid}:final_state"})
        for g in (final.get("guard_events") or []):
            if g.get("severity") == "block":
                wrong.append({"what": f"guard block ({g.get('source')}): {str(g.get('message'))[:140]}", "at_ms": None, "cite": f"{rid}:guard:{g.get('id')}"})
        critic = next((x for x in final.get("agents") or [] if x.get("name") == "Critic"), None)
        if critic and critic.get("status") == "blocked":
            wrong.append({"what": f"Critic rejected the answer: {critic.get('note')}", "at_ms": None, "cite": f"{rid}:agents.Critic"})
    cost = (final or {}).get("cost_usd", 0) - (snap0 or {}).get("cost_usd", 0) if final else None
    rows = [[k, f"{(v[1] - v[0]) / 1000:.1f}s" if v[1] is not None else "not finished"] for k, v in steps.items()]
    rows += [[f"tool {tc['name']}", f"{tc.get('ms', 0) / 1000:.1f}s"] for tc in tools.values() if tc["name"] != "render_a2ui"]
    return _insight("replay_summary", f"What went wrong in run {rid[:8]}", (f"{len(wrong)} issue(s): " + "; ".join(w["what"] for w in wrong[:3])) if wrong else "Nothing went wrong: every tool returned, no refusals, no errors, no stalls.",
                    agent="audit", tier="T0", source=f"data/agui_runs/{rid}.jsonl", findings=wrong, run_id=rid,
                    table={"columns": ["step / tool", "duration"], "rows": rows},
                    facts=[{"label": "events", "value": len(evs), "cite": f"agui_runs/{rid}.jsonl"}, {"label": "duration", "value": f"{last_t / 1000:.1f}s"},
                           {"label": "cost", "value": f"${cost:.4f}" if isinstance(cost, (int, float)) else "n/a"}, {"label": "answer chars", "value": len(text)}],
                    citations=[{"source": "data/agui_runs", "ref": f"{rid}.jsonl"}], n=len(evs))


# ======================================================================= trace summary (deep tracing, OPS9 pattern)
TRACES = Path(DATA) / "traces"


def _trace_lines(trace_id: str | None = None) -> list[dict]:
    if not TRACES.exists():
        return []
    out = []
    for f in sorted(TRACES.glob("[0-9]*.jsonl")):
        try:
            text = f.read_text()
        except OSError:
            continue
        for line in text.splitlines():
            if trace_id and trace_id not in line:
                continue
            try:
                ln = json.loads(line)
            except ValueError:
                continue
            if not trace_id or ln.get("traceId") == trace_id:
                out.append(ln)
    return out


def trace_summary(trace_id: str = "latest") -> dict:
    """What happened in one turn trace (data/traces): per-kind counts, slowest spans, errors/refusals, LLM tokens and cost."""
    tid = (trace_id or "latest").strip().lower()
    if tid in ("latest", ""):
        roots = [ln for ln in _trace_lines() if ln.get("kind") == "turn" and not ln.get("parentId")]
        if not roots:
            return _insight("trace_summary", "Trace summary", "No turn traces in data/traces (tracing off, or no turn run since it was enabled).",
                            agent="audit", tier="T0", source="data/traces", n=0)
        tid = max(roots, key=lambda r: r.get("start", 0))["traceId"]
    spans = _trace_lines(tid)
    if not spans:
        return _insight("trace_summary", "Trace summary", f"No spans for trace {tid}.", agent="audit", tier="T0", source="data/traces", n=0)
    kinds = Counter(sp.get("kind") for sp in spans)
    root = next((sp for sp in spans if sp.get("kind") == "turn" and not sp.get("parentId")), None)
    start, end = min(sp["start"] for sp in spans), max(sp["end"] for sp in spans)
    findings = []
    for sp in spans:
        a = sp.get("attrs") or {}
        if sp.get("status") == "error" or sp.get("kind") == "error":
            findings.append({"what": f"{sp['kind']} span '{sp['name']}' errored", "at_ms": round(sp["start"] - start), "cite": f"trace {tid[:8]}:span {sp['spanId']}"})
        if sp.get("kind") == "policy" and a.get("sparky.policy.decision") == "refuse":
            hitl = str(a.get("sparky.policy.rule") or "").startswith("hitl")
            findings.append({"what": f"policy-mcp refused {a.get('sparky.policy.tool')} ({a.get('sparky.policy.rule')})" + (" - proposed for human approval, not an error" if hitl else ""), "at_ms": round(sp["start"] - start), "cite": f"trace {tid[:8]}:span {sp['spanId']}"})
        if sp.get("kind") == "retrieval" and a.get("sparky.retrieval.zero_result"):
            findings.append({"what": "a search returned zero results", "at_ms": round(sp["start"] - start), "cite": f"trace {tid[:8]}:span {sp['spanId']}"})
    llm = [sp for sp in spans if sp.get("kind") == "llm"]
    cost = sum(float((sp.get("attrs") or {}).get("sparky.cost_usd") or 0) for sp in llm)
    tin = sum(int((sp.get("attrs") or {}).get("gen_ai.usage.input_tokens") or 0) for sp in llm)
    cread = sum(int((sp.get("attrs") or {}).get("sparky.llm.cache_read_tokens") or 0) for sp in llm)
    slow = sorted(spans, key=lambda sp: sp["end"] - sp["start"], reverse=True)[:8]
    ra = (root or {}).get("attrs") or {}
    return _insight("trace_summary", f"Trace {tid[:8]}", (f"{len(spans)} spans across {len(set(sp.get('service') for sp in spans))} services in {(end - start) / 1000:.1f}s; "
                    + (f"{len(findings)} issue(s): " + "; ".join(f["what"] for f in findings[:3]) if findings else "no errors or refusals")),
                    agent="audit", tier="T0", source="data/traces/*.jsonl", trace_id=tid, run_id=ra.get("sparky.run_id"), findings=findings,
                    kind_counts=dict(kinds),
                    table={"columns": ["span", "kind", "service", "duration"], "rows": [[sp["name"], sp.get("kind"), sp.get("service"), f"{(sp['end'] - sp['start']) / 1000:.2f}s"] for sp in slow]},
                    facts=[{"label": "spans", "value": len(spans), "cite": f"trace {tid}"}, {"label": "kinds", "value": ", ".join(f"{k}={v}" for k, v in sorted(kinds.items()))},
                           {"label": "duration", "value": f"{(end - start) / 1000:.1f}s"}, {"label": "llm cost", "value": f"${cost:.4f}" if llm else "n/a"},
                           {"label": "cache-read ratio", "value": f"{cread / tin:.2f}" if tin else "n/a"}, {"label": "surface", "value": ra.get("sparky.surface", "-")}],
                    citations=[{"source": "data/traces", "ref": tid}], n=len(spans))


# ======================================================================= 10. proactive watch alerts
def watch_alerts(p_threshold: float = 0.05, hours: float = 24.0) -> dict:
    since = time.time() - hours * 3600
    notes = []
    for g in _gates(limit=20):
        if g["ts"] < since:
            break
        if not g["passed"]:
            failed = [k for k, v in (g["detail"].get("checks") or {}).items() if not v.get("passed")]
            notes.append({"id": f"gate#{g['id']}", "kind": "gate_red", "severity": "high", "ts": g["ts"],
                          "message": f"Eval gate red for {g['version']}: {', '.join(failed) or 'failed'}",
                          "next_action": "Show recent eval gate deltas with CIs", "prompt": "Show the eval gate NDCG@10 deltas with their confidence intervals.", "cite": f"ops.db gates#{g['id']}"})
            break
    a = _latest_alert()
    if a and a["ts"] >= since:
        p = (a["detail"].get("current") or {}).get("p_value")
        if isinstance(p, (int, float)) and p < p_threshold:
            notes.append({"id": a["alert_id"], "kind": "drift", "severity": "high" if p < 0.01 else "medium", "ts": a["ts"],
                          "message": f"Drift p-value {p} < {p_threshold} (alert {a['alert_id']})",
                          "next_action": "Explain which query slices moved", "prompt": "Explain the drift: which query slices moved?", "cite": f"ops.db alerts {a['alert_id']}"})
    st = _search("GET", "/canary/status", timeout=10)
    if "_unavailable" not in st and st.get("status") == "running" and (st.get("guardrail") or {}).get("breached"):
        notes.append({"id": f"canary:{st.get('version')}", "kind": "canary_breach", "severity": "high", "ts": time.time(),
                      "message": f"Canary {st.get('version')} breaching guardrail: {'; '.join(st['guardrail'].get('reasons', []))}",
                      "next_action": "Roll back the candidate (runbook, T2 approval)", "prompt": "Run the rollback_candidate runbook.", "cite": "search-svc /canary/status"})
    for d in db.rows("SELECT id,ts,subject FROM audit WHERE action='auto_rollback' AND ts>=? ORDER BY ts DESC LIMIT 1", (since,)):
        notes.append({"id": f"audit#{d['id']}", "kind": "canary_breach", "severity": "high", "ts": d["ts"], "message": f"Guardrail auto-rolled back {d['subject']}",
                      "next_action": "Summarise what went wrong", "prompt": "Triage the latest incident.", "cite": f"ops.db audit#{d['id']}"})
    return _insight("watch_alerts", "Watch alerts", f"{len(notes)} active alert(s) in the last {hours:.0f}h.", agent="drift-monitor-agent", tier="T0",
                    source="ops.db gates+alerts+audit, search-svc /canary/status", notifications=notes,
                    table={"columns": ["severity", "alert", "suggested next action", "record"], "rows": [[n["severity"], n["message"], n["next_action"], n["cite"]] for n in notes]},
                    citations=[{"source": n["cite"].split(" ")[0], "ref": n["id"]} for n in notes], n=len(notes))
