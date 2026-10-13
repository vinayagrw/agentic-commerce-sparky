"""Shared helpers for the B16 accounts/wallet/authorisation specs."""
from __future__ import annotations

import sqlite3

from shop_mcp import accounts, commerce, storefront
from shop_mcp.db import db_path

STORE = "4108"


def bind(sid: str, aid: str | None):
    accounts.ensure_seeded()
    return accounts.set_session_account(sid, aid)


def fill_cart(sid: str, *items):
    for pid, qty in items:
        commerce.add(sid, pid, qty)
    return commerce.cart(sid)


def preview(sid: str, pm_ids, store_id: str = STORE):
    return storefront.tender_preview(sid, list(pm_ids), store_id)


def signed_mandate(sid: str, pv: dict, spend_cap: float = 500.0, address_id: str | None = None):
    return commerce.create_mandate(sid, spend_cap, "demo-store.example", pv["account_id"], address_id,
                                   pv["plan"], pv["tender_hash"])


def approved_mandate(sid: str, pv: dict, spend_cap: float = 500.0, address_id: str | None = None):
    m = signed_mandate(sid, pv, spend_cap, address_id)
    commerce.approve_mandate(m["mandate"]["mandate_id"], True)
    return m["mandate"]["mandate_id"]


def resign(mandate_id: str, mutate):
    """Re-sign a mandate after mutating its body, so a spec can isolate ONE failing check."""
    import json

    with commerce.connect() as c:
        row = c.execute("SELECT body FROM mandates WHERE mandate_id=?", (mandate_id,)).fetchone()
        d = json.loads(row["body"])
        mutate(d["mandate"])
        d["signature"]["value"] = commerce.sign(d["mandate"])
        c.execute("UPDATE mandates SET body=? WHERE mandate_id=?", (json.dumps(d), mandate_id))


def all_db_text() -> str:
    """Every value in every row of every table, as one blob, for the no-PAN scan."""
    conn = sqlite3.connect(db_path())
    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    out = []
    for t in tables:
        for row in conn.execute(f"SELECT * FROM {t}"):
            out.append(" ".join("" if v is None else str(v) for v in row))
    conn.close()
    return "\n".join(out)


def column_names() -> dict[str, list[str]]:
    conn = sqlite3.connect(db_path())
    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    out = {t: [r[1] for r in conn.execute(f"PRAGMA table_info({t})")] for t in tables}
    conn.close()
    return out
