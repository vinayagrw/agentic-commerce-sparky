"""FastAPI side app (port 8802) for the web UI and BFF. Shares SQLite state with the MCP server."""
from __future__ import annotations

import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from . import agent_api, commerce, guard, tools
from .injection import detect_injection

app = FastAPI(title="shop-http", version="0.1.0")


class CartAdd(BaseModel):
    product_id: str
    qty: int = 1
    budget: float | None = None


class Decision(BaseModel):
    approved: bool


class ScanBody(BaseModel):
    text: str


class TenderLeg(BaseModel):
    pm_id: str
    amount: float
    kind: str | None = None
    brand: str | None = None
    last4: str | None = None
    covers: str | None = None
    label: str | None = None


class MandateBody(BaseModel):
    spend_cap: float
    merchant: str = "demo-store.example"
    account_id: str | None = None
    address_id: str | None = None
    tender: list[TenderLeg] | None = None
    tender_hash: str | None = None


@app.get("/health")
def health():
    return {"ok": True, "service": "shop-http"}


@app.get("/cart/{session_id}")
def get_cart(session_id: str):
    return tools.get_cart(session_id)


@app.post("/cart/{session_id}/items")
def add_item(session_id: str, body: CartAdd):
    r = tools.add_to_cart(session_id, body.product_id, body.qty, body.budget)
    if "error" in r:
        raise HTTPException(400, r["error"])
    return r


@app.delete("/cart/{session_id}/items/{product_id}")
def remove_item(session_id: str, product_id: str, qty: int | None = None):
    return tools.remove_from_cart(session_id, product_id, qty)


@app.post("/cart/{session_id}/mandate")
def create_mandate(session_id: str, body: MandateBody):
    if not (body.tender or body.account_id or body.address_id):
        # Guest path: exactly today's call, so the mandate body and its signature are unchanged.
        return tools.create_checkout_mandate(session_id, body.spend_cap, body.merchant)
    return _svc(lambda: commerce.create_mandate(
        session_id, body.spend_cap, body.merchant, body.account_id, body.address_id,
        [t.model_dump(exclude_none=True) for t in body.tender] if body.tender else None, body.tender_hash))


@app.get("/mandates/{mandate_id}")
def get_mandate(mandate_id: str):
    m = commerce.get_mandate(mandate_id)
    if not m:
        raise HTTPException(404, "unknown mandate")
    return m


@app.post("/mandates/{mandate_id}/approve")
def approve(mandate_id: str):
    return tools.approve_mandate(mandate_id, True)


@app.post("/mandates/{mandate_id}/reject")
def reject(mandate_id: str):
    return tools.approve_mandate(mandate_id, False)


@app.post("/mandates/{mandate_id}/decision")
def decide(mandate_id: str, body: Decision):
    return tools.approve_mandate(mandate_id, body.approved)


class BudgetBody(BaseModel):
    budget: float


@app.post("/sessions/{session_id}/budget")
def set_budget(session_id: str, body: BudgetBody):
    """BFF records the ledger budget so the MCP-path guard can enforce it even if the model omits it."""
    commerce.set_budget(session_id, body.budget)
    return {"session_id": session_id, "budget": body.budget}


@app.get("/guard/events/{session_id}")
def guard_events(session_id: str, since: float = 0):
    return {"session_id": session_id, "events": guard.events(session_id, since)}


@app.get("/agent/catalog/{category}")
def agent_feed(category: str, x_agent_id: str = Header("anonymous"), x_agent_signature: str | None = Header(None)):
    r = tools.agent_catalog_feed(category, x_agent_id, x_agent_signature)
    if r.get("status") in (403, 429):
        raise HTTPException(r["status"], r)
    return r


@app.get("/agent/sign")
def agent_sign(agent_id: str, category: str):
    """Demo helper so the UI can show a 'verified' agent call."""
    return {"agent_id": agent_id, "category": category, "signature": agent_api.sign_agent_request(agent_id, category)}


@app.get("/agent/readiness/{category}")
def readiness(category: str):
    return tools.agent_readiness_score(category)


@app.get("/seller-listing/{product_id}")
def seller_listing(product_id: str):
    return tools.get_seller_listing(product_id)


@app.post("/injection/scan")
def scan(body: ScanBody):
    return detect_injection(body.text)


# ======================= Storefront / B15 catalogue services (contract: Wave 0) =======================
from typing import Literal  # noqa: E402

from . import catalog_services as cs  # noqa: E402
from . import storefront  # noqa: E402
from .search_client import SearchSvcUnavailable  # noqa: E402


def _svc(fn):
    try:
        return fn()
    except SearchSvcUnavailable as e:
        raise HTTPException(503, e.as_result())
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/sessions/{session_id}/budget")
def clear_budget(session_id: str):
    commerce.clear_budget(session_id)
    return {"session_id": session_id, "budget": None}


@app.get("/stores")
def stores():
    return {"stores": list(cs.STORES.values())}


@app.get("/catalog-services/quote/{pid}")
def cs_quote(pid: str, store_id: str = cs.DEFAULT_STORE, fresh: bool = False):
    return cs.quote(pid, store_id, fresh=fresh)


class QuotesBody(BaseModel):
    product_ids: list[str]
    store_id: str = cs.DEFAULT_STORE
    fresh: bool = False


@app.post("/catalog-services/quotes")
def cs_quotes(body: QuotesBody):
    return {"quotes": cs.quotes(body.product_ids[:200], body.store_id, fresh=body.fresh)}


class FaultBody(BaseModel):
    service: Literal["price", "promo", "inventory", "eligibility"]
    down: bool
    seconds: int | None = None


@app.get("/catalog-services/faults")
def cs_faults():
    return cs.faults()


@app.post("/catalog-services/faults")
def cs_set_fault(body: FaultBody):
    return _svc(lambda: cs.set_fault(body.service, body.down, body.seconds))


class InventoryBody(BaseModel):
    product_id: str
    store_id: str = cs.DEFAULT_STORE
    qty: int
    reason: str


@app.post("/catalog-services/inventory")
def cs_inventory(body: InventoryBody):
    return _svc(lambda: cs.adjust_inventory(body.product_id, body.store_id, body.qty, body.reason))


class PriceBody(BaseModel):
    product_id: str
    list_price: float | None
    reason: str


@app.post("/catalog-services/price")
def cs_price(body: PriceBody):
    """Operator/test list-price override (additive to the contract)."""
    return _svc(lambda: cs.set_price(body.product_id, body.list_price, body.reason))


@app.get("/catalog-services/product/{pid}")
def cs_product(pid: str, store_id: str = cs.DEFAULT_STORE):
    r = _svc(lambda: storefront.product_detail(pid, store_id))
    if r is None:
        raise HTTPException(404, "product not found")
    return r


class SearchFilters(BaseModel):
    brands: list[str] | None = None
    min_price: float | None = None
    max_price: float | None = None
    dietary: list[str] | None = None
    in_stock: bool | None = None
    exclude_terms: list[str] | None = None


class StorefrontSearch(BaseModel):
    session_id: str | None = None
    query: str
    store_id: str = cs.DEFAULT_STORE
    filters: SearchFilters = SearchFilters()
    sort: Literal["relevance", "price_asc", "price_desc", "rating"] = "relevance"
    page: int = 1
    page_size: int = 24


@app.post("/storefront/search")
def storefront_search(body: StorefrontSearch):
    r = storefront.search(body.query, body.store_id, body.filters.model_dump(exclude_none=True), body.sort,
                          body.page, body.page_size, body.session_id)
    if "service_unavailable" in r:
        raise HTTPException(503, r)
    return r


@app.get("/storefront/suggest")
def storefront_suggest(q: str = ""):
    r = storefront.suggest(q)
    if "service_unavailable" in r:
        raise HTTPException(503, r)
    return r


@app.get("/help/answer")
def help_answer(q: str, lang: str | None = None):
    return storefront.help_answer(q, lang)


@app.get("/triage")
def triage(status: str | None = None):
    return storefront.triage_list(status)


class TriageBody(BaseModel):
    status: Literal["open", "acknowledged", "resolved"]
    note: str | None = None


@app.post("/triage/{tid}")
def triage_update(tid: str, body: TriageBody):
    r = storefront.triage_update(tid, body.status, body.note)
    if r is None:
        raise HTTPException(404, "unknown triage id")
    return r


class QtyBody(BaseModel):
    qty: int


@app.put("/cart/{session_id}/items/{product_id}")
def set_qty(session_id: str, product_id: str, body: QtyBody):
    return {"cart": _svc(lambda: storefront.set_qty(session_id, product_id, body.qty))}


@app.post("/cart/{session_id}/revalidate")
def revalidate(session_id: str, store_id: str | None = None):
    return _svc(lambda: storefront.revalidate(session_id, store_id))


class StoreBody(BaseModel):
    store_id: str


@app.get("/sessions/{session_id}/store")
def get_store(session_id: str):
    return storefront.get_store(session_id)


@app.put("/sessions/{session_id}/store")
def put_store(session_id: str, body: StoreBody):
    return _svc(lambda: storefront.set_store(session_id, body.store_id))


class OrderBody(BaseModel):
    mandate_id: str


@app.post("/sessions/{session_id}/orders")
def create_order(session_id: str, body: OrderBody):
    return {"order": _svc(lambda: storefront.create_order(session_id, body.mandate_id))}


@app.get("/sessions/{session_id}/orders")
def list_orders(session_id: str):
    return storefront.orders(session_id)


class ListBody(BaseModel):
    name: str


class ListItemBody(BaseModel):
    product_id: str


@app.get("/sessions/{session_id}/lists")
def get_lists(session_id: str):
    return storefront.lists(session_id)


@app.post("/sessions/{session_id}/lists")
def create_list(session_id: str, body: ListBody):
    return _svc(lambda: storefront.create_list(session_id, body.name))


@app.post("/sessions/{session_id}/lists/{name}/items")
def add_list_item(session_id: str, name: str, body: ListItemBody):
    return _svc(lambda: storefront.add_list_item(session_id, name, body.product_id))


@app.delete("/sessions/{session_id}/lists/{name}/items/{product_id}")
def remove_list_item(session_id: str, name: str, product_id: str):
    return storefront.remove_list_item(session_id, name, product_id)


@app.delete("/sessions/{session_id}/lists/{name}")
def delete_list(session_id: str, name: str):
    return storefront.delete_list(session_id, name)


# ======================= B16 accounts, wallet, simulated authorisation, fulfilment =======================
from . import accounts, payments  # noqa: E402


def _wallet(fn):
    """Like _svc, but a number outside the frozen allowlist is a 422 that never echoes the input.

    UnknownTestCard subclasses ValueError, so it is converted BEFORE _svc can map it to a 400.
    """
    def inner():
        try:
            return fn()
        except payments.UnknownTestCard as e:
            raise HTTPException(422, {"error": str(e), "accepted": e.accepted})
    return _svc(inner)


@app.get("/accounts")
def list_accounts():
    return accounts.list_accounts()


@app.get("/accounts/{aid}")
def get_account(aid: str):
    return _svc(lambda: accounts.get_account(aid))


@app.get("/sessions/{sid}/account")
def get_session_account(sid: str):
    return accounts.get_session_account(sid)


class SessionAccountBody(BaseModel):
    account_id: str | None = None


@app.put("/sessions/{sid}/account")
def put_session_account(sid: str, body: SessionAccountBody):
    return _svc(lambda: accounts.set_session_account(sid, body.account_id))


@app.get("/payment-methods/test-cards")
def test_cards():
    return payments.test_cards()


class PaymentMethodBody(BaseModel):
    kind: Literal["credit", "debit", "ebt_snap", "gift"]
    number: str | None = None  # looked up in the frozen allowlist and discarded; never stored
    balance: float | None = None
    nickname: str | None = None
    is_default: bool = False


class PaymentMethodPatch(BaseModel):
    nickname: str | None = None
    balance: float | None = None
    is_default: bool | None = None


@app.get("/accounts/{aid}/payment-methods")
def get_payment_methods(aid: str):
    return _svc(lambda: accounts.payment_methods(aid))


@app.post("/accounts/{aid}/payment-methods")
def add_payment_method(aid: str, body: PaymentMethodBody):
    return _wallet(lambda: accounts.add_payment_method(aid, body.kind, body.number, body.balance,
                                                       body.nickname, body.is_default))


@app.put("/accounts/{aid}/payment-methods/{pm}")
def put_payment_method(aid: str, pm: str, body: PaymentMethodPatch):
    return _svc(lambda: accounts.update_payment_method(aid, pm, body.nickname, body.balance, body.is_default))


@app.delete("/accounts/{aid}/payment-methods/{pm}")
def delete_payment_method(aid: str, pm: str):
    return _svc(lambda: accounts.delete_payment_method(aid, pm))


@app.post("/accounts/{aid}/payment-methods/{pm}/default")
def default_payment_method(aid: str, pm: str):
    return _svc(lambda: accounts.set_default_payment_method(aid, pm))


class AddressBody(BaseModel):
    name: str | None = None
    line1: str | None = None
    line2: str | None = None
    city: str | None = None
    region: str | None = None
    postal_code: str | None = None
    store_id: str | None = None
    instructions: str | None = None
    is_default: bool = False


@app.get("/accounts/{aid}/addresses")
def get_addresses(aid: str):
    return _svc(lambda: accounts.addresses(aid))


@app.post("/accounts/{aid}/addresses")
def add_address(aid: str, body: AddressBody):
    return _svc(lambda: accounts.add_address(aid, body.model_dump()))


@app.put("/accounts/{aid}/addresses/{adr}")
def put_address(aid: str, adr: str, body: AddressBody):
    return _svc(lambda: accounts.update_address(aid, adr, body.model_dump(exclude_unset=True)))


@app.delete("/accounts/{aid}/addresses/{adr}")
def delete_address(aid: str, adr: str):
    return _svc(lambda: accounts.delete_address(aid, adr))


@app.post("/accounts/{aid}/addresses/{adr}/default")
def default_address(aid: str, adr: str):
    return _svc(lambda: accounts.set_default_address(aid, adr))


class TenderPreviewBody(BaseModel):
    pm_ids: list[str]
    store_id: str | None = None


@app.post("/cart/{sid}/tender-preview")
def tender_preview(sid: str, body: TenderPreviewBody):
    return _svc(lambda: storefront.tender_preview(sid, body.pm_ids, body.store_id))


@app.post("/mandates/{mid}/authorize")
def authorize(mid: str):
    """Records a SIMULATED authorisation. payment_executed is False on every path."""
    return _svc(lambda: commerce.authorize(mid))


class StepUpBody(BaseModel):
    code: str
    step_up_id: str | None = None


@app.post("/step-ups/{sid}/verify")
def verify_step_up(sid: str, body: StepUpBody):
    """`sid` is a step_up_id, or a session_id whose newest pending verification step is used."""
    return _svc(lambda: commerce.verify_step_up(body.step_up_id or sid, body.code))


@app.get("/accounts/{aid}/orders")
def account_orders(aid: str):
    return _svc(lambda: storefront.account_orders(aid))


@app.get("/orders/{oid}")
def get_order(oid: str):
    return _svc(lambda: storefront.get_order(oid))


class AdvanceBody(BaseModel):
    stage: Literal["placed", "preparing", "ready_for_pickup", "picked_up"] | None = None


@app.post("/orders/{oid}/fulfilment/advance")
def advance_fulfilment(oid: str, body: AdvanceBody | None = None):
    return _svc(lambda: storefront.advance_fulfilment(oid, body.stage if body else None))


def main():
    import uvicorn

    uvicorn.run(app, host=os.environ.get("SHOP_HTTP_HOST", "127.0.0.1"), port=int(os.environ.get("SHOP_HTTP_PORT", "8802")))


if __name__ == "__main__":
    main()
