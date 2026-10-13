"""Order confirmation, the four mandate checks + cap/total, and the pure fulfilment function."""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from shop_mcp import accounts, commerce, http_app, storefront

from _flow import approved_mandate, bind, fill_cart, preview, resign, signed_mandate

TORTILLAS = "W-900002"
CHARGER = "W-200430"


def _happy(sid="s_ord"):
    bind(sid, "acct_maya")
    fill_cart(sid, (TORTILLAS, 2))
    pv = preview(sid, ["pm_maya_visa"])
    mid = approved_mandate(sid, pv, address_id="adr_maya_home")
    auth = commerce.authorize(mid)
    assert auth["decision"] == "approved", auth
    return sid, mid, auth


def test_order_confirmation_carries_payment_address_and_fulfilment():
    sid, mid, auth = _happy()
    order = storefront.create_order(sid, mid)
    assert order["payment_executed"] is False
    assert order["payment"]["auth_ref"] == auth["auth_ref"] == order["auth_ref"]
    assert order["payment"]["status"] == "simulated_authorisation_recorded"
    assert order["payment"]["split_tender"] is False
    assert order["address"]["address_id"] == "adr_maya_home"
    assert order["account_id"] == "acct_maya"
    assert order["fulfilment"]["stage"] == "placed" and order["fulfilment"]["derived_from"] == "elapsed_time"
    assert "simulated" in order["fulfilment"]["label"]
    assert commerce.cart(sid)["items"] == []
    assert storefront.account_orders("acct_maya")["orders"][0]["order_id"] == order["order_id"]


def test_order_is_idempotent_per_mandate():
    sid, mid, _ = _happy("s_idem")
    first = storefront.create_order(sid, mid)
    second = storefront.create_order(sid, mid)
    assert second["order_id"] == first["order_id"]
    assert second["note"] == "order already exists for this mandate"
    assert len(storefront.orders(sid)["orders"]) == 1


def test_order_needs_a_recorded_authorisation_when_the_mandate_names_a_tender():
    bind("s_noauth", "acct_maya")
    fill_cart("s_noauth", (TORTILLAS, 1))
    pv = preview("s_noauth", ["pm_maya_visa"])
    mid = approved_mandate("s_noauth", pv)
    with pytest.raises(ValueError, match="authorize"):
        storefront.create_order("s_noauth", mid)


def test_split_tender_order_records_both_legs():
    bind("s_sp", "acct_rosa")
    fill_cart("s_sp", (TORTILLAS, 1), (CHARGER, 1))
    pv = preview("s_sp", ["pm_rosa_ebt", "pm_rosa_debit"])
    mid = approved_mandate("s_sp", pv, address_id="adr_rosa_home")
    assert commerce.authorize(mid)["decision"] == "approved"
    order = storefront.create_order("s_sp", mid)
    assert order["payment"]["split_tender"] is True
    assert [t["amount"] for t in order["payment"]["tender"]] == [2.98, 12.88]
    assert order["payment"]["payment_executed"] is False


# ------------------------------------------------------------------ the checks
def _checks(mid):
    out = commerce.authorize(mid)
    assert out["payment_executed"] is False
    return out


def test_authorize_refuses_tender_changed():
    bind("s_tc", "acct_maya")
    fill_cart("s_tc", (TORTILLAS, 1))
    pv = preview("s_tc", ["pm_maya_visa"])
    mid = approved_mandate("s_tc", pv)

    def bump(body):
        body["tender"][0]["amount"] = body["tender"][0]["amount"] + 1.0

    resign(mid, bump)  # re-signed, so ONLY tender_unchanged can fail
    out = _checks(mid)
    assert out["decision"] == "refused" and out["checks"]["signature_valid"] is True
    assert out["checks"]["tender_unchanged"] is False
    assert "tender_unchanged" in out["failed_checks"]


def test_authorize_refuses_cart_changed():
    bind("s_cc", "acct_maya")
    fill_cart("s_cc", (TORTILLAS, 1))
    pv = preview("s_cc", ["pm_maya_visa"])
    mid = approved_mandate("s_cc", pv)
    fill_cart("s_cc", (CHARGER, 1))
    out = _checks(mid)
    assert out["decision"] == "refused"
    assert out["checks"]["cart_unchanged"] is False
    assert out["checks"]["amount_matches_cart_total"] is False


def test_authorize_refuses_over_the_spend_cap():
    bind("s_cap", "acct_maya")
    fill_cart("s_cap", (TORTILLAS, 2))
    pv = preview("s_cap", ["pm_maya_visa"])
    mid = approved_mandate("s_cap", pv, spend_cap=1.00)
    out = _checks(mid)
    assert out["decision"] == "refused" and out["checks"]["within_spend_cap"] is False


def test_authorize_refuses_an_expired_mandate():
    bind("s_exp", "acct_maya")
    fill_cart("s_exp", (TORTILLAS, 1))
    pv = preview("s_exp", ["pm_maya_visa"])
    mid = approved_mandate("s_exp", pv)
    resign(mid, lambda body: body.update(expires_at=int(time.time()) - 5))
    out = _checks(mid)
    assert out["decision"] == "refused" and out["checks"]["not_expired"] is False
    assert out["checks"]["signature_valid"] is True


def test_declined_and_expired_instruments_set_the_new_mandate_statuses():
    bind("s_dec", "acct_dev")
    fill_cart("s_dec", (TORTILLAS, 1))
    mid = approved_mandate("s_dec", preview("s_dec", ["pm_dev_declined"]))
    out = _checks(mid)
    assert out["decision"] == "declined"
    assert commerce.get_mandate(mid)["status"] == "payment_declined"
    for word in ("charged", "paid", "transaction"):
        assert word not in out["message"].lower()

    bind("s_exp2", "acct_dev")
    fill_cart("s_exp2", (TORTILLAS, 1))
    mid2 = approved_mandate("s_exp2", preview("s_exp2", ["pm_dev_expired"]))
    out2 = _checks(mid2)
    assert out2["decision"] == "refused" and out2["reason"] == "expired"


def test_authorize_needs_a_human_approved_mandate_and_a_tender():
    bind("s_pend", "acct_maya")
    fill_cart("s_pend", (TORTILLAS, 1))
    pv = preview("s_pend", ["pm_maya_visa"])
    mid = signed_mandate("s_pend", pv)["mandate"]["mandate_id"]
    with pytest.raises(ValueError, match="human-approved"):
        commerce.authorize(mid)
    guest = commerce.create_mandate("s_pend", 500.0)["mandate"]["mandate_id"]
    with pytest.raises(ValueError, match="no payment tender"):
        commerce.authorize(guest)
    with pytest.raises(LookupError):
        commerce.authorize("mdt_nope")


# ------------------------------------------------------------------ guest path unchanged
def test_guest_order_has_no_payment_block():
    client = TestClient(http_app.app)
    sid = "s_guest_order"
    assert client.post(f"/cart/{sid}/items", json={"product_id": TORTILLAS, "qty": 1}).status_code == 200
    m = client.post(f"/cart/{sid}/mandate", json={"spend_cap": 500}).json()
    body = m["mandate"]
    assert "tender" not in body and "account_id" not in body and "address_id" not in body
    assert m["signature"]["alg"] == "HMAC-SHA256" and len(m["signature"]["value"]) == 64
    assert client.post(f"/mandates/{body['mandate_id']}/decision",
                       json={"approved": True}).json()["status"] == "approved"
    order = client.post(f"/sessions/{sid}/orders",
                        json={"mandate_id": body["mandate_id"]}).json()["order"]
    assert "payment" not in order and "auth_ref" not in order
    assert order["account_id"] is None and order["address_id"] is None
    assert order["payment_executed"] is False


# ------------------------------------------------------------------ fulfilment purity
def test_fulfilment_stage_is_a_pure_function():
    f = storefront.fulfilment_state
    cases = {0: "placed", 119: "placed", 120: "preparing", 599: "preparing",
             600: "ready_for_pickup", 1799: "ready_for_pickup", 1800: "picked_up", 99999: "picked_up"}
    for elapsed, stage in cases.items():
        got = f(1000.0, 1000.0 + elapsed)
        assert got["stage"] == stage and got["derived_from"] == "elapsed_time"
        assert got == f(1000.0, 1000.0 + elapsed)          # same inputs -> same output
        assert got == f(5_000_000.0, 5_000_000.0 + elapsed)  # depends only on the difference
    assert f(1000.0, 500.0)["stage"] == "placed"  # clock skew cannot go negative
    # demo_control only ever moves forward
    assert f(1000.0, 1000.0)["derived_from"] == "elapsed_time"
    ctrl = f(1000.0, 1000.0, "ready_for_pickup")
    assert ctrl["stage"] == "ready_for_pickup" and ctrl["derived_from"] == "demo_control"
    assert f(1000.0, 1000.0 + 99999, "placed")["stage"] == "picked_up"
    assert f(1000.0, 1000.0 + 99999, "placed")["derived_from"] == "elapsed_time"
    assert f(1000.0, 1000.0)["payment_executed"] is False


def test_advance_fulfilment_endpoint_cannot_go_backwards():
    sid, mid, _ = _happy("s_adv")
    order = storefront.create_order(sid, mid)
    client = TestClient(http_app.app)
    r = client.post(f"/orders/{order['order_id']}/fulfilment/advance", json={})
    assert r.json()["fulfilment"]["stage"] == "preparing"
    r = client.post(f"/orders/{order['order_id']}/fulfilment/advance", json={"stage": "picked_up"})
    assert r.json()["fulfilment"]["stage"] == "picked_up"
    assert client.post(f"/orders/{order['order_id']}/fulfilment/advance",
                       json={"stage": "placed"}).status_code == 400
    assert client.get(f"/orders/{order['order_id']}").json()["status"] == "picked_up"
    assert client.get("/orders/ord_nope").status_code == 404


def test_http_surface_smoke():
    accounts.ensure_seeded()
    client = TestClient(http_app.app)
    assert len(client.get("/accounts").json()["accounts"]) == 3
    assert client.get("/accounts/acct_nope").status_code == 404
    assert client.put("/sessions/s_http/account", json={"account_id": "acct_maya"}).json()["account_id"] == "acct_maya"
    assert client.get("/sessions/s_http/account").json()["account"]["name"] == "Maya Alvarez"
    cards = client.get("/payment-methods/test-cards").json()
    assert len(cards["cards"]) == 7 and cards["payment_executed"] is False
    assert client.post("/accounts/acct_maya/payment-methods/pm_maya_gift/default").json()[
        "payment_method"]["is_default"] is True
    adr = client.post("/accounts/acct_maya/addresses",
                      json={"line1": "3 Third St", "city": "Bentonville", "region": "AR"}).json()["address"]
    assert client.post(f"/accounts/acct_maya/addresses/{adr['address_id']}/default").json()[
        "address"]["is_default"] is True
    assert client.delete(f"/accounts/acct_maya/addresses/{adr['address_id']}").status_code == 200
    client.post("/cart/s_http/items", json={"product_id": TORTILLAS, "qty": 1})
    pv = client.post("/cart/s_http/tender-preview", json={"pm_ids": ["pm_maya_visa"]}).json()
    assert pv["ok"] is True
    m = client.post("/cart/s_http/mandate", json={"spend_cap": 500, "account_id": "acct_maya",
                                                  "tender": pv["plan"], "tender_hash": pv["tender_hash"]}).json()
    mid = m["mandate"]["mandate_id"]
    client.post(f"/mandates/{mid}/decision", json={"approved": True})
    auth = client.post(f"/mandates/{mid}/authorize").json()
    assert auth["decision"] == "approved" and auth["payment_executed"] is False
    assert client.get("/accounts/acct_maya/orders").status_code == 200
    assert client.post("/step-ups/stp_nope/verify", json={"code": "000000"}).status_code == 404


def test_order_tender_names_the_instrument_not_just_its_id():
    """A confirmation page must be able to say "Visa ending 4242".

    The mandate body's tender is only what the client sent ({pm_id, amount}); brand/last4/label are
    resolved during authorisation. Reading the block from the mandate alone left every one of those
    fields null, so the confirmation page had nothing but an opaque pm_id to render.
    """
    sid, mid, _ = _happy("s_ord_tender_names")
    order = storefront.create_order(sid, mid)
    leg = order["payment"]["tender"][0]
    assert leg["pm_id"] == "pm_maya_visa"
    assert leg["brand"] == "visa", leg
    assert leg["last4"] == "4242", leg
    assert leg["kind"] == "credit", leg
    assert leg["label"], "the instrument label is what marks it synthetic on the page"
    assert order["payment"]["payment_executed"] is False


def test_order_inherits_the_session_persona_when_the_mandate_did_not_name_one():
    """A session bound to a persona must not file its order as a guest's.

    The UI can sign a mandate without repeating the account id; the binding is already on the session.
    Without the fallback the order carried account_id=None and vanished from that persona's history.
    """
    sid = "s_ord_persona_fallback"
    bind(sid, "acct_maya")
    fill_cart(sid, (TORTILLAS, 1))
    pv = preview(sid, ["pm_maya_visa"])
    # Sign WITHOUT an account_id, the way a client that relies on the session binding would.
    m = commerce.create_mandate(sid, 500.0, "demo-store.example", None, None, pv["plan"], pv["tender_hash"])
    mid = m["mandate"]["mandate_id"]
    assert m["mandate"].get("account_id") is None
    commerce.approve_mandate(mid, True)
    commerce.authorize(mid)
    order = storefront.create_order(sid, mid)
    assert order["account_id"] == "acct_maya", order
    assert order["order_id"] in [o["order_id"] for o in storefront.account_orders("acct_maya")["orders"]]
    # An address nobody chose is still not invented.
    assert order.get("address_id") is None
    assert "address" not in order or order.get("address") is None
