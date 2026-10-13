"""ops-http (port 8803): the ONLY place humans approve/reject remediations, promotions and rollbacks, review labels,
and read the audit log. Also runs the guardrail watcher that auto-rolls back a breaching canary."""
from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import db, guardrail, labeling, online_eval

app = FastAPI(title="ops-http", version="0.1.0")


class Decision(BaseModel):
    decided_by: str = "human@demo"
    note: str = ""


class Review(BaseModel):
    item_id: str
    label: str
    reviewer: str = "human@demo"


@app.on_event("startup")
def _startup():
    if os.environ.get("OPS_GUARDRAIL_WATCH", "1") != "0":
        guardrail.start(float(os.environ.get("OPS_GUARDRAIL_INTERVAL", "2")))


@app.get("/health")
def health():
    return {"ok": True, "service": "ops-http", "guardrail": guardrail.last()}


@app.get("/approvals")
def approvals(status: str | None = None):
    if status:
        return db.rows("SELECT * FROM approvals WHERE status=? ORDER BY requested_at DESC", (status,))
    return db.rows("SELECT * FROM approvals ORDER BY requested_at DESC")


def _decide(approval_id: str, approved: bool, body: Decision):
    r = db.decide_approval(approval_id, approved, body.decided_by, body.note)
    if r is None:
        raise HTTPException(404, "unknown approval")
    if "error" in r:
        raise HTTPException(409, r["error"])
    return r


@app.post("/approvals/{approval_id}/approve")
def approve(approval_id: str, body: Decision = Decision()):
    return _decide(approval_id, True, body)


@app.post("/approvals/{approval_id}/reject")
def reject(approval_id: str, body: Decision = Decision()):
    return _decide(approval_id, False, body)


def _by_subject(kind: str, subject: str, approved: bool, body: Decision, create: bool):
    a = db.approval_for(kind, subject)
    if (not a or a["status"] != "pending") and create:
        a = db.request_approval(kind, subject, body.decided_by, f"{kind} {subject} (requested from UI)")
    if not a:
        raise HTTPException(404, f"no {kind} approval request for {subject}")
    return _decide(a["approval_id"], approved, body)


@app.post("/remediations/{remediation_id}/approve")
def approve_remediation(remediation_id: str, body: Decision = Decision()):
    return _by_subject("remediation", remediation_id, True, body, create=False)


@app.post("/remediations/{remediation_id}/reject")
def reject_remediation(remediation_id: str, body: Decision = Decision()):
    return _by_subject("remediation", remediation_id, False, body, create=False)


@app.post("/promotions/{version}/approve")
def approve_promote(version: str, body: Decision = Decision()):
    return _by_subject("promote", version, True, body, create=True)


@app.post("/rollbacks/{version}/approve")
def approve_rollback(version: str, body: Decision = Decision()):
    return _by_subject("rollback", version, True, body, create=True)


@app.get("/remediations")
def remediations():
    return db.rows("SELECT remediation_id,alert_id,option_id,status,candidate_version,created_at FROM remediations ORDER BY created_at DESC")


@app.get("/alerts")
def alerts():
    return db.rows("SELECT alert_id,ts,kind FROM alerts ORDER BY ts DESC")


@app.get("/labels/review_queue")
def review_queue():
    return labeling.review_queue()


@app.post("/labels/review")
def review(body: Review):
    r = labeling.submit_review(body.item_id, body.label, body.reviewer)
    if r is None:
        raise HTTPException(400, "unknown item or label not in E|S|C|I")
    return r


class Sessions(BaseModel):
    """Real session records from the BFF: one per traced request it actually served."""
    sessions: list[dict]


@app.post("/online_evals/sessions")
def ingest_sessions(body: Sessions):
    """Technique 29: the BFF posts the sessions it really served; the judge scores a sample of them."""
    return online_eval.ingest(body.sessions)


@app.get("/online_evals/agreement")
def online_agreement(rate: float = 1.0, max_pairs: int = 400):
    return online_eval.agreement(rate, max_pairs)


@app.get("/online_evals/sample")
def online_sample(rate: float = 1.0):
    s = online_eval.sample(rate)
    return {**s, "sessions": s["sessions"][:20]}


@app.get("/audit")
def audit(limit: int = 100):
    return db.audit_log(limit)


@app.get("/gates/{version}")
def gate(version: str):
    g = db.latest_gate(version)
    if not g:
        raise HTTPException(404, "no gate run for version")
    return g


@app.post("/gates/preregistered/{candidate}")
def gate_preregistered(candidate: str, n_queries: int = 200):
    """B08: a real preregistered null candidate through the release gate, measured live. Expected to go red."""
    from . import tools
    r = tools.gate_preregistered_candidate(candidate, n_queries)
    if r.get("error") and "known" in r:
        raise HTTPException(404, r["error"])
    return r


# ---------------- Ops Copilot top 10 (Phase 3) ----------------
@app.get("/copilot/watch")
def copilot_watch(p_threshold: float = 0.05, hours: float = 24.0):
    from . import copilot
    return copilot.watch_alerts(p_threshold, hours)


@app.get("/copilot/tokens")
def copilot_tokens(hours: float = 168.0):
    from . import copilot
    return copilot.token_cost_report(hours)


class RunbookExec(BaseModel):
    approval_id: str


@app.post("/runbooks/execute")
def runbook_execute(body: RunbookExec):
    """Run a T2 runbook AFTER a human approved it here (single use; the executor re-checks the approval)."""
    from . import copilot
    r = copilot.execute_approved_runbook(body.approval_id)
    if r.get("error") and "kind" not in r:
        raise HTTPException(409, r["error"])
    return r


@app.get("/guardrail/status")
def guardrail_status():
    return guardrail.last()


@app.post("/guardrail/check")
def guardrail_check():
    return guardrail.check_once()


def main():
    import uvicorn

    uvicorn.run(app, host=os.environ.get("OPS_HTTP_HOST", "127.0.0.1"), port=int(os.environ.get("OPS_HTTP_PORT", "8803")))


if __name__ == "__main__":
    main()
