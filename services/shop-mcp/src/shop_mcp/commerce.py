"""Commerce simulator: carts, budgets, AP2/UCP-style intent mandates. Never executes payment."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import uuid

from . import payments, search_client
from .db import connect

DEMO_KEY = os.environ.get("SHOP_DEMO_HMAC_KEY", "sparky-next-demo-key-not-secret").encode()
MANDATE_TTL_S = 15 * 60


def _canon(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def sign(obj) -> str:
    return hmac.new(DEMO_KEY, _canon(obj), hashlib.sha256).hexdigest()


def cart(session_id: str) -> dict:
    with connect() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT product_id,title,price,qty FROM cart_items WHERE session_id=? ORDER BY product_id", (session_id,))]
        b = c.execute("SELECT budget FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    for r in rows:
        r["line_total"] = round(r["price"] * r["qty"], 2)
    total = round(sum(r["line_total"] for r in rows), 2)
    budget = b["budget"] if b else None
    check = None
    if budget is not None:
        check = {"budget": budget, "total": total, "status": "met" if total <= budget else "violated",
                 "remaining": round(budget - total, 2)}
    return {"session_id": session_id, "items": rows, "item_count": sum(r["qty"] for r in rows),
            "total": total, "currency": "USD", "budget_check": check}


def set_budget(session_id: str, budget: float | None):
    if budget is None:
        return
    with connect() as c:
        c.execute("INSERT INTO sessions(session_id,budget) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET budget=excluded.budget",
                  (session_id, float(budget)))


def clear_budget(session_id: str):
    with connect() as c:
        c.execute("UPDATE sessions SET budget=NULL WHERE session_id=?", (session_id,))


def add(session_id: str, product_id: str, qty: int = 1, budget: float | None = None) -> dict:
    if qty < 1 or qty > 20:
        raise ValueError("qty must be between 1 and 20")
    p, src = search_client.get_product(product_id)
    if not p:
        raise ValueError(f"unknown product {product_id}")
    set_budget(session_id, budget)
    price = p["price"]
    from . import catalog_services  # effective (promo) price when the price service answers
    try:
        pr = catalog_services.quote(product_id, product=p)["price"]
        if pr["status"] != "unavailable" and pr["price"] is not None:
            price = pr["price"]
    except Exception:  # noqa: BLE001 - base price from search-svc stands; revalidation re-checks at checkout
        pass
    with connect() as c:
        c.execute("""INSERT INTO cart_items(session_id,product_id,title,price,qty) VALUES(?,?,?,?,?)
                     ON CONFLICT(session_id,product_id) DO UPDATE SET qty=qty+excluded.qty""",
                  (session_id, product_id, p["title"], price, qty))
    out = cart(session_id)
    out["source"] = src
    return out


def remove(session_id: str, product_id: str, qty: int | None = None) -> dict:
    with connect() as c:
        if qty is None:
            c.execute("DELETE FROM cart_items WHERE session_id=? AND product_id=?", (session_id, product_id))
        else:
            c.execute("UPDATE cart_items SET qty=qty-? WHERE session_id=? AND product_id=?", (qty, session_id, product_id))
            c.execute("DELETE FROM cart_items WHERE qty<=0")
    return cart(session_id)


def cart_hash(cart_obj: dict) -> str:
    lines = [{"product_id": i["product_id"], "qty": i["qty"], "price": i["price"]} for i in cart_obj["items"]]
    return "sha256:" + hashlib.sha256(_canon(lines)).hexdigest()


def create_mandate(session_id: str, spend_cap: float, merchant: str = "demo-store.example",
                   account_id: str | None = None, address_id: str | None = None,
                   tender: list[dict] | None = None, tender_hash: str | None = None) -> dict:
    """The signature covers whatever `body` is, so the account/address/tender fields are signed too and
    verify_mandate needs no change. A guest mandate (no account, no address, no tender) is byte-for-byte
    what it was before accounts existed: the extra keys are only added when they are supplied."""
    ct = cart(session_id)
    if not ct["items"]:
        raise ValueError("cart is empty")
    now = int(time.time())
    body = {
        "type": "IntentMandate", "spec": "AP2/UCP-style (demo)", "mandate_id": "mdt_" + uuid.uuid4().hex[:12],
        "session_id": session_id, "merchant": merchant, "currency": "USD",
        "spend_cap": round(float(spend_cap), 2), "cart_total": ct["total"], "cart_hash": cart_hash(ct),
        "line_count": len(ct["items"]), "created_at": now, "expires_at": now + MANDATE_TTL_S,
        "requires": "human_present_approval", "payment_executed": False,
    }
    if tender:
        from . import storefront  # local: storefront imports commerce
        legs = [{"pm_id": t["pm_id"], "amount": round(float(t["amount"]), 2)} for t in tender]
        computed = storefront.tender_hash(legs)
        if tender_hash and tender_hash != computed:
            raise ValueError("tender_hash does not match the tender in this request")
        body["tender"] = [{k: t.get(k) for k in ("pm_id", "kind", "brand", "last4", "amount", "covers", "label")}
                          for t in tender]
        body["tender_hash"] = computed
        body["tender_total"] = round(sum(l["amount"] for l in legs), 2)
        body["payment_note"] = ("Naming a tender authorises a simulated authorisation only. "
                                "No payment is ever executed.")
    if account_id:
        body["account_id"] = account_id
    if address_id:
        body["address_id"] = address_id
    body["within_cap"] = ct["total"] <= body["spend_cap"]
    sig = {"alg": "HMAC-SHA256", "kid": "demo-key-1", "value": sign(body)}
    with connect() as c:
        c.execute("INSERT INTO mandates VALUES(?,?,?,?,?,NULL)",
                  (body["mandate_id"], session_id, json.dumps({"mandate": body, "signature": sig}), "pending_human_approval", now))
    return {"mandate": body, "signature": sig, "status": "pending_human_approval"}


def verify_mandate(mandate: dict, signature: dict) -> bool:
    return hmac.compare_digest(sign(mandate), signature.get("value", ""))


def get_mandate(mandate_id: str) -> dict | None:
    with connect() as c:
        r = c.execute("SELECT * FROM mandates WHERE mandate_id=?", (mandate_id,)).fetchone()
    if not r:
        return None
    d = json.loads(r["body"])
    d.update(status=r["status"], decided_at=r["decided_at"])
    return d


def approve_mandate(mandate_id: str, approved: bool) -> dict:
    """Called by UI/BFF only (NOT an MCP tool). Records a human decision; still never pays."""
    m = get_mandate(mandate_id)
    if not m:
        raise ValueError("unknown mandate")
    if m["status"] != "pending_human_approval":
        return {**m, "note": "already decided"}
    checks = {"signature_valid": verify_mandate(m["mandate"], m["signature"]),
              "not_expired": time.time() < m["mandate"]["expires_at"],
              "cart_unchanged": cart_hash(cart(m["mandate"]["session_id"])) == m["mandate"]["cart_hash"]}
    if approved and not all(checks.values()):
        status = "rejected_invalid"
    else:
        status = "approved" if approved else "rejected"
    with connect() as c:
        c.execute("UPDATE mandates SET status=?, decided_at=? WHERE mandate_id=?", (status, time.time(), mandate_id))
    return {**get_mandate(mandate_id), "checks": checks, "payment_executed": False,
            "note": "Demo: approval is recorded only; no payment is ever executed."}


# ======================= simulated authorisation (never executes a payment) =======================
AUTHORIZABLE_STATUSES = ("approved", "payment_declined", "payment_step_up_required")


def _set_status(mandate_id: str, status: str) -> None:
    with connect() as c:
        c.execute("UPDATE mandates SET status=? WHERE mandate_id=?", (status, mandate_id))


def latest_attempt(mandate_id: str) -> dict | None:
    with connect() as c:
        r = c.execute("SELECT * FROM payment_attempts WHERE mandate_id=? ORDER BY created_at DESC LIMIT 1",
                      (mandate_id,)).fetchone()
    return dict(r) if r else None


def attempts(mandate_id: str) -> list[dict]:
    with connect() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM payment_attempts WHERE mandate_id=? ORDER BY created_at", (mandate_id,))]


def _record_attempt(m_body: dict, result: dict, step_up_id: str | None = None) -> str:
    """Audit row for a simulated authorisation. Nothing here can hold a card number."""
    attempt_id = "pat_" + uuid.uuid4().hex[:12]
    with connect() as c:
        c.execute("INSERT INTO payment_attempts(attempt_id,mandate_id,session_id,account_id,tender_hash,"
                  "amount,decision,reason,auth_ref,step_up_id,detail,created_at)"
                  " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                  (attempt_id, m_body["mandate_id"], m_body["session_id"], m_body.get("account_id"),
                   m_body.get("tender_hash"), result.get("amount"), result["decision"], result.get("reason"),
                   result.get("auth_ref"), step_up_id,
                   json.dumps({"tender": result.get("tender"), "payment_executed": False}), time.time()))
    return attempt_id


def authorize(mandate_id: str) -> dict:
    """Run the four mandate checks, then a simulated authorisation. payment_executed is always False."""
    m = get_mandate(mandate_id)
    if not m:
        raise LookupError("unknown mandate")
    body, sig = m["mandate"], m["signature"]
    tender = body.get("tender") or []
    if not tender:
        raise ValueError("this mandate names no payment tender, so there is nothing to authorise")
    if m["status"] not in AUTHORIZABLE_STATUSES:
        raise ValueError(f"mandate status is {m['status']}; a human-approved mandate is required")
    from . import accounts, storefront  # local: storefront imports commerce

    ct = cart(body["session_id"])
    amount = round(sum(round(float(t["amount"]), 2) for t in tender), 2)
    pm_ids = [t["pm_id"] for t in tender]
    checks = {
        "signature_valid": verify_mandate(body, sig),
        "not_expired": time.time() < body["expires_at"],
        "cart_unchanged": cart_hash(ct) == body["cart_hash"],
        "tender_unchanged": storefront.tender_hash(
            [{"pm_id": t["pm_id"], "amount": round(float(t["amount"]), 2)} for t in tender]) == body.get("tender_hash"),
        "within_spend_cap": amount <= body["spend_cap"] + 0.004,
        "amount_matches_cart_total": abs(amount - ct["total"]) < 0.005,
    }
    base = {"mandate_id": mandate_id, "amount": amount, "checks": checks, "payment_executed": False,
            "synthetic_label": payments.SYNTHETIC_LABEL}
    if not all(checks.values()):
        failed = [k for k, v in checks.items() if not v]
        result = {**base, "decision": "refused", "reason": failed[0], "failed_checks": failed,
                  "tender": tender, "amount": amount,
                  "message": "No simulated authorisation was attempted: " + ", ".join(failed) + "."}
        _record_attempt(body, result)
        return {**result, "status": m["status"]}

    legs = accounts.resolve_tender(pm_ids, body.get("account_id"))
    by_id = {t["pm_id"]: round(float(t["amount"]), 2) for t in tender}
    for leg in legs:
        leg["amount"] = by_id[leg["pm_id"]]
    preview_gate = None
    try:
        preview_gate = storefront.tender_eligibility_gate(
            storefront.tender_preview(body["session_id"], pm_ids))
    except (ValueError, LookupError):
        preview_gate = None
    result = payments.authorize(body, legs, ct["items"], preview_gate)
    result = {**base, **result, "checks": checks, "payment_executed": False}

    step_up_id = None
    if result["decision"] == "step_up_required":
        su = result["step_up"]
        step_up_id = su["step_up_id"]
        with connect() as c:
            c.execute("INSERT INTO step_ups VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                      (step_up_id, body["session_id"], mandate_id, su["pm_id"], su["amount"], su["code"],
                       0, su["max_attempts"], su["expires_at"], "pending", time.time()))
        _set_status(mandate_id, "payment_step_up_required")
    elif result["decision"] in ("declined", "refused"):
        _set_status(mandate_id, "payment_declined")
    _record_attempt(body, result, step_up_id)
    return {**result, "status": get_mandate(mandate_id)["status"]}


def get_step_up(step_up_id: str) -> dict | None:
    with connect() as c:
        r = c.execute("SELECT * FROM step_ups WHERE step_up_id=?", (step_up_id,)).fetchone()
    return dict(r) if r else None


def _step_up_view(r: dict) -> dict:
    return {"step_up_id": r["step_up_id"], "session_id": r["session_id"], "mandate_id": r["mandate_id"],
            "pm_id": r["pm_id"], "amount": r["amount"], "attempts": r["attempts"],
            "max_attempts": r["max_attempts"], "attempts_remaining": max(0, r["max_attempts"] - r["attempts"]),
            "expires_at": r["expires_at"], "status": r["status"], "payment_executed": False,
            "synthetic_label": payments.SYNTHETIC_LABEL}


def verify_step_up(ref: str, code: str) -> dict:
    """`ref` is a step_up_id, or a session_id whose newest pending step-up is used."""
    with connect() as c:
        r = c.execute("SELECT * FROM step_ups WHERE step_up_id=?", (ref,)).fetchone()
        if not r:
            r = c.execute("SELECT * FROM step_ups WHERE session_id=? AND status='pending'"
                          " ORDER BY created_at DESC LIMIT 1", (ref,)).fetchone()
        if not r:
            raise LookupError(f"no pending verification step for {ref}")
        r = dict(r)
        if r["status"] != "pending":
            return {**_step_up_view(r), "verified": False,
                    "message": f"this verification step is already {r['status']}"}
        if time.time() > r["expires_at"]:
            c.execute("UPDATE step_ups SET status='expired' WHERE step_up_id=?", (r["step_up_id"],))
            r["status"] = "expired"
            return {**_step_up_view(r), "verified": False,
                    "message": "The verification step expired, so the simulated authorisation was not completed. "
                               "Start a new one."}
        if str(code or "").strip() != r["code"]:
            r["attempts"] += 1
            r["status"] = "locked" if r["attempts"] >= r["max_attempts"] else "pending"
            c.execute("UPDATE step_ups SET attempts=?, status=? WHERE step_up_id=?",
                      (r["attempts"], r["status"], r["step_up_id"]))
            return {**_step_up_view(r), "verified": False,
                    "message": ("That code is not correct and this verification step is now locked; "
                                "no simulated authorisation was completed."
                                if r["status"] == "locked" else
                                f"That code is not correct. "
                                f"{r['max_attempts'] - r['attempts']} attempt(s) remaining.")}
        c.execute("UPDATE step_ups SET status='verified' WHERE step_up_id=?", (r["step_up_id"],))
        r["status"] = "verified"
    m = get_mandate(r["mandate_id"])
    body = m["mandate"]
    amount = round(sum(round(float(t["amount"]), 2) for t in body.get("tender") or []), 2)
    result = {"mandate_id": body["mandate_id"], "decision": "approved", "reason": None,
              "amount": amount, "tender": body.get("tender"),
              "auth_ref": payments.auth_ref(body["mandate_id"], [t["pm_id"] for t in body.get("tender") or []], amount),
              "payment_executed": False,
              "message": "Verification accepted. Simulated authorisation succeeded; no payment was executed.",
              "synthetic_label": payments.SYNTHETIC_LABEL}
    _set_status(body["mandate_id"], "approved")
    _record_attempt(body, result, r["step_up_id"])
    return {**_step_up_view(r), "verified": True, "authorisation": result, "payment_executed": False}
