#!/usr/bin/env python3
"""Build BM25 (bm25s) + dense (bge-small-en-v1.5, CPU) FAISS IndexFlatIP over data/products.parquet.

Run from services/search-svc:  uv run python ../../scripts/build_index.py
Writes data/bm25/, data/embeddings.npy, data/faiss.index. Cross-encoder reranker is loaded lazily by the service
(this script pre-downloads it with --warm-reranker, default on).
"""
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")  # torch + faiss both ship libomp on macOS
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
from sentence_transformers import CrossEncoder, SentenceTransformer  # noqa: E402  (must import before faiss)

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "search-svc"))

import bm25s  # noqa: E402
import faiss  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import Stemmer  # noqa: E402
from sentence_transformers import CrossEncoder, SentenceTransformer  # noqa: E402

import torch  # noqa: E402
torch.set_num_threads(os.cpu_count() or 4)
from engine import DATA, EMB_MODEL, RERANK_MODEL, doc_text  # noqa: E402


def main():
    t0 = time.time()
    p = pd.read_parquet(DATA / "products.parquet")
    texts = [doc_text(r) for r in p.to_dict("records")]
    print(f"[index] {len(texts):,} products")

    stemmer = Stemmer.Stemmer("english")
    bm_texts = [f"{r['title']} {r['brand']} {r['bullets']}" for r in p.to_dict("records")]
    toks = bm25s.tokenize(bm_texts, stopwords="en", stemmer=stemmer, show_progress=False)
    bm = bm25s.BM25()
    bm.index(toks, show_progress=False)
    bm.save(str(DATA / "bm25"))
    print(f"[index] BM25 done in {time.time()-t0:.0f}s")

    t1 = time.time()
    model = SentenceTransformer(EMB_MODEL, device="cpu")
    model.max_seq_length = 128
    emb = model.encode(texts, batch_size=128, normalize_embeddings=True, show_progress_bar=True).astype(np.float32)
    np.save(DATA / "embeddings.npy", emb)
    index = faiss.IndexFlatIP(emb.shape[1])
    index.add(emb)
    faiss.write_index(index, str(DATA / "faiss.index"))
    print(f"[index] embeddings {emb.shape} + FAISS done in {time.time()-t1:.0f}s")

    if "--no-warm-reranker" not in sys.argv:
        CrossEncoder(RERANK_MODEL, device="cpu")
        print("[index] reranker weights cached")
    print(f"[index] total {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
