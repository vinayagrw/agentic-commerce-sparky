"""Deterministic guard on the MCP tool path (CaMeL-style policy check, not an LLM).

The claude CLI executes MCP tools itself, so a BFF-side guard can only flag. This check runs
inside the add_to_cart tool before any state change and blocks:
  - qty above MAX_QTY,
  - a cart total that would exceed the session budget (argument or recorded ledger budget),
  - a product whose seller listing was quarantined for injection in the same session
    (or, when the model omitted session_id on the listing call, within QUARANTINE_TTL_S).
Every block is written to the guard_events table, which the BFF reads into shared state.
"""
from __future__ import annotations

import json
import time
import uuid

from . import commerce, search_client, tools
from .db import connect

MAX_QTY = 5
QUARANTINE_TTL_S = 30 * 60


def record_quarantine(session_id: str | None, product_id: str, signals=None) -> None:
    with connect() as c:
        c.execute("INSERT INTO quarantine VALUES(?,?,?,?)", (session_id, product_id, time.time(), json.dumps(signals or [])))


def _quarantined(session_id: str, product_id: str) -> bool:
    with connect() as c:
        r = c.execute(
            "SELECT 1 FROM quarantine WHERE product_id=? AND (session_id=? OR (session_id IS NULL AND ts>?)) LIMIT 1",
            (product_id, session_id, time.time() - QUARANTINE_TTL_S)).fetchone()
    return r is not None


def _session_budget(session_id: str) -> float | None:
    with connect() as c:
        r = c.execute("SELECT budget FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    return r["budget"] if r else None


def check_add(session_id: str, product_id: str, qty: int, budget: float | None) -> list[dict]:
    """Return a list of violations ({kind, reason}); empty means allow."""
    out = []
    if _quarantined(session_id, product_id):
        out.append({"kind": "injection", "reason": f"{product_id} comes from a quarantined seller listing in this session"})
    if qty > MAX_QTY:
        out.append({"kind": "qty_jump", "reason": f"qty {qty} exceeds the {MAX_QTY}-unit limit"})
    cap = budget if budget is not None else _session_budget(session_id)
    if cap is not None:
        p, _ = search_client.get_product(product_id)
        if p:
            total = commerce.cart(session_id)["total"]
            new_total = round(total + float(p["price"]) * qty, 2)
            if new_total > cap:
                out.append({"kind": "budget", "reason": f"cart would be ${new_total:.2f}, over the ${cap:.2f} budget"})
    return out


def log_event(session_id: str, tool: str, kind: str, product_id: str, qty: int, reason: str) -> dict:
    ev = {"id": "gd_" + uuid.uuid4().hex[:12], "ts": time.time(), "session_id": session_id, "tool": tool,
          "kind": kind, "product_id": product_id, "qty": qty, "reason": reason}
    with connect() as c:
        c.execute("INSERT INTO guard_events VALUES(:id,:ts,:session_id,:tool,:kind,:product_id,:qty,:reason)", ev)
    return ev


def events(session_id: str, since: float = 0) -> list[dict]:
    with connect() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM guard_events WHERE session_id=? AND ts>=? ORDER BY ts", (session_id, since))]


def guarded_add_to_cart(session_id: str, product_id: str, qty: int = 1, budget: float | None = None) -> dict:
    violations = check_add(session_id, product_id, int(qty), budget)
    if not violations:
        return tools.add_to_cart(session_id, product_id, qty, budget)
    evs = [log_event(session_id, "add_to_cart", v["kind"], product_id, int(qty), v["reason"]) for v in violations]
    reason = "; ".join(v["reason"] for v in violations)
    return {"blocked": True, "reason": reason, "error": f"Blocked by guard: {reason}",
            "guard": {"events": evs, "policy": {"max_qty": MAX_QTY, "budget": budget, "quarantine": "same session"}},
            "cart": commerce.cart(session_id), "ui": {"surface": "cart"},
            "provenance": {"source": "commerce-sim", "service": "shop-mcp", "guard": "deterministic, pre-execution"}}
