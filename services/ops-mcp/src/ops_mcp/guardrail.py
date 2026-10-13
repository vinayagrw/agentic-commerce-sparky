"""Guardrail watcher (T3): polls the canary and auto-rolls back when p95 latency or NDCG breaches."""
from __future__ import annotations

import threading
import time

from . import db, search_client

_last: dict = {"checked_at": None, "action": None}


def check_once(client=search_client) -> dict:
    try:
        st = client.call("GET", "/canary/status", timeout=10)
    except search_client.SearchUnavailable as e:
        _last.update(checked_at=time.time(), action="error", error=str(e))
        return dict(_last)
    action = {"action": "none", "canary_status": st.get("status"), "checked_at": time.time()}
    if st.get("status") == "running" and st.get("guardrail", {}).get("breached"):
        reason = "guardrail breach: " + "; ".join(st["guardrail"]["reasons"])
        r = client.call("POST", "/models/rollback", {"version": st["version"], "reason": reason, "actor": "guardrail-watcher"})
        db.audit("guardrail-watcher", "T3", "auto_rollback", st["version"], outcome=r.get("status", "?"),
                 detail={"reason": reason, "arms": st.get("arms"), "rollback": r})
        action = {"action": "rolled_back", "version": st["version"], "reason": reason, "rollback": r, "checked_at": time.time()}
    _last.clear()
    _last.update(action)
    return action


def last() -> dict:
    return dict(_last)


def start(interval_s: float = 2.0) -> threading.Thread:
    def loop():
        while True:
            check_once()
            time.sleep(interval_s)

    t = threading.Thread(target=loop, daemon=True, name="guardrail-watcher")
    t.start()
    return t
