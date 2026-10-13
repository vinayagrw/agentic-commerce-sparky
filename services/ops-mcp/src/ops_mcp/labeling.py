"""Labeling agent (technique 1 LLM labeling, 19 calibrated judges): the model labels query-product pairs with ESCI
classes; held-out ESCI gold labels stay in SQLite and are never returned to the model."""
from __future__ import annotations

import time

import pandas as pd

from . import db
from .db import DATA

LABELS = ["E", "S", "C", "I"]
GUIDE = {"E": "Exact: satisfies all query specifications", "S": "Substitute: somewhat relevant, fails some aspects but usable instead",
         "C": "Complement: does not fulfil the query but could be used with an exact item", "I": "Irrelevant"}
LOW_CONFIDENCE = 0.7


def sample(n: int = 20) -> dict:
    n = max(4, min(int(n), 80))
    batch_no = len(db.rows("SELECT DISTINCT batch_id FROM label_items"))
    batch_id = db.new_id("lbl")
    qr = pd.read_parquet(DATA / "qrels_dev.parquet")
    q = pd.read_parquet(DATA / "queries.parquet")[["query_id", "query"]]
    p = pd.read_parquet(DATA / "products.parquet", columns=["product_id", "title", "brand", "bullets"])
    df = qr.merge(q, on="query_id").merge(p, on="product_id")
    used = {r["product_id"] + "|" + r["query"] for r in db.rows("SELECT product_id, query FROM label_items")}
    df = df[~(df["product_id"] + "|" + df["query"]).isin(used)]
    per = n // len(LABELS)
    parts = [g.sample(min(len(g), per + (1 if i < n % len(LABELS) else 0)), random_state=100 + batch_no)
             for i, (_, g) in enumerate(df.groupby("esci_label"))]
    pick = pd.concat(parts).sample(frac=1.0, random_state=batch_no)
    items = []
    now = time.time()
    with db.connect() as c:
        for k, r in enumerate(pick.itertuples()):
            iid = f"{batch_id}-{k:02d}"
            c.execute("INSERT INTO label_items(item_id,batch_id,query,product_id,title,gold,status,ts) VALUES(?,?,?,?,?,?,?,?)",
                      (iid, batch_id, r.query, r.product_id, r.title, r.esci_label, "awaiting_model_label", now))
            items.append({"item_id": iid, "query": r.query, "product_title": r.title[:160], "brand": r.brand,
                          "bullets": str(r.bullets or "")[:200]})
    return {"batch_id": batch_id, "n": len(items), "items": items, "label_set": GUIDE,
            "instructions": "For each item return {item_id, label in E|S|C|I, confidence 0..1}. Then call record_labels(batch_id, labels).",
            "gold_labels": "held out server-side (ESCI dev qrels); not visible to the model"}


def _kappa(a: list[str], b: list[str]) -> float | None:
    n = len(a)
    if not n:
        return None
    po = sum(x == y for x, y in zip(a, b)) / n
    pe = sum((a.count(c) / n) * (b.count(c) / n) for c in LABELS)
    return round((po - pe) / (1 - pe), 4) if pe < 1 else 1.0


def record(batch_id: str, labels: list[dict]) -> dict:
    items = {r["item_id"]: r for r in db.rows("SELECT * FROM label_items WHERE batch_id=?", (batch_id,))}
    if not items:
        return {"error": f"unknown batch {batch_id}"}
    model, gold, scored, review, invalid = [], [], [], [], []
    with db.connect() as c:
        for lab in labels:
            iid, label = lab.get("item_id"), str(lab.get("label", "")).strip().upper()[:1]
            conf = float(lab.get("confidence", 0.5))
            if iid not in items or label not in LABELS:
                invalid.append(iid)
                continue
            status = "human_review" if conf < LOW_CONFIDENCE else "auto_accepted"
            c.execute("UPDATE label_items SET model_label=?, confidence=?, status=? WHERE item_id=?", (label, conf, status, iid))
            model.append(label)
            gold.append(items[iid]["gold"])
            scored.append((iid, label, items[iid]["gold"], conf))
            if status == "human_review":
                review.append({"item_id": iid, "query": items[iid]["query"], "product_title": items[iid]["title"][:120],
                               "model_label": label, "confidence": conf})
    n = len(model)
    agree = sum(m == g for m, g in zip(model, gold))
    hi = [(m == g) for _, m, g, cf in scored if cf >= LOW_CONFIDENCE]
    lo = [(m == g) for _, m, g, cf in scored if cf < LOW_CONFIDENCE]
    confusion = {g: {m: 0 for m in LABELS} for g in LABELS}
    for m, g in zip(model, gold):
        confusion[g][m] += 1
    return {"batch_id": batch_id, "labeled": n, "invalid": invalid,
            "agreement": round(agree / n, 4) if n else None, "cohens_kappa": _kappa(model, gold),
            "calibration": {"high_conf_accuracy": round(sum(hi) / len(hi), 4) if hi else None, "high_conf_n": len(hi),
                            "low_conf_accuracy": round(sum(lo) / len(lo), 4) if lo else None, "low_conf_n": len(lo),
                            "threshold": LOW_CONFIDENCE},
            "confusion_gold_by_model": confusion,
            "human_review_queue": review,
            "gold_source": "ESCI dev qrels (held out; compared server-side)"}


def review_queue() -> list[dict]:
    return db.rows("SELECT item_id,batch_id,query,title,model_label,confidence,status FROM label_items "
                   "WHERE status='human_review' ORDER BY ts")


def submit_review(item_id: str, label: str, reviewer: str) -> dict | None:
    label = label.strip().upper()[:1]
    r = db.rows("SELECT * FROM label_items WHERE item_id=?", (item_id,))
    if not r or label not in LABELS:
        return None
    db.execute("UPDATE label_items SET human_label=?, reviewer=?, status='human_reviewed' WHERE item_id=?", (label, reviewer, item_id))
    db.audit(reviewer, "human", "label_review", item_id, detail={"label": label, "model_label": r[0]["model_label"]}, actor_type="human")
    return {"item_id": item_id, "human_label": label, "model_label": r[0]["model_label"], "status": "human_reviewed"}
