"""Synthetic shopper accounts: wallet (payment methods), addresses, preferences, session binding.

Nothing here can hold a card number. `add_payment_method` takes a `number`, hands it to
`payments.lookup_card` and discards it in the same expression; every stored field (brand, last4,
kind, outcome, balance, token) comes from the frozen `payments.CARD_PROFILES` constant. The digits
never reach a DB row, a response, the audit table, a log line or an exception message.

`guest` is not a persona: a session with no `session_account` row simply has no account, which is
what keeps the guest checkout path byte-identical to the pre-accounts behaviour.
"""
from __future__ import annotations

import json
import time
import uuid

from . import payments
from .db import ROOT, connect

PERSONAS_FILE = ROOT / "data" / "personas.json"
SYNTHETIC_LABEL = "synthetic demo shopper account - not a real person and not a real balance (demo)"
GUEST = {"account_id": None, "name": "Guest", "is_guest": True,
         "note": "Guest sessions have no account, no stored wallet and no saved address.",
         "prefs": {}, "payment_methods": [], "addresses": [], "synthetic_label": SYNTHETIC_LABEL}
_PREF_KEYS = ("dietary", "brands", "store_id", "household_size")


def _now() -> float:
    return time.time()


def _audit(c, kind: str, detail: dict) -> None:
    c.execute("INSERT INTO audit VALUES(?,?,?)", (_now(), kind, json.dumps(detail)))


# ------------------------------------------------------------------ seeding
def load_personas() -> dict:
    return json.loads(PERSONAS_FILE.read_text())


def ensure_seeded() -> dict:
    """Idempotent. Inserts only ids that are absent, so operator edits to seeded rows survive."""
    data = load_personas()
    inserted = {"accounts": [], "payment_methods": [], "addresses": []}
    with connect() as c:
        for p in data.get("personas", []):
            aid = p["account_id"]
            if not c.execute("SELECT 1 FROM accounts WHERE account_id=?", (aid,)).fetchone():
                prefs = {k: p.get("prefs", {}).get(k) for k in _PREF_KEYS}
                c.execute("INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?)",
                          (aid, p.get("name"), p.get("email"), json.dumps(prefs), p.get("label") or SYNTHETIC_LABEL,
                           1, _now(), _now()))
                inserted["accounts"].append(aid)
            for pm in p.get("payment_methods", []):
                if c.execute("SELECT 1 FROM payment_methods WHERE pm_id=?", (pm["pm_id"],)).fetchone():
                    continue
                _insert_pm(c, aid, pm["pm_id"], _seed_pm_fields(pm), pm.get("is_default", False),
                           pm.get("nickname"))
                inserted["payment_methods"].append(pm["pm_id"])
            for ad in p.get("addresses", []):
                if c.execute("SELECT 1 FROM addresses WHERE address_id=?", (ad["address_id"],)).fetchone():
                    continue
                _insert_address(c, aid, ad["address_id"], ad, ad.get("is_default", False))
                inserted["addresses"].append(ad["address_id"])
            _fix_default(c, "payment_methods", "pm_id", aid)
            _fix_default(c, "addresses", "address_id", aid)
    return {"seeded": inserted, "accounts": [a["account_id"] for a in list_accounts()["accounts"]],
            "source": "data/personas.json", "synthetic_label": SYNTHETIC_LABEL}


def _seed_pm_fields(pm: dict) -> dict:
    """Resolve a seed entry to stored fields. Cards are named by PROFILE ID, never by number."""
    if pm.get("profile"):
        prof = payments.CARD_PROFILES.get(pm["profile"])
        if prof is None:
            raise ValueError(f"unknown card profile {pm['profile']!r} in data/personas.json")
        return {**prof, "label": payments.CARD_LABEL}
    kind = pm.get("kind")
    tender = payments.DEMO_TENDERS.get(kind)
    if tender is None:
        raise ValueError(f"payment method must name a card profile or one of {payments.TENDER_KINDS}")
    if pm.get("balance") is None:
        raise ValueError(f"{kind} requires a balance")
    return {"kind": kind, "brand": None, "last4": None, "outcome": tender["outcome"],
            "balance": round(float(pm["balance"]), 2), "exp_month": None, "exp_year": None,
            "label": payments.TENDER_LABEL}


# ------------------------------------------------------------------ default invariant
def _fix_default(c, table: str, idcol: str, account_id: str) -> None:
    """Invariant: an account with at least one row has exactly one default."""
    rows = c.execute(f"SELECT {idcol} AS id, is_default FROM {table} WHERE account_id=? ORDER BY created_at, {idcol}",
                     (account_id,)).fetchall()
    if not rows:
        return
    defaults = [r["id"] for r in rows if r["is_default"]]
    keep = defaults[0] if defaults else rows[0]["id"]
    c.execute(f"UPDATE {table} SET is_default=0 WHERE account_id=? AND {idcol}<>?", (account_id, keep))
    c.execute(f"UPDATE {table} SET is_default=1 WHERE {idcol}=?", (keep,))


# ------------------------------------------------------------------ accounts
def _account_row(c, aid: str):
    r = c.execute("SELECT * FROM accounts WHERE account_id=?", (aid,)).fetchone()
    if not r:
        raise LookupError(f"unknown account {aid}")
    return r


def _account(c, r) -> dict:
    aid = r["account_id"]
    return {"account_id": aid, "name": r["name"], "email": r["email"],
            "prefs": json.loads(r["prefs"] or "{}"), "label": r["label"], "is_guest": False,
            "payment_methods": [_pm(x) for x in c.execute(
                "SELECT * FROM payment_methods WHERE account_id=? ORDER BY is_default DESC, created_at, pm_id", (aid,))],
            "addresses": [_address(x) for x in c.execute(
                "SELECT * FROM addresses WHERE account_id=? ORDER BY is_default DESC, created_at, address_id", (aid,))],
            "synthetic": bool(r["synthetic"]), "synthetic_label": SYNTHETIC_LABEL}


def list_accounts() -> dict:
    ensure_seeded_once()
    with connect() as c:
        rows = c.execute("SELECT * FROM accounts ORDER BY account_id").fetchall()
        out = [_account(c, r) for r in rows]
    return {"accounts": out, "guest": GUEST, "synthetic_label": SYNTHETIC_LABEL}


_seeded = False


def ensure_seeded_once() -> None:
    """Seeds on first read per process; tests and operators can call ensure_seeded() directly.

    This used to return early when ANY account row existed, which made seeding a one-shot: a seeded
    instrument deleted through the API (a spec tidying up, an operator clicking Remove) was gone for
    good, with no repair short of deleting data/commerce.db and the 365 real orders in it. Since
    ensure_seeded() already checks each account, instrument and address id individually and inserts
    only what is absent, running it once per process instead restores missing seed rows on restart
    and still leaves operator edits to rows that DO exist untouched.
    """
    global _seeded
    if _seeded:
        return
    # Set the flag FIRST: ensure_seeded() finishes by calling list_accounts(), which re-enters this
    # function. Setting it afterwards recurses until the stack blows.
    _seeded = True
    try:
        ensure_seeded()
    except Exception:
        _seeded = False  # a failed seed must be retried, not silently remembered as done
        raise
    _seeded = True


def get_account(aid: str) -> dict:
    ensure_seeded_once()
    with connect() as c:
        return _account(c, _account_row(c, aid))


def prefs(aid: str | None) -> dict:
    """Stored preferences, returned as-is for the BFF to apply. This module never applies them."""
    if not aid:
        return {}
    return get_account(aid)["prefs"]


# ------------------------------------------------------------------ session binding
def get_session_account(sid: str) -> dict:
    ensure_seeded_once()
    with connect() as c:
        r = c.execute("SELECT account_id FROM session_account WHERE session_id=?", (sid,)).fetchone()
        if not r or not r["account_id"]:
            return {"session_id": sid, "account_id": None, "account": GUEST}
        try:
            acct = _account(c, _account_row(c, r["account_id"]))
        except LookupError:
            return {"session_id": sid, "account_id": None, "account": GUEST,
                    "note": "the bound account no longer exists; this session is a guest"}
    return {"session_id": sid, "account_id": acct["account_id"], "account": acct}


def set_session_account(sid: str, account_id: str | None) -> dict:
    ensure_seeded_once()
    with connect() as c:
        if account_id:
            _account_row(c, account_id)
            c.execute("INSERT INTO session_account VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET"
                      " account_id=excluded.account_id, updated_at=excluded.updated_at", (sid, account_id, _now()))
        else:
            c.execute("DELETE FROM session_account WHERE session_id=?", (sid,))
    return get_session_account(sid)


# ------------------------------------------------------------------ payment methods
def _pm(r) -> dict:
    return {"pm_id": r["pm_id"], "account_id": r["account_id"], "kind": r["kind"], "brand": r["brand"],
            "last4": r["last4"], "exp_month": r["exp_month"], "exp_year": r["exp_year"], "token": r["token"],
            "outcome": r["outcome"], "balance": r["balance"], "label": r["label"],
            "is_default": bool(r["is_default"]), "display": _display(r),
            "synthetic": bool(r["synthetic"]), "synthetic_label": payments.SYNTHETIC_LABEL}


def _display(r) -> str:
    if r["kind"] in payments.TENDER_KINDS:
        base = payments.DEMO_TENDERS[r["kind"]]["display"]
        return f"{base} - ${float(r['balance'] or 0):.2f} available"
    return f"{(r['brand'] or 'card').title()} ending {r['last4']} (exp {r['exp_month']:02d}/{r['exp_year']})"


def _insert_pm(c, aid: str, pm_id: str, f: dict, is_default: bool, nickname: str | None) -> None:
    label = f["label"] + (f" - {nickname}" if nickname else "")
    c.execute("INSERT INTO payment_methods VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (pm_id, aid, f["kind"], f["brand"], f["last4"], f["exp_month"], f["exp_year"],
               payments.token_for(pm_id), f["outcome"], f["balance"], label, int(bool(is_default)), 1,
               _now(), _now()))
    # Audit rows carry the pm_id and the frozen last4 only - there is nothing else to carry.
    _audit(c, "wallet_add", {"account_id": aid, "pm_id": pm_id, "kind": f["kind"],
                             "brand": f["brand"], "last4": f["last4"], "outcome": f["outcome"]})


def payment_methods(aid: str) -> dict:
    acct = get_account(aid)
    return {"account_id": aid, "payment_methods": acct["payment_methods"],
            "synthetic_label": payments.SYNTHETIC_LABEL}


def add_payment_method(aid: str, kind: str, number=None, balance: float | None = None,
                       nickname: str | None = None, is_default: bool = False) -> dict:
    """`number` is looked up in the frozen allowlist and discarded here. It is never stored."""
    if kind not in payments.ALL_KINDS:
        raise ValueError(f"kind must be one of {payments.ALL_KINDS}")
    if kind in payments.CARD_KINDS:
        fields = payments.lookup_card(number)  # raises payments.UnknownTestCard; never echoes digits
        number = None
        del number
        if fields["kind"] != kind:
            raise ValueError(f"that test card is a {fields['kind']} card, not {kind}")
    else:
        if balance is None:
            raise ValueError(f"{kind} requires a balance")
        fields = _seed_pm_fields({"kind": kind, "balance": balance})
    pm_id = "pm_" + uuid.uuid4().hex[:12]
    with connect() as c:
        _account_row(c, aid)
        had = c.execute("SELECT 1 FROM payment_methods WHERE account_id=? LIMIT 1", (aid,)).fetchone()
        _insert_pm(c, aid, pm_id, fields, is_default or not had, nickname)
        if is_default or not had:
            c.execute("UPDATE payment_methods SET is_default=0 WHERE account_id=? AND pm_id<>?", (aid, pm_id))
        _fix_default(c, "payment_methods", "pm_id", aid)
    return {"payment_method": get_payment_method(pm_id), **payment_methods(aid)}


def get_payment_method(pm_id: str) -> dict:
    with connect() as c:
        r = c.execute("SELECT * FROM payment_methods WHERE pm_id=?", (pm_id,)).fetchone()
    if not r:
        raise LookupError(f"unknown payment method {pm_id}")
    return _pm(r)


def update_payment_method(aid: str, pm_id: str, nickname: str | None = None, balance: float | None = None,
                          is_default: bool | None = None) -> dict:
    """Nickname, demo balance and default flag only. There is nothing card-like to edit."""
    with connect() as c:
        r = c.execute("SELECT * FROM payment_methods WHERE pm_id=? AND account_id=?", (pm_id, aid)).fetchone()
        if not r:
            raise LookupError(f"unknown payment method {pm_id} for account {aid}")
        label = r["label"]
        if nickname is not None:
            base = (r["label"] or "").split(" - ")[0]
            label = f"{base} - {nickname}" if nickname else base
        bal = r["balance"]
        if balance is not None:
            if r["kind"] not in payments.TENDER_KINDS:
                raise ValueError("a balance can only be set on an ebt_snap or gift instrument")
            bal = round(float(balance), 2)
        c.execute("UPDATE payment_methods SET label=?, balance=?, updated_at=? WHERE pm_id=?",
                  (label, bal, _now(), pm_id))
        if is_default:
            c.execute("UPDATE payment_methods SET is_default=0 WHERE account_id=?", (aid,))
            c.execute("UPDATE payment_methods SET is_default=1 WHERE pm_id=?", (pm_id,))
        _fix_default(c, "payment_methods", "pm_id", aid)
    return {"payment_method": get_payment_method(pm_id), **payment_methods(aid)}


def set_default_payment_method(aid: str, pm_id: str) -> dict:
    return update_payment_method(aid, pm_id, is_default=True)


def delete_payment_method(aid: str, pm_id: str) -> dict:
    """Deleting the default promotes the next remaining instrument, so the invariant holds."""
    with connect() as c:
        r = c.execute("SELECT is_default FROM payment_methods WHERE pm_id=? AND account_id=?", (pm_id, aid)).fetchone()
        if not r:
            raise LookupError(f"unknown payment method {pm_id} for account {aid}")
        c.execute("DELETE FROM payment_methods WHERE pm_id=?", (pm_id,))
        _audit(c, "wallet_delete", {"account_id": aid, "pm_id": pm_id})
        _fix_default(c, "payment_methods", "pm_id", aid)
    return payment_methods(aid)


# ------------------------------------------------------------------ addresses
def _address(r) -> dict:
    return {"address_id": r["address_id"], "account_id": r["account_id"], "name": r["name"], "line1": r["line1"],
            "line2": r["line2"], "city": r["city"], "region": r["region"], "postal_code": r["postal_code"],
            "store_id": r["store_id"], "instructions": r["instructions"], "label": r["label"],
            "is_default": bool(r["is_default"]),
            "display": ", ".join(x for x in (r["line1"], r["line2"], r["city"], r["region"], r["postal_code"]) if x),
            "synthetic": bool(r["synthetic"]), "synthetic_label": SYNTHETIC_LABEL}


ADDRESS_LABEL = "synthetic demo address - not a real place (demo)"


def _insert_address(c, aid: str, address_id: str, a: dict, is_default: bool) -> None:
    if not a.get("line1"):
        raise ValueError("line1 required")
    c.execute("INSERT INTO addresses VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (address_id, aid, a.get("name"), a["line1"], a.get("line2"), a.get("city"), a.get("region"),
               a.get("postal_code"), a.get("store_id"), a.get("instructions"), ADDRESS_LABEL,
               int(bool(is_default)), 1, _now(), _now()))


def addresses(aid: str) -> dict:
    return {"account_id": aid, "addresses": get_account(aid)["addresses"], "synthetic_label": SYNTHETIC_LABEL}


def add_address(aid: str, body: dict) -> dict:
    address_id = "adr_" + uuid.uuid4().hex[:12]
    with connect() as c:
        _account_row(c, aid)
        had = c.execute("SELECT 1 FROM addresses WHERE account_id=? LIMIT 1", (aid,)).fetchone()
        want = bool(body.get("is_default")) or not had
        _insert_address(c, aid, address_id, body, want)
        if want:
            c.execute("UPDATE addresses SET is_default=0 WHERE account_id=? AND address_id<>?", (aid, address_id))
        _fix_default(c, "addresses", "address_id", aid)
    return {"address": get_address(address_id), **addresses(aid)}


def get_address(address_id: str) -> dict:
    with connect() as c:
        r = c.execute("SELECT * FROM addresses WHERE address_id=?", (address_id,)).fetchone()
    if not r:
        raise LookupError(f"unknown address {address_id}")
    return _address(r)


_ADDRESS_FIELDS = ("name", "line1", "line2", "city", "region", "postal_code", "store_id", "instructions")


def update_address(aid: str, address_id: str, body: dict) -> dict:
    with connect() as c:
        r = c.execute("SELECT * FROM addresses WHERE address_id=? AND account_id=?", (address_id, aid)).fetchone()
        if not r:
            raise LookupError(f"unknown address {address_id} for account {aid}")
        vals = {k: (body[k] if k in body and body[k] is not None else r[k]) for k in _ADDRESS_FIELDS}
        if not vals["line1"]:
            raise ValueError("line1 required")
        c.execute("UPDATE addresses SET " + ",".join(f"{k}=?" for k in _ADDRESS_FIELDS) +
                  ", updated_at=? WHERE address_id=?", (*[vals[k] for k in _ADDRESS_FIELDS], _now(), address_id))
        if body.get("is_default"):
            c.execute("UPDATE addresses SET is_default=0 WHERE account_id=?", (aid,))
            c.execute("UPDATE addresses SET is_default=1 WHERE address_id=?", (address_id,))
        _fix_default(c, "addresses", "address_id", aid)
    return {"address": get_address(address_id), **addresses(aid)}


def set_default_address(aid: str, address_id: str) -> dict:
    return update_address(aid, address_id, {"is_default": True})


def delete_address(aid: str, address_id: str) -> dict:
    with connect() as c:
        r = c.execute("SELECT 1 FROM addresses WHERE address_id=? AND account_id=?", (address_id, aid)).fetchone()
        if not r:
            raise LookupError(f"unknown address {address_id} for account {aid}")
        c.execute("DELETE FROM addresses WHERE address_id=?", (address_id,))
        _fix_default(c, "addresses", "address_id", aid)
    return addresses(aid)


# ------------------------------------------------------------------ tender resolution
def resolve_tender(pm_ids: list[str], account_id: str | None = None) -> list[dict]:
    """Resolve pm_ids to instruments in the order given. Amounts are decided by the tender planner."""
    out = []
    with connect() as c:
        for pm_id in pm_ids:
            r = c.execute("SELECT * FROM payment_methods WHERE pm_id=?", (pm_id,)).fetchone()
            if not r:
                raise LookupError(f"unknown payment method {pm_id}")
            if account_id and r["account_id"] != account_id:
                raise LookupError(f"payment method {pm_id} does not belong to account {account_id}")
            out.append({**_pm(r), "amount": 0.0})
    return out


def default_payment_method(aid: str) -> dict | None:
    return next((p for p in get_account(aid)["payment_methods"] if p["is_default"]), None)


def default_address(aid: str) -> dict | None:
    return next((a for a in get_account(aid)["addresses"] if a["is_default"]), None)
