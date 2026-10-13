import pytest

from shop_mcp import guard, tools


def test_qty_blocked_and_logged():
    r = guard.guarded_add_to_cart("g1", "W-900003", 10)
    assert r["blocked"] and "qty 10" in r["reason"]
    assert r["cart"]["item_count"] == 0
    ev = guard.events("g1")
    assert len(ev) == 1 and ev[0]["kind"] == "qty_jump"


def test_budget_blocked_from_arg_and_session():
    r = guard.guarded_add_to_cart("g2", "W-900003", 2, budget=1)
    assert r["blocked"] and any(e["kind"] == "budget" for e in r["guard"]["events"])
    from shop_mcp import commerce
    commerce.set_budget("g3", 1)
    assert guard.guarded_add_to_cart("g3", "W-900003", 1)["blocked"]


def test_quarantined_listing_blocks_same_session_only():
    lst = tools.get_seller_listing("W-300112")
    assert lst["injection_flagged"]
    guard.record_quarantine("g4", "W-300112", lst["injection_signals"])
    r = guard.guarded_add_to_cart("g4", "W-300112", 1)
    assert r["blocked"] and r["guard"]["events"][0]["kind"] == "injection"
    ok = guard.guarded_add_to_cart("other", "W-300112", 1)
    assert not ok.get("blocked") and ok["cart"]["item_count"] == 1


def test_allowed_add_passes_through():
    r = guard.guarded_add_to_cart("g5", "W-900005", 2, budget=100)
    assert not r.get("blocked") and r["cart"]["item_count"] == 2
    assert guard.events("g5") == []


def test_mcp_tool_is_guarded():
    import asyncio, json
    from shop_mcp.server import mcp
    out = asyncio.run(mcp.call_tool("add_to_cart", {"session_id": "g6", "product_id": "W-900003", "qty": 9}))
    text = json.dumps(out, default=str)
    assert "blocked" in text and "qty 9" in text
