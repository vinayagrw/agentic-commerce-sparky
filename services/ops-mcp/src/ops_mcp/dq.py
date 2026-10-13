"""Data Quality agent: validation gates on data/products.parquet (playbook techniques 4 validation gates, 5 dedup)."""
from __future__ import annotations

import re
import time

import numpy as np
import pandas as pd

from .db import DATA

FOOD_CATEGORIES = {"grocery"}


def _empty(s: pd.Series) -> pd.Series:
    return s.isna() | (s.astype("string").fillna("").str.strip() == "")


def near_duplicates(titles: list[str], ids: list[str], threshold: float = 0.9, num_perm: int = 128, max_pairs: int = 8):
    from datasketch import MinHash, MinHashLSH

    lsh = MinHashLSH(threshold=threshold, num_perm=num_perm)
    hashes = {}
    for pid, t in zip(ids, titles):
        toks = re.findall(r"[a-z0-9]+", (t or "").lower())
        shingles = {" ".join(toks[i:i + 2]) for i in range(max(1, len(toks) - 1))} if toks else set()
        if len(shingles) < 3:
            continue
        m = MinHash(num_perm=num_perm)
        m.update_batch([s.encode("utf8") for s in shingles])
        hashes[pid] = m
        lsh.insert(pid, m)
    title_of = dict(zip(ids, titles))
    seen, pairs = set(), []
    for pid, m in hashes.items():
        for other in lsh.query(m):
            if other == pid or (other, pid) in seen:
                continue
            seen.add((pid, other))
            pairs.append((pid, other, m.jaccard(hashes[other])))
    pairs.sort(key=lambda x: -x[2])
    in_pairs = {p for a, b, _ in pairs for p in (a, b)}
    examples = [{"a": a, "b": b, "jaccard_est": round(j, 3), "title_a": title_of[a][:90], "title_b": title_of[b][:90]}
                for a, b, j in pairs[:max_pairs]]
    return {"pairs": len(pairs), "products_involved": len(in_pairs), "examples": examples, "hashed": len(hashes)}


def semantic_duplicates(emb: np.ndarray, ids: list[str], titles: list[str], threshold: float = 0.95,
                        chunk: int = 512, max_examples: int = 8):
    """Embedding near-duplicate pass (playbook technique 5, semantic half).

    `emb` is the bge-small-en-v1.5 matrix search-svc already built (rows L2-normalised), so cosine is a dot product.
    Blocked matmul over the upper triangle, then single-link (union-find) clustering of the surviving pairs.
    """
    n = len(ids)
    if n < 2 or emb.shape[0] != n:
        return {"pairs": 0, "products_involved": 0, "clusters": 0, "examples": [], "scanned": n,
                "threshold": threshold, "error": None if n >= 2 else "fewer than 2 products"}
    x = np.ascontiguousarray(emb, dtype=np.float32)
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    x = x / np.where(norms == 0, 1.0, norms)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    pairs, npairs = [], 0
    for s in range(0, n, chunk):
        block = x[s:s + chunk]
        sims = block @ x.T                      # (chunk, n)
        for r in range(block.shape[0]):
            i = s + r
            js = np.nonzero(sims[r, i + 1:] >= threshold)[0] + i + 1
            npairs += len(js)
            for j in js:
                union(i, int(j))
                if len(pairs) < 4000:
                    pairs.append((i, int(j), float(sims[r, j])))
    pairs.sort(key=lambda t: -t[2])
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    clusters = [g for g in groups.values() if len(g) > 1]
    involved = sum(len(g) for g in clusters)
    examples = [{"a": ids[i], "b": ids[j], "cosine": round(c, 4), "title_a": titles[i][:90], "title_b": titles[j][:90]}
                for i, j, c in pairs[:max_examples]]
    return {"pairs": npairs, "products_involved": involved, "clusters": len(clusters),
            "largest_cluster": max((len(g) for g in clusters), default=0),
            "examples": examples, "scanned": n, "threshold": threshold,
            "method": f"bge-small-en-v1.5 cosine >= {threshold} (cached data/embeddings.npy), single-link clustering"}


def dedup_report(p: pd.DataFrame, positions: np.ndarray, threshold: float = 0.95, sample: int | None = 6000,
                 seed: int = 20260915) -> dict:
    """MinHash-only vs semantic-only vs combined duplicate rates on the SAME sample of products.

    `positions` are row offsets into data/embeddings.npy (products.parquet row order), aligned with `p`.
    """
    emb_path = DATA / "embeddings.npy"
    if not emb_path.exists():
        return {"status": "skipped", "reason": "data/embeddings.npy missing - run scripts/build_index.py"}
    n = len(p)
    if sample and n > sample:
        rng = np.random.default_rng(seed)
        take = np.sort(rng.choice(n, size=sample, replace=False))
        p, positions = p.iloc[take], positions[take]
    ids = p["product_id"].tolist()
    titles = [str(t) for t in p["title"].tolist()]
    all_emb = np.load(emb_path, mmap_mode="r")
    emb = np.asarray(all_emb[positions])

    t0 = time.perf_counter()
    mh_pair_keys = set(_minhash_pairs(titles, ids))
    t_mh = time.perf_counter() - t0
    t0 = time.perf_counter()
    sem = semantic_duplicates(emb, ids, titles, threshold=threshold)
    sem_pairs = _semantic_pairs(emb, ids, threshold)
    t_sem = time.perf_counter() - t0

    idx_of = {pid: i for i, pid in enumerate(ids)}
    mh_set = {pid for pr in mh_pair_keys for pid in pr}
    sem_set = {pid for a, b, _ in sem_pairs for pid in (a, b)}
    sem_pair_keys = {tuple(sorted((a, b))) for a, b, _ in sem_pairs}
    missed = [e for e in sem_pairs if tuple(sorted((e[0], e[1]))) not in mh_pair_keys]
    missed.sort(key=lambda e: -e[2])
    n_s = len(ids)
    return {
        "sample_size": n_s, "seed": seed, "cosine_threshold": threshold,
        "minhash_only": {"duplicate_rate": round(len(mh_set) / n_s, 4), "products_involved": len(mh_set),
                         "pairs": len(mh_pair_keys), "seconds": round(t_mh, 2),
                         "method": "MinHash (128 perm) + LSH over title word-bigrams, Jaccard >= 0.9 (datasketch)"},
        "semantic_only": {"duplicate_rate": round(len(sem_set) / n_s, 4), "products_involved": len(sem_set),
                          "pairs": len(sem_pair_keys), "clusters": sem["clusters"], "largest_cluster": sem["largest_cluster"],
                          "seconds": round(t_sem, 2), "method": sem["method"]},
        "combined": {"duplicate_rate": round(len(mh_set | sem_set) / n_s, 4), "products_involved": len(mh_set | sem_set),
                     "pairs": len(mh_pair_keys | sem_pair_keys)},
        "semantic_finds_minhash_misses": {
            "pairs": len(missed),
            "share_of_semantic_pairs": round(len(missed) / len(sem_pair_keys), 4) if sem_pair_keys else 0.0,
            "examples": [{"a": a, "b": b, "cosine": round(c, 4),
                          "title_a": titles[idx_of[a]][:90], "title_b": titles[idx_of[b]][:90]} for a, b, c in missed[:6]]},
        "minhash_finds_semantic_misses": {"pairs": len(mh_pair_keys - sem_pair_keys)},
    }


def _minhash_pairs(titles: list[str], ids: list[str], threshold: float = 0.9, num_perm: int = 128) -> list[tuple[str, str]]:
    from datasketch import MinHash, MinHashLSH

    lsh = MinHashLSH(threshold=threshold, num_perm=num_perm)
    hashes = {}
    for pid, t in zip(ids, titles):
        toks = re.findall(r"[a-z0-9]+", (t or "").lower())
        shingles = {" ".join(toks[i:i + 2]) for i in range(max(1, len(toks) - 1))} if toks else set()
        if len(shingles) < 3:
            continue
        m = MinHash(num_perm=num_perm)
        m.update_batch([s.encode("utf8") for s in shingles])
        hashes[pid] = m
        lsh.insert(pid, m)
    out = set()
    for pid, m in hashes.items():
        for other in lsh.query(m):
            if other != pid:
                out.add(tuple(sorted((pid, other))))
    return sorted(out)


def _semantic_pairs(emb: np.ndarray, ids: list[str], threshold: float, chunk: int = 512, cap: int = 20000):
    x = np.ascontiguousarray(emb, dtype=np.float32)
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    x = x / np.where(norms == 0, 1.0, norms)
    out = []
    n = len(ids)
    for s in range(0, n, chunk):
        sims = x[s:s + chunk] @ x.T
        for r in range(sims.shape[0]):
            i = s + r
            js = np.nonzero(sims[r, i + 1:] >= threshold)[0] + i + 1
            for j in js:
                out.append((ids[i], ids[int(j)], float(sims[r, j])))
                if len(out) >= cap:
                    return out
    return out


def run(category: str | None = None, semantic_dedup: bool = True, dedup_sample: int | None = 6000,
        cosine_threshold: float = 0.95) -> dict:
    t0 = time.perf_counter()
    p = pd.read_parquet(DATA / "products.parquet").reset_index(drop=True)
    positions = p.index.to_numpy()
    if category:
        keep = p["category"] == category
        p, positions = p[keep], positions[keep.to_numpy()]
    n = len(p)
    if n == 0:
        return {"error": f"no products in category {category!r}", "categories": sorted(pd.read_parquet(DATA / "products.parquet")["category"].unique())}
    missing = {c: round(float(_empty(p[c]).mean()), 4) for c in ("title", "brand", "description", "bullets", "color")}
    food = p[p["category"].isin(FOOD_CATEGORIES)]
    diet_cov = round(float((food["dietary"].map(len) > 0).mean()), 4) if len(food) else None

    # robust price outliers per category (modified z-score on log price, MAD)
    outliers = []
    for cat, g in p.groupby("category"):
        lp = np.log1p(g["price"].to_numpy())
        med = np.median(lp)
        mad = np.median(np.abs(lp - med)) or 1e-9
        z = 0.6745 * (lp - med) / mad
        for i in np.where(np.abs(z) > 3.5)[0]:
            outliers.append({"product_id": g.iloc[i]["product_id"], "category": cat, "price": float(g.iloc[i]["price"]),
                             "category_median": round(float(np.expm1(med)), 2), "robust_z": round(float(z[i]), 2),
                             "title": g.iloc[i]["title"][:80]})
    outliers.sort(key=lambda o: -abs(o["robust_z"]))
    dups = near_duplicates(p["title"].tolist(), p["product_id"].tolist())
    sem = dedup_report(p, positions, threshold=cosine_threshold, sample=dedup_sample) if semantic_dedup else \
        {"status": "skipped", "reason": "semantic_dedup=false"}

    gates = [
        {"gate": "title_present", "value": missing["title"], "threshold": "<= 0.0", "status": "pass" if missing["title"] == 0 else "fail"},
        {"gate": "brand_missing_rate", "value": missing["brand"], "threshold": "<= 0.05",
         "status": "pass" if missing["brand"] <= 0.05 else "fail"},
        {"gate": "description_or_bullets_missing_rate",
         "value": round(float((_empty(p["description"]) & _empty(p["bullets"])).mean()), 4), "threshold": "<= 0.10"},
        {"gate": "dietary_tag_coverage_food", "value": diet_cov, "threshold": ">= 0.60"},
        {"gate": "price_outlier_rate", "value": round(len(outliers) / n, 4), "threshold": "<= 0.01"},
        {"gate": "near_duplicate_title_rate", "value": round(dups["products_involved"] / n, 4), "threshold": "<= 0.02"},
    ]
    gates[2]["status"] = "pass" if gates[2]["value"] <= 0.10 else "fail"
    gates[3]["status"] = "skip" if diet_cov is None else ("pass" if diet_cov >= 0.60 else "warn")
    gates[4]["status"] = "pass" if gates[4]["value"] <= 0.01 else "warn"
    gates[5]["status"] = "pass" if gates[5]["value"] <= 0.02 else "warn"
    if "combined" in sem:
        gates.append({"gate": "combined_duplicate_rate_minhash_or_semantic", "value": sem["combined"]["duplicate_rate"],
                      "threshold": "<= 0.05", "status": "pass" if sem["combined"]["duplicate_rate"] <= 0.05 else "warn",
                      "scope": f"sample of {sem['sample_size']} products"})
    failing = [g for g in gates if g["status"] in ("fail", "warn")]
    issue = None
    if failing:
        issue = {"title": f"Catalog data quality: {len(failing)} gate(s) not passing" + (f" in {category}" if category else ""),
                 "gates": [g["gate"] for g in failing],
                 "suggested_owner": "catalog-data team", "blocks_training_data": any(g["status"] == "fail" for g in failing)}
    return {"category": category or "all", "products": n, "gates": gates, "verdict": "fail" if any(g["status"] == "fail" for g in gates)
            else ("warn" if failing else "pass"),
            "missing_attribute_rates": missing, "price_outliers": {"count": len(outliers), "examples": outliers[:5]},
            "near_duplicates": {**dups, "method": "MinHash (128 perm) + LSH over title word-bigrams, Jaccard >= 0.9 (datasketch)"},
            "semantic_dedup": sem,
            "issue": issue, "seconds": round(time.perf_counter() - t0, 2),
            "note": "titles/brands are real ESCI; price and dietary tags are SYNTHETIC demo fields"}
