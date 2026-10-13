"""SQLite state shared by the ops MCP server (stdio) and ops-http: audit log, approvals, alerts, remediations,
eval gates, labeling batches and the human review queue."""
from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

# src/ops_mcp/db.py -> parents[4] == sparky-next root
ROOT = Path(__file__).resolve().parents[4]
DATA = Path(os.environ.get("SPARKY_DATA", ROOT / "data"))
EVALS = ROOT / "evals"

SCHEMA = """
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, actor TEXT, actor_type TEXT,
  tier TEXT, action TEXT, subject TEXT, approval_id TEXT, outcome TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT PRIMARY KEY, kind TEXT, subject TEXT, status TEXT,
  summary TEXT, requested_by TEXT, requested_at REAL, decided_by TEXT, decided_at REAL, note TEXT);
CREATE TABLE IF NOT EXISTS alerts (alert_id TEXT PRIMARY KEY, ts REAL, kind TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS remediations (remediation_id TEXT PRIMARY KEY, alert_id TEXT, option_id TEXT, body TEXT,
  status TEXT, candidate_version TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS gates (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT, ts REAL, passed INTEGER, detail TEXT);
CREATE TABLE IF NOT EXISTS label_items (item_id TEXT PRIMARY KEY, batch_id TEXT, query TEXT, product_id TEXT, title TEXT,
  gold TEXT, model_label TEXT, confidence REAL, human_label TEXT, reviewer TEXT, status TEXT, ts REAL);
"""


def db_path() -> Path:
    return Path(os.environ.get("OPS_DB_PATH") or DATA / "ops.db")


def connect() -> sqlite3.Connection:
    p = db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    return conn


def rows(sql: str, args=()) -> list[dict]:
    with connect() as c:
        return [dict(r) for r in c.execute(sql, args)]


def execute(sql: str, args=()):
    with connect() as c:
        c.execute(sql, args)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


# ---------------- audit ----------------
def audit(actor: str, tier: str, action: str, subject: str | None = None, approval_id: str | None = None,
          outcome: str = "ok", detail: dict | None = None, actor_type: str = "agent") -> dict:
    rec = {"ts": round(time.time(), 3), "actor": actor, "actor_type": actor_type, "tier": tier, "action": action,
           "subject": subject, "approval_id": approval_id, "outcome": outcome}
    execute("INSERT INTO audit(ts,actor,actor_type,tier,action,subject,approval_id,outcome,detail) VALUES(?,?,?,?,?,?,?,?,?)",
            (rec["ts"], actor, actor_type, tier, action, subject, approval_id, outcome, json.dumps(detail or {}, default=str)))
    return rec


def audit_log(limit: int = 100) -> list[dict]:
    out = rows("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,))
    for r in out:
        r["detail"] = json.loads(r["detail"] or "{}")
    return out


# ---------------- approvals (decisions are made ONLY via ops-http) ----------------
def request_approval(kind: str, subject: str, requested_by: str, summary: str) -> dict:
    existing = rows("SELECT * FROM approvals WHERE kind=? AND subject=? AND status IN ('pending','approved') "
                    "ORDER BY requested_at DESC LIMIT 1", (kind, subject))
    if existing:
        return existing[0]
    aid = new_id("apr")
    execute("INSERT INTO approvals(approval_id,kind,subject,status,summary,requested_by,requested_at) VALUES(?,?,?,?,?,?,?)",
            (aid, kind, subject, "pending", summary, requested_by, time.time()))
    return rows("SELECT * FROM approvals WHERE approval_id=?", (aid,))[0]


def approval_for(kind: str, subject: str) -> dict | None:
    r = rows("SELECT * FROM approvals WHERE kind=? AND subject=? ORDER BY requested_at DESC LIMIT 1", (kind, subject))
    return r[0] if r else None


def decide_approval(approval_id: str, approved: bool, decided_by: str, note: str = "") -> dict | None:
    r = rows("SELECT * FROM approvals WHERE approval_id=?", (approval_id,))
    if not r:
        return None
    if r[0]["status"] != "pending":
        return {**r[0], "error": f"already {r[0]['status']}"}
    status = "approved" if approved else "rejected"
    execute("UPDATE approvals SET status=?, decided_by=?, decided_at=?, note=? WHERE approval_id=?",
            (status, decided_by, time.time(), note, approval_id))
    rec = rows("SELECT * FROM approvals WHERE approval_id=?", (approval_id,))[0]
    audit(decided_by, "human", f"{status}_{rec['kind']}", rec["subject"], approval_id, detail={"note": note}, actor_type="human")
    if rec["kind"] == "remediation":
        execute("UPDATE remediations SET status=? WHERE remediation_id=?", (status, rec["subject"]))
    return rec


# ---------------- gates ----------------
def record_gate(version: str, passed: bool, detail: dict):
    execute("INSERT INTO gates(version,ts,passed,detail) VALUES(?,?,?,?)", (version, time.time(), int(passed), json.dumps(detail, default=str)))


def latest_gate(version: str) -> dict | None:
    r = rows("SELECT * FROM gates WHERE version=? ORDER BY id DESC LIMIT 1", (version,))
    if not r:
        return None
    r[0]["passed"] = bool(r[0]["passed"])
    r[0]["detail"] = json.loads(r[0]["detail"])
    return r[0]
