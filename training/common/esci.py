"""Shared ESCI data access for the GPU-only training techniques (playbook §11-§17).

Every script under `training/` builds its dataset from the SAME on-disk artefacts that the
rest of Sparky Next uses (`data/*.parquet`, produced by `scripts/fetch_data.py`). Nothing here
invents labels: the supervision signal is always the real Amazon ESCI E/S/C/I judgement.

Hard dependencies: pandas, numpy. Everything else (datasets, torch, transformers) is imported
lazily by the callers so that `--smoke` runs on a CPU-only laptop with a minimal environment.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

# repo root = .../agentic-commerce-sparky  (this file is training/common/esci.py)
REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("SPARKY_DATA_DIR", REPO_ROOT / "data"))

REQUIRED_FILES = ["products.parquet", "queries.parquet", "qrels_dev.parquet", "qrels_test.parquet"]

# ESCI gain mapping as written by scripts/fetch_data.py
GAIN = {"E": 3, "S": 2, "C": 1, "I": 0}

CATEGORIES = [
    "grocery",
    "home_kitchen",
    "baby",
    "health_household",
    "pet",
    "electronics_accessories",
]

DIETARY_TAGS = ["gluten_free", "vegan", "organic"]


class DataMissingError(RuntimeError):
    """Raised when the ESCI parquet files have not been fetched yet."""


def data_dir() -> Path:
    return DATA_DIR


def assert_data_present(where: Path | None = None) -> Path:
    d = Path(where) if where else DATA_DIR
    missing = [f for f in REQUIRED_FILES if not (d / f).exists()]
    if missing:
        raise DataMissingError(
            f"missing {missing} under {d}. Run:  cd services/search-svc && "
            f"uv run python ../../scripts/fetch_data.py"
        )
    return d


@dataclass
class EsciCorpus:
    """The three ESCI frames, joined on demand."""

    products: pd.DataFrame
    queries: pd.DataFrame
    qrels: pd.DataFrame
    split: str = "dev"
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def n(self) -> dict[str, int]:
        return {
            "products": len(self.products),
            "queries": len(self.queries),
            "qrels": len(self.qrels),
        }


def load_corpus(split: str = "dev", where: Path | None = None) -> EsciCorpus:
    """Load products + queries + qrels for a split. Pure pandas, no GPU, no network."""
    d = assert_data_present(where)
    products = pd.read_parquet(d / "products.parquet")
    queries = pd.read_parquet(d / "queries.parquet")
    qrels = pd.read_parquet(d / f"qrels_{split}.parquet")
    # keep only qrels whose query survived the subsetting step
    qrels = qrels[qrels["query_id"].isin(set(queries["query_id"]))]
    source = (d / "SOURCE.txt").read_text().strip() if (d / "SOURCE.txt").exists() else "unknown"
    return EsciCorpus(
        products=products,
        queries=queries,
        qrels=qrels,
        split=split,
        meta={"data_dir": str(d), "source": source},
    )


# --------------------------------------------------------------------------------------
# Task 1: tail-query rewriting (playbook §11 UC1, §12, §14)
# --------------------------------------------------------------------------------------

_WS = re.compile(r"\s+")


def _clean(s: Any) -> str:
    return _WS.sub(" ", str(s or "")).strip()


def is_tail(row: pd.Series) -> bool:
    """A 'tail' query in the ESCI subset: hard (high difficulty) or sparsely-relevant.

    `difficulty` is written by scripts/fetch_data.py; `frac_irrelevant` is the share of
    judged products labelled I. Both come from the real judgements, not from a heuristic
    about the query string.
    """
    return bool(row.get("difficulty", 0) >= 1.0 or row.get("frac_irrelevant", 0.0) >= 0.30)


def canonical_rewrite(title: str, brand: str, category: str) -> str:
    """A deterministic, extractive 'rewrite' target built from the judged product.

    This is NOT a model-generated or hand-written gold rewrite. It is the head noun phrase of
    an E-judged (exact-match) product title plus its brand, which is exactly the supervision
    the playbook describes for a rewriter trained on converted items (§11 step 1). Keeping it
    extractive means the target is auditable against the catalogue row it came from.
    """
    t = _clean(title)
    # first clause of the title up to the first heavy separator, capped to a short phrase
    t = re.split(r"[,|\-–(\[]", t)[0]
    words = t.split()[:8]
    phrase = " ".join(words).lower()
    b = _clean(brand).lower()
    if b and b not in phrase:
        phrase = f"{b} {phrase}"
    return _WS.sub(" ", phrase).strip()


REWRITE_SYSTEM = (
    "You are the Sparky query-understanding rewriter. Rewrite a shopper's raw search query "
    "into a canonical catalogue phrase and assign one category.\n"
    "Categories: " + ", ".join(CATEGORIES) + ".\n"
    "Answer with exactly two lines:\nrewrite: <phrase>\ncategory: <category>"
)


def build_rewrite_pairs(
    corpus: EsciCorpus,
    max_examples: int | None = None,
    tail_only: bool = True,
    seed: int = 20260915,
) -> pd.DataFrame:
    """(query, rewrite, category) triples grounded in E-judged products.

    Returns columns: query_id, query, prompt, completion, rewrite, category, product_id.
    """
    q = corpus.queries
    if tail_only:
        q = q[q.apply(is_tail, axis=1)]
    exact = corpus.qrels[corpus.qrels["esci_label"] == "E"]
    prod = corpus.products.set_index("product_id")
    joined = exact.merge(q[["query_id", "query"]], on="query_id", how="inner")
    if joined.empty:
        raise DataMissingError("no E-judged (query, product) rows for this split")

    rng = np.random.default_rng(seed)
    joined = joined.sample(frac=1.0, random_state=int(rng.integers(0, 2**31 - 1)))
    # one target product per query: the first E-judgement after the shuffle
    joined = joined.drop_duplicates(subset=["query_id"], keep="first")

    rows: list[dict[str, Any]] = []
    for r in joined.itertuples(index=False):
        if r.product_id not in prod.index:
            continue
        p = prod.loc[r.product_id]
        rw = canonical_rewrite(p["title"], p["brand"], p["category"])
        if len(rw) < 3:
            continue
        rows.append(
            {
                "query_id": int(r.query_id),
                "query": _clean(r.query),
                "product_id": r.product_id,
                "rewrite": rw,
                "category": str(p["category"]),
                "prompt": f"query: {_clean(r.query)}",
                "completion": f"rewrite: {rw}\ncategory: {p['category']}",
            }
        )
        if max_examples and len(rows) >= max_examples:
            break
    return pd.DataFrame(rows)


def to_chat(df: pd.DataFrame, system: str = REWRITE_SYSTEM) -> list[dict[str, Any]]:
    """TRL conversational format: {"prompt": [...], "completion": [...]}."""
    return [
        {
            "prompt": [
                {"role": "system", "content": system},
                {"role": "user", "content": r["prompt"]},
            ],
            "completion": [{"role": "assistant", "content": r["completion"]}],
        }
        for _, r in df.iterrows()
    ]


# --------------------------------------------------------------------------------------
# Task 2: preference pairs (playbook §12)
# --------------------------------------------------------------------------------------


def build_preference_pairs(
    corpus: EsciCorpus,
    max_examples: int | None = None,
    seed: int = 20260915,
) -> pd.DataFrame:
    """(prompt, chosen, rejected) where `chosen` is derived from an E product and `rejected`
    from an I product judged against the SAME query.

    The preference signal is therefore the human ESCI judgement itself, not an LLM judge and
    not a guess. Playbook §12 US-12.2 requires every pair to be traceable: we carry
    chosen_product_id / rejected_product_id / source on every row.
    """
    qr = corpus.qrels
    prod = corpus.products.set_index("product_id")
    qtext = dict(zip(corpus.queries["query_id"], corpus.queries["query"]))

    rng = np.random.default_rng(seed)
    exact = qr[qr["esci_label"] == "E"]
    irrel = qr[qr["esci_label"] == "I"]
    common = sorted(set(exact["query_id"]) & set(irrel["query_id"]))
    rng.shuffle(common)

    e_by_q = {k: list(v) for k, v in exact.groupby("query_id")["product_id"]}
    i_by_q = {k: list(v) for k, v in irrel.groupby("query_id")["product_id"]}

    rows: list[dict[str, Any]] = []
    for qid in common:
        pe, pi = e_by_q[qid][0], i_by_q[qid][0]
        if pe not in prod.index or pi not in prod.index:
            continue
        ce, ci = prod.loc[pe], prod.loc[pi]
        chosen = f"rewrite: {canonical_rewrite(ce['title'], ce['brand'], ce['category'])}\ncategory: {ce['category']}"
        rejected = f"rewrite: {canonical_rewrite(ci['title'], ci['brand'], ci['category'])}\ncategory: {ci['category']}"
        if chosen == rejected:
            continue
        rows.append(
            {
                "query_id": int(qid),
                "prompt": f"query: {_clean(qtext.get(qid, ''))}",
                "chosen": chosen,
                "rejected": rejected,
                "chosen_product_id": pe,
                "rejected_product_id": pi,
                "source": "esci_human_judgement",
                "judge_id": None,
                "human_verified": True,
                "len_delta": len(chosen) - len(rejected),
            }
        )
        if max_examples and len(rows) >= max_examples:
            break
    return pd.DataFrame(rows)


def length_balance_filter(pairs: pd.DataFrame, max_ratio: float = 1.5) -> pd.DataFrame:
    """Playbook §12 step 3 / AC2: drop pairs where `chosen` is systematically longer,
    which is the classic DPO length-exploitation failure mode."""
    if pairs.empty:
        return pairs
    lc = pairs["chosen"].str.len().clip(lower=1)
    lr = pairs["rejected"].str.len().clip(lower=1)
    ratio = lc / lr
    return pairs[(ratio <= max_ratio) & (ratio >= 1.0 / max_ratio)].copy()


# --------------------------------------------------------------------------------------
# Task 3: verifiable filter extraction (playbook §13)
# --------------------------------------------------------------------------------------

FILTER_SYSTEM = (
    "Convert a shopper query into a Sparky search filter object. Reply with JSON only, "
    'matching: {"category": <one of ' + "|".join(CATEGORIES) + '>, '
    '"price_max": <number or null>, "dietary": [<gluten_free|vegan|organic>], '
    '"brand": <string or null>, "evidence": <substring of the query>}'
)


def build_filter_tasks(
    corpus: EsciCorpus,
    max_examples: int | None = None,
    seed: int = 20260915,
) -> pd.DataFrame:
    """Prompts plus a GOLD filter object derived from the E-judged products of each query.

    gold.category  = modal category of the query's E products
    gold.price_max = 90th percentile price of the query's E products (a real catalogue number)
    gold.dietary   = dietary tags present on >= half of the E products
    gold.brand     = modal brand when >= half the E products share it, else null
    """
    prod = corpus.products.set_index("product_id")
    exact = corpus.qrels[corpus.qrels["esci_label"] == "E"]
    qtext = dict(zip(corpus.queries["query_id"], corpus.queries["query"]))
    rng = np.random.default_rng(seed)

    rows: list[dict[str, Any]] = []
    qids = sorted(set(exact["query_id"]))
    rng.shuffle(qids)
    grouped = {k: list(v) for k, v in exact.groupby("query_id")["product_id"]}
    for qid in qids:
        pids = [p for p in grouped[qid] if p in prod.index]
        if len(pids) < 2:
            continue
        sub = prod.loc[pids]
        cats = sub["category"].value_counts()
        brands = sub["brand"].astype(str).str.strip().replace("", np.nan).dropna().value_counts()
        diet_counts: dict[str, int] = {t: 0 for t in DIETARY_TAGS}
        for tags in sub["dietary"]:
            for t in list(tags) if tags is not None else []:
                if t in diet_counts:
                    diet_counts[t] += 1
        gold = {
            "category": str(cats.index[0]),
            "price_max": round(float(np.percentile(sub["price"].astype(float), 90)), 2),
            "dietary": sorted([t for t, c in diet_counts.items() if c >= len(sub) / 2]),
            "brand": str(brands.index[0]) if len(brands) and brands.iloc[0] >= len(sub) / 2 else None,
        }
        query = _clean(qtext.get(qid, ""))
        if not query:
            continue
        rows.append(
            {
                "query_id": int(qid),
                "prompt": f"query: {query}",
                "query": query,
                "gold": json.dumps(gold),
                "n_exact_products": len(sub),
            }
        )
        if max_examples and len(rows) >= max_examples:
            break
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------------------
# Task 4: catalogue text corpus (playbook §15 continued pre-training)
# --------------------------------------------------------------------------------------


def build_catalog_corpus(
    corpus: EsciCorpus, max_docs: int | None = None
) -> pd.DataFrame:
    """Plain-text catalogue documents: title + brand + bullets + description.

    §15 only makes sense for continued pre-training on a domain corpus; this is that corpus.
    `untrusted_seller_text` is deliberately EXCLUDED (it carries the planted-injection strings
    from scripts/plant_injections.py and must never reach a training corpus).
    """
    p = corpus.products
    parts = [
        p["title"].fillna(""),
        p["brand"].fillna(""),
        p["category"].fillna(""),
        p["bullets"].fillna(""),
        p["description"].fillna(""),
    ]
    text = parts[0].str.cat([x.astype(str) for x in parts[1:]], sep="\n").map(_clean)
    out = pd.DataFrame({"product_id": p["product_id"], "text": text})
    out = out[out["text"].str.len() >= 40]
    if max_docs:
        out = out.head(max_docs)
    return out.reset_index(drop=True)


# --------------------------------------------------------------------------------------
# Smoke-test plumbing shared by every entrypoint
# --------------------------------------------------------------------------------------


def optional_imports(names: list[str]) -> dict[str, str]:
    """Report which heavy GPU-side libraries are importable here, without failing."""
    import importlib

    out: dict[str, str] = {}
    for n in names:
        try:
            m = importlib.import_module(n)
            out[n] = str(getattr(m, "__version__", "present"))
        except Exception:
            out[n] = "MISSING (installed on the GPU target, not required for --smoke)"
    return out


def smoke_report(title: str, sections: dict[str, Any]) -> int:
    """Print a deterministic, greppable smoke report. Returns a process exit code."""
    print(f"\n=== SMOKE: {title} ===")
    for k, v in sections.items():
        if isinstance(v, dict):
            print(f"[{k}]")
            for kk, vv in v.items():
                print(f"    {kk}: {vv}")
        elif isinstance(v, list):
            print(f"[{k}]")
            for item in v:
                print(f"    - {item}")
        else:
            print(f"[{k}] {v}")
    print("=== SMOKE OK: config + data + shapes validated on CPU. NO TRAINING RUN. ===\n")
    return 0


def require_gpu(technique: str) -> None:
    """Refuse to pretend. If there is no CUDA device, say so and exit non-zero."""
    try:
        import torch
    except Exception:
        raise SystemExit(
            f"{technique}: torch is not installed here. This script runs on a GPU target "
            f"(see README.md). Use --smoke for the CPU validation path."
        )
    if not torch.cuda.is_available():
        raise SystemExit(
            f"{technique}: no CUDA device visible. This technique is NOT runnable on this "
            f"machine by design. Submit it with the one-command cloud path in README.md, "
            f"or use --smoke for the CPU validation path."
        )
