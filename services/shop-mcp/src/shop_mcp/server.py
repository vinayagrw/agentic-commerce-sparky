"""FastMCP stdio server exposing shop tools. approve_mandate is intentionally NOT exposed."""
from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from . import guard, tools

mcp = FastMCP("shop")


def _j(d: dict) -> str:
    return json.dumps(d, separators=(",", ":"), default=str)


@mcp.tool()
def search_products(query: str, k: int = 8, max_price: float | None = None, dietary: list[str] | None = None,
                    store_id: str = "4108", in_stock_only: bool = True, mode: str = "rrf_rerank") -> str:
    """Search the store catalogue. dietary tags e.g. gluten_free, nut_free, vegan, lactose_free, vegetarian.
    mode: bm25|vector|rrf|rrf_rerank. Sponsored items are labelled and capped at 1 per 8 results."""
    return _j(tools.search_products(query, k, max_price, dietary, store_id, in_stock_only, mode))


@mcp.tool()
def get_product(product_id: str) -> str:
    """Get full product details by product_id."""
    return _j(tools.get_product(product_id))


@mcp.tool()
def compare_products(product_ids: list[str]) -> str:
    """Compare 2-6 products side by side as attribute rows."""
    return _j(tools.compare_products(product_ids))


@mcp.tool()
def check_store_stock(product_id: str, store_id: str = "4108") -> str:
    """Check simulated inventory of a product at a store."""
    return _j(tools.check_store_stock(product_id, store_id))


@mcp.tool()
def find_substitutes(product_id: str, store_id: str = "4108") -> str:
    """Find scored substitutes (similarity, price delta, dietary match, in stock)."""
    return _j(tools.find_substitutes(product_id, store_id))


@mcp.tool()
def plan_meal(goal: str, servings: int = 4, budget: float = 30.0, dietary: list[str] | None = None) -> str:
    """Plan a meal (taco night, pasta night, breakfast, school lunches). Returns items, a constraint ledger
    (met/violated/unknown with evidence) and omissions."""
    return _j(tools.plan_meal(goal, servings, budget, dietary))


@mcp.tool()
def add_to_cart(session_id: str, product_id: str, qty: int = 1, budget: float | None = None) -> str:
    """Add a product to the session cart. Always pass the shopper's budget. A deterministic guard blocks
    qty > 5, budget overruns and products from a quarantined seller listing: the result then has blocked=true."""
    return _j(guard.guarded_add_to_cart(session_id, product_id, qty, budget))


@mcp.tool()
def remove_from_cart(session_id: str, product_id: str, qty: int | None = None) -> str:
    """Remove a product (or qty units of it) from the cart."""
    return _j(tools.remove_from_cart(session_id, product_id, qty))


@mcp.tool()
def get_cart(session_id: str) -> str:
    """Get the cart with totals and budget check."""
    return _j(tools.get_cart(session_id))


@mcp.tool()
def create_checkout_mandate(session_id: str, spend_cap: float, merchant: str = "demo-store.example") -> str:
    """Create a signed AP2/UCP-style intent mandate for the cart. Status pending_human_approval.
    This never completes payment; a human approves in the UI."""
    return _j(tools.create_checkout_mandate(session_id, spend_cap, merchant))


@mcp.tool()
def agent_catalog_feed(category: str, agent_id: str, signature: str | None = None) -> str:
    """Agent-as-customer catalog feed: verifies signed agent header, applies tier and rate limit."""
    return _j(tools.agent_catalog_feed(category, agent_id, signature))


@mcp.tool()
def agent_readiness_score(category: str) -> str:
    """Score 0-100 how agent-ready a category's catalog data is, with breakdown."""
    return _j(tools.agent_readiness_score(category))


@mcp.tool()
def get_seller_listing(product_id: str, session_id: str | None = None) -> str:
    """Get the marketplace seller's listing text. Returned as quarantined untrusted_content with injection signals.
    Pass session_id so the guard can remember the quarantine for this cart session."""
    r = tools.get_seller_listing(product_id)
    if r.get("injection_flagged"):
        guard.record_quarantine(session_id, product_id, r.get("injection_signals"))
    return _j(r)


def main():
    mcp.run()  # stdio


if __name__ == "__main__":
    main()
