"""The frozen allowlist, the no-card-number invariant, and the deterministic decision branches."""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from shop_mcp import accounts, commerce, http_app, payments

from _flow import all_db_text, approved_mandate, bind, fill_cart, preview

PUBLISHED = {
    "4242424242424242": ("visa", "approved"),
    "5555555555554444": ("mastercard", "approved"),
    "378282246310005": ("amex", "approved"),
    "4000000000000002": ("visa", "declined"),
    "4000000000009995": ("visa", "insufficient_funds"),
    "4000000000003220": ("visa", "step_up"),
    "4000000000000069": ("visa", "expired"),
}
# Luhn-valid, widely used as an example, and deliberately NOT in the allowlist.
NOT_ALLOWED = "4111111111111111"


def _luhn(number: str) -> bool:
    total, even = 0, False
    for ch in reversed(number):
        d = int(ch)
        if even:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        even = not even
    return total % 10 == 0


def test_allowlist_is_exactly_the_published_set():
    assert set(payments.TEST_CARDS) == set(PUBLISHED)
    for num, (brand, outcome) in PUBLISHED.items():
        prof = payments.CARD_PROFILES[payments.TEST_CARDS[num]]
        assert (prof["brand"], prof["outcome"]) == (brand, outcome)
        assert prof["last4"] == num[-4:]  # last4 comes from the constant and happens to agree
    assert payments.CARD_PROFILES["visa_debit_insufficient"]["balance"] == 25.00


def test_ebt_and_gift_are_not_described_as_published_test_cards():
    for t in payments.DEMO_TENDERS.values():
        assert "not a published test instrument" in t["label"]
        assert "defined by this environment" in t["label"]
        assert "not issued by anyone" in t["label"]
        assert t["last4"] is None and t["brand"] is None
    assert set(payments.DEMO_TENDERS) & set(payments.TEST_CARDS.values()) == set()


def test_luhn_valid_non_test_number_is_rejected():
    assert _luhn(NOT_ALLOWED) and NOT_ALLOWED not in payments.TEST_CARDS
    with pytest.raises(payments.UnknownTestCard) as ei:
        payments.lookup_card(NOT_ALLOWED)
    assert NOT_ALLOWED not in str(ei.value)
    assert {c["number"] for c in ei.value.accepted} == set(PUBLISHED)


def test_rejected_digits_appear_in_no_response_row_audit_or_exception():
    accounts.ensure_seeded()
    client = TestClient(http_app.app)
    r = client.post("/accounts/acct_maya/payment-methods",
                    json={"kind": "credit", "number": NOT_ALLOWED, "nickname": "nope"})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert set(detail) == {"error", "accepted"}
    assert NOT_ALLOWED not in r.text
    assert NOT_ALLOWED not in detail["error"]
    # Nothing was stored, and the digits are in no row of any table (audit included).
    assert NOT_ALLOWED not in all_db_text()
    assert len(accounts.payment_methods("acct_maya")["payment_methods"]) == 2
    # The same holds for the direct (non-HTTP) path, whose exception message is also clean.
    try:
        accounts.add_payment_method("acct_maya", "credit", NOT_ALLOWED)
    except payments.UnknownTestCard as e:
        assert NOT_ALLOWED not in repr(e)
        assert NOT_ALLOWED not in str(e.accepted)
    else:
        raise AssertionError("expected UnknownTestCard")
    assert NOT_ALLOWED not in all_db_text()


def test_accepted_number_is_looked_up_and_discarded():
    accounts.ensure_seeded()
    client = TestClient(http_app.app)
    r = client.post("/accounts/acct_maya/payment-methods",
                    json={"kind": "credit", "number": "5555555555554444", "nickname": "second card"})
    assert r.status_code == 200, r.text
    pm = r.json()["payment_method"]
    assert (pm["brand"], pm["last4"], pm["outcome"]) == ("mastercard", "4444", "approved")
    assert "5555555555554444" not in r.text          # not echoed back
    assert "5555555555554444" not in all_db_text()   # not stored anywhere, audit included
    assert pm["token"] == payments.token_for(pm["pm_id"])  # token derives from the pm_id alone


def test_no_table_has_a_card_number_column():
    from _flow import column_names

    for table, cols in column_names().items():
        for col in cols:
            assert col.lower() not in ("pan", "card_number", "cardnumber", "number", "card"), (table, col)


# ------------------------------------------------------------------ auth_ref determinism
def test_auth_ref_is_deterministic_and_mandate_scoped():
    a = payments.auth_ref("mdt_1", ["pm_a", "pm_b"], 15.86)
    assert a == payments.auth_ref("mdt_1", ["pm_a", "pm_b"], 15.86)
    assert a == payments.auth_ref("mdt_1", ["pm_b", "pm_a"], 15.86)  # order-independent
    assert a != payments.auth_ref("mdt_2", ["pm_a", "pm_b"], 15.86)
    assert a != payments.auth_ref("mdt_1", ["pm_a"], 15.86)
    assert a != payments.auth_ref("mdt_1", ["pm_a", "pm_b"], 15.87)
    assert a.startswith("auth_") and len(a) == 15


def _mandate(mid="mdt_x", expires_in=600):
    return {"mandate_id": mid, "expires_at": int(time.time()) + expires_in}


def _leg(pm_id, outcome, amount, balance=None, kind="credit"):
    return {"pm_id": pm_id, "kind": kind, "brand": "visa", "last4": "0000", "outcome": outcome,
            "balance": balance, "amount": amount, "label": "demo"}


def test_insufficient_funds_boundary_is_decided_by_the_amount():
    m = _mandate()
    at = payments.authorize(m, [_leg("pm_d", "insufficient_funds", 25.00, 25.00, "debit")])
    assert at["decision"] == "approved" and at["auth_ref"] and at["payment_executed"] is False
    over = payments.authorize(m, [_leg("pm_d", "insufficient_funds", 25.01, 25.00, "debit")])
    assert over["decision"] == "declined" and over["reason"] == "insufficient_funds"
    assert over["payment_executed"] is False and "auth_ref" not in over


def test_declined_and_expired_branches():
    m = _mandate()
    d = payments.authorize(m, [_leg("pm_x", "declined", 5.0)])
    assert d["decision"] == "declined" and d["reason"] == "declined"
    e = payments.authorize(m, [_leg("pm_y", "expired", 5.0)])
    assert e["decision"] == "refused" and e["reason"] == "expired"
    for r in (d, e):
        assert r["payment_executed"] is False


def test_step_up_expiry_is_capped_by_the_mandate():
    short = payments.authorize(_mandate(expires_in=30), [_leg("pm_s", "step_up", 5.0)])
    assert short["decision"] == "step_up_required"
    assert short["step_up"]["expires_at"] <= int(time.time()) + 30
    long = payments.authorize(_mandate(expires_in=9999), [_leg("pm_s", "step_up", 5.0)])
    assert long["step_up"]["expires_at"] <= int(time.time()) + payments.STEP_UP_TTL_S


# ------------------------------------------------------------------ step-up, end to end
def _step_up_session(sid="s_step"):
    bind(sid, "acct_dev")
    fill_cart(sid, ("W-900011", 1))
    pv = preview(sid, ["pm_dev_stepup"])
    mid = approved_mandate(sid, pv)
    out = commerce.authorize(mid)
    assert out["decision"] == "step_up_required" and out["payment_executed"] is False
    assert commerce.get_mandate(mid)["status"] == "payment_step_up_required"
    return mid, out["step_up"]["step_up_id"]


def test_step_up_wrong_code_then_correct_code():
    mid, su = _step_up_session()
    bad = commerce.verify_step_up(su, "123456")
    assert bad["verified"] is False and bad["attempts"] == 1 and bad["attempts_remaining"] == 2
    ok = commerce.verify_step_up(su, payments.STEP_UP_CODE)
    assert ok["verified"] is True and ok["authorisation"]["decision"] == "approved"
    assert ok["authorisation"]["auth_ref"] and ok["payment_executed"] is False
    assert commerce.get_mandate(mid)["status"] == "approved"


def test_step_up_locks_after_three_attempts():
    _mid, su = _step_up_session("s_lock")
    for n in (1, 2):
        assert commerce.verify_step_up(su, "000001")["attempts"] == n
    third = commerce.verify_step_up(su, "000001")
    assert third["status"] == "locked" and third["attempts"] == 3
    after = commerce.verify_step_up(su, payments.STEP_UP_CODE)
    assert after["verified"] is False and "locked" in after["message"]


def test_step_up_expires():
    _mid, su = _step_up_session("s_exp")
    with commerce.connect() as c:
        c.execute("UPDATE step_ups SET expires_at=? WHERE step_up_id=?", (time.time() - 1, su))
    out = commerce.verify_step_up(su, payments.STEP_UP_CODE)
    assert out["verified"] is False and out["status"] == "expired" and "expired" in out["message"]


def test_unknown_step_up_raises_lookup_error():
    with pytest.raises(LookupError):
        commerce.verify_step_up("stp_nope", payments.STEP_UP_CODE)
