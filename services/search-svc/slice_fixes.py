"""Targeted, class-gated retrieval fixes evaluated by scripts/slice_report.py (backlog B07).

Nothing here is wired into /search or graph.route; it is an offline experiment arm.

use_case fix: "purpose-clause-aware lexical query" (`use_case_rank`)
    Use-case queries look like "<product head> for <audience/activity>" ("blackout curtains for
    bathroom windows", "beef jerky for dad"). Product titles rarely contain the audience/activity
    words, so in BM25 those terms either match nothing or match unrelated items that mention "dad" /
    "kitchen", diluting the head noun. The fix changes ONLY the BM25 query text for queries the
    classifier labels `use_case`; the dense encoder and the cross-encoder still see the full
    original query, and RRF(k=60) + top-50 rerank are identical to Engine.search(mode="rrf_rerank").
    Candidate rewrites (chosen on the DEV split, never on test):
      head_only      BM25 query = text before the purpose clause ("for ..."/"gift(s)" removed)
      head_boost     BM25 query = head repeated twice + full query (upweights head terms, keeps the rest)
    Non-use_case queries fall through to the unchanged production path.
"""
from __future__ import annotations

import re

from engine import RERANK_DEPTH, rrf

PURPOSE = re.compile(r"\s+(?:for|gifts?\s+for)\s+.*$", re.I)
GIFT = re.compile(r"\b(?:gifts?|ideas?|essentials)\b", re.I)


def head_phrase(query: str) -> str:
    """Strip the trailing purpose clause ("... for X") and gift/idea words; fall back to the query."""
    h = PURPOSE.sub("", query)
    h = GIFT.sub(" ", h)
    h = re.sub(r"\s+", " ", h).strip()
    return h or query


def rewrite_bm25(query: str, variant: str) -> str:
    h = head_phrase(query)
    if variant == "head_only":
        return h
    if variant == "head_boost":
        return f"{h} {h} {query}"
    raise ValueError(variant)


def production_rank(e, query: str, bm25_query: str | None = None, k: int = 10) -> list[int]:
    """Engine.search(mode='rrf_rerank') with an optional different BM25 query string."""
    bm = e.bm25_top(bm25_query or query, None)
    vec = e.vector_top(query, None)
    order, _ = rrf([i for i, _ in bm], [i for i, _ in vec])
    if not order:
        return []
    cand = order[:max(RERANK_DEPTH, k)]
    p = e.products
    rs = e.reranker().predict([(query, f"{p.at[i, 'title']} {p.at[i, 'brand']}") for i in cand],
                              batch_size=64, show_progress_bar=False)
    return [i for i, _ in sorted(zip(cand, rs), key=lambda x: -x[1])][:k]


def use_case_rank(e, query: str, cls: str, variant: str = "head_boost", k: int = 10) -> list[int]:
    if cls != "use_case":
        return production_rank(e, query, k=k)
    return production_rank(e, query, rewrite_bm25(query, variant), k=k)


FIXES = {
    "use_case": {
        "symbol": "use_case_rank",
        "fn": use_case_rank,
        "candidates": ["head_only", "head_boost"],
        "description": ("Purpose-clause-aware lexical query for use_case queries: the BM25 leg gets a rewritten "
                        "query built from the product head phrase (text before 'for ...', gift/idea words removed); "
                        "dense retrieval and the cross-encoder keep the original query. Gated on "
                        "query_types.classify == 'use_case'; variant selected on the dev split."),
    },
}
