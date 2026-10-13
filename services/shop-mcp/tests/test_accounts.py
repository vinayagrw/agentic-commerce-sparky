"""Seeding, the exactly-one-default invariant, and guest."""
from __future__ import annotations

import json

import pytest

from shop_mcp import accounts
from shop_mcp.db import ROOT, connect

PERSONAS = ("acct_maya", "acct_dev", "acct_rosa")


def test_seeding_is_idempotent_and_preserves_operator_edits():
    first = accounts.ensure_seeded()
    assert set(first["seeded"]["accounts"]) == set(PERSONAS)
    accounts.update_payment_method("acct_rosa", "pm_rosa_ebt", nickname="edited by an operator", balance=99.0)
    second = accounts.ensure_seeded()
    assert second["seeded"] == {"accounts": [], "payment_methods": [], "addresses": []}
    pm = accounts.get_payment_method("pm_rosa_ebt")
    assert pm["balance"] == 99.0 and "edited by an operator" in pm["label"]
    assert len(accounts.list_accounts()["accounts"]) == 3


def test_personas_carry_prefs_for_the_bff():
    accounts.ensure_seeded()
    assert accounts.prefs("acct_rosa")["household_size"] == 5
    assert accounts.prefs("acct_maya")["dietary"] == ["gluten_free"]
    assert accounts.prefs("acct_dev")["store_id"] == "2231"
    for aid in PERSONAS:
        assert set(accounts.prefs(aid)) == {"dietary", "brands", "store_id", "household_size"}
    assert accounts.prefs(None) == {}


def test_guest_has_no_account():
    accounts.ensure_seeded()
    g = accounts.get_session_account("s_guest")
    assert g["account_id"] is None and g["account"]["is_guest"] is True
    assert g["account"]["payment_methods"] == [] and g["account"]["addresses"] == []
    assert "guest" not in {p["account_id"] for p in json.loads(
        (ROOT / "data" / "personas.json").read_text())["personas"]}


def test_session_binding_round_trip():
    accounts.ensure_seeded()
    assert accounts.set_session_account("s1", "acct_maya")["account_id"] == "acct_maya"
    assert accounts.get_session_account("s1")["account"]["name"] == "Maya Alvarez"
    assert accounts.set_session_account("s1", None)["account_id"] is None
    with pytest.raises(LookupError):
        accounts.set_session_account("s1", "acct_nope")


def test_unknown_account_raises_lookup_error():
    accounts.ensure_seeded()
    for call in (lambda: accounts.get_account("acct_nope"),
                 lambda: accounts.payment_methods("acct_nope"),
                 lambda: accounts.addresses("acct_nope"),
                 lambda: accounts.add_payment_method("acct_nope", "gift", balance=5.0),
                 lambda: accounts.get_payment_method("pm_nope"),
                 lambda: accounts.get_address("adr_nope"),
                 lambda: accounts.delete_payment_method("acct_maya", "pm_nope"),
                 lambda: accounts.delete_address("acct_maya", "adr_nope")):
        with pytest.raises(LookupError):
            call()


def _defaults(aid, table, idcol):
    with connect() as c:
        return [r[idcol] for r in c.execute(
            f"SELECT {idcol} FROM {table} WHERE account_id=? AND is_default=1", (aid,))]


def test_exactly_one_default_payment_method_and_address():
    accounts.ensure_seeded()
    for aid in PERSONAS:
        assert len(_defaults(aid, "payment_methods", "pm_id")) == 1
        assert len(_defaults(aid, "addresses", "address_id")) == 1
    assert _defaults("acct_maya", "payment_methods", "pm_id") == ["pm_maya_visa"]
    accounts.set_default_payment_method("acct_maya", "pm_maya_gift")
    assert _defaults("acct_maya", "payment_methods", "pm_id") == ["pm_maya_gift"]
    # Adding a method with is_default moves the flag rather than adding a second one.
    accounts.add_payment_method("acct_maya", "gift", balance=10.0, is_default=True)
    assert len(_defaults("acct_maya", "payment_methods", "pm_id")) == 1


def test_deleting_the_default_promotes_another():
    accounts.ensure_seeded()
    assert accounts.get_payment_method("pm_dev_stepup")["is_default"] is True
    accounts.delete_payment_method("acct_dev", "pm_dev_stepup")
    promoted = _defaults("acct_dev", "payment_methods", "pm_id")
    assert len(promoted) == 1 and promoted[0] in ("pm_dev_declined", "pm_dev_expired")
    # Deleting the last one leaves no default to promote, and that is not an error.
    for pm in list(p["pm_id"] for p in accounts.payment_methods("acct_dev")["payment_methods"]):
        accounts.delete_payment_method("acct_dev", pm)
    assert accounts.payment_methods("acct_dev")["payment_methods"] == []
    assert _defaults("acct_dev", "payment_methods", "pm_id") == []


def test_deleting_the_default_address_promotes_another():
    accounts.ensure_seeded()
    accounts.add_address("acct_maya", {"line1": "9 Second St", "city": "Bentonville", "region": "AR"})
    assert _defaults("acct_maya", "addresses", "address_id") == ["adr_maya_home"]
    accounts.delete_address("acct_maya", "adr_maya_home")
    assert len(_defaults("acct_maya", "addresses", "address_id")) == 1


def test_first_instrument_and_first_address_become_the_default():
    accounts.ensure_seeded()
    with connect() as c:
        c.execute("DELETE FROM payment_methods WHERE account_id='acct_maya'")
    added = accounts.add_payment_method("acct_maya", "gift", balance=7.5, nickname="only one")
    assert added["payment_method"]["is_default"] is True


def test_balance_can_only_be_set_on_a_demo_tender():
    accounts.ensure_seeded()
    with pytest.raises(ValueError):
        accounts.update_payment_method("acct_maya", "pm_maya_visa", balance=100.0)
    with pytest.raises(ValueError):
        accounts.add_payment_method("acct_maya", "gift")  # a gift needs a balance
    with pytest.raises(ValueError):
        accounts.add_payment_method("acct_maya", "cheque", balance=1.0)


def test_a_deleted_seed_row_is_restored_on_the_next_process(monkeypatch):
    """Seeding must repair, not just initialise.

    ensure_seeded_once() used to return early whenever ANY account row existed, so an instrument
    deleted through the API — a spec tidying up, an operator clicking Remove — was gone permanently:
    the only recovery was deleting data/commerce.db, and with it every real order in it. Seeding is
    per-id idempotent, so running it each process repairs the gap and still never overwrites a row
    that exists.
    """
    accounts.ensure_seeded()
    before = {p["pm_id"] for p in accounts.get_account("acct_maya")["payment_methods"]}
    assert "pm_maya_gift" in before

    accounts.delete_payment_method("acct_maya", "pm_maya_gift")
    assert "pm_maya_gift" not in {p["pm_id"] for p in accounts.get_account("acct_maya")["payment_methods"]}

    # A fresh process: the in-process "already seeded" flag is clear, the database is not empty.
    monkeypatch.setattr(accounts, "_seeded", False)
    accounts.ensure_seeded_once()

    restored = accounts.get_account("acct_maya")["payment_methods"]
    assert "pm_maya_gift" in {p["pm_id"] for p in restored}, "the seeded instrument was not repaired"
    gift = next(p for p in restored if p["pm_id"] == "pm_maya_gift")
    assert gift["kind"] == "gift" and gift["balance"] == 25.0
    assert sum(1 for p in restored if p["is_default"]) == 1, "repair must not create a second default"


def test_seeding_never_overwrites_an_edited_row():
    """Operator edits to a row that still exists survive re-seeding."""
    accounts.ensure_seeded()
    accounts.update_payment_method("acct_maya", "pm_maya_visa", nickname="Renamed by the operator")
    accounts.ensure_seeded()
    pm = next(p for p in accounts.get_account("acct_maya")["payment_methods"] if p["pm_id"] == "pm_maya_visa")
    assert "Renamed by the operator" in (pm.get("label") or "") + (pm.get("nickname") or "")
