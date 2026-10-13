#!/usr/bin/env python3
"""Fetch + subset the Amazon ESCI Shopping Queries dataset (Apache-2.0) for Sparky Next.

Outputs (in <repo>/data/):
  products.parquet     ~25k US products in grocery / home_kitchen / baby / health_household / pet /
                       electronics_accessories, with SYNTHETIC price, rating, dietary, stock, sponsored, image
  queries.parquet      real ESCI queries (query_id, query, split, n_judged, n_relevant, difficulty)
  qrels_dev.parquet    (query_id, product_id, esci_label, gain)  E=3 S=2 C=1 I=0
  qrels_test.parquet
  SOURCE.txt           which source was actually used

Run from services/search-svc:  uv run python ../../scripts/fetch_data.py [--max-products 25000]
Falls back (LOUDLY) to a scaled-up synthetic catalog if ESCI cannot be downloaded.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import random
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
import requests

SEED = 20260915
ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW = DATA / "raw"
STORES = ["4108", "2231", "5360"]
GAIN = {"E": 3, "S": 2, "C": 1, "I": 0}

URLS = {
    "examples": [
        "https://media.githubusercontent.com/media/amazon-science/esci-data/main/shopping_queries_dataset/shopping_queries_dataset_examples.parquet",
        "https://huggingface.co/datasets/tasksource/esci/resolve/main/shopping_queries_dataset_examples.parquet",
    ],
    "products": [
        "https://media.githubusercontent.com/media/amazon-science/esci-data/main/shopping_queries_dataset/shopping_queries_dataset_products.parquet",
        "https://huggingface.co/datasets/tasksource/esci/resolve/main/shopping_queries_dataset_products.parquet",
    ],
}

# ---- category heuristics (order = priority) -------------------------------------------------
CATS = {
    "pet": r"\b(dog|dogs|puppy|puppies|kitten|cat litter|cat food|cat toy|cat tree|cats|pet|pets|aquarium|fish food|bird seed|birdseed|hamster|guinea pig|leash|chew toy|litter box)\b",
    "baby": r"\b(baby|babies|infant|toddler|diaper|diapers|pacifier|nursery|newborn|crib|stroller|onesie|teether|teething|sippy|breast pump|bottle nipple|baby formula|bib|bibs)\b",
    "grocery": r"\b(snack|snacks|coffee|k-cup|k cups|tea bags|green tea|chocolate|candy|cereal|pasta|seasoning|spice|spices|gluten free|gluten-free|protein bar|granola|cookies|crackers|chips|almonds|cashews|pistachios|jerky|honey|olive oil|flour|sweetener|soda|juice|drink mix|oatmeal|rice|beans|peanut butter|salsa|tortilla|tortillas|popcorn|creamer|syrup|vinegar|broth|soup|hot sauce|bbq sauce|ketchup|mustard|mayonnaise|pretzels|gummies|gummy|licorice|noodles|ramen|sparkling water|energy drink|protein powder|trail mix|dried fruit|jam|oreo|sugar free)\b",
    "health_household": r"\b(vitamin|vitamins|supplement|supplements|toothpaste|toothbrush|shampoo|conditioner|deodorant|lotion|sunscreen|bandage|bandages|first aid|pain relief|allergy relief|probiotic|probiotics|paper towels|toilet paper|detergent|laundry|dish soap|dishwasher|trash bags|garbage bags|disinfectant|disinfecting|cleaner|wipes|hand soap|body wash|razor|razors|floss|mouthwash|thermometer|melatonin|multivitamin|electrolyte|tissues|cotton swabs|contact lens|eye drops|hand sanitizer|sponges)\b",
    "electronics_accessories": r"\b(charger|charging cable|usb|usb-c|hdmi|phone case|screen protector|earbuds|headphones|power bank|keyboard|mouse|webcam|sd card|micro sd|memory card|flash drive|aa batteries|aaa batteries|surge protector|extension cord|bluetooth speaker|smart plug|lightning cable|stylus|tripod|ethernet cable|wall charger|car charger|phone holder|phone mount|airpods case|power strip)\b",
    "home_kitchen": r"\b(kitchen|cookware|skillet|frying pan|saucepan|knife set|cutting board|mug|mugs|tumbler|water bottle|food storage|bakeware|baking sheet|utensil|utensils|spatula|blender|coffee maker|air fryer|toaster|bath towel|towels|bath mat|shower curtain|pillow|pillows|sheet set|bed sheets|comforter|blanket|curtains|area rug|lamp|storage bins|organizer|hangers|vacuum|mop|candle|candles|vase|picture frame|trash can|dish rack|placemat|placemats|tablecloth|dinnerware|glassware|wine glasses|measuring cups|mixing bowl|pot|pots|kettle|thermos|lunch box|ice cube tray|colander|grater|can opener)\b",
}
EXCLUDE = r"\b(book|novel|paperback|hardcover|dvd|blu-ray|t-shirt|tshirt|hoodie|sweatshirt|costume|poster|necklace|earrings|bracelet|sticker|decal|tattoo|sneakers|shoes|leggings|dress)\b"

META = {  # emoji, color, price range, rating mean
    "grocery": ("🥫", "#F4A261", (1.5, 25)),
    "home_kitchen": ("🍳", "#2A9D8F", (6, 120)),
    "baby": ("🍼", "#E9C3E6", (4, 80)),
    "health_household": ("🧴", "#8ECAE6", (3, 45)),
    "pet": ("🐾", "#B5838D", (4, 60)),
    "electronics_accessories": ("🔌", "#6C757D", (7, 70)),
}
DIET = {
    "gluten_free": r"\b(?:gluten[- ]free|gf)\b",
    "vegan": r"\b(?:vegan|plant[- ]based)\b",
    "organic": r"\b(?:organic|usda organic)\b",
}


def banner(msg: str) -> None:
    line = "!" * 100
    print(f"\n{line}\n!!! {msg}\n{line}\n", file=sys.stderr, flush=True)


def download(name: str) -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    dest = RAW / f"shopping_queries_dataset_{name}.parquet"
    if dest.exists() and dest.stat().st_size > 1_000_000:
        try:
            pq.ParquetFile(dest)
            print(f"[fetch] cached {dest.name} ({dest.stat().st_size/1e6:.0f} MB)")
            return dest
        except Exception:
            print(f"[fetch] cached {dest.name} is corrupt/incomplete, re-downloading")
    last = None
    for url in URLS[name]:
        try:
            print(f"[fetch] GET {url}")
            with requests.get(url, stream=True, timeout=60) as r:
                r.raise_for_status()
                tmp = dest.with_suffix(".part")
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            pq.ParquetFile(tmp)  # validate (LFS pointer files fail here)
            tmp.rename(dest)
            return dest
        except Exception as e:  # try next mirror
            last = e
            print(f"[fetch] failed: {e}")
    raise RuntimeError(f"all mirrors failed for {name}: {last}")


def categorize(titles: pa.Array) -> np.ndarray:
    low = pc.utf8_lower(titles)
    out = np.full(len(low), "", dtype=object)
    excl = pc.fill_null(pc.match_substring_regex(low, EXCLUDE), False).to_numpy(zero_copy_only=False)
    for cat, rx in CATS.items():
        m = pc.fill_null(pc.match_substring_regex(low, rx), False).to_numpy(zero_copy_only=False)
        out[(out == "") & m & ~excl] = cat
    return out


def stable_rng(key: str) -> random.Random:
    return random.Random(int(hashlib.sha256(f"{SEED}|{key}".encode()).hexdigest()[:16], 16))


def add_synthetic(df: pd.DataFrame) -> pd.DataFrame:
    rng = np.random.default_rng(SEED)
    n = len(df)
    text = (df["title"].fillna("") + " " + df["bullets"].fillna("")).str.lower()
    lo = df["category"].map(lambda c: META[c][2][0]).to_numpy()
    hi = df["category"].map(lambda c: META[c][2][1]).to_numpy()
    u = rng.random(n) ** 1.8  # skew to cheaper
    df["price"] = np.round(lo + u * (hi - lo), 0) - rng.choice([0.03, 0.12, 0.22, 0.53, 0.76], n)
    df["price"] = df["price"].clip(lower=0.97)
    df["rating"] = np.round(np.clip(rng.normal(4.3, 0.45, n), 2.5, 5.0), 1)
    df["rating_count"] = rng.integers(3, 12000, n)
    dietary = [[] for _ in range(n)]
    for tag, rx in DIET.items():
        hits = text.str.contains(rx, regex=True).to_numpy()
        for i in np.where(hits)[0]:
            dietary[i].append(tag)
    df["dietary"] = dietary
    for s in STORES:
        q = rng.integers(0, 40, n)
        q[rng.random(n) < 0.15] = 0  # ~15% OOS per store
        df[f"stock_{s}"] = q.astype(int)
    spons = rng.random(n) < 0.05
    df["sponsored"] = spons
    df["ad_id"] = [f"ad-{SEED % 10000}-{i:06d}" if s else None for i, s in enumerate(spons)]
    df["image"] = df["category"].map(lambda c: f"placeholder:{c}:{META[c][0]}:{META[c][1]}")
    df["synthetic"] = True
    return df


def build_from_esci(max_products: int) -> None:
    ex_path, pr_path = download("examples"), download("products")
    print("[esci] loading US products (title/brand)...")
    t = pq.read_table(pr_path, columns=["product_id", "product_title", "product_brand", "product_locale"],
                      filters=[("product_locale", "=", "us")])
    cat = categorize(t["product_title"])
    pmap = pd.DataFrame({"product_id": t["product_id"].to_numpy(zero_copy_only=False), "category": cat})
    print(f"[esci] US products: {len(pmap):,}; categorized: {(pmap.category != '').sum():,}")
    del t

    ex = pq.read_table(ex_path, columns=["query_id", "query", "product_id", "esci_label", "small_version", "product_locale"],
                       filters=[("product_locale", "=", "us")]).to_pandas()
    ex = ex.merge(pmap, on="product_id", how="left")
    ex["category"] = ex["category"].fillna("")
    ex["gain"] = ex["esci_label"].map(GAIN).astype(int)
    g = ex.groupby("query_id").agg(n=("product_id", "size"), cov=("category", lambda s: (s != "").mean()),
                                   nrel=("gain", lambda s: (s >= 2).sum()), small=("small_version", "max"))
    good = g[(g["cov"] >= 0.75) & (g["n"] >= 6) & (g["nrel"] >= 1)].index
    ex = ex[ex.query_id.isin(good) & (ex.category != "")]
    qcat = ex.groupby("query_id")["category"].agg(lambda s: s.value_counts().index[0])
    print(f"[esci] candidate queries: {len(qcat):,}  by category: {qcat.value_counts().to_dict()}")

    # round-robin across categories, deterministic shuffle, until product budget reached
    rng = random.Random(SEED)
    buckets = {c: sorted(qcat[qcat == c].index.tolist()) for c in CATS}
    for b in buckets.values():
        rng.shuffle(b)
    by_q = ex.groupby("query_id")["product_id"].apply(list).to_dict()
    chosen_q, chosen_p = [], set()
    while len(chosen_p) < max_products and any(buckets.values()):
        for c in CATS:
            if buckets[c] and len(chosen_p) < max_products:
                q = buckets[c].pop()
                chosen_q.append(q)
                chosen_p.update(by_q[q])
    qrels = ex[ex.query_id.isin(chosen_q) & ex.product_id.isin(chosen_p)]
    print(f"[esci] chose {len(chosen_q):,} queries, {len(chosen_p):,} products, {len(qrels):,} judgements")

    print("[esci] loading full product text for subset...")
    ids = pa.array(sorted(chosen_p))
    full = pq.read_table(pr_path, columns=["product_id", "product_title", "product_description", "product_bullet_point",
                                           "product_brand", "product_color", "product_locale"],
                         filters=[("product_locale", "=", "us")])
    full = full.filter(pc.is_in(full["product_id"], value_set=ids)).to_pandas()
    full = full.drop_duplicates("product_id").rename(columns={
        "product_title": "title", "product_description": "description", "product_bullet_point": "bullets",
        "product_brand": "brand", "product_color": "color"}).drop(columns=["product_locale"])
    full = full.merge(pmap, on="product_id", how="left")
    full["brand"] = full["brand"].fillna("Unbranded")
    full["description"] = full["description"].fillna("").str.replace(r"<[^>]+>", " ", regex=True).str.slice(0, 2000)
    full["bullets"] = full["bullets"].fillna("")
    full = add_synthetic(full.sort_values("product_id").reset_index(drop=True))
    full["source"] = "esci"

    # queries + splits
    qdf = ex[ex.query_id.isin(chosen_q)].groupby("query_id").agg(query=("query", "first"), small=("small_version", "max")).reset_index()
    st = qrels.groupby("query_id").agg(n_judged=("gain", "size"), n_relevant=("gain", lambda s: (s >= 2).sum()),
                                       n_exact=("gain", lambda s: (s == 3).sum()), frac_irrelevant=("gain", lambda s: (s <= 1).mean()))
    qdf = qdf.merge(st, on="query_id")
    qdf["category"] = qdf["query_id"].map(qcat)
    nwords = qdf["query"].str.split().str.len()
    qdf["difficulty"] = (qdf["frac_irrelevant"] + 0.1 * np.minimum(nwords, 8) + 0.3 * qdf["small"]
                         + 0.3 * qdf["query"].str.contains(r"\b(?:without|not|no|for|under|free)\b", regex=True)).round(3)
    qdf["split"] = [("test" if stable_rng(f"split{q}").random() < 0.6 else "dev") for q in qdf["query_id"]]
    qdf = qdf.drop(columns=["small"])
    write_outputs(full, qdf, qrels[["query_id", "product_id", "esci_label", "gain"]],
                  "Amazon ESCI Shopping Queries (Apache-2.0), US locale subset; commerce fields synthetic")


def write_outputs(products: pd.DataFrame, queries: pd.DataFrame, qrels: pd.DataFrame, source: str) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    products.to_parquet(DATA / "products.parquet", index=False)
    queries.to_parquet(DATA / "queries.parquet", index=False)
    split = qrels.merge(queries[["query_id", "split"]], on="query_id")
    for s in ("dev", "test"):
        split[split.split == s].drop(columns="split").to_parquet(DATA / f"qrels_{s}.parquet", index=False)
    (DATA / "SOURCE.txt").write_text(source + "\n")
    print(f"[done] products={len(products):,} queries={len(queries):,} "
          f"(dev={int((queries.split=='dev').sum())}, test={int((queries.split=='test').sum())}) "
          f"qrels={len(qrels):,}\n[done] source: {source}")
    print(products["category"].value_counts().to_string())


def build_synthetic_fallback(max_products: int) -> None:
    banner("ESCI DOWNLOAD FAILED -> USING SYNTHETIC FALLBACK CATALOG (NOT REAL QUERIES/LABELS)")
    # The synthetic generator lives in a design-document folder outside this repo. Point
    # SAMPLE_DATA_DIR at it to use that fallback; without it there is nothing to fall back to,
    # and failing loudly beats writing a catalogue nobody can trace.
    sample_dir = os.environ.get("SAMPLE_DATA_DIR")
    if not sample_dir or not os.path.isdir(sample_dir):
        raise SystemExit(
            "ESCI download failed and no synthetic fallback is available. Set SAMPLE_DATA_DIR to a\n"
            "directory containing generate_sample_data.py, or re-run once the download works."
        )
    sys.path.insert(0, sample_dir)
    import generate_sample_data as g  # noqa: E402

    dept_map = {"grocery": "grocery", "household": "health_household", "baby": "baby", "pharmacy_otc": "health_household"}
    base = [c for c in g.CAT]
    rng = random.Random(SEED)
    sizes = ["Value Pack", "Family Size", "2 Pack", "Travel Size", "Bulk", "Mini", "Original", "Lite"]
    rows, queries, qrels = [], [], []
    i = 0
    while len(rows) < max_products:
        c = base[i % len(base)]
        cat = dept_map.get(c[1], "home_kitchen")
        title = f"{c[4]} {rng.choice(sizes)}" if i >= len(base) else c[4]
        rows.append({"product_id": f"SYN{i:07d}", "title": title, "brand": c[5], "description": c[3],
                     "bullets": c[2], "color": "", "category": cat})
        i += 1
    prods = add_synthetic(pd.DataFrame(rows))
    prods["source"] = "synthetic_fallback"
    for qi, pt in enumerate(sorted({c[2] for c in base})):
        qid = qi + 1
        queries.append({"query_id": qid, "query": pt.lower(), "n_judged": 0, "n_relevant": 0, "n_exact": 0,
                        "frac_irrelevant": 0.0, "category": "", "difficulty": 0.0,
                        "split": "test" if qi % 5 else "dev"})
        hits = prods[prods.bullets == pt].head(20)
        for pid in hits.product_id:
            qrels.append({"query_id": qid, "product_id": pid, "esci_label": "E", "gain": 3})
    prods["bullets"] = ""
    write_outputs(prods, pd.DataFrame(queries), pd.DataFrame(qrels), "SYNTHETIC FALLBACK (generate_sample_data.py scaled)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-products", type=int, default=int(os.environ.get("SPARKY_MAX_PRODUCTS", 25000)))
    ap.add_argument("--synthetic", action="store_true", help="force synthetic fallback")
    a = ap.parse_args()
    if a.synthetic:
        return build_synthetic_fallback(a.max_products)
    try:
        build_from_esci(a.max_products)
    except Exception as e:
        banner(f"ESCI path failed: {e!r}")
        build_synthetic_fallback(a.max_products)


if __name__ == "__main__":
    main()
