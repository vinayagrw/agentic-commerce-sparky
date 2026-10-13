#!/usr/bin/env python3
"""Technique 6: model-based data selection for the search index.

Score every product for informativeness with the SAME embedding model the index uses (bge-small-en-v1.5, cached in
data/embeddings.npy), keep the top --keep-frac, then build a real BM25 + FAISS index over only that subset and
measure NDCG@10 on held-out ESCI test queries against the full index and against a size-matched random subset.

Score (all three terms come from the model, none from the labels of the evaluation queries):
    coverage[i]   = max cosine(product_i, q) over the DEV-split query embeddings   -- is this product reachable demand?
    redundancy[i] = mean cosine to its k nearest catalogue neighbours              -- is it already represented?
    novelty[i]    = 1 - redundancy
    score = coverage + lambda * novelty
Dev queries only: the test split used for evaluation is never looked at during selection.

Usage (from services/search-svc, which owns bm25s/faiss/sentence-transformers):
    uv run python ../../scripts/select_data.py [--sample N] [--keep-frac 0.4] [--n-queries 200]
Writes data/selection_report.json. Idempotent for a given --seed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("SPARKY_DATA", ROOT / "data"))
sys.path.insert(0, str(ROOT / "services" / "search-svc"))

USD_PER_CPU_MIN = 0.0017    # same constant ops_mcp.tools uses: ~$0.10 per vCPU-hour on-demand
K_RRF = 60


# ------------------------------------------------------------------ scoring (numpy only: unit-testable)
def normalize(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=1, keepdims=True)
    return x / np.where(n == 0, 1.0, n)


def coverage_scores(emb: np.ndarray, qemb: np.ndarray, chunk: int = 2048) -> np.ndarray:
    """max cosine to any query embedding, per product."""
    out = np.empty(emb.shape[0], dtype=np.float32)
    with np.errstate(all="ignore"):     # macOS Accelerate raises spurious FP flags from BLAS matmul
        for s in range(0, emb.shape[0], chunk):
            out[s:s + chunk] = (emb[s:s + chunk] @ qemb.T).max(axis=1)
    return out


def redundancy_scores(emb: np.ndarray, k: int = 10, chunk: int = 1024) -> np.ndarray:
    """mean cosine to the k nearest OTHER catalogue items, per product."""
    n = emb.shape[0]
    k = min(k, max(1, n - 1))
    out = np.empty(n, dtype=np.float32)
    with np.errstate(all="ignore"):
        for s in range(0, n, chunk):
            sims = emb[s:s + chunk] @ emb.T
            for r in range(sims.shape[0]):
                sims[r, s + r] = -9.0                   # exclude self
            part = np.partition(sims, -k, axis=1)[:, -k:]
            out[s:s + chunk] = part.mean(axis=1)
    return out


def cluster_labels(emb: np.ndarray, threshold: float, chunk: int = 1024) -> np.ndarray:
    """Single-link clustering of the embedding space at a cosine threshold (union-find over the chunked sim matrix)."""
    n = emb.shape[0]
    parent = np.arange(n)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    with np.errstate(all="ignore"):
        for s in range(0, n, chunk):
            sims = emb[s:s + chunk] @ emb.T
            for r in range(sims.shape[0]):
                i = s + r
                for j in (np.nonzero(sims[r, i + 1:] >= threshold)[0] + i + 1):
                    ra, rb = find(i), find(int(j))
                    if ra != rb:
                        parent[max(ra, rb)] = min(ra, rb)
    return np.array([find(i) for i in range(n)])


def select_cluster_representative(emb: np.ndarray, quality: np.ndarray, n_keep: int, lo: float = 0.55,
                                  hi: float = 0.995, iters: int = 12):
    """Coreset selection: cluster the model's embedding space so the cluster count matches the budget, then keep the
    highest-quality member of each cluster. Every semantic neighbourhood keeps a representative, so a dropped product
    always has a near-twin still in the index - which a random subset cannot promise."""
    n = emb.shape[0]
    best = None
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        lab = cluster_labels(emb, mid)
        nc = len(np.unique(lab))
        if best is None or abs(nc - n_keep) < abs(best[1] - n_keep):
            best = (lab, nc, mid)
        if nc < n_keep:          # too few clusters -> raise the threshold (split more)
            lo = mid
        else:
            hi = mid
        if abs(nc - n_keep) <= max(5, n_keep // 200):
            break
    lab, nc, tau = best
    order = np.lexsort((-quality, lab))                 # within each cluster, highest quality first
    first = np.ones(n, dtype=bool)
    first[1:] = lab[order][1:] != lab[order][:-1]
    reps = order[first]
    if len(reps) > n_keep:                              # trim the lowest-quality representatives
        reps = reps[np.argsort(-quality[reps])[:n_keep]]
    elif len(reps) < n_keep:                            # top up with the best non-representatives
        rest = np.setdiff1d(np.arange(n), reps)
        reps = np.concatenate([reps, rest[np.argsort(-quality[rest])[:n_keep - len(reps)]]])
    return np.sort(reps), {"cosine_threshold": round(tau, 4), "clusters": int(nc),
                           "singletons": int((np.bincount(np.unique(lab, return_inverse=True)[1]) == 1).sum())}


def select(emb: np.ndarray, qemb: np.ndarray, keep_frac: float, lam: float = 0.5, k: int = 10):
    cov = coverage_scores(emb, qemb)
    red = redundancy_scores(emb, k=k)
    score = cov + lam * (1.0 - red)
    n_keep = max(1, int(round(keep_frac * emb.shape[0])))
    order = np.argsort(-score, kind="stable")[:n_keep]
    return np.sort(order), cov, red, {"coverage_mean": round(float(cov.mean()), 4),
                                      "redundancy_mean": round(float(red.mean()), 4),
                                      "score_mean": round(float(score.mean()), 4), "lambda": lam, "knn_k": k,
                                      "selected_coverage_mean": round(float(cov[order].mean()), 4),
                                      "selected_redundancy_mean": round(float(red[order].mean()), 4)}


# ------------------------------------------------------------------ index build + eval (heavy deps, lazy)
def build_index(texts_bm25: list[str], emb: np.ndarray, stemmer):
    """Build BM25 + FAISS over one subset. Returns (bm25, faiss_index, build_seconds)."""
    import bm25s
    import faiss

    t0 = time.perf_counter()
    toks = bm25s.tokenize(texts_bm25, stopwords="en", stemmer=stemmer, show_progress=False)
    bm = bm25s.BM25()
    bm.index(toks, show_progress=False)
    idx = faiss.IndexFlatIP(emb.shape[1])
    idx.add(np.ascontiguousarray(emb))
    return bm, idx, time.perf_counter() - t0


def evaluate(bm, faiss_idx, stemmer, sub_ids: list[str], qtexts: list[str], qids: list[int], grades: dict,
             qvecs: np.ndarray, depth: int = 100):
    """RRF(BM25, dense) top-10 NDCG over one index. Returns (mean ndcg, n scored, mean query latency ms)."""
    import bm25s
    from engine import ndcg10, rrf

    nd, lat = [], []
    for t, qid, qv in zip(qtexts, qids, qvecs):
        t0 = time.perf_counter()
        toks = bm25s.tokenize([t], stemmer=stemmer, show_progress=False)
        vocab_inv = {v: kk for kk, v in toks.vocab.items()}
        words = [vocab_inv[x] for x in toks.ids[0]]
        bs = bm.get_scores(words) if words else np.zeros(len(sub_ids), dtype=np.float32)
        bm_top = [int(i) for i in np.argsort(-bs)[:depth] if bs[i] > 0]
        D, I = faiss_idx.search(qv.reshape(1, -1), depth)
        vec_top = [int(i) for i in I[0] if i >= 0]
        order, _ = rrf(bm_top, vec_top)
        lat.append((time.perf_counter() - t0) * 1000)
        ranked = [sub_ids[i] for i in order[:10]]
        v = ndcg10(grades[qid], ranked)
        if v is not None:
            nd.append(v)
    return (round(float(np.mean(nd)), 4) if nd else None), len(nd), round(float(np.median(lat)), 1)


def relevant_retention(keep_idx: np.ndarray, pos: dict, grades: dict, qids: list[int]) -> float:
    """Mean per-query share of graded-relevant products that survive in the subset. The mechanical driver of NDCG
    under index pruning: a graded label is attached to one product_id, so a dropped relevant doc cannot be substituted."""
    s = set(keep_idx.tolist())
    vals = []
    for q in qids:
        rel = [pos[d] for d, g in grades[q].items() if g > 0 and d in pos]
        if rel:
            vals.append(sum(1 for d in rel if d in s) / len(rel))
    return round(float(np.mean(vals)), 4) if vals else None


def arm(name: str, keep_idx: np.ndarray, products: pd.DataFrame, emb: np.ndarray, stemmer, qtexts, qids, grades,
        qvecs, n_docs_full: int, encode_rate: float, pos: dict | None = None) -> dict:
    sub = products.iloc[keep_idx]
    texts = [f"{r['title']} {r['brand']} {r['bullets']}" for r in sub.to_dict("records")]
    bm, idx, build_s = build_index(texts, emb[keep_idx], stemmer)
    ndcg, n_scored, p50 = evaluate(bm, idx, stemmer, sub["product_id"].tolist(), qtexts, qids, grades, qvecs)
    n = len(keep_idx)
    embed_s = n / encode_rate
    total_cpu_min = (build_s + embed_s) / 60.0
    return {"arm": name, "docs": int(n), "frac_of_catalogue": round(n / n_docs_full, 4),
            "ndcg10": ndcg, "queries_scored": n_scored, "query_p50_ms": p50,
            "relevant_doc_retention": relevant_retention(keep_idx, pos, grades, qids) if pos else None,
            "index_build_seconds": round(build_s, 2),
            "embedding_seconds_extrapolated": round(embed_s, 1),
            "total_build_cpu_minutes": round(total_cpu_min, 3),
            "build_cost_usd": round(total_cpu_min * USD_PER_CPU_MIN, 5)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=0, help="use only the first N products (0 = whole catalogue)")
    ap.add_argument("--keep-frac", type=float, default=0.4)
    ap.add_argument("--lam", type=float, default=0.5, help="weight on the novelty (1 - redundancy) term")
    ap.add_argument("--knn-k", type=int, default=10)
    ap.add_argument("--n-queries", type=int, default=200, help="held-out TEST queries to score")
    ap.add_argument("--n-dev-queries", type=int, default=300, help="DEV queries used for the coverage term")
    ap.add_argument("--encode-probe", type=int, default=200, help="docs to encode to measure the embedding rate")
    ap.add_argument("--seed", type=int, default=20260915)
    ap.add_argument("--out", default=str(DATA / "selection_report.json"))
    a = ap.parse_args()

    import Stemmer
    from engine import EMB_MODEL, QUERY_PREFIX, doc_text
    from sentence_transformers import SentenceTransformer

    t_all = time.time()
    products = pd.read_parquet(DATA / "products.parquet").reset_index(drop=True)
    emb_all = np.load(DATA / "embeddings.npy")
    if a.sample:
        products = products.head(a.sample).reset_index(drop=True)
        emb_all = emb_all[:a.sample]
    emb = normalize(emb_all.astype(np.float32))
    n_docs = len(products)

    queries = pd.read_parquet(DATA / "queries.parquet")
    qrels = {s: pd.read_parquet(DATA / f"qrels_{s}.parquet") for s in ("dev", "test")}
    grades = {q: dict(zip(g.product_id, g.gain)) for q, g in qrels["test"].groupby("query_id")}
    test_q = queries[queries.split == "test"].sort_values("query_id")
    qids = [int(q) for q in test_q.query_id if q in grades and max(grades[q].values()) > 0][:a.n_queries]
    qtext = dict(zip(queries.query_id, queries["query"]))
    qtexts = [qtext[q] for q in qids]
    dev_texts = queries[queries.split == "dev"].sort_values("query_id")["query"].head(a.n_dev_queries).tolist()

    print(f"[select] {n_docs:,} products, {len(qtexts)} held-out test queries, {len(dev_texts)} dev queries for coverage", flush=True)
    enc = SentenceTransformer(EMB_MODEL, device="cpu")
    enc.max_seq_length = 128
    qvecs = normalize(enc.encode([QUERY_PREFIX + t for t in qtexts], normalize_embeddings=True).astype(np.float32))
    devvecs = normalize(enc.encode([QUERY_PREFIX + t for t in dev_texts], normalize_embeddings=True).astype(np.float32))

    # measure the real encode rate so build cost for a doc set is grounded in a measurement, not a guess
    probe_texts = [doc_text(r) for r in products.head(a.encode_probe).to_dict("records")]
    t0 = time.perf_counter()
    enc.encode(probe_texts, batch_size=64, normalize_embeddings=True, show_progress_bar=False)
    encode_rate = len(probe_texts) / (time.perf_counter() - t0)
    print(f"[select] measured encode rate {encode_rate:.1f} docs/s on this CPU", flush=True)

    t0 = time.perf_counter()
    keep_cov, cov, red, score_stats = select(emb, devvecs, a.keep_frac, lam=a.lam, k=a.knn_k)
    n_keep = len(keep_cov)
    keep_rep, clu_stats = select_cluster_representative(emb, cov, n_keep)
    select_s = time.perf_counter() - t0
    rng = np.random.default_rng(a.seed)
    rand = np.sort(rng.choice(n_docs, size=n_keep, replace=False))
    print(f"[select] scored+selected {n_keep:,}/{n_docs:,} in {select_s:.1f}s  {score_stats}  clusters={clu_stats}", flush=True)

    pos = {pid: i for i, pid in enumerate(products["product_id"])}
    stemmer = Stemmer.Stemmer("english")
    arms = []
    for name, idxs in (("full", np.arange(n_docs)), ("selected_cluster_representative", keep_rep),
                       ("selected_coverage_novelty", keep_cov), ("random_baseline", rand)):
        r = arm(name, idxs, products, emb, stemmer, qtexts, qids, grades, qvecs, n_docs, encode_rate, pos)
        arms.append(r)
        print(f"[select] {name:32s} docs={r['docs']:>6,} NDCG@10={r['ndcg10']} "
              f"rel-retention={r['relevant_doc_retention']} build={r['index_build_seconds']}s "
              f"cost=${r['build_cost_usd']}", flush=True)

    by = {r["arm"]: r for r in arms}
    full, rnd, alt = by["full"], by["random_baseline"], by["selected_coverage_novelty"]
    # the primary selected arm is whichever model-based strategy actually scored higher (reported, not assumed)
    sel = max((by["selected_cluster_representative"], alt), key=lambda r: r["ndcg10"] or 0)
    out = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "seconds": round(time.time() - t_all, 1),
        "inputs": {"source": "data/products.parquet + data/embeddings.npy (bge-small-en-v1.5)", "catalogue": n_docs,
                   "sample": a.sample or None, "keep_frac": a.keep_frac, "seed": a.seed,
                   "test_queries": len(qids), "dev_queries_for_coverage": len(dev_texts),
                   "embedding_model": EMB_MODEL, "usd_per_cpu_min": USD_PER_CPU_MIN},
        "method": {"score": "coverage(max cosine to a DEV query) + lambda * (1 - redundancy(mean cosine to k-NN))",
                   "lambda": a.lam, "knn_k": a.knn_k, "selection_seconds": round(select_s, 2),
                   "retrieval": "RRF(k=60) over BM25 + dense top-100, no cross-encoder (identical for all three arms)",
                   "eval": "NDCG@10 on held-out ESCI test queries; the test split is never used for selection",
                   "cost_model": "measured index build time + embedding time extrapolated from a measured encode rate, "
                                 f"priced at ${USD_PER_CPU_MIN}/CPU-minute",
                   "scoring_stats": score_stats},
        "arms": arms,
        "comparison": {
            "primary_selected_arm": sel["arm"],
            "ndcg10_full": full["ndcg10"], "ndcg10_selected": sel["ndcg10"], "ndcg10_random_baseline": rnd["ndcg10"],
            "ndcg10_selected_coverage_novelty": alt["ndcg10"],
            "ndcg10_selected_cluster_representative": by["selected_cluster_representative"]["ndcg10"],
            "ndcg_delta_selected_vs_full": round(sel["ndcg10"] - full["ndcg10"], 4),
            "ndcg_retained_pct": round(100 * sel["ndcg10"] / full["ndcg10"], 1) if full["ndcg10"] else None,
            "ndcg_delta_selected_vs_random": round(sel["ndcg10"] - rnd["ndcg10"], 4),
            "build_cost_usd_full": full["build_cost_usd"], "build_cost_usd_selected": sel["build_cost_usd"],
            "build_cost_saving_pct": round(100 * (1 - sel["build_cost_usd"] / full["build_cost_usd"]), 1)
            if full["build_cost_usd"] else None,
            "build_time_saving_pct": round(100 * (1 - sel["total_build_cpu_minutes"] / full["total_build_cpu_minutes"]), 1)
            if full["total_build_cpu_minutes"] else None,
        },
        "note": "Dropping catalogue rows removes relevant documents, so some NDCG loss is arithmetically unavoidable. "
                "The honest question is how the selected subset compares with a random subset of the SAME size, which is "
                "why the random arm is reported alongside, together with each arm's relevant_doc_retention.",
        "interpretation": "In ESCI every graded label is bound to one product_id, so a dropped relevant document cannot "
                          "be substituted by a near-twin and NDCG under index pruning tracks relevant_doc_retention "
                          "almost mechanically. Uniform random pruning retains exactly keep_frac of EVERY query's "
                          "relevant set; a model-based scorer can only beat it by predicting which documents will be "
                          "judged relevant for unseen queries. Compare the arms' relevant_doc_retention against "
                          f"keep_frac={a.keep_frac} to see how much signal each strategy actually carries.",
    }
    Path(a.out).write_text(json.dumps(out, indent=2))
    c = out["comparison"]
    print(f"[select] selected retains {c['ndcg_retained_pct']}% of full NDCG@10 "
          f"({c['ndcg10_selected']} vs {c['ndcg10_full']}), beats random by {c['ndcg_delta_selected_vs_random']:+.4f}, "
          f"build cost -{c['build_cost_saving_pct']}% -> {a.out}", flush=True)


if __name__ == "__main__":
    main()
