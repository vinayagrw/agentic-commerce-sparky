"""Sparky Next search-svc (port 8801). Contract shared with bff / shop-mcp — do not change shapes."""
from __future__ import annotations

from typing import Literal, Optional

import sparky_trace
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from engine import Engine

Mode = Literal["bm25", "vector", "rrf", "rrf_rerank"]
app = FastAPI(title="Sparky Next search-svc", version="0.1.0")
_engine: Engine | None = None
_error: str | None = None


def engine() -> Engine:
    global _engine, _error
    if _engine is None and _error is None:
        try:
            _engine = Engine()
        except Exception as e:  # data/index missing
            _error = repr(e)
    if _engine is None:
        raise HTTPException(503, f"index not loaded: {_error}. Run fetch_data.py and build_index.py")
    return _engine


@app.on_event("startup")
def _startup():
    try:
        engine()
    except HTTPException:
        pass


class Filters(BaseModel):
    category: Optional[str] = None
    max_price: Optional[float] = None
    dietary: Optional[list[str]] = None
    store_id: Optional[str] = None
    in_stock_only: Optional[bool] = None


class SearchReq(BaseModel):
    query: str
    k: int = Field(10, ge=1, le=100)
    mode: Mode = "rrf_rerank"
    filters: Filters = Filters()


class SubReq(BaseModel):
    product_id: str
    store_id: Optional[str] = None
    k: int = Field(5, ge=1, le=50)


class EvalReq(BaseModel):
    modes: list[Mode] = ["bm25", "vector", "rrf", "rrf_rerank"]
    split: Literal["dev", "test"] = "test"
    n_queries: int = Field(200, ge=1, le=2000)


@app.get("/health")
def health():
    e = _engine
    return {"status": "ok" if e else "degraded", "products": len(e.ids) if e else 0,
            "index_loaded": e is not None, "reranker_loaded": bool(e and e.reranker_loaded)}


def _index_version() -> str:
    """Identity of the loaded index files (mtime of the BM25 dir + FAISS index), for the retrieval span."""
    from engine import DATA
    try:
        return f"bm25@{int((DATA / 'bm25').stat().st_mtime)}+faiss@{int((DATA / 'faiss.index').stat().st_mtime)}"
    except OSError:
        return "unknown"


@app.post("/search")
def search(req: SearchReq, request: Request):
    tp = request.headers.get("traceparent")
    if not tp:
        return engine().search(req.query, req.k, req.mode, req.filters.model_dump(exclude_none=True))
    # Child of the caller's span (policy-mcp -> shop-mcp search_client). Query text is hashed, never stored.
    with sparky_trace.span("retrieval search", "retrieval", traceparent=tp, service="search-svc") as sp:
        q = req.query
        normalised = " ".join(q.split())
        stats: dict = {}
        out = engine().search(req.query, req.k, req.mode, req.filters.model_dump(exclude_none=True), stats=stats)
        sparky_trace.set_attrs(sp, {
            **sparky_trace.redact(q, "sparky.retrieval.query"),
            "sparky.retrieval.mode": req.mode,
            "sparky.retrieval.k": req.k,
            "sparky.retrieval.filters": sorted(req.filters.model_dump(exclude_none=True).keys()),
            "sparky.retrieval.normalise": "none in /search (bm25s tokenizer + stemmer only)",
            "sparky.retrieval.normalise_whitespace_changed": normalised != q,
            "sparky.retrieval.spell": "not applied on /search (did_you_mean is /suggest only)",
            "sparky.retrieval.bm25_count": stats.get("bm25_count"),
            "sparky.retrieval.bm25_ms": stats.get("bm25_ms"),
            "sparky.retrieval.dense_count": stats.get("dense_count"),
            "sparky.retrieval.dense_ms": stats.get("dense_ms"),
            "sparky.retrieval.fusion": "rrf k=60" if "fusion_count" in stats else "none",
            "sparky.retrieval.fusion_count": stats.get("fusion_count"),
            "sparky.retrieval.fusion_ms": stats.get("fusion_ms"),
            "sparky.retrieval.rerank_count": stats.get("rerank_count"),
            "sparky.retrieval.rerank_ms": stats.get("rerank_ms"),
            "sparky.retrieval.topk_ids": stats.get("topk_ids", []),
            "sparky.retrieval.result_count": len(out.get("results", [])),
            "sparky.retrieval.zero_result": not out.get("results"),
            "sparky.retrieval.relaxation": "none: a zero-result search is returned as zero results",
            "sparky.retrieval.index_version": _index_version(),
            "sparky.retrieval.latency_ms": out.get("latency_ms"),
        })
        return out


@app.get("/catalog")
def catalog(category: Optional[str] = None, limit: int = 500):
    """Read-only slice of the live index. Backs shop-mcp's measured agent-readiness score."""
    e = engine()
    items = e.catalog(category, max(1, min(limit, 2000)))
    return {"category": category, "count": len(items), "total_indexed": len(e.ids), "items": items}


@app.get("/product/{product_id}")
def product(product_id: str):
    e = engine()
    if product_id not in e.pos:
        raise HTTPException(404, "product not found")
    return e.product(e.pos[product_id], full=True)


@app.post("/substitutes")
def substitutes(req: SubReq):
    e = engine()
    if req.product_id not in e.pos:
        raise HTTPException(404, "product not found")
    return e.substitutes(req.product_id, req.store_id, req.k)


@app.post("/eval/ndcg")
def eval_ndcg(req: EvalReq):
    return engine().eval_ndcg(req.modes, req.split, req.n_queries)


@app.get("/queries/sample")
def queries_sample(n: int = 20):
    return engine().sample_queries(n)


# ======================= MLOps plane (model versions, eval compare, drift, canary) =======================
from mlops import MLOps  # noqa: E402

_mlops: MLOps | None = None


def mlops() -> MLOps:
    global _mlops
    if _mlops is None:
        _mlops = MLOps(engine())
    return _mlops


class ModelConfig(BaseModel):
    embedding_model: str = "BAAI/bge-small-en-v1.5"
    rrf_k: int = Field(60, ge=1, le=1000)
    w_bm25: float = Field(1.0, ge=0, le=10)
    w_vector: float = Field(1.0, ge=0, le=10)
    reranker: bool = True
    reranker_model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"
    rerank_depth: int = Field(50, ge=10, le=200)
    synonyms: dict[str, list[str]] = {}


class CandidateReq(BaseModel):
    config: ModelConfig
    note: str = ""
    actor: str = "api"


class CompareReq(BaseModel):
    champion: str = "champion"
    candidate: str = "candidate"
    split: Literal["dev", "test"] = "test"
    n_queries: int = Field(200, ge=10, le=1000)


class DriftReq(BaseModel):
    stream: Literal["seasonal", "in_distribution"] = "seasonal"
    window: int = Field(150, ge=30, le=600)
    n_windows: int = Field(6, ge=1, le=12)


class CanaryReq(BaseModel):
    version: str
    traffic_pct: float = Field(10, gt=0, le=100)
    background: bool = True
    actor: str = "api"


class TrafficReq(BaseModel):
    n: int = Field(50, ge=1, le=2000)


class VersionReq(BaseModel):
    version: Optional[str] = None
    reason: str = ""
    actor: str = "api"


class LatencyReq(BaseModel):
    ms: float = Field(..., ge=0, le=5000)


def _kerr(fn):
    try:
        return fn()
    except KeyError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@app.get("/models")
def models():
    return mlops().reg.listing()


@app.post("/models/candidate")
def models_candidate(req: CandidateReq):
    return mlops().create_candidate(req.config.model_dump(), req.note, req.actor)


@app.post("/models/promote")
def models_promote(req: VersionReq):
    if not req.version:
        raise HTTPException(422, "version required")
    return _kerr(lambda: mlops().promote(req.version, req.actor, req.reason))


@app.post("/models/rollback")
def models_rollback(req: VersionReq):
    return _kerr(lambda: mlops().rollback(req.version, req.reason, req.actor))


@app.post("/eval/compare")
def eval_compare(req: CompareReq):
    return _kerr(lambda: mlops().compare(req.champion, req.candidate, req.split, req.n_queries))


@app.post("/drift")
def drift(req: DriftReq):
    return mlops().drift(req.stream, req.window, req.n_windows)


@app.post("/canary")
def canary(req: CanaryReq):
    return _kerr(lambda: mlops().canary_start(req.version, req.traffic_pct, req.background, req.actor))


@app.get("/canary/status")
def canary_status():
    return mlops().canary_status()


@app.post("/canary/traffic")
def canary_traffic(req: TrafficReq):
    """Synchronous replay of n simulated requests (deterministic alternative to the background replay)."""
    return _kerr(lambda: mlops().canary_traffic(req.n))


@app.post("/debug/inject_latency")
def inject_latency(req: LatencyReq):
    mlops().injected_latency_ms = req.ms
    return {"injected_latency_ms": req.ms, "applies_to": "canary arm of simulated traffic"}


# ======================= SOTA techniques 8 / 9 / 10 =======================
# 8  Contextual retrieval      - alternate document representation built by scripts/contextual_enrich.py
# 9  Late-interaction retrieval - ColBERT-style MaxSim over TEXT. ColPali is the VISION variant of this
#                                technique and is NOT run here: no image model, no page rasterisation,
#                                no visual-retrieval claim anywhere in this service.
# 10 Routed GraphRAG           - networkx product graph + rules-first query router
from engine import provenance  # noqa: E402
from graph import ProductGraph  # noqa: E402

_graph: ProductGraph | None = None


def product_graph() -> ProductGraph:
    global _graph
    if _graph is None:
        _graph = ProductGraph(engine())
    return _graph


class VariantSearchReq(BaseModel):
    query: str
    k: int = Field(10, ge=1, le=100)
    variant: Optional[str] = Field(None, description="index variant name; null = baseline index")
    rerank: bool = True
    filters: Filters = Filters()


class LateInteractionReq(BaseModel):
    query: str
    k: int = Field(10, ge=1, le=100)
    depth: int = Field(50, ge=10, le=200, description="first-stage candidates rescored with MaxSim")
    cache_doc_tokens: bool = True
    filters: Filters = Filters()


class TechEvalReq(BaseModel):
    split: Literal["dev", "test"] = "test"
    n_queries: int = Field(200, ge=10, le=2000)
    category: Optional[str] = None
    variant: Optional[str] = None


class GraphReq(BaseModel):
    query: str
    k: int = Field(5, ge=1, le=50)


@app.get("/variants")
def variants():
    """Technique 8: the index variants on disk, with their build lineage and measured cost."""
    return {"variants": engine().variant_listing(), "provenance": provenance("/variants")}


@app.post("/search/variant")
def search_variant(req: VariantSearchReq):
    """Technique 8: the baseline hybrid path run against an alternate document representation.

    variant=null is the baseline index and is numerically identical to /search mode=rrf_rerank.
    """
    e = engine()
    try:
        e.variant(req.variant)
    except KeyError as ex:
        raise HTTPException(404, str(ex))
    order, scores, ms = e.rank_variant(req.query, req.k, req.variant, req.rerank,
                                       req.filters.model_dump(exclude_none=True))
    return {"query": req.query, "variant": req.variant or "baseline", "rerank": req.rerank,
            "latency_ms": round(ms, 1), "results": [e.result(i, scores[i], "rrf_rerank") for i in order],
            "provenance": provenance("/search/variant", req.variant, technique=8,
                                     technique_name="Contextual retrieval")}


@app.post("/search/late_interaction")
def search_late_interaction(req: LateInteractionReq):
    """Technique 9: ColBERT-style multi-vector MaxSim rescoring of the hybrid first stage, over TEXT.

    ColPali is the vision variant of this technique and is NOT run here.
    """
    e = engine()
    order, scores, ms = e.late_interaction(req.query, req.k, req.filters.model_dump(exclude_none=True),
                                           req.depth, req.cache_doc_tokens)
    return {"query": req.query, "depth": req.depth, "latency_ms": round(ms, 1),
            "results": [e.result(i, scores[i], "rrf") for i in order],
            "method": {"scoring": "score(q,d) = sum_i max_j <q_i, d_j> (MaxSim) over L2-normalised token embeddings",
                       "encoder": "BAAI/bge-small-en-v1.5 token embeddings (not a trained ColBERT checkpoint)",
                       "doc_text": "title + brand, identical to the cross-encoder pair text",
                       "colpali": "ColPali is the VISION variant of this technique and is NOT run here - no image "
                                  "model runs in this service and no visual-retrieval claim is made"},
            "provenance": provenance("/search/late_interaction", None, technique=9,
                                     technique_name="Late-interaction retrieval (text)")}


@app.post("/eval/contextual")
def eval_contextual(req: TechEvalReq):
    """Technique 8 measurement: paired NDCG@10, enriched variant vs baseline, on the same held-out queries."""
    e = engine()
    if not req.variant:
        raise HTTPException(422, "variant required")
    try:
        e.variant(req.variant)
    except KeyError as ex:
        raise HTTPException(404, str(ex))
    return _kerr(lambda: mlops().eval_contextual(req.variant, req.split, req.n_queries, req.category))


@app.post("/eval/late_interaction")
def eval_late_interaction(req: TechEvalReq):
    """Technique 9 measurement: paired NDCG@10 and latency, MaxSim vs the current hybrid+rerank path."""
    return mlops().eval_late_interaction(req.split, req.n_queries, req.category)


@app.get("/graph/stats")
def graph_stats():
    """Technique 10: the built networkx product graph, its edge counts and their data sources."""
    g = product_graph()
    return {"graph": g.stats, "provenance": provenance("/graph/stats", None, technique=10,
                                                       technique_name="Routed GraphRAG")}


@app.post("/graph/route")
def graph_route(req: GraphReq):
    """Technique 10: route the query, then answer from the graph or from hybrid retrieval."""
    a = product_graph().answer(req.query, req.k)
    a["provenance"] = provenance("/graph/route", None, technique=10, technique_name="Routed GraphRAG",
                                 route=a["routing"]["route"])
    return a


@app.get("/graph/eval")
def graph_eval():
    """Technique 10 measurement: router precision/recall + graph hit rate on the hand-labelled set.

    The eval set is hand-labelled by an LLM and has 30 queries; the response carries that caveat.
    """
    r = product_graph().evaluate()
    r["provenance"] = provenance("/graph/eval", None, technique=10, technique_name="Routed GraphRAG")
    return r


@app.on_event("shutdown")
def _shutdown():
    if _mlops:
        _mlops.canary_stop("shutdown")


# ======================= Storefront additions: suggest + intent routing =======================
import difflib  # noqa: E402
import re as _re  # noqa: E402
from collections import Counter  # noqa: E402

from graph import route as _route  # noqa: E402

_suggest_cache: dict = {}
_TOK = _re.compile(r"[a-z][a-z']+")


def _suggest_data():
    """Real ESCI query strings (data/queries.parquet) + title vocabulary of the live index. Built once."""
    if not _suggest_cache:
        e = engine()
        qs = sorted({str(q).strip().lower() for q in e.queries["query"].tolist() if str(q).strip()})
        vocab = Counter()
        for t in e.products["title"].tolist():
            vocab.update(w for w in _TOK.findall(str(t).lower()) if len(w) >= 3)
        by_initial: dict[str, list[str]] = {}
        for w, c in vocab.items():
            if c >= 2:
                by_initial.setdefault(w[0], []).append(w)
        _suggest_cache.update(queries=qs, vocab=vocab, by_initial=by_initial)
    return _suggest_cache


def did_you_mean(q: str) -> str | None:
    d = _suggest_data()
    vocab, changed, out = d["vocab"], False, []
    for tok in _re.findall(r"\S+", q.lower()):
        w = tok.strip("¿?¡!.,;:\"'")
        if len(w) < 4 or not w.isalpha() or vocab.get(w, 0) >= 2:
            out.append(tok)
            continue
        cands = difflib.get_close_matches(w, d["by_initial"].get(w[0], []), n=3, cutoff=0.8)
        if cands:
            best = max(cands, key=lambda c: (difflib.SequenceMatcher(None, w, c).ratio(), vocab[c]))
            out.append(tok.replace(w, best))
            changed = True
        else:
            out.append(tok)
    return " ".join(out) if changed else None


@app.get("/suggest")
def suggest(q: str = "", n: int = 8):
    """Completions = prefix matches over the real ESCI query log; did_you_mean = difflib token
    correction against the indexed title vocabulary (null when nothing needs correcting)."""
    d = _suggest_data()
    n = max(1, min(n, 25))
    qn = q.strip().lower()
    comps: list[str] = []
    if qn:
        comps = [x for x in d["queries"] if x.startswith(qn) and x != qn][:n]
        if len(comps) < n:
            comps += [x for x in d["queries"] if f" {qn}" in f" {x}" and x not in comps and x != qn][: n - len(comps)]
    return {"q": q, "completions": comps, "did_you_mean": did_you_mean(qn) if qn else None,
            "source": {"completions": "ESCI queries (data/queries.parquet)",
                       "did_you_mean": "difflib vs index title vocabulary"}}


class IntentReq(BaseModel):
    query: str


@app.post("/route/intent")
def route_intent(req: IntentReq):
    """Rules-only intent decision (graph.route). Does not load the graph."""
    return _route(req.query)
