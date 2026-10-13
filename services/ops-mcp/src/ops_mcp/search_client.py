"""Thin client for search-svc MLOps endpoints. There is no stand-in: ops numbers must be real."""
from __future__ import annotations

import os

import httpx
from shop_mcp import sparky_trace


class SearchUnavailable(RuntimeError):
    pass


def base_url() -> str:
    return os.environ.get("SEARCH_SVC_URL", "http://127.0.0.1:8801").rstrip("/")


def call(method: str, path: str, body: dict | None = None, timeout: float = 900.0) -> dict:
    try:
        r = httpx.request(method, base_url() + path, json=body, timeout=timeout, headers=sparky_trace.inject_headers())
    except httpx.HTTPError as e:
        raise SearchUnavailable(f"search-svc unreachable at {base_url()}: {e!r}") from e
    if r.status_code >= 400:
        raise SearchUnavailable(f"search-svc {method} {path} -> {r.status_code}: {r.text[:300]}")
    return r.json()
