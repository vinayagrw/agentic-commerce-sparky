#!/usr/bin/env python3
"""Technique 8: CONTEXTUAL RETRIEVAL over a coherent slice of the real ESCI catalogue.

Anthropic's contextual retrieval (Sept 2024) prepends an LLM-written, document-aware situating
context to each chunk before embedding and BM25. Here the "document" is a product record and the
"chunk" is the indexed product text, so the context has to do the job the playbook describes for
policy chunks: bridge the vocabulary gap between how the catalogue writes a product and how a
shopper searches for it.

  SCOPE (declared, not hidden): the slice is the `baby` category - the category with the largest
  share (67/200) of the held-out ESCI test queries the existing eval already uses - narrowed by
  --pool-depth to the union of the BASELINE hybrid top-K candidates for those 67 queries. That is
  every document that actually competes for a top-10 slot on the evaluated queries, relevant and
  irrelevant alike, so the comparison is not stacked toward the relevant documents. The narrowing
  exists because the measured claude-CLI cost is ~$0.0015/product at batch 40 and the budget is
  $1.50, which buys ~1,000 products, not the whole 4,033-product category.

  This makes the measurement CONSERVATIVE in one specific way, and the report must say so: a
  document that only enrichment would have pulled into the top-K is not in the pool, so it is not
  enriched and cannot gain. The design can therefore under-state a positive effect. It cannot
  manufacture one.

  The playbook's own "When NOT to use" says contextual retrieval is for chunks that lost their
  parent context, NOT for "structured catalog records that already carry their context in fields
  (title, brand, category)". This script runs it anyway, on a structured catalogue, and reports what
  actually happens. A null or negative delta is a legitimate outcome of that experiment.

Verification (playbook step 4), applied to every generated context before it is indexed:
  1. schema      - the batch call must return one object per requested product id
  2. length      - <= MAX_WORDS words
  3. entity check - every number and every non-leading capitalised token in the context must occur
                    in the product's real text. Generic shopper vocabulary (lower-case) is allowed
                    through, because adding it is the entire point; inventing a brand, a model
                    number or a size is not.
Rejected contexts are dropped (the product keeps its baseline text) and counted in the report.

Writes:
  data/variants/<name>/contexts.json   every accepted context + its generator model and prompt hash
  data/variants/<name>/emb.npy         the variant document embedding matrix (full catalogue)
  data/variants/<name>/bm25/           the variant BM25 index over the enriched corpus
  data/variants/<name>/manifest.json   lineage: slice, counts, model, prompt hash, cost, timings

Usage (from services/search-svc; needs the claude CLI on PATH or at ~/.local/bin/claude):
    uv run python ../../scripts/contextual_enrich.py --category baby --batch 12 --parallel 8
    uv run python ../../scripts/contextual_enrich.py --category baby --limit 24 --dry-cost   # probe
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
sys.path.insert(0, str(ROOT / "services" / "search-svc"))

MAX_WORDS = 55
SYSTEM = ("You are a retrieval-index enrichment tool for a retail product catalogue. "
          "You output ONE JSON array and nothing else. No prose, no markdown fences.")

PROMPT = """<catalogue_slice>
{slice_doc}
</catalogue_slice>

Here are the product records we want to situate within that catalogue slice, so that shopper
searches find them. For EACH product write a short situating context (max {max_words} words).

The context must:
- name the concrete product TYPE in plain shopper words (e.g. "infant car seat base", "nursing pillow cover")
- add the everyday search terms and synonyms a shopper would type for it that the title does not already use
- name what it is used for / what it is compatible with, only if the product text says so
- NOT invent any brand, model number, size, age range, material or claim that is not in the product text
- be a single sentence fragment, no full stop needed, no marketing language

PRODUCTS
{products}

Return exactly a JSON array, one object per product, in the same order:
[{{"id": "<product id>", "context": "<context>"}}, ...]"""


def claude_bin() -> str | None:
    p = shutil.which("claude")
    if p:
        return p
    home = Path.home() / ".local/bin/claude"
    return str(home) if home.exists() else None


class Claude:
    """Thin wrapper around the claude CLI, same shape as scripts/synth_attributes.py. Measured spend."""

    def __init__(self, model: str, cwd: str, cfg: str):
        self.bin = claude_bin()
        self.model, self.cwd, self.cfg = model, cwd, cfg
        self.cost = 0.0
        self.calls = 0
        self.failures = 0

    def ask(self, prompt: str, timeout: int = 240) -> tuple[str | None, float]:
        cmd = [self.bin, "-p", prompt, "--output-format", "json", "--model", self.model,
               "--mcp-config", self.cfg, "--strict-mcp-config", "--allowedTools", "",
               "--setting-sources", "", "--disable-slash-commands", "--max-turns", "1",
               "--system-prompt", SYSTEM]
        env = {**os.environ, "ENABLE_TOOL_SEARCH": "false"}
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env, cwd=self.cwd)
            d = json.loads(p.stdout) if p.stdout.strip().startswith("{") else {}
        except Exception:
            self.failures += 1
            return None, 0.0
        c = float(d.get("total_cost_usd") or 0.0)
        self.cost += c
        self.calls += 1
        if d.get("is_error"):
            self.failures += 1
            return None, c
        return d.get("result"), c


def parse_array(s: str | None) -> list | None:
    if not s:
        return None
    m = re.search(r"\[.*\]", s.strip(), re.S)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
        return v if isinstance(v, list) else None
    except Exception:
        return None


def product_text(r: dict) -> str:
    return f"{r['title']} | {r['brand']} | {str(r.get('description') or '')[:300]} | {str(r.get('bullets') or '')[:400]}"


CAP_RX = re.compile(r"\b[A-Z][A-Za-z0-9''\-]{1,}\b")
NUM_RX = re.compile(r"\b\d+(?:\.\d+)?\b")


def verify(ctx: str, source: str) -> list[str]:
    """Return failure reasons; empty means the context is safe to index."""
    reasons = []
    if not isinstance(ctx, str) or not ctx.strip():
        return ["empty context"]
    ctx = ctx.strip()
    if len(ctx.split()) > MAX_WORDS:
        reasons.append(f"too long: {len(ctx.split())} words > {MAX_WORDS}")
    low = source.lower()
    for n in set(NUM_RX.findall(ctx)):
        if n not in low:
            reasons.append(f"number not in product text: {n}")
    toks = ctx.split()
    for i, t in enumerate(toks):
        for cap in CAP_RX.findall(t):
            if i == 0 and cap == t:
                continue  # leading word may be capitalised by the model
            if cap.lower() not in low:
                reasons.append(f"capitalised token not in product text: {cap}")
    return sorted(set(reasons))


def slice_doc(df: pd.DataFrame, category: str) -> str:
    """The cached 'document' prefix: what this catalogue slice actually contains, from the real data."""
    brands = df["brand"].value_counts().head(25).index.tolist()
    return (f"Retail catalogue slice: category `{category}`, {len(df):,} products from the Amazon ESCI "
            f"shopping-queries dataset (US locale), indexed for a grocery/marketplace search engine.\n"
            f"Most frequent brands in this slice: {', '.join(brands)}.\n"
            f"Shoppers search this slice with short, misspelt, attribute-heavy queries.")


def make_batch_prompt(rows: list[dict], sdoc: str) -> str:
    items = []
    for r in rows:
        items.append(f"- id: {r['product_id']}\n  title: {r['title'][:200]}\n  brand: {r['brand']}\n"
                     f"  text: {(str(r.get('description') or '') + ' ' + str(r.get('bullets') or '')).strip()[:420]}")
    return PROMPT.format(slice_doc=sdoc, max_words=MAX_WORDS, products="\n".join(items))


def run_batch(rows: list[dict], sdoc: str, cl: Claude) -> list[dict]:
    prompt = make_batch_prompt(rows, sdoc)
    raw, cost = cl.ask(prompt)
    arr = parse_array(raw) or []
    by_id = {str(o.get("id")): str(o.get("context") or "") for o in arr if isinstance(o, dict)}
    out = []
    per = round(cost / max(1, len(rows)), 7)
    for r in rows:
        ctx = by_id.get(r["product_id"], "").strip()
        rec = {"product_id": r["product_id"], "context": ctx, "cost_usd": per}
        if not ctx:
            rec.update(accepted=False, reasons=["no context returned for this id"])
        else:
            reasons = verify(ctx, product_text(r))
            rec.update(accepted=not reasons, reasons=reasons)
        out.append(rec)
    return out


def build_variant(name: str, contexts: dict[str, str], products: pd.DataFrame, out_dir: Path) -> dict:
    """Re-embed and re-BM25 the FULL catalogue with `context + "\\n\\n" + doc_text` for enriched rows."""
    import numpy as np
    import torch  # noqa: F401  import before faiss/bm25s to avoid the macOS OpenMP segfault
    import bm25s
    import Stemmer
    from sentence_transformers import SentenceTransformer

    from engine import EMB_MODEL, doc_text

    texts = []
    for _, r in products.iterrows():
        base = doc_text(r)
        c = contexts.get(r["product_id"])
        texts.append(f"{c}\n\n{base}" if c else base)

    t0 = time.time()
    enc = SentenceTransformer(EMB_MODEL, device="cpu")
    emb = enc.encode(texts, batch_size=128, normalize_embeddings=True, show_progress_bar=True).astype("float32")
    t_emb = round(time.time() - t0, 1)

    t1 = time.time()
    stemmer = Stemmer.Stemmer("english")
    corpus = bm25s.tokenize(texts, stemmer=stemmer, show_progress=False)
    bm = bm25s.BM25()
    bm.index(corpus, show_progress=False)
    out_dir.mkdir(parents=True, exist_ok=True)
    bm.save(str(out_dir / "bm25"))
    np.save(out_dir / "emb.npy", emb)
    return {"embed_seconds": t_emb, "bm25_seconds": round(time.time() - t1, 1),
            "embedding_model": EMB_MODEL, "n_texts": len(texts), "emb_shape": list(emb.shape)}


def candidate_pool(category: str, depth: int, split: str, n_queries: int) -> tuple[set[str], dict]:
    """Union of the baseline hybrid (BM25+dense RRF) top-`depth` ids over the held-out queries of
    `category`. Uses the SAME query selection as engine.eval_qids, so the pool is exactly the set of
    documents that compete on the queries the delta is measured on."""
    import torch  # noqa: F401  before faiss
    from engine import Engine, rrf

    e = Engine()
    qids, _ = e.eval_qids(split, n_queries)
    q = e.queries.set_index("query_id")
    sel = [qid for qid in qids if q.at[qid, "category"] == category]
    pool: set[str] = set()
    for qid in sel:
        text = q.at[qid, "query"]
        bm = e.bm25_top(text, None)
        vec = e.vector_top(text, None)
        order, _ = rrf([i for i, _ in bm], [i for i, _ in vec])
        pool.update(e.ids[i] for i in order[:depth])
    meta = {"basis": "union of baseline BM25+dense RRF(k=60) top-K over the held-out queries of this category",
            "split": split, "n_queries_scanned": len(qids), "queries_in_category": len(sel),
            "pool_depth": depth, "pool_size": len(pool)}
    return pool, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--category", default="baby")
    ap.add_argument("--pool-depth", type=int, default=0,
                    help="restrict the slice to the baseline hybrid top-K candidate pool of this category's held-out queries")
    ap.add_argument("--split", default="test")
    ap.add_argument("--n-queries", type=int, default=200, help="held-out query budget, same as the existing eval")
    ap.add_argument("--name", default=None, help="variant name (default ctx_<category>)")
    ap.add_argument("--batch", type=int, default=12)
    ap.add_argument("--parallel", type=int, default=8)
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--limit", type=int, default=0, help="only enrich the first N products (probing)")
    ap.add_argument("--budget-usd", type=float, default=1.50, help="hard stop once measured spend exceeds this")
    ap.add_argument("--dry-cost", action="store_true", help="generate contexts only; do not re-embed")
    a = ap.parse_args()

    if not claude_bin():
        raise SystemExit("claude CLI not found (looked on PATH and at ~/.local/bin/claude)")

    name = a.name or f"ctx_{a.category}"
    out_dir = DATA / "variants" / name
    out_dir.mkdir(parents=True, exist_ok=True)

    products = pd.read_parquet(DATA / "products.parquet")
    sl = products[products.category == a.category]
    pool_meta = None
    if a.pool_depth:
        pool, pool_meta = candidate_pool(a.category, a.pool_depth, a.split, a.n_queries)
        sl = sl[sl.product_id.isin(pool)]
        pool_meta["in_category_pool_size"] = len(sl)
        print(f"[ctx] candidate pool depth {a.pool_depth}: {pool_meta['pool_size']:,} ids over "
              f"{pool_meta['queries_in_category']} `{a.category}` queries -> {len(sl):,} in-category products", flush=True)
    rows = sl.to_dict("records")
    if a.limit:
        rows = rows[: a.limit]
    sdoc = slice_doc(sl, a.category)
    prompt_hash = hashlib.sha256((PROMPT + SYSTEM).encode()).hexdigest()[:12]
    print(f"[ctx] slice `{a.category}`: {len(sl):,}/{len(products):,} products; enriching {len(rows):,} "
          f"in batches of {a.batch} (prompt {prompt_hash})", flush=True)

    cfg = Path(tempfile.gettempdir()) / "ctx-nomcp.json"
    cfg.write_text('{"mcpServers":{}}')
    cl = Claude(a.model, tempfile.gettempdir(), str(cfg))
    t0 = time.time()
    warm, wc = cl.ask("Reply with exactly: OK")
    print(f"[ctx] cache warm-up {'ok' if warm else 'failed'} (${wc:.4f})", flush=True)

    batches = [rows[i:i + a.batch] for i in range(0, len(rows), a.batch)]
    items: list[dict] = []
    stopped_on_budget = False
    with ThreadPoolExecutor(a.parallel) as ex:
        for i in range(0, len(batches), a.parallel):
            if cl.cost > a.budget_usd:
                stopped_on_budget = True
                print(f"[ctx] budget ${a.budget_usd} exceeded at ${cl.cost:.4f}; stopping early", flush=True)
                break
            chunk = batches[i:i + a.parallel]
            for res in ex.map(lambda b: run_batch(b, sdoc, cl), chunk):
                items.extend(res)
            done = len(items)
            acc = sum(1 for x in items if x["accepted"])
            print(f"[ctx] {done:,}/{len(rows):,} products, accepted {acc:,} ({acc / max(1, done):.1%}), "
                  f"${cl.cost:.4f}", flush=True)

    accepted = {x["product_id"]: x["context"] for x in items if x["accepted"]}
    reason_counts: dict[str, int] = {}
    for x in items:
        for r in x["reasons"]:
            key = re.sub(r":.*$", "", r)
            reason_counts[key] = reason_counts.get(key, 0) + 1

    (out_dir / "contexts.json").write_text(json.dumps(
        {"generator_model": a.model, "prompt_hash": prompt_hash, "max_words": MAX_WORDS,
         "items": items}, indent=2))

    manifest = {
        "name": name, "technique": 8, "technique_name": "Contextual retrieval",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "slice": {"category": a.category, "products_in_slice": len(sl), "attempted": len(rows),
                  "catalogue_size": len(products), "candidate_pool": pool_meta,
                  "why": "largest share of the 200 held-out ESCI test queries used by the existing eval",
                  "conservative_bias": ("documents outside the baseline candidate pool are not enriched, so a "
                                        "document that only enrichment would have surfaced cannot gain; the design "
                                        "can under-state a positive effect, never manufacture one")
                  if pool_meta else None},
        "generator": {"model": a.model, "cli": "claude -p, 1 turn, no tools", "batch_size": a.batch,
                      "parallel": a.parallel, "prompt_hash": prompt_hash},
        "verification": {"max_words": MAX_WORDS,
                         "checks": ["schema: one object per requested id", f"length <= {MAX_WORDS} words",
                                    "entity: every number and non-leading capitalised token must occur in the real product text"],
                         "rejected_reasons": dict(sorted(reason_counts.items(), key=lambda kv: -kv[1]))},
        "results": {"attempted": len(items), "accepted": len(accepted),
                    "acceptance_rate": round(len(accepted) / max(1, len(items)), 4),
                    "enriched_share_of_catalogue": round(len(accepted) / len(products), 4)},
        "cost": {"claude_calls": cl.calls, "failed_calls": cl.failures, "total_usd": round(cl.cost, 4),
                 "budget_usd": a.budget_usd, "stopped_on_budget": stopped_on_budget,
                 "usd_per_accepted_context": round(cl.cost / len(accepted), 6) if accepted else None},
        "seconds_generation": round(time.time() - t0, 1),
    }
    if not a.dry_cost and accepted:
        print(f"[ctx] re-embedding {len(products):,} products ({len(accepted):,} enriched)...", flush=True)
        manifest["index"] = build_variant(name, accepted, products, out_dir)
        manifest["files"] = {"emb": "emb.npy", "bm25": "bm25/", "contexts": "contexts.json"}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"[ctx] accepted {len(accepted):,}/{len(items):,} contexts, ${cl.cost:.4f} -> {out_dir}", flush=True)


if __name__ == "__main__":
    main()
