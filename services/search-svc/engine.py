"""Search engine: BM25 (bm25s) + dense (bge-small / FAISS) + RRF(k=60) + lazy cross-encoder rerank.

NDCG/RRF logic mirrors Search/sample_data/demo_rrf_and_ndcg.py.
"""
from __future__ import annotations

import math
import os
import time
from collections import defaultdict
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")  # torch + faiss both ship libomp on macOS
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np
import pandas as pd
import torch  # noqa: F401  import before faiss to avoid OpenMP segfault
from sentence_transformers import CrossEncoder, SentenceTransformer  # noqa: F401

torch.set_num_threads(min(8, os.cpu_count() or 4))
ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get("SPARKY_DATA", ROOT / "data"))
STORES = ["4108", "2231", "5360"]
K_RRF, DEPTH, RERANK_DEPTH = 60, 100, 50
VARIANTS = DATA / "variants"          # technique 8: alternate document representations
LI_DEPTH, LI_MAX_TOKENS = 50, 48      # technique 9: late-interaction rescoring window / token cap
SERVICE = "search-svc"
EMB_MODEL = "BAAI/bge-small-en-v1.5"
RERANK_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


def provenance(endpoint: str, index_variant: str | None = None, **extra) -> dict:
    """Response provenance block for the technique endpoints: who answered, from which index, when.

    The four original endpoints (/search, /substitutes, /eval/ndcg, /queries/sample) keep their exact
    response shape because bff and shop-mcp are pinned to it; this block is added only on the new
    endpoints, where nothing is pinned yet.
    """
    return {"service": SERVICE, "endpoint": endpoint, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "index_variant": index_variant or "baseline", "embedding_model": EMB_MODEL,
            "catalogue": "ESCI US subset, data/products.parquet", **extra}


def doc_text(row) -> str:
    return f"{row['title']} | {row['brand']} | {str(row.get('bullets') or '')[:400]}"


def rrf(*lists):
    s = defaultdict(float)
    for lst in lists:
        for r, iid in enumerate(lst, 1):
            s[iid] += 1 / (K_RRF + r)
    return [i for i, _ in sorted(s.items(), key=lambda x: -x[1])], s


def ndcg10(grades: dict, ranked: list):
    """grades: product_id -> gain for one query. Exponential gain, as in demo_rrf_and_ndcg.py."""
    dcg = sum((2 ** grades.get(i, 0) - 1) / math.log2(r + 1) for r, i in enumerate(ranked[:10], 1))
    ideal = sorted(grades.values(), reverse=True)[:10]
    idcg = sum((2 ** g - 1) / math.log2(r + 1) for r, g in enumerate(ideal, 1))
    return dcg / idcg if idcg else None


def mrr(grades: dict, ranked: list, min_gain: int = 3):
    for r, i in enumerate(ranked[:10], 1):
        if grades.get(i, 0) >= min_gain:
            return 1.0 / r
    return 0.0


class Engine:
    def __init__(self):
        import bm25s
        import faiss
        import Stemmer

        self.products = pd.read_parquet(DATA / "products.parquet")
        self.ids = self.products["product_id"].tolist()
        self.pos = {p: i for i, p in enumerate(self.ids)}
        self.stemmer = Stemmer.Stemmer("english")
        self.bm25 = bm25s.BM25.load(str(DATA / "bm25"))
        self.faiss_index = faiss.read_index(str(DATA / "faiss.index"))
        self.emb = np.load(DATA / "embeddings.npy")
        from sentence_transformers import SentenceTransformer

        self.encoder = SentenceTransformer(EMB_MODEL, device="cpu")
        self._reranker = None
        p = self.products
        self.cat = p["category"].to_numpy()
        self.price = p["price"].to_numpy()
        self.stock = {s: p[f"stock_{s}"].to_numpy() for s in STORES}
        self.diet = [set(d) for d in p["dietary"]]
        self.queries = pd.read_parquet(DATA / "queries.parquet")
        self.qrels = {s: pd.read_parquet(DATA / f"qrels_{s}.parquet") for s in ("dev", "test")}

    # ---------------- models ----------------
    @property
    def reranker_loaded(self) -> bool:
        return self._reranker is not None

    def reranker(self):
        if self._reranker is None:
            from sentence_transformers import CrossEncoder

            self._reranker = CrossEncoder(RERANK_MODEL, device="cpu")
        return self._reranker

    # ---------------- filters ----------------
    def mask(self, f: dict | None):
        if not f:
            return None
        m = np.ones(len(self.ids), dtype=bool)
        if f.get("category"):
            m &= self.cat == f["category"]
        if f.get("max_price") is not None:
            m &= self.price <= f["max_price"]
        if f.get("dietary"):
            want = set(f["dietary"])
            m &= np.array([want <= d for d in self.diet])
        if f.get("in_stock_only"):
            sid = f.get("store_id")
            if sid and sid in self.stock:
                m &= self.stock[sid] > 0
            else:
                m &= np.any(np.stack([self.stock[s] for s in STORES]) > 0, axis=0)
        return m

    # ---------------- retrievers ----------------
    def bm25_scores(self, query: str):
        import bm25s

        toks = bm25s.tokenize([query], stemmer=self.stemmer, show_progress=False)
        vocab_inv = {v: k for k, v in toks.vocab.items()}
        words = [vocab_inv[t] for t in toks.ids[0]]
        return self.bm25.get_scores(words) if words else np.zeros(len(self.ids), dtype=np.float32)

    def bm25_top(self, query, m, depth=DEPTH):
        sc = self.bm25_scores(query).astype(np.float32)
        if m is not None:
            sc = np.where(m, sc, -1)
        idx = np.argsort(-sc)[:depth]
        return [(int(i), float(sc[i])) for i in idx if sc[i] > 0]

    def encode_query(self, query):
        return self.encoder.encode([QUERY_PREFIX + query], normalize_embeddings=True).astype(np.float32)

    def vector_top(self, query, m, depth=DEPTH, qv=None):
        qv = self.encode_query(query) if qv is None else qv
        if m is None:
            D, I = self.faiss_index.search(qv, depth)
            return [(int(i), float(d)) for i, d in zip(I[0], D[0]) if i >= 0]
        sc = self.emb @ qv[0]
        sc = np.where(m, sc, -9)
        idx = np.argsort(-sc)[:depth]
        return [(int(i), float(sc[i])) for i in idx if sc[i] > -9]

    # ---------------- search ----------------
    def search(self, query: str, k: int = 10, mode: str = "rrf_rerank", filters: dict | None = None, stats: dict | None = None):
        """`stats`, when given, is filled with per-leg counts and timings for the retrieval span (sparky_trace)."""
        t0 = time.perf_counter()
        st = stats if stats is not None else {}
        m = self.mask(filters)
        st["mask_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        scores: dict[int, dict] = defaultdict(dict)
        bm = vec = None
        if mode in ("bm25", "rrf", "rrf_rerank"):
            t = time.perf_counter()
            bm = self.bm25_top(query, m)
            st["bm25_ms"], st["bm25_count"] = round((time.perf_counter() - t) * 1000, 2), len(bm)
            for r, (i, s) in enumerate(bm, 1):
                scores[i]["bm25"] = round(s, 4)
                scores[i]["_bm25_rank"] = r
        if mode in ("vector", "rrf", "rrf_rerank"):
            t = time.perf_counter()
            vec = self.vector_top(query, m)
            st["dense_ms"], st["dense_count"] = round((time.perf_counter() - t) * 1000, 2), len(vec)
            for r, (i, s) in enumerate(vec, 1):
                scores[i]["vector"] = round(s, 4)
                scores[i]["_vec_rank"] = r
        if mode == "bm25":
            order = [i for i, _ in bm]
        elif mode == "vector":
            order = [i for i, _ in vec]
        else:
            t = time.perf_counter()
            order, fused = rrf([i for i, _ in bm], [i for i, _ in vec])
            for i in order:
                scores[i]["rrf"] = round(fused[i], 5)
            st["fusion_ms"], st["fusion_count"] = round((time.perf_counter() - t) * 1000, 2), len(order)
            if mode == "rrf_rerank" and order:
                t = time.perf_counter()
                cand = order[:max(RERANK_DEPTH, k)]
                p = self.products
                pairs = [(query, f"{p.at[i, 'title']} {p.at[i, 'brand']}") for i in cand]
                rs = self.reranker().predict(pairs, batch_size=64, show_progress_bar=False)
                for i, s in zip(cand, rs):
                    scores[i]["rerank"] = round(float(s), 4)
                order = [i for i, _ in sorted(zip(cand, rs), key=lambda x: -x[1])]
                st["rerank_ms"], st["rerank_count"] = round((time.perf_counter() - t) * 1000, 2), len(cand)
        results = [self.result(i, scores[i], mode) for i in order[:k]]
        st["topk_ids"] = [self.ids[i] for i in order[:k]]
        return {"query": query, "mode": mode, "latency_ms": round((time.perf_counter() - t0) * 1000, 1), "results": results}

    def explain(self, sc: dict, mode: str) -> str:
        parts = []
        if "_bm25_rank" in sc:
            parts.append(f"BM25 #{sc['_bm25_rank']} ({sc['bm25']:.2f})")
        elif mode in ("bm25", "rrf", "rrf_rerank"):
            parts.append("no BM25 match")
        if "_vec_rank" in sc:
            parts.append(f"vector #{sc['_vec_rank']} (cos {sc['vector']:.3f})")
        if "rrf" in sc:
            parts.append(f"RRF k=60 -> {sc['rrf']:.4f}")
        if "rerank" in sc:
            parts.append(f"cross-encoder {sc['rerank']:.2f}")
        return "; ".join(parts)

    def product(self, i: int, full: bool = False) -> dict:
        r = self.products.iloc[i]
        d = {
            "product_id": r["product_id"], "title": r["title"], "brand": r["brand"], "category": r["category"],
            "price": round(float(r["price"]), 2), "rating": float(r["rating"]), "dietary": list(r["dietary"]),
            "image": r["image"], "sponsored": bool(r["sponsored"]),
            "stock": {s: int(r[f"stock_{s}"]) for s in STORES}, "synthetic": True,
        }
        if r["sponsored"]:
            d["ad_id"] = r["ad_id"]
        if full:
            d["description"] = r["description"]
            d["bullets"] = [b.strip() for b in str(r["bullets"]).split("\n") if b.strip()]
            d["rating_count"] = int(r["rating_count"])
            # Third-party marketplace copy planted by scripts/plant_injections.py. Never merged
            # into description/bullets: it stays a separate field so shop-mcp can quarantine it.
            seller = str(r["untrusted_seller_text"]) if "untrusted_seller_text" in self.products.columns else ""
            if seller and seller.lower() != "nan":
                d["untrusted_seller_text"] = seller
                d["seller_type"] = "3P"
        return d

    def catalog(self, category: str | None = None, limit: int = 500) -> list[dict]:
        """Every indexed product (optionally filtered by category), with the full record.

        Read-only. shop-mcp's agent-readiness score is computed over this so the score is a
        real measurement of the live catalogue rather than a constant.
        """
        out = []
        for i in range(len(self.products)):
            if category and category.lower() not in str(self.products.at[int(i), "category"]).lower():
                continue
            out.append(self.product(i, full=True))
            if len(out) >= limit:
                break
        return out

    def result(self, i: int, sc: dict, mode: str) -> dict:
        d = self.product(i)
        d["scores"] = {k: v for k, v in sc.items() if not k.startswith("_")}
        d["rank_explain"] = self.explain(sc, mode) + (" [SPONSORED]" if d["sponsored"] else "")
        return d

    # ---------------- substitutes ----------------
    def substitutes(self, product_id: str, store_id: str | None, k: int = 5):
        i0 = self.pos[product_id]
        base_price, base_diet, base_cat = self.price[i0], self.diet[i0], self.cat[i0]
        sims = self.emb @ self.emb[i0]
        sims[i0] = -9
        sims = np.where(self.cat == base_cat, sims, sims - 0.15)
        cand = np.argsort(-sims)[:200]
        out = []
        for j in cand:
            if self.products.at[int(j), "title"] == self.products.at[i0, "title"]:
                continue
            sim = float(self.emb[j] @ self.emb[i0])
            pdelta = float((self.price[j] - base_price) / base_price)
            dmatch = 1.0 if not base_diet else len(base_diet & self.diet[j]) / len(base_diet)
            if store_id in self.stock:
                ins = 1.0 if self.stock[store_id][j] > 0 else 0.0
            else:
                ins = 1.0 if any(self.stock[s][j] > 0 for s in STORES) else 0.0
            score = 0.5 * sim + 0.2 * max(0.0, 1 - abs(pdelta)) + 0.15 * dmatch + 0.15 * ins
            d = self.product(int(j))
            d["sub_score"] = round(score, 4)
            d["components"] = {"similarity": round(sim, 4), "price_delta": round(pdelta, 4),
                               "dietary_match": round(dmatch, 3), "in_stock": bool(ins)}
            out.append(d)
        out.sort(key=lambda x: -x["sub_score"])
        return out[:k]

    # ---------------- eval ----------------
    def eval_ndcg(self, modes, split="test", n_queries=200):
        qr = self.qrels[split]
        grades = {q: dict(zip(g.product_id, g.gain)) for q, g in qr.groupby("query_id")}
        qids = [q for q in self.queries[self.queries.split == split].sort_values("query_id").query_id if q in grades]
        qids = [q for q in qids if max(grades[q].values()) > 0][:n_queries]
        qtext = dict(zip(self.queries.query_id, self.queries["query"]))
        rows = []
        for mode in modes:
            nd, rr, lat = [], [], []
            for q in qids:
                res = self.search(qtext[q], k=10, mode=mode)
                ranked = [r["product_id"] for r in res["results"]]
                v = ndcg10(grades[q], ranked)
                if v is None:
                    continue
                nd.append(v)
                rr.append(mrr(grades[q], ranked))
                lat.append(res["latency_ms"])
            rows.append({"mode": mode, "ndcg10": round(float(np.mean(nd)), 4), "mrr": round(float(np.mean(rr)), 4),
                         "latency_p50_ms": round(float(np.median(lat)), 1)})
        return {"rows": rows, "n_queries": len(qids)}

    def sample_queries(self, n=20):
        q = self.queries[self.queries.split == "test"]
        nw = q["query"].str.split().str.len()
        # hard but demo-able: several relevant items, plenty of distractors, 3-9 words, no author/book-style queries
        q = q[(q.n_relevant >= 3) & (q.frac_irrelevant.between(0.15, 0.7)) & nw.between(3, 9)
              & ~q["query"].str.contains(r"\bby\b|\bbook\b|\bnovel\b|\bboots?\b|\bshoes?\b", regex=True)]
        q = q.sort_values(["difficulty", "query_id"], ascending=[False, True])
        return [{"query_id": int(r.query_id), "query": r.query, "category": r.category, "difficulty": float(r.difficulty),
                 "n_judged": int(r.n_judged), "n_relevant": int(r.n_relevant)} for r in q.head(n).itertuples()]

    # ---------------- config-driven ranking (model versions, MLOps plane) ----------------
    def _embedder(self, model: str):
        """(encoder, doc-embedding matrix). Default model reuses the cached index; others are embedded once and cached."""
        if model == EMB_MODEL:
            return self.encoder, self.emb
        cache = getattr(self, "_embedders", None)
        if cache is None:
            cache = self._embedders = {}
        if model not in cache:
            from sentence_transformers import SentenceTransformer

            enc = SentenceTransformer(model, device="cpu")
            f = DATA / "emb_cache" / (model.replace("/", "__") + ".npy")
            if f.exists():
                emb = np.load(f)
            else:
                texts = [doc_text(r) for _, r in self.products.iterrows()]
                emb = enc.encode(texts, batch_size=128, normalize_embeddings=True, show_progress_bar=False).astype(np.float32)
                f.parent.mkdir(parents=True, exist_ok=True)
                np.save(f, emb)
            cache[model] = (enc, emb)
        return cache[model]

    def _cross(self, model: str):
        if model == RERANK_MODEL:
            return self.reranker()
        cache = getattr(self, "_crosses", None)
        if cache is None:
            cache = self._crosses = {}
        if model not in cache:
            from sentence_transformers import CrossEncoder

            cache[model] = CrossEncoder(model, device="cpu")
        return cache[model]

    @staticmethod
    def expand_synonyms(query: str, synonyms: dict | None) -> str:
        if not synonyms:
            return query
        q = query.lower()
        extra = [s for term, syns in synonyms.items() if term.lower() in q for s in syns]
        return query + (" " + " ".join(extra) if extra else "")

    def rank_cfg(self, query: str, cfg: dict, k: int = 10, filters: dict | None = None):
        """Rank with a model-version config. Returns (ordered indices, per-index scores, latency_ms)."""
        t0 = time.perf_counter()
        m = self.mask(filters)
        scores: dict[int, dict] = defaultdict(dict)
        bm = self.bm25_top(self.expand_synonyms(query, cfg.get("synonyms")), m)
        model = cfg.get("embedding_model", EMB_MODEL)
        if model == EMB_MODEL:
            vec = self.vector_top(query, m)
        else:
            enc, emb = self._embedder(model)
            prefix = QUERY_PREFIX if "bge" in model else ""
            qv = enc.encode([prefix + query], normalize_embeddings=True).astype(np.float32)
            sc = emb @ qv[0]
            if m is not None:
                sc = np.where(m, sc, -9)
            idx = np.argsort(-sc)[:DEPTH]
            vec = [(int(i), float(sc[i])) for i in idx if sc[i] > -9]
        kk, wb, wv = cfg.get("rrf_k", K_RRF), cfg.get("w_bm25", 1.0), cfg.get("w_vector", 1.0)
        fused = defaultdict(float)
        for r, (i, s) in enumerate(bm, 1):
            fused[i] += wb / (kk + r)
            scores[i].update(bm25=round(s, 4), _bm25_rank=r)
        for r, (i, s) in enumerate(vec, 1):
            fused[i] += wv / (kk + r)
            scores[i].update(vector=round(s, 4), _vec_rank=r)
        order = [i for i, _ in sorted(fused.items(), key=lambda x: -x[1])]
        for i in order:
            scores[i]["rrf"] = round(fused[i], 5)
        if cfg.get("reranker", True) and order:
            cand = order[:max(int(cfg.get("rerank_depth", RERANK_DEPTH)), k)]
            p = self.products
            pairs = [(query, f"{p.at[i, 'title']} {p.at[i, 'brand']}") for i in cand]
            rs = self._cross(cfg.get("reranker_model", RERANK_MODEL)).predict(pairs, batch_size=64, show_progress_bar=False)
            for i, s in zip(cand, rs):
                scores[i]["rerank"] = round(float(s), 4)
            order = [i for i, _ in sorted(zip(cand, rs), key=lambda x: -x[1])]
        return order[:k], scores, (time.perf_counter() - t0) * 1000

    def eval_qids(self, split: str, n_queries: int):
        qr = self.qrels[split]
        grades = {q: dict(zip(g.product_id, g.gain)) for q, g in qr.groupby("query_id")}
        qids = [q for q in self.queries[self.queries.split == split].sort_values("query_id").query_id if q in grades]
        qids = [q for q in qids if max(grades[q].values()) > 0][:n_queries]
        return qids, grades

    # ======================= technique 8: contextual retrieval (variant indexes) =======================
    def variant(self, name: str | None) -> "VariantIndex | None":
        """Load (and cache) an alternate document representation built by scripts/contextual_enrich.py.

        `None` is the baseline index. A variant swaps the DOCUMENT side of first-stage retrieval
        (dense embeddings and, if present, BM25); the query encoder, the RRF fusion and the
        cross-encoder pair text are identical to the baseline, so the variant is the only thing
        that changes between the two arms of the measurement.
        """
        if not name:
            return None
        cache = getattr(self, "_variants", None)
        if cache is None:
            cache = self._variants = {}
        if name not in cache:
            cache[name] = VariantIndex(VARIANTS / name, self)
        return cache[name]

    def variant_listing(self) -> list[dict]:
        out = []
        if VARIANTS.exists():
            for d in sorted(VARIANTS.iterdir()):
                f = d / "manifest.json"
                if f.is_dir() or not f.exists():
                    continue
                import json

                m = json.loads(f.read_text())
                out.append({"name": m.get("name", d.name), "technique": m.get("technique"),
                            "slice": m.get("slice"), "results": m.get("results"), "cost": m.get("cost"),
                            "generated_at": m.get("generated_at"), "loaded": bool(getattr(self, "_variants", {}).get(d.name))})
        return out

    def rank_variant(self, query: str, k: int = 10, variant: str | None = None, rerank: bool = True,
                     filters: dict | None = None, depth: int = DEPTH):
        """Baseline hybrid path, parameterised by document representation. variant=None == baseline.

        Returns (ordered indices, per-index score dicts, latency_ms). With variant=None and
        rerank=True this is numerically identical to search(mode="rrf_rerank").
        """
        t0 = time.perf_counter()
        v = self.variant(variant)
        m = self.mask(filters)
        scores: dict[int, dict] = defaultdict(dict)
        bm = v.bm25_top(query, m, depth) if (v and v.bm25 is not None) else self.bm25_top(query, m, depth)
        qv = self.encode_query(query)
        if v is not None:
            sc = v.emb @ qv[0]
            if m is not None:
                sc = np.where(m, sc, -9)
            idx = np.argsort(-sc)[:depth]
            vec = [(int(i), float(sc[i])) for i in idx if sc[i] > -9]
        else:
            vec = self.vector_top(query, m, depth, qv=qv)
        for r, (i, s) in enumerate(bm, 1):
            scores[i].update(bm25=round(s, 4), _bm25_rank=r)
        for r, (i, s) in enumerate(vec, 1):
            scores[i].update(vector=round(s, 4), _vec_rank=r)
        order, fused = rrf([i for i, _ in bm], [i for i, _ in vec])
        for i in order:
            scores[i]["rrf"] = round(fused[i], 5)
        if rerank and order:
            cand = order[:max(RERANK_DEPTH, k)]
            p = self.products
            pairs = [(query, f"{p.at[i, 'title']} {p.at[i, 'brand']}") for i in cand]
            rs = self.reranker().predict(pairs, batch_size=64, show_progress_bar=False)
            for i, s in zip(cand, rs):
                scores[i]["rerank"] = round(float(s), 4)
            order = [i for i, _ in sorted(zip(cand, rs), key=lambda x: -x[1])]
        return order[:k], scores, (time.perf_counter() - t0) * 1000

    # ======================= technique 9: late interaction (ColBERT-style MaxSim over TEXT) ==========
    #
    # HONEST LABEL: this is the TEXT late-interaction variant. ColPali is the VISION variant of this
    # technique (page images -> patch embeddings) and is NOT run here: no image model runs anywhere in
    # this repository, no page is rasterised, and no claim in this codebase is a visual-retrieval
    # result. What is implemented is ColBERTv2-style MaxSim, score(q, d) = sum_i max_j <q_i, d_j>,
    # using token-level embeddings from the SAME bge-small encoder the dense index already loads.
    # No separate ColBERT checkpoint is downloaded: a real ColBERT model would need its own
    # [Q]/[D] marker tokens and a 128-d projection it was trained with, and borrowing one of those
    # checkpoints without its trained projection would be a worse, not a better, experiment.
    # Consequence, stated up front: bge-small token vectors are not TRAINED for late interaction,
    # so this measures the technique's SHAPE (multi-vector MaxSim rescoring of first-stage
    # candidates), not the quality a trained ColBERT checkpoint would reach.

    def token_embeddings(self, texts: list[str], is_query: bool = False, max_tokens: int = LI_MAX_TOKENS):
        """Per-token, L2-normalised embeddings from the dense encoder; special tokens dropped."""
        out = self.encoder.encode([(QUERY_PREFIX + t) if is_query else t for t in texts],
                                  output_value="token_embeddings", batch_size=32, show_progress_bar=False)
        vecs = []
        for t in out:
            a = t.detach().cpu().numpy().astype(np.float32)
            if len(a) > 2:
                a = a[1:-1]  # drop [CLS]/[SEP]
            a = a[:max_tokens]
            n = np.linalg.norm(a, axis=1, keepdims=True)
            vecs.append(a / np.maximum(n, 1e-9))
        return vecs

    def _doc_tokens(self, idx: list[int], cache: bool) -> dict:
        """Token embeddings for candidate documents. cache=False is the honest cold path used when
        measuring latency; cache=True is what a served deployment would do."""
        p = self.products

        def encode(items):
            return dict(zip(items, self.token_embeddings([f"{p.at[i, 'title']} {p.at[i, 'brand']}" for i in items])))

        if not cache:
            return encode(idx)
        store = getattr(self, "_li_cache", None)
        if store is None:
            store = self._li_cache = {}
        miss = [i for i in idx if i not in store]
        if miss:
            store.update(encode(miss))
        return {i: store[i] for i in idx}

    @staticmethod
    def maxsim(q: np.ndarray, d: np.ndarray) -> float:
        """score(q, d) = sum over query tokens of max over document tokens of cosine similarity."""
        with np.errstate(over="ignore", invalid="ignore", divide="ignore"):  # spurious Accelerate FP warnings on macOS
            return float((q @ d.T).max(axis=1).sum())

    def late_interaction(self, query: str, k: int = 10, filters: dict | None = None,
                         depth: int = LI_DEPTH, cache: bool = True):
        """First stage = the SAME BM25+dense RRF as the baseline; second stage = MaxSim instead of the
        cross-encoder. Only the rescorer differs, so the delta is attributable to late interaction."""
        t0 = time.perf_counter()
        m = self.mask(filters)
        bm = self.bm25_top(query, m)
        vec = self.vector_top(query, m)
        order, fused = rrf([i for i, _ in bm], [i for i, _ in vec])
        if not order:
            return [], {}, (time.perf_counter() - t0) * 1000
        cand = order[:max(depth, k)]
        qt = self.token_embeddings([query], is_query=True)[0]
        docs = self._doc_tokens(cand, cache)
        scores: dict[int, dict] = defaultdict(dict)
        ms = {i: self.maxsim(qt, docs[i]) for i in cand}
        for r, (i, s) in enumerate(bm, 1):
            scores[i].update(bm25=round(s, 4), _bm25_rank=r)
        for r, (i, s) in enumerate(vec, 1):
            scores[i].update(vector=round(s, 4), _vec_rank=r)
        for i in cand:
            scores[i].update(rrf=round(fused[i], 5), maxsim=round(ms[i], 4),
                             maxsim_norm=round(ms[i] / max(1, len(qt)), 4))
        ranked = sorted(cand, key=lambda i: -ms[i])
        return ranked[:k], scores, (time.perf_counter() - t0) * 1000


    # ---------------- paired eval used by techniques 8 and 9 ----------------
    def _eval_slice(self, split: str, n_queries: int, category: str | None):
        qids, grades = self.eval_qids(split, n_queries)
        if category:
            q = self.queries.set_index("query_id")
            qids = [i for i in qids if q.at[i, "category"] == category]
        qtext = dict(zip(self.queries.query_id, self.queries["query"]))
        return qids, grades, qtext

    def paired_eval(self, arms: dict, split: str = "test", n_queries: int = 200, category: str | None = None) -> dict:
        """Score several ranking arms on the SAME held-out queries, per query, so deltas can be paired.

        `arms` maps an arm name to a callable(query) -> (ordered indices, scores, latency_ms).
        NDCG@10 is engine.ndcg10 - the exact function the existing /eval/ndcg and mlops.compare use -
        so the numbers are directly comparable to everything else in this repo.
        """
        import numpy as np

        qids, grades, qtext = self._eval_slice(split, n_queries, category)
        per = {a: {"qids": [], "ndcg": [], "mrr": [], "lat": []} for a in arms}
        for q in qids:
            for name, fn in arms.items():
                order, _, ms = fn(qtext[q])
                ranked = [self.ids[i] for i in order]
                v = ndcg10(grades[q], ranked)
                if v is None:
                    continue
                per[name]["qids"].append(int(q))
                per[name]["ndcg"].append(v)
                per[name]["mrr"].append(mrr(grades[q], ranked))
                per[name]["lat"].append(ms)
        common = sorted(set.intersection(*[set(p["qids"]) for p in per.values()])) if per else []
        out = {"split": split, "category": category, "n_queries_scanned": len(qids), "n_queries_scored": len(common),
               "query_ids": common, "arms": {}, "per_query_ndcg": {}}
        for name, p in per.items():
            idx = [p["qids"].index(q) for q in common]
            nd = np.array(p["ndcg"])[idx]
            rr = np.array(p["mrr"])[idx]
            lat = np.array(p["lat"])[idx]
            out["arms"][name] = {"ndcg10": round(float(nd.mean()), 4), "mrr": round(float(rr.mean()), 4),
                                 "latency_p50_ms": round(float(np.percentile(lat, 50)), 1),
                                 "latency_p95_ms": round(float(np.percentile(lat, 95)), 1),
                                 "latency_mean_ms": round(float(lat.mean()), 1)}
            out["per_query_ndcg"][name] = nd.tolist()
        return out


class VariantIndex:
    """An alternate document representation: variant dense embeddings + optional variant BM25."""

    def __init__(self, path: Path, engine: Engine):
        import json

        self.path = Path(path)
        if not (self.path / "manifest.json").exists():
            raise KeyError(f"unknown index variant {self.path.name}")
        self.manifest = json.loads((self.path / "manifest.json").read_text())
        self.name = self.manifest.get("name", self.path.name)
        self.emb = np.load(self.path / "emb.npy")
        if self.emb.shape[0] != len(engine.ids):
            raise RuntimeError(f"variant {self.name}: {self.emb.shape[0]} rows for {len(engine.ids)} products")
        self.bm25 = None
        if (self.path / "bm25").exists():
            import bm25s

            self.bm25 = bm25s.BM25.load(str(self.path / "bm25"))
        self.stemmer = engine.stemmer
        self._n = len(engine.ids)

    def bm25_scores(self, query: str):
        import bm25s

        toks = bm25s.tokenize([query], stemmer=self.stemmer, show_progress=False)
        inv = {v: k for k, v in toks.vocab.items()}
        words = [inv[t] for t in toks.ids[0]]
        return self.bm25.get_scores(words) if words else np.zeros(self._n, dtype=np.float32)

    def bm25_top(self, query, m, depth=DEPTH):
        sc = self.bm25_scores(query).astype(np.float32)
        if m is not None:
            sc = np.where(m, sc, -1)
        idx = np.argsort(-sc)[:depth]
        return [(int(i), float(sc[i])) for i in idx if sc[i] > 0]
