"""Technique 29, half two: an online judge over REAL sessions, with its agreement measured.

How this is wired end to end:

  1. The BFF traces every routed request as an OTel GenAI span (bff/src/otel.ts) and POSTs a
     compact session record - trace id, query, arm, the product ids it actually returned - to
     ops-http `POST /online_evals/sessions`. Those are real requests that really happened;
     nothing is synthesised here.
  2. `sample()` takes a deterministic, stratified sample of them. Deterministic because the
     bucket is `hash(trace_id)`, so re-running the sampler picks the same sessions and arms
     stay comparable across runs (playbook 29 step 3).
  3. `judge()` scores each sampled (query, product) pair for relevance. The judge is a
     transparent lexical-and-attribute scorer, deliberately NOT the ranking model - a judge
     from the same family as the generator is the self-preference bias the playbook warns
     about (arXiv 2410.21819). It is a weak judge and is reported as one.
  4. `agreement()` compares the judge to the ONLY ground truth that exists on this laptop:
     held-out ESCI relevance labels. E/S = relevant, C/I = not. Agreement, Cohen's kappa, a
     Wilson CI and the confusion matrix are reported, always with the sample size, and the
     coverage - how many judged pairs had ground truth at all - is reported too, because a
     judge scored on 30 pairs is not a judge that has been validated.

There is no fallback. With no sessions ingested, every accessor says so.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import time

import pandas as pd

from .db import DATA

SESSIONS = DATA / "online_sessions.jsonl"
RELEVANT = {"E", "S"}
_qrels: pd.DataFrame | None = None


# ---------------------------------------------------------------- session store
def ingest(rows: list[dict]) -> dict:
    """Append real session records from the BFF. One JSON object per line."""
    n = 0
    SESSIONS.parent.mkdir(parents=True, exist_ok=True)
    with SESSIONS.open("a") as fh:
        for r in rows:
            if not r.get("query"):
                continue
            fh.write(json.dumps({**r, "ingested_at": time.time()}, default=str) + "\n")
            n += 1
    return {"ingested": n, "store": str(SESSIONS)}


def sessions(limit: int = 2000) -> list[dict]:
    if not SESSIONS.exists():
        return []
    out = []
    for line in SESSIONS.read_text().splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out[-limit:]


def clear() -> None:
    if SESSIONS.exists():
        SESSIONS.unlink()


# ---------------------------------------------------------------- sampling
def _bucket(trace_id: str) -> float:
    return int(hashlib.sha256(trace_id.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def sample(rate: float = 1.0, strata_key: str = "arm", limit: int = 2000) -> dict:
    """Deterministic hash-of-trace-id sampling, reported per stratum."""
    rows = sessions(limit)
    picked = [r for r in rows if _bucket(str(r.get("trace_id") or r.get("query"))) < rate]
    strata: dict[str, int] = {}
    for r in picked:
        strata[str(r.get(strata_key, "unknown"))] = strata.get(str(r.get(strata_key, "unknown")), 0) + 1
    return {"population": len(rows), "sampled": len(picked), "rate": rate,
            "sampling": f"deterministic: hash(trace_id) < {rate}; re-running picks the same sessions",
            "strata": strata, "sessions": picked}


# ---------------------------------------------------------------- the judge
_WORD = re.compile(r"[a-z0-9]+")


def _tokens(s: str) -> set[str]:
    return set(_WORD.findall((s or "").lower()))


def judge(query: str, title: str, brand: str = "", bullets: str = "") -> dict:
    """Binary relevance with a transparent score. Weak on purpose, and labelled weak."""
    q = _tokens(query)
    if not q:
        return {"relevant": False, "score": 0.0, "reason": "empty query"}
    hay = _tokens(f"{title} {brand} {bullets}")
    hit = q & hay
    coverage = len(hit) / len(q)
    # A brand or head-noun match in the title is worth more than a bullet match.
    title_cov = len(q & _tokens(title)) / len(q)
    score = round(0.65 * title_cov + 0.35 * coverage, 4)
    return {"relevant": score >= 0.5, "score": score, "matched_terms": sorted(hit),
            "reason": f"title term coverage {title_cov:.2f}, full-text coverage {coverage:.2f}"}


JUDGE_SPEC = {
    "judge_id": "sparky-lexical-judge-1.0.0",
    "judge_kind": "lexical",
    "label": "lexical judge (token overlap, not an LLM). Its kappa says nothing about LLM judges.",
    "family": "deterministic lexical scorer",
    "independent_of_generator": True,
    "why": "the ranker is a bi-encoder + cross-encoder; the judge is lexical, so it is not scoring its own output. "
           "A same-family judge is the self-preference bias arXiv:2410.21819 documents.",
    "threshold": 0.5,
    "limits": "a lexical judge cannot see semantics; it will call a correct substitute irrelevant. Its measured "
              "agreement with ESCI gold below is the honest ceiling on what it can tell you.",
}


# ---------------------------------------------------------------- ground truth
def _load_qrels() -> pd.DataFrame:
    global _qrels
    if _qrels is None:
        qr = pd.concat([pd.read_parquet(DATA / f"qrels_{s}.parquet") for s in ("dev", "test")], ignore_index=True)
        q = pd.read_parquet(DATA / "queries.parquet")[["query_id", "query"]]
        _qrels = qr.merge(q, on="query_id")
        _qrels["qkey"] = _qrels["query"].str.lower().str.strip()
    return _qrels


def _wilson(k: int, n: int, z: float = 1.96) -> list[float] | None:
    if not n:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0.0, c - h), 4), round(min(1.0, c + h), 4)]


def _kappa(a: list[bool], b: list[bool]) -> float | None:
    n = len(a)
    if not n:
        return None
    po = sum(x == y for x, y in zip(a, b)) / n
    pa, pb = sum(a) / n, sum(b) / n
    pe = pa * pb + (1 - pa) * (1 - pb)
    return round((po - pe) / (1 - pe), 4) if pe < 1 else 1.0


def agreement(rate: float = 1.0, max_pairs: int = 400) -> dict:
    """Judge every sampled session's returned products, and score the judge against ESCI gold."""
    s = sample(rate)
    if not s["sessions"]:
        return {"error": "no_sessions_ingested",
                "detail": f"the online judge scores REAL sessions and none have been ingested into {SESSIONS}. "
                          f"Run traffic through the BFF with OTEL_ENABLED=1 first; nothing is simulated here.",
                "sampling": s}
    try:
        qrels = _load_qrels()
        titles = pd.read_parquet(DATA / "products.parquet", columns=["product_id", "title", "brand"]).set_index("product_id")
    except (OSError, ValueError) as e:
        return {"error": "ground_truth_unavailable", "detail": repr(e)}

    gold_map = {(r.qkey, r.product_id): r.esci_label for r in qrels.itertuples()}
    judged, with_gold = [], []
    for sess in s["sessions"]:
        qkey = str(sess.get("query", "")).lower().strip()
        for pid in (sess.get("product_ids") or [])[:10]:
            if len(judged) >= max_pairs:
                break
            title = str(titles["title"].get(pid, ""))
            brand = str(titles["brand"].get(pid, ""))
            if not title:
                continue
            v = judge(sess["query"], title, brand)
            row = {"trace_id": sess.get("trace_id"), "arm": sess.get("arm"), "query": sess["query"],
                   "product_id": pid, "judge_relevant": v["relevant"], "judge_score": v["score"]}
            g = gold_map.get((qkey, pid))
            if g is not None:
                row["gold_esci"] = g
                row["gold_relevant"] = g in RELEVANT
                with_gold.append(row)
            judged.append(row)

    n = len(with_gold)
    if not n:
        return {"judged_pairs": len(judged), "pairs_with_ground_truth": 0,
                "agreement": None,
                "note": "the judge ran on real sessions, but none of the returned products had an ESCI label for that "
                        "query, so the judge's agreement is UNMEASURED. No agreement number is reported.",
                "judge": JUDGE_SPEC, "sampling": s["sampling"], "strata": s["strata"],
                "sessions_sampled": s["sampled"], "population": s["population"]}

    jr = [r["judge_relevant"] for r in with_gold]
    gr = [r["gold_relevant"] for r in with_gold]
    agree = sum(x == y for x, y in zip(jr, gr))
    tp = sum(1 for x, y in zip(jr, gr) if x and y)
    fp = sum(1 for x, y in zip(jr, gr) if x and not y)
    fn = sum(1 for x, y in zip(jr, gr) if not x and y)
    tn = sum(1 for x, y in zip(jr, gr) if not x and not y)
    prec = round(tp / (tp + fp), 4) if tp + fp else None
    rec = round(tp / (tp + fn), 4) if tp + fn else None
    return {
        "technique": 29,
        "sessions_population": s["population"],
        "sessions_sampled": s["sampled"],
        "sampling": s["sampling"],
        "strata": s["strata"],
        "judged_pairs": len(judged),
        "pairs_with_ground_truth": n,
        "ground_truth": "held-out ESCI relevance labels (dev+test qrels); E/S = relevant, C/I = not",
        "agreement": round(agree / n, 4),
        "agreement_ci95_wilson": _wilson(agree, n),
        "cohens_kappa": _kappa(jr, gr),
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
        "precision": prec,
        "recall": rec,
        "base_rate_gold_relevant": round(sum(gr) / n, 4),
        "judge": JUDGE_SPEC,
        "sample_size_caveat": f"n = {n} labelled pairs. Every figure above is conditioned on that. A kappa from a few "
                              f"hundred pairs is an indication, not a certification; the playbook's own bar (29 US-1 AC2) "
                              f"is a kappa threshold agreed on a human gold set, which does not exist here.",
        "rows": with_gold[:25],
    }
