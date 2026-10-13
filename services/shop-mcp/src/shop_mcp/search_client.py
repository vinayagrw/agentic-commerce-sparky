"""Client for search-svc (:8801). This is the only catalogue source; there is no substitute.

The demo used to fall back to an in-process stand-in catalogue whenever search-svc was slow
or down, which meant a client could be shown invented numbers believing they were real. Now
an unreachable search-svc raises SearchSvcUnavailable; the caller turns that into an explicit
"search-svc down on :8801 - run `make dev`" refusal and the run stops.
"""
from __future__ import annotations

import os

import httpx

from . import sparky_trace

SOURCE = "search-svc"


class SearchSvcUnavailable(RuntimeError):
    """search-svc could not answer. Carries what the UI needs to tell the presenter."""

    def __init__(self, detail: str):
        self.service = "search-svc"
        self.url = base_url()
        self.port = 8801
        self.fix = "make dev"
        self.detail = detail
        super().__init__(f"search-svc unreachable at {self.url}: {detail}. Fix: run `{self.fix}`")

    def as_result(self) -> dict:
        return {
            "error": str(self),
            "service_unavailable": {"service": self.service, "url": self.url, "port": self.port,
                                    "fix": self.fix, "detail": self.detail},
            "provenance": {"service": "shop-mcp", "endpoint": "search-svc", "note": "upstream unavailable"},
        }


def base_url() -> str:
    return os.environ.get("SEARCH_SVC_URL", "http://127.0.0.1:8801").rstrip("/")


def _call(method: str, path: str, json_body=None, timeout: float = 8.0):
    try:
        r = httpx.request(method, base_url() + path, json=json_body, timeout=timeout, headers=sparky_trace.inject_headers())
    except httpx.HTTPError as e:
        raise SearchSvcUnavailable(repr(e)) from e
    if r.status_code == 404:
        return None
    if r.status_code >= 500:
        raise SearchSvcUnavailable(f"HTTP {r.status_code}: {r.text[:200]}")
    try:
        r.raise_for_status()
        return r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise SearchSvcUnavailable(repr(e)) from e


def search(query, k=8, mode="rrf_rerank", filters=None):
    data = _call("POST", "/search", {"query": query, "k": k, "mode": mode, "filters": filters or {}})
    return (data or {"results": []}), SOURCE


def get_product(pid):
    return _call("GET", f"/product/{pid}"), SOURCE


def substitutes(pid, store_id, k=5):
    data = _call("POST", "/substitutes", {"product_id": pid, "store_id": store_id, "k": k})
    if isinstance(data, dict):
        data = data.get("substitutes", [])
    return (data or []), SOURCE


def catalog(category: str | None = None, limit: int = 500):
    """The live indexed catalogue. Used by the measured agent-readiness score."""
    q = f"/catalog?limit={int(limit)}" + (f"&category={category}" if category else "")
    data = _call("GET", q, timeout=20.0)
    return ((data or {}).get("items", []), SOURCE)


def route_intent(query: str) -> dict:
    """search-svc POST /route/intent (rules-first router, incl. the help intent)."""
    data = _call("POST", "/route/intent", {"query": query})
    if not isinstance(data, dict) or "route" not in data:
        raise SearchSvcUnavailable("POST /route/intent returned no route (search-svc too old? restart it)")
    return data


def suggest(q: str, n: int = 8) -> dict:
    from urllib.parse import quote

    data = _call("GET", f"/suggest?q={quote(q)}&n={int(n)}")
    if not isinstance(data, dict):
        raise SearchSvcUnavailable("GET /suggest not available (search-svc too old? restart it)")
    return data
