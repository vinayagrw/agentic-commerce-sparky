"""Split tender maths, EBT refusals that quote the real eligibility rule, and the tender hash."""
from __future__ import annotations

import pytest

from shop_mcp import accounts, catalog_services as cs, commerce, storefront

from _flow import bind, fill_cart, preview

TORTILLAS = "W-900002"   # Grocery, SNAP eligible, 2.98
CHARGER = "W-200430"     # Electronics, NOT SNAP eligible, 12.88
BARS = "W-300140"        # Grocery, SNAP eligible, 4.18


def test_snap_split_maths():
    bind("s_split", "acct_rosa")
    fill_cart("s_split", (TORTILLAS, 1), (CHARGER, 1))
    pv = preview("s_split", ["pm_rosa_ebt", "pm_rosa_debit"])
    assert pv["total"] == 15.86 and pv["snap_subtotal"] == 2.98
    assert pv["ok"] is True and pv["split_tender"] is True
    assert [(p["pm_id"], p["amount"]) for p in pv["plan"]] == [("pm_rosa_ebt", 2.98), ("pm_rosa_debit", 12.88)]
    assert pv["covered_total"] == 15.86 and pv["uncovered"] == 0.0
    assert pv["split_tender_plan"] == [{"pm_id": "pm_rosa_ebt", "amount": 2.98, "covers": "SNAP-eligible lines"},
                                       {"pm_id": "pm_rosa_debit", "amount": 12.88,
                                        "covers": "remainder not covered by EBT"}]
    assert pv["payment_executed"] is False


def test_ebt_covers_at_most_its_balance():
    bind("s_bal", "acct_rosa")
    accounts.update_payment_method("acct_rosa", "pm_rosa_ebt", balance=5.00)
    fill_cart("s_bal", (BARS, 4))  # 16.72, all SNAP eligible
    pv = preview("s_bal", ["pm_rosa_ebt", "pm_rosa_debit"])
    assert pv["snap_subtotal"] == 16.72
    assert [(p["pm_id"], p["amount"]) for p in pv["plan"]] == [("pm_rosa_ebt", 5.0), ("pm_rosa_debit", 11.72)]
    assert any(r["kind"] == "ebt_balance_short" and not r["blocking"] for r in pv["refusals"])
    assert pv["ok"] is True


def test_uncovered_remainder_with_no_secondary_instrument_is_a_blocking_refusal():
    bind("s_only", "acct_rosa")
    fill_cart("s_only", (TORTILLAS, 1), (CHARGER, 1))
    pv = preview("s_only", ["pm_rosa_ebt"])
    assert pv["ok"] is False and pv["uncovered"] == 12.88
    blocking = [r for r in pv["refusals"] if r["blocking"]]
    assert blocking and blocking[0]["kind"] == "not_snap_eligible"
    assert blocking[0]["product_ids"] == [CHARGER]
    # The refusal quotes the real rule text from catalog_services, not a paraphrase.
    rule = next(r["text"] for r in cs.evaluate_eligibility(
        {"title": "USB-C Charger 20W", "category": "Electronics"}, "4108")["rules"]
        if r["rule"] == "snap_food_category")
    assert rule in blocking[0]["message"]
    assert pv["eligibility_rule_source"].startswith("catalog_services.evaluate_eligibility")


def test_eligibility_unavailable_refuses_ebt_outright():
    bind("s_fault", "acct_rosa")
    fill_cart("s_fault", (TORTILLAS, 1))
    cs.set_fault("eligibility", True)
    try:
        pv = preview("s_fault", ["pm_rosa_ebt", "pm_rosa_debit"])
    finally:
        cs.set_fault("eligibility", False)
    ref = [r for r in pv["refusals"] if r["kind"] == "eligibility_unverified"]
    assert ref and ref[0]["blocking"] is True
    assert "could not be verified" in ref[0]["message"] and "EBT cannot be used" in ref[0]["message"]
    assert all(p["kind"] != "ebt_snap" for p in pv["plan"])  # never guesses
    assert pv["ok"] is False and all(l["snap_eligible"] is None for l in pv["lines"])


def test_single_card_covers_the_whole_basket():
    bind("s_one", "acct_maya")
    fill_cart("s_one", (TORTILLAS, 2))
    pv = preview("s_one", ["pm_maya_visa"])
    assert pv["ok"] is True and pv["split_tender"] is False and pv["split_tender_plan"] is None
    assert pv["plan"][0]["amount"] == pv["total"] == 5.96
    assert pv["plan"][0]["covers"] == "whole basket"


def test_tender_hash_is_stable_under_reordering():
    a = [{"pm_id": "pm_b", "amount": 12.88}, {"pm_id": "pm_a", "amount": 2.98}]
    b = list(reversed(a))
    assert storefront.tender_hash(a) == storefront.tender_hash(b)
    assert storefront.tender_hash(a).startswith("sha256:")
    assert storefront.tender_hash(a) != storefront.tender_hash(
        [{"pm_id": "pm_b", "amount": 12.89}, {"pm_id": "pm_a", "amount": 2.98}])
    bind("s_h", "acct_rosa")
    fill_cart("s_h", (TORTILLAS, 1), (CHARGER, 1))
    assert (preview("s_h", ["pm_rosa_ebt", "pm_rosa_debit"])["tender_hash"]
            == storefront.tender_hash([{"pm_id": "pm_rosa_debit", "amount": 12.88},
                                       {"pm_id": "pm_rosa_ebt", "amount": 2.98}]))


def test_preview_rejects_foreign_or_unknown_instruments_and_empty_carts():
    bind("s_bad", "acct_rosa")
    fill_cart("s_bad", (TORTILLAS, 1))
    with pytest.raises(LookupError):
        preview("s_bad", ["pm_maya_visa"])
    with pytest.raises(LookupError):
        preview("s_bad", ["pm_nope"])
    commerce.remove("s_bad", TORTILLAS)
    with pytest.raises(ValueError):
        preview("s_bad", ["pm_rosa_ebt"])
