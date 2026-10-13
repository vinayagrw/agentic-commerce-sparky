"""MLOps top-10 capabilities (docs/MLOPS_TOP10_SELECTION.md), built on the Ops Copilot "ops_insight" surface.

Built here: 1 interleave_rankers, 2 ab_sequential_test, 3 skew_check, 4 lineage_query, 5 retrain_trigger,
6 exposure_audit, 7 prompt_registry_diff, 8 slo_budget_status, 9 golden_set_diff, 10 shadow_deploy_diff.
A new capability: add a function returning copilot._insight(...), register it in TOOLS at the bottom, then in ops-mcp server.py, policy-mcp (policy.OPS_TOOLS, forward.IMPLS, server.py) and bff ops/meta.ts +
ops/prompt.ts.

Live-only: every number is computed from the live search-svc, data/*.parquet, commerce.db, mlflow.db, registry.json
or ops.db at call time. Anything simulated (e.g. clicks derived from ESCI judgments) is labelled in the card. Each
run also writes its measured result to docs/evidence/mlops_<n>_<slug>.json, which scripts/coverage_extras.py reads.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
import sqlite3
import statistics
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import db, search_client
from .copilot import _insight
from .db import DATA, ROOT

EVIDENCE = ROOT / "docs" / "evidence"
SESSIONS = Path(DATA) / "online_sessions.jsonl"
COMMERCE = Path(DATA) / "commerce.db"
MLFLOW = Path(DATA) / "mlflow.db"
SLICES = Path(DATA) / "slice_report.json"


# ---------------------------------------------------------------------------------------------- shared helpers
def _evidence(n: int, slug: str, payload: dict) -> str:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    p = EVIDENCE / f"mlops_{n}_{slug}.json"
    p.write_text(json.dumps({"capability": n, "slug": slug, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **payload}, indent=1, default=str))
    return str(p.relative_to(ROOT)) if p.is_relative_to(ROOT) else str(p)


def ndcg10(grades: dict, ranked: list) -> float | None:
    """Same formula as services/search-svc/engine.py ndcg10 (exponential gain)."""
    dcg = sum((2 ** grades.get(i, 0) - 1) / math.log2(r + 1) for r, i in enumerate(ranked[:10], 1))
    ideal = sorted(grades.values(), reverse=True)[:10]
    idcg = sum((2 ** g - 1) / math.log2(r + 1) for r, g in enumerate(ideal, 1))
    return dcg / idcg if idcg else None


def _judgments():
    import pandas as pd

    q = pd.read_parquet(Path(DATA) / "queries.parquet")
    qr = pd.concat([pd.read_parquet(Path(DATA) / f"qrels_{s}.parquet") for s in ("dev", "test")])
    grades = {qid: dict(zip(g.product_id, g.gain)) for qid, g in qr.groupby("query_id")}
    return q, grades


def _search_many(queries: list[str], mode: str, k: int = 10) -> dict[str, list[str]]:
    def one(qt):
        r = search_client.call("POST", "/search", {"query": qt, "k": k, "mode": mode}, timeout=120)
        return qt, [x["product_id"] for x in r.get("results", [])]
    with ThreadPoolExecutor(6) as ex:
        return dict(ex.map(one, list(dict.fromkeys(queries))))


def _norm_p(z: float) -> float:
    return math.erfc(abs(z) / math.sqrt(2))


def sign_test_p(wins: int, losses: int) -> float:
    """Exact two-sided binomial sign test (ties dropped)."""
    n = wins + losses
    if n == 0:
        return 1.0
    k = min(wins, losses)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def welch_p(a: list[float], b: list[float]) -> float:
    if len(a) < 2 or len(b) < 2:
        return 1.0
    se = math.sqrt(statistics.variance(a) / len(a) + statistics.variance(b) / len(b))
    return 1.0 if se == 0 else _norm_p((statistics.mean(a) - statistics.mean(b)) / se)


def _boot_ci(xs: list[float], seed: int, reps: int = 1000) -> list[float]:
    if not xs:
        return [None, None]
    rng = random.Random(seed)
    ms = sorted(statistics.mean(rng.choices(xs, k=len(xs))) for _ in range(reps))
    return [round(ms[int(0.025 * reps)], 4), round(ms[int(0.975 * reps) - 1], 4)]


def _unavailable(kind: str, title: str, e: Exception, agent: str, tier: str) -> dict:
    return _insight(kind, title, f"search-svc unavailable: {e}. Nothing was computed or substituted.", agent=agent, tier=tier, source="search-svc", n=0)


# ======================================================================= 1. team-draft interleaving pre-screen
def team_draft(a: list[str], b: list[str], rng: random.Random, k: int = 10) -> list[tuple[str, str]]:
    """Team-draft interleaving (Radlinski et al. 2008). Returns [(doc, team)] with team in {"A","B"}."""
    out, seen, na, nb = [], set(), 0, 0
    ia = ib = 0
    while len(out) < k and (ia < len(a) or ib < len(b)):
        pick_a = na < nb or (na == nb and rng.random() < 0.5)
        src, idx = (a, ia) if pick_a else (b, ib)
        while idx < len(src) and src[idx] in seen:
            idx += 1
        if idx >= len(src):  # this team is exhausted: let the other one pick
            pick_a = not pick_a
            src, idx = (a, ia) if pick_a else (b, ib)
            while idx < len(src) and src[idx] in seen:
                idx += 1
            if idx >= len(src):
                break
        out.append((src[idx], "A" if pick_a else "B"))
        seen.add(src[idx])
        if pick_a:
            na, ia = na + 1, idx + 1
        else:
            nb, ib = nb + 1, idx + 1
    return out


def interleave_rankers(ranker_a: str = "rrf_rerank", ranker_b: str = "rrf", n_queries: int = 200, split: str = "test",
                       click_min_gain: int = 3, seed: int = 20260917) -> dict:
    title = f"Interleaving pre-screen: {ranker_a} vs {ranker_b}"
    q, grades = _judgments()
    qs = q[q.split == split].sort_values("query_id")
    qs = [(int(r.query_id), r.query) for r in qs.itertuples() if int(r.query_id) in grades and max(grades[int(r.query_id)].values()) > 0][:n_queries]
    texts = [t for _, t in qs]
    try:
        ra, rb = _search_many(texts, ranker_a), _search_many(texts, ranker_b)
    except search_client.SearchUnavailable as e:
        return _unavailable("interleave_rankers", title, e, "eval-agent", "T1")
    outcomes, nd_a, nd_b = [], [], []
    for qid, t in qs:
        g = grades[qid]
        mixed = team_draft(ra[t], rb[t], random.Random(seed + qid))
        ca = sum(1 for d, team in mixed if team == "A" and g.get(d, 0) >= click_min_gain)
        cb = sum(1 for d, team in mixed if team == "B" and g.get(d, 0) >= click_min_gain)
        outcomes.append(1 if ca > cb else -1 if cb > ca else 0)
        nd_a.append(ndcg10(g, ra[t]) or 0.0)
        nd_b.append(ndcg10(g, rb[t]) or 0.0)
    n = len(outcomes)
    wins, losses = outcomes.count(1), outcomes.count(-1)
    ties = n - wins - losses
    p_il = sign_test_p(wins, losses)
    ci = _boot_ci(outcomes, seed)
    # Sensitivity: the same queries as a split A/B (alternate queries per arm, unpaired) vs interleaving, at growing n.
    sens = []
    for m in [x for x in (25, 50, 100, 200, 400) if x <= n] or [n]:
        o = outcomes[:m]
        sens.append([m, round(sign_test_p(o.count(1), o.count(-1)), 4), round(welch_p(nd_a[:m:2], nd_b[1:m:2]), 4)])
    pref = (wins - losses) / n if n else 0.0
    verdict = "advance to A/B" if p_il < 0.05 and wins > losses else "B preferred: do not advance A" if p_il < 0.05 else "no detectable preference"
    res = {"n_queries": n, "wins_a": wins, "wins_b": losses, "ties": ties, "preference_a": round(pref, 4), "preference_ci95": ci,
           "sign_test_p": round(p_il, 6), "ndcg10_a": round(statistics.mean(nd_a), 4) if n else None, "ndcg10_b": round(statistics.mean(nd_b), 4) if n else None,
           "sensitivity": [{"n": s[0], "interleave_p": s[1], "split_ab_p": s[2]} for s in sens], "rankers": [ranker_a, ranker_b],
           "click_model": f"simulated: a click on every interleaved result with ESCI gain >= {click_min_gain}; no real users"}
    ev = _evidence(1, "interleaving", res)
    db.audit("eval-agent", "T1", "interleave_rankers", f"{ranker_a} vs {ranker_b}", detail={k: res[k] for k in ("n_queries", "wins_a", "wins_b", "ties", "sign_test_p")})
    return _insight("interleave_rankers", title,
                    f"{ranker_a} won {wins}, {ranker_b} won {losses}, {ties} ties over n={n} ESCI {split} queries; sign test p={p_il:.2g}. Proposal: {verdict} (a human decides).",
                    agent="eval-agent", tier="T1", source="search-svc /search (live, both rankers) + ESCI qrels",
                    facts=[{"label": "preference A", "value": f"{pref:+.3f} CI95 {ci}", "cite": "bootstrap 1000"},
                           {"label": "sign test p", "value": round(p_il, 6), "cite": "exact binomial, ties dropped"},
                           {"label": f"NDCG@10 {ranker_a}", "value": res["ndcg10_a"], "cite": "same result lists"},
                           {"label": f"NDCG@10 {ranker_b}", "value": res["ndcg10_b"], "cite": "same result lists"},
                           {"label": "clicks", "value": "SIMULATED from ESCI labels", "cite": res["click_model"]}],
                    chart={"type": "bar", "unit": "queries won", "series": [{"label": ranker_a, "value": wins}, {"label": ranker_b, "value": losses}, {"label": "ties", "value": ties}]},
                    table={"columns": ["n queries", "interleave p (sign test)", "split A/B p (Welch, NDCG@10)"], "rows": sens},
                    findings=[{"severity": "info", "finding": "Clicks are simulated from ESCI relevance labels, not real shoppers; the win rate measures label-preference, not engagement.", "cite": "qrels_" + split},
                              {"severity": "info", "finding": f"Recommendation only (T1): {verdict}. Advancing to an A/B test is a human decision.", "cite": ev}],
                    citations=[{"source": "search-svc", "ref": f"/search mode={ranker_a},{ranker_b}"}, {"source": f"data/qrels_{split}.parquet", "ref": "ESCI gains"}, {"source": ev, "ref": "evidence"}],
                    result=res, n=n)


# ======================================================================= 2. CUPED + mSPRT sequential A/B
def cuped(y: list[float], x: list[float]) -> tuple[list[float], float]:
    mx = statistics.mean(x)
    vx = statistics.pvariance(x)
    theta = 0.0 if vx == 0 else sum((a - mx) * (b - statistics.mean(y)) for a, b in zip(x, y)) / len(x) / vx
    return [b - theta * (a - mx) for a, b in zip(x, y)], theta


def msprt_path(yc: list[float], yt: list[float], order: list[int], tau2: float, sigma2: float, alpha: float = 0.05, burn_in: int = 10):
    """Normal-mixture mSPRT (Johari et al. 2017) for a difference in means. order = arm per unit (0 control, 1 treatment),
    yc/yt are consumed in arrival order. Returns (always-valid p per step, first stopping index or None)."""
    ci = ti = 0
    sc = st = 0.0
    p, path, stop = 1.0, [], None
    for i, arm in enumerate(order):
        if arm == 0:
            sc += yc[ci]
            ci += 1
        else:
            st += yt[ti]
            ti += 1
        if ci >= burn_in and ti >= burn_in and sigma2 > 0:
            d = st / ti - sc / ci
            v = sigma2 * (1 / ti + 1 / ci)
            lam = math.sqrt(v / (v + tau2)) * math.exp(min(700.0, tau2 * d * d / (2 * v * (v + tau2))))
            p = min(p, 1 / lam)
            if stop is None and p < alpha:
                stop = i + 1
        path.append(p)
    return path, stop


def ab_sequential_test(control: str = "rrf_rerank", treatment: str = "rrf", alpha: float = 0.05, tau: float = 0.05, seed: int = 20260917) -> dict:
    title = f"Sequential A/B (CUPED + mSPRT): {control} vs {treatment}"
    q, grades = _judgments()
    qid = dict(zip(q["query"], q["query_id"]))
    sess = [json.loads(l) for l in SESSIONS.read_text().splitlines() if l.strip()] if SESSIONS.exists() else []
    sess = [s for s in sorted(sess, key=lambda s: s.get("ingested_at", 0)) if s.get("query") in qid and max(grades.get(int(qid[s["query"]]), {0: 0}).values()) > 0]
    if len(sess) < 40:
        return _insight("ab_sequential_test", title, f"Only {len(sess)} judged sessions in data/online_sessions.jsonl; need >= 40. Nothing computed.",
                        agent="eval-agent", tier="T1", source="data/online_sessions.jsonl", n=len(sess))
    queries = [s["query"] for s in sess]
    try:
        res_c, res_t = _search_many(queries, control), _search_many(queries, treatment)
    except search_client.SearchUnavailable as e:
        return _unavailable("ab_sequential_test", title, e, "eval-agent", "T1")
    arm = [int(hashlib.sha256((s["trace_id"] + str(seed)).encode()).hexdigest(), 16) % 2 for s in sess]
    g = [grades[int(qid[s["query"]])] for s in sess]
    x = [ndcg10(gi, s["product_ids"]) or 0.0 for gi, s in zip(g, sess)]  # pre-period: what was actually served and logged
    y = [ndcg10(gi, (res_t if a else res_c)[s["query"]]) or 0.0 for gi, s, a in zip(g, sess, arm)]
    yadj, theta = cuped(y, x)

    def split(v):
        return [a for a, m in zip(v, arm) if m == 0], [a for a, m in zip(v, arm) if m == 1]

    def diff(v):
        c, t = split(v)
        d = statistics.mean(t) - statistics.mean(c)
        se = math.sqrt(statistics.variance(c) / len(c) + statistics.variance(t) / len(t))
        return round(d, 5), [round(d - 1.96 * se, 5), round(d + 1.96 * se, 5)], se, _norm_p(d / se) if se else 1.0

    d_raw, ci_raw, se_raw, p_raw = diff(y)
    d_cup, ci_cup, se_cup, p_cup = diff(yadj)
    var_red = 1 - statistics.variance(yadj) / statistics.variance(y) if statistics.variance(y) else 0.0
    tau2 = tau * tau
    path_raw, stop_raw = msprt_path(*split(y), arm, tau2, statistics.variance(y), alpha)
    path_cup, stop_cup = msprt_path(*split(yadj), arm, tau2, statistics.variance(yadj), alpha)
    n = len(sess)
    nc, nt = arm.count(0), arm.count(1)
    res = {"n_sessions": n, "n_control": nc, "n_treatment": nt, "unique_queries": len(set(queries)), "theta": round(theta, 4),
           "variance_reduction": round(var_red, 4), "delta_raw": d_raw, "ci95_raw": ci_raw, "p_fixed_raw": round(p_raw, 6),
           "delta_cuped": d_cup, "ci95_cuped": ci_cup, "p_fixed_cuped": round(p_cup, 6),
           "msprt": {"tau": tau, "alpha": alpha, "stop_at_raw": stop_raw, "stop_at_cuped": stop_cup,
                     "final_always_valid_p_raw": round(path_raw[-1], 6), "final_always_valid_p_cuped": round(path_cup[-1], 6)},
           "assignment": "re-randomised: sha256(trace_id+seed) % 2 over logged sessions (the router's own arms are NOT randomised)",
           "outcome": "NDCG@10 of the arm's live ranking against ESCI judgments (offline proxy, not conversion)",
           "covariate": "pre-period NDCG@10 of the product_ids the router actually served and logged"}
    ev = _evidence(2, "cuped_msprt", res)
    db.audit("eval-agent", "T1", "ab_sequential_test", f"{control} vs {treatment}", detail={k: res[k] for k in ("n_sessions", "variance_reduction", "delta_cuped", "msprt")})
    stops = lambda s: f"stopped at session {s}" if s else "did not cross the boundary"
    step = max(1, n // 16)
    return _insight("ab_sequential_test", title,
                    f"CUPED cut variance {var_red:.0%} (θ={theta:.3f}); Δ NDCG@10 {d_cup:+.4f} CI95 {ci_cup}. mSPRT raw {stops(stop_raw)}, CUPED {stops(stop_cup)} (n={n}). The ship call is a human decision.",
                    agent="eval-agent", tier="T1", source="data/online_sessions.jsonl + search-svc /search (live) + ESCI qrels",
                    facts=[{"label": "n control / treatment", "value": f"{nc} / {nt}", "cite": "hash re-randomisation"},
                           {"label": "variance reduction", "value": f"{var_red:.1%}", "cite": "CUPED, pooled θ"},
                           {"label": "Δ raw", "value": f"{d_raw:+.4f} CI95 {ci_raw}", "cite": "Welch normal"},
                           {"label": "Δ CUPED", "value": f"{d_cup:+.4f} CI95 {ci_cup}", "cite": "Welch normal"},
                           {"label": "mSPRT stop (raw / CUPED)", "value": f"{stop_raw} / {stop_cup}", "cite": f"τ={tau}, α={alpha}"},
                           {"label": "unique queries", "value": len(set(queries)), "cite": "sessions repeat queries"}],
                    chart={"type": "line", "unit": "always-valid p (CUPED)", "series": [{"label": str(i + 1), "value": round(path_cup[i], 4)} for i in range(step - 1, n, step)][-16:]},
                    table={"columns": ["analysis", "Δ NDCG@10", "CI95", "fixed-horizon p", "mSPRT stop at"],
                           "rows": [["raw", d_raw, json.dumps(ci_raw), round(p_raw, 6), stop_raw or "-"], ["CUPED", d_cup, json.dumps(ci_cup), round(p_cup, 6), stop_cup or "-"]]},
                    findings=[{"severity": "medium", "finding": "Arms are re-randomised over logged sessions and the outcome is offline ESCI NDCG@10, not conversion; only " + str(len(set(queries))) + " unique queries, so sessions are not independent.", "cite": "data/online_sessions.jsonl"},
                              {"severity": "info", "finding": "Recommendation only (T1): a human calls ship / no-ship.", "cite": ev}],
                    citations=[{"source": "data/online_sessions.jsonl", "ref": f"{n} judged sessions"}, {"source": "search-svc", "ref": f"/search mode={control},{treatment}"}, {"source": ev, "ref": "evidence"}],
                    result=res, n=n)


# ======================================================================= 3. training-serving skew
def psi(train: list[float], serve: list[float], bins: int = 10) -> float:
    """Population stability index with quantile bins from the training distribution."""
    if not train or not serve:
        return float("nan")
    s = sorted(train)
    edges = sorted(set(s[min(len(s) - 1, int(len(s) * i / bins))] for i in range(1, bins)))

    def hist(v):
        c = [0] * (len(edges) + 1)
        for a in v:
            c[sum(1 for e in edges if a >= e)] += 1
        return [(x + 0.5) / (len(v) + 0.5 * len(c)) for x in c]
    ht, hs = hist(train), hist(serve)
    return sum((b - a) * math.log(b / a) for a, b in zip(ht, hs))


def ks_stat(a: list[float], b: list[float]) -> float:
    a, b = sorted(a), sorted(b)
    i = j = 0
    d = 0.0
    while i < len(a) and j < len(b):
        x = min(a[i], b[j])
        while i < len(a) and a[i] <= x:
            i += 1
        while j < len(b) and b[j] <= x:
            j += 1
        d = max(d, abs(i / len(a) - j / len(b)))
    return d


def skew_check(version: str = "candidate", psi_threshold: float = 0.2) -> dict:
    import pandas as pd

    title = "Training-serving skew check"
    if not COMMERCE.exists():
        return _insight("skew_check", title, f"{COMMERCE} missing: no serving path to compare.", agent="data-quality-agent", tier="T2", source="commerce.db", n=0)
    train = pd.read_parquet(Path(DATA) / "products.parquet", columns=["product_id", "price", "stock_4108", "stock_2231", "stock_5360"]).set_index("product_id")
    con = sqlite3.connect(f"file:{COMMERCE}?mode=ro", uri=True)
    price = pd.read_sql("SELECT product_id, COALESCE(override_price, price) AS price, promo FROM cs_price", con).set_index("product_id")
    inv = pd.read_sql("SELECT product_id, store_id, COALESCE(override_qty, qty) AS qty FROM cs_inventory", con)
    con.close()
    feats, rows = {}, []
    j = train.join(price, how="inner", rsuffix="_serve")
    feats["price"] = (j["price"].astype(float).tolist(), j["price_serve"].astype(float).tolist(), len(j))
    for store in ("4108", "2231", "5360"):
        s = inv[inv.store_id == store].set_index("product_id")
        js = train.join(s, how="inner")
        feats[f"stock_{store}"] = (js[f"stock_{store}"].astype(float).tolist(), js["qty"].astype(float).tolist(), len(js))
    flagged = []
    for name, (tr, sv, n) in feats.items():
        p, k = psi(tr, sv), ks_stat(tr, sv)
        changed = sum(1 for a, b in zip(tr, sv) if abs(a - b) > 1e-9) / n if n else 0.0
        rows.append([name, n, round(statistics.mean(tr), 3) if tr else None, round(statistics.mean(sv), 3) if sv else None, round(p, 4), round(k, 4), f"{changed:.1%}"])
        if p > psi_threshold:
            flagged.append(name)
    promo_share = float((price["promo"].fillna("null") != "null").mean()) if len(price) else 0.0
    rows.append(["promo (serving-only)", len(price), "absent in training", f"{promo_share:.1%} rows", "n/a", "n/a", "not a training feature"])
    reg = _registry_safe()
    vid = reg.get(version, version) if isinstance(reg, dict) and version in ("champion", "candidate") else version
    appr = None
    if flagged:
        appr = db.request_approval("skew_review", vid, "data-quality-agent", f"Training-serving skew on {', '.join(flagged)} (PSI > {psi_threshold}); promotion of {vid} blocked pending review")
        db.audit("data-quality-agent", "T2", "skew_check", vid, appr["approval_id"], outcome="blocked_skew", detail={"flagged": flagged})
    else:
        db.audit("data-quality-agent", "T2", "skew_check", vid, outcome="no_skew")
    res = {"version": vid, "psi_threshold": psi_threshold, "features": [dict(zip(["feature", "n", "train_mean", "serve_mean", "psi", "ks", "rows_changed"], r)) for r in rows],
           "flagged": flagged, "approval_id": appr and appr["approval_id"], "promo_share_serving": round(promo_share, 4),
           "training": "data/products.parquet (what the index and eval were built on)", "serving": "data/commerce.db cs_price/cs_inventory (what shop-mcp serves, overrides applied)"}
    ev = _evidence(3, "skew", res)
    worst = max(rows[:-1], key=lambda r: r[4]) if rows[:-1] else None
    summary = (f"Skew on {', '.join(flagged)} (PSI > {psi_threshold}); promotion of {vid} is BLOCKED until a human reviews approval {appr['approval_id']}." if flagged
               else f"No feature above PSI {psi_threshold} (worst {worst[0]} PSI {worst[4]}); promotion not blocked.")
    return _insight("skew_check", title, summary, agent="data-quality-agent", tier="T2", source="products.parquet vs commerce.db serving tables",
                    facts=[{"label": "features compared", "value": len(feats), "cite": "price + 3 store stocks"},
                           {"label": "flagged", "value": ", ".join(flagged) or "none", "cite": f"PSI > {psi_threshold}"},
                           {"label": "serving-only promo share", "value": f"{promo_share:.1%}", "cite": "cs_price.promo"},
                           {"label": "review approval", "value": appr["approval_id"] if appr else "not needed", "cite": "ops.db approvals"}],
                    chart={"type": "bar", "unit": "PSI", "series": [{"label": r[0], "value": r[4]} for r in rows[:-1]]},
                    table={"columns": ["feature", "n", "train mean", "serve mean", "PSI", "KS", "rows changed"], "rows": rows},
                    findings=[{"severity": "high" if flagged else "info", "finding": summary, "cite": f"approval {appr['approval_id']}" if appr else "ops.db audit"},
                              {"severity": "info", "finding": "Catalogue prices and stock are synthetic commerce data (ESCI has none); the skew is real between the two stores of that data.", "cite": "data/SOURCE.txt"}],
                    citations=[{"source": "data/products.parquet", "ref": "training features"}, {"source": "data/commerce.db", "ref": "cs_price, cs_inventory"}, {"source": ev, "ref": "evidence"}],
                    result=res, approval_id=appr and appr["approval_id"], n=sum(v[2] for v in feats.values()))


def _registry_safe() -> dict:
    try:
        return search_client.call("GET", "/models", timeout=30)
    except Exception:
        reg = Path(DATA) / "registry.json"
        return json.loads(reg.read_text()) if reg.exists() else {}


def skew_blocks(version: str) -> dict | None:
    """Used by tools.promote: an unresolved skew review on this version blocks promotion."""
    a = db.approval_for("skew_review", version)
    return a if a and a["status"] in ("pending", "rejected") else None


# ======================================================================= 4. lineage graph
DATA_DEPS = {  # declared by services/search-svc/engine.py: which artefacts each index build reads/writes
    "products.parquet": ["bm25", "embeddings.npy"], "embeddings.npy": ["faiss.index"],
}


def build_lineage() -> tuple[dict, list[dict]]:
    nodes, edges = {}, []

    def node(i, kind, **kw):
        nodes.setdefault(i, {"id": i, "kind": kind, **kw})

    def edge(a, b, rel, cite):
        edges.append({"from": a, "to": b, "relation": rel, "cite": cite})
    for src, dsts in DATA_DEPS.items():
        if (Path(DATA) / src).exists():
            node(f"data:{src}", "dataset")
            for d in dsts:
                if (Path(DATA) / d).exists():
                    node(f"data:{d}", "dataset")
                    edge(f"data:{src}", f"data:{d}", "indexed_into", "services/search-svc/engine.py")
    reg = json.loads((Path(DATA) / "registry.json").read_text()) if (Path(DATA) / "registry.json").exists() else {"versions": {}}
    versions = reg["versions"].values() if isinstance(reg.get("versions"), dict) else reg.get("versions", [])
    runs = {}
    if MLFLOW.exists():
        con = sqlite3.connect(f"file:{MLFLOW}?mode=ro", uri=True)
        runs = {r[0]: {"name": r[1], "status": r[2]} for r in con.execute("SELECT run_uuid, name, status FROM runs")}
        for name, ver, run_id, source in con.execute("SELECT name, version, run_id, source FROM model_versions"):
            node(f"mlflow:{name}/{ver}", "model_version", source=source)
            node(f"run:{run_id}", "mlflow_run", **runs.get(run_id, {}))
            edge(f"run:{run_id}", f"mlflow:{name}/{ver}", "registered_as", "mlflow.db model_versions")
        con.close()
    for v in versions:
        vid = f"model:{v['version']}"
        node(vid, "registry_version", status=v.get("status"), config_hash=v.get("config_hash"), actor=v.get("actor"))
        if v.get("parent"):
            edge(f"model:{v['parent']}", vid, "parent_of", "data/registry.json parent")
        cfg = v.get("config") or {}
        if cfg.get("embedding_model") and (Path(DATA) / "faiss.index").exists():
            edge("data:faiss.index", vid, f"retrieves_with ({cfg['embedding_model']})", "registry config.embedding_model")
        if (Path(DATA) / "bm25").exists():
            edge("data:bm25", vid, "retrieves_with (bm25)", "registry config w_bm25")
        run = (v.get("mlflow") or {}).get("run_id")
        if run:
            node(f"run:{run}", "mlflow_run", **runs.get(run, {"missing_in_mlflow_db": True}))
            edge(vid, f"run:{run}", "logged_as", "data/registry.json mlflow.run_id")
    for g in db.rows("SELECT id, version, passed FROM gates"):
        node(f"gate#{g['id']}", "eval_gate", passed=bool(g["passed"]))
        edge(f"model:{g['version']}", f"gate#{g['id']}", "evaluated_by", "ops.db gates")
        for qf in ("queries.parquet", "qrels_test.parquet"):
            if (Path(DATA) / qf).exists():
                node(f"data:{qf}", "dataset")
                edge(f"data:{qf}", f"gate#{g['id']}", "eval_set_of", "tools.run_eval_suite -> /eval/compare split=test")
    for r in db.rows("SELECT remediation_id, alert_id, candidate_version FROM remediations"):
        node(f"rem:{r['remediation_id']}", "remediation")
        if r["alert_id"]:
            node(f"alert:{r['alert_id']}", "drift_alert")
            edge(f"alert:{r['alert_id']}", f"rem:{r['remediation_id']}", "remediated_by", "ops.db remediations")
        if r["candidate_version"]:
            edge(f"rem:{r['remediation_id']}", f"model:{r['candidate_version']}", "built", "ops.db remediations")
    if COMMERCE.exists():
        for t in ("cs_price", "cs_inventory"):
            node(f"table:commerce.db/{t}", "serving_table")
            edge(f"table:commerce.db/{t}", "serving:shop-mcp", "served_by", "services/shop-mcp")
        node("serving:shop-mcp", "serving_path")
        champ = reg.get("champion")
        if champ:
            edge(f"model:{champ}", "serving:shop-mcp", "ranks_for (champion)", "data/registry.json champion")
    for e in edges:
        for k in ("from", "to"):
            nodes.setdefault(e[k], {"id": e[k], "kind": e[k].split(":")[0].split("#")[0]})
    return nodes, edges


def lineage_query(node: str = "champion", depth: int = 3) -> dict:
    nodes, edges = build_lineage()
    reg = json.loads((Path(DATA) / "registry.json").read_text()) if (Path(DATA) / "registry.json").exists() else {}
    nid = node
    if node in ("champion", "candidate"):
        nid = f"model:{reg.get(node)}"
    elif node not in nodes and f"model:{node}" in nodes:
        nid = f"model:{node}"
    elif node not in nodes and f"data:{node}" in nodes:
        nid = f"data:{node}"
    if nid not in nodes:
        return _insight("lineage_query", "Lineage graph", f"Unknown node {node!r}. Try champion, candidate, a version (v4), a dataset (products.parquet) or gate#<id>.",
                        agent="release-agent", tier="T0", source="registry.json + mlflow.db + ops.db", facts=[{"label": "graph nodes", "value": len(nodes)}], n=0)

    def walk(start, forward):
        seen, out, dq_ = {start}, [], deque([(start, 0)])
        while dq_:
            cur, d = dq_.popleft()
            if d >= depth:
                continue
            for e in edges:
                a, b = (e["from"], e["to"]) if forward else (e["to"], e["from"])
                if a == cur:
                    out.append(e)
                    if b not in seen:
                        seen.add(b)
                        dq_.append((b, d + 1))
        return out, seen - {start}
    up, up_nodes = walk(nid, False)
    down, down_nodes = walk(nid, True)
    reg_runs = [n for n in nodes.values() if n["kind"] == "mlflow_run"]
    missing = [n["id"] for n in reg_runs if n.get("missing_in_mlflow_db")]
    rows = [["upstream", e["from"], e["relation"], e["to"], e["cite"]] for e in up] + [["downstream", e["from"], e["relation"], e["to"], e["cite"]] for e in down]
    res = {"node": nid, "depth": depth, "graph_nodes": len(nodes), "graph_edges": len(edges), "upstream_nodes": sorted(up_nodes), "downstream_nodes": sorted(down_nodes),
           "mlflow_runs": len(reg_runs), "runs_missing_in_mlflow_db": missing}
    ev = _evidence(4, "lineage", res)
    return _insight("lineage_query", f"Lineage: {nid}", f"{len(up_nodes)} upstream and {len(down_nodes)} downstream nodes within depth {depth} (graph: {len(nodes)} nodes, {len(edges)} edges).",
                    agent="release-agent", tier="T0", source="data/registry.json + data/mlflow.db + ops.db + commerce.db",
                    facts=[{"label": "graph nodes / edges", "value": f"{len(nodes)} / {len(edges)}", "cite": "built at call time"},
                           {"label": "upstream", "value": ", ".join(sorted(up_nodes)[:6]) or "none"},
                           {"label": "downstream", "value": ", ".join(sorted(down_nodes)[:6]) or "none"},
                           {"label": "mlflow runs linked", "value": len(reg_runs), "cite": "mlflow.db runs"},
                           {"label": "runs missing in mlflow.db", "value": len(missing)}],
                    table={"columns": ["direction", "from", "relation", "to", "cite"], "rows": rows},
                    findings=[{"severity": "info", "finding": "Dataset→index edges are declared from the engine code; MLflow has no logged dataset inputs (datasets table is empty), so they are not OpenLineage-emitted events yet.", "cite": "mlflow.db datasets"}]
                    + ([{"severity": "medium", "finding": f"{len(missing)} registry run id(s) not found in mlflow.db", "cite": ", ".join(missing[:3])}] if missing else []),
                    citations=[{"source": "data/registry.json", "ref": "versions/parent/mlflow.run_id"}, {"source": "data/mlflow.db", "ref": "runs, model_versions"}, {"source": "ops.db", "ref": "gates, remediations"}, {"source": ev, "ref": "evidence"}],
                    graph={"nodes": [nodes[i] for i in sorted({nid} | up_nodes | down_nodes)], "edges": up + down}, result=res, n=len(up) + len(down))


# ======================================================================= 5. retraining trigger + DAG
FAST_LABEL_MAX_AGE_H = 168.0
DELTA_TRIGGER = -0.02  # same rule as tools.propose_remediation


def detect_label_profile(now: float | None = None) -> tuple[str, float | None]:
    """fast = implicit online signals (online_sessions.jsonl) fresher than FAST_LABEL_MAX_AGE_H; else delayed (human ESCI judgments)."""
    last = None
    if SESSIONS.exists():
        for l in SESSIONS.read_text().splitlines():
            if l.strip():
                last = max(last or 0, json.loads(l).get("ingested_at") or 0)
    age = ((now or time.time()) - last) / 3600 if last else None
    return ("fast" if age is not None and age <= FAST_LABEL_MAX_AGE_H else "delayed"), age


def retrain_trigger(label_profile: str = "auto", window: int = 150) -> dict:
    t_all = time.time()
    steps = []

    def step(name, fn):
        t0 = time.time()
        try:
            status, detail = fn()
        except Exception as e:  # a failed step stops the DAG and is reported, not hidden
            status, detail = "failed", str(e)[:200]
        steps.append({"step": name, "status": status, "seconds": round(time.time() - t0, 2), "detail": detail})
        return status
    ctx: dict = {}

    def detect():
        d = search_client.call("POST", "/drift", {"stream": "seasonal", "window": window, "n_windows": 6}, timeout=120)
        ctx["drift"] = d["current"]
        c = d["current"]
        return "ok", f"MMD² {c.get('mmd2')} p={c.get('p_value')} alert={c.get('alert')} est ΔNDCG@10 {c.get('est_ndcg10_delta')}"

    def profile():
        p, age = detect_label_profile()
        ctx["profile"] = p if label_profile == "auto" else label_profile
        ctx["age_h"] = age
        return "ok", f"{ctx['profile']} (online_sessions last ingested {age:.1f} h ago)" if age is not None else f"{ctx['profile']} (no online sessions)"

    def slices():
        if not SLICES.exists():
            return "skipped", "no slice_report.json"
        sr = json.loads(SLICES.read_text())
        worst = min(((c, m.get("rrf_rerank", {}).get("mean")) for c, m in sr["per_slice"].items() if m.get("rrf_rerank", {}).get("mean") is not None), key=lambda x: x[1], default=None)
        ctx["worst_slice"] = worst
        return "ok", f"worst slice {worst[0]} NDCG@10 {worst[1]}" if worst else "no slices"

    def decide():
        c = ctx["drift"]
        fire = bool(c.get("alert") and (c.get("est_ndcg10_delta") or 0) <= DELTA_TRIGGER)
        ctx["fire"] = fire
        return "ok", f"{'FIRE' if fire else 'no retrain'}: alert={c.get('alert')} and est ΔNDCG@10 {c.get('est_ndcg10_delta')} <= {DELTA_TRIGGER}"

    def record_alert():
        aid = db.new_id("alr")
        db.execute("INSERT INTO alerts(alert_id,ts,kind,detail) VALUES(?,?,?,?)", (aid, time.time(), "embedding_drift", json.dumps({"current": ctx["drift"], "source": "retrain_trigger"})))
        ctx["alert_id"] = aid
        return "ok", f"alert {aid} recorded"

    def gate_build():
        if ctx["profile"] == "delayed":
            a = db.request_approval("retrain_signoff", ctx["alert_id"], "retrain-agent", f"Delayed-label profile: sign off retraining for {ctx['alert_id']} before candidate build")
            ctx["approval"] = a
            return "waiting_human", f"delayed-label profile needs human sign-off {a['approval_id']} before propose_remediation/build_candidate"
        ctx["approval"] = None
        return "handoff", f"fast-label profile: auto-fired; next propose_remediation('{ctx['alert_id']}') then build_candidate (T2 remediation approval)"

    ok = step("detect_drift", detect) == "ok"
    ok = ok and step("label_profile", profile) == "ok"
    ok = ok and step("slice_check", slices) in ("ok", "skipped")
    ok = ok and step("trigger_decision", decide) == "ok"
    if ok and ctx.get("fire"):
        step("record_alert", record_alert)
        step("build_candidate_gate", gate_build)
    else:
        for s in ("record_alert", "build_candidate_gate"):
            steps.append({"step": s, "status": "skipped", "seconds": 0.0, "detail": "trigger did not fire" if ok else "upstream step failed"})
    steps.append({"step": "eval_gate", "status": "pending", "seconds": 0.0, "detail": "run_eval_suite on the built candidate (T3 gate)"})
    steps.append({"step": "promote", "status": "requires_human", "seconds": 0.0, "detail": "promotion is ALWAYS a human T2 approval; this DAG never promotes"})
    secs = round(time.time() - t_all, 2)
    appr = ctx.get("approval")
    res = {"fired": bool(ctx.get("fire")), "profile": ctx.get("profile"), "label_age_h": ctx.get("age_h") and round(ctx["age_h"], 2), "drift": ctx.get("drift"),
           "alert_id": ctx.get("alert_id"), "approval_id": appr and appr["approval_id"], "steps": steps, "seconds": secs}
    ev = _evidence(5, "retrain_dag", res)
    db.audit("retrain-agent", "T2", "retrain_trigger", ctx.get("alert_id") or "no_alert", appr and appr["approval_id"],
             outcome="fired" if res["fired"] else "not_fired", detail={"profile": res["profile"], "steps": [(s["step"], s["status"]) for s in steps]})
    summary = (f"Retrain DAG {'FIRED' if res['fired'] else 'did not fire'} ({res['profile']}-label profile) in {secs}s; "
               + ("waiting on human sign-off " + appr["approval_id"] if appr else "handed off to remediation + eval gate" if res["fired"] else "no action") + ". Promotion always needs a human.")
    icon = {"ok": 1, "handoff": 1, "skipped": 0, "pending": 0, "waiting_human": 0, "requires_human": 0, "failed": -1}
    return _insight("retrain_trigger", "Retraining trigger + DAG", summary, agent="retrain-agent", tier="T2", source="search-svc /drift + online_sessions + slice_report + ops.db",
                    facts=[{"label": "label profile", "value": res["profile"], "cite": f"fast if online sessions < {FAST_LABEL_MAX_AGE_H:.0f} h old"},
                           {"label": "drift p-value", "value": (ctx.get("drift") or {}).get("p_value", "n/a"), "cite": "search-svc /drift"},
                           {"label": "est ΔNDCG@10", "value": (ctx.get("drift") or {}).get("est_ndcg10_delta", "n/a"), "cite": f"trigger ≤ {DELTA_TRIGGER}"},
                           {"label": "alert", "value": ctx.get("alert_id") or "none", "cite": "ops.db alerts"},
                           {"label": "sign-off", "value": appr["approval_id"] if appr else "not required", "cite": "ops.db approvals"},
                           {"label": "DAG seconds", "value": secs}],
                    table={"columns": ["step", "status", "seconds", "detail"], "rows": [[s["step"], s["status"], s["seconds"], s["detail"]] for s in steps]},
                    chart={"type": "bar", "unit": "seconds per step", "series": [{"label": s["step"], "value": s["seconds"]} for s in steps if s["seconds"]]},
                    findings=[{"severity": "high" if s["status"] == "failed" else "medium" if s["status"] in ("waiting_human", "requires_human") else "info", "finding": f"{s['step']}: {s['status']}", "cite": s["detail"][:60]} for s in steps if icon.get(s["status"], 0) != 1],
                    citations=[{"source": "search-svc", "ref": "/drift"}, {"source": "data/online_sessions.jsonl", "ref": "label freshness"}, {"source": "ops.db", "ref": "alerts, approvals, audit"}, {"source": ev, "ref": "evidence"}],
                    result=res, approval_id=appr and appr["approval_id"], n=len(steps))


# ======================================================================= shared helpers for 6-10
def _boot_diff(a: list[float], b: list[float], seed: int, reps: int = 1000) -> list[float]:
    """Percentile bootstrap CI95 of mean(b) - mean(a), resampling each group independently."""
    if len(a) < 2 or len(b) < 2:
        return [None, None]
    rng = random.Random(seed)
    ds = sorted(statistics.mean(rng.choices(b, k=len(b))) - statistics.mean(rng.choices(a, k=len(a))) for _ in range(reps))
    return [round(ds[int(0.025 * reps)], 6), round(ds[int(0.975 * reps) - 1], 6)]


def _pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, math.ceil(q * len(s)) - 1))]


def wilson(bad: int, n: int, z: float = 1.96) -> list[float]:
    if n == 0:
        return [None, None]
    p = bad / n
    c = (p + z * z / (2 * n)) / (1 + z * z / n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return [round(max(0.0, c - h), 5), round(min(1.0, c + h), 5)]


def _test_queries(split: str, n_queries: int):
    q, grades = _judgments()
    qs = q[q.split == split].sort_values("query_id")
    return [(int(r.query_id), r.query) for r in qs.itertuples() if int(r.query_id) in grades and max(grades[int(r.query_id)].values()) > 0][:n_queries], grades


# ======================================================================= 6. fairness + sponsored-vs-organic exposure audit
def _pos_w(r: int) -> float:
    return 1 / math.log2(r + 1)


def exposure_shares(ranked: list[str], flag: dict, grades: dict) -> tuple[float, float]:
    """Position-weighted (1/log2(r+1)) sponsored exposure share of the live list, and of the SAME items re-ordered by
    ESCI gain (relevance-matched baseline; unjudged = gain 0, ties keep live order)."""
    if not ranked:
        return 0.0, 0.0
    base = sorted(ranked, key=lambda d: -grades.get(d, 0))  # stable sort: ties keep live order
    tot = sum(_pos_w(r) for r in range(1, len(ranked) + 1))
    live = sum(_pos_w(r) for r, d in enumerate(ranked, 1) if flag.get(d)) / tot
    rel = sum(_pos_w(r) for r, d in enumerate(base, 1) if flag.get(d)) / tot
    return live, rel


def exposure_audit(mode: str = "rrf_rerank", n_queries: int = 200, split: str = "test", k: int = 10, seed: int = 20260917) -> dict:
    import pandas as pd

    title = f"Exposure audit: sponsored vs organic ({mode})"
    qs, grades = _test_queries(split, n_queries)
    prods = pd.read_parquet(Path(DATA) / "products.parquet", columns=["product_id", "sponsored", "brand"])
    flag = dict(zip(prods.product_id, prods.sponsored.fillna(False).astype(bool)))
    brand = dict(zip(prods.product_id, prods.brand.fillna("unknown")))
    try:
        live = _search_many([t for _, t in qs], mode, k)
    except search_client.SearchUnavailable as e:
        return _unavailable("exposure_audit", title, e, "eval-agent", "T1")
    sl, sb, d, slot_s, rel_s, rel_o = [], [], [], 0, [], []
    bexp: dict[str, float] = {}
    for qid, t in qs:
        ranked = live[t][:k]
        a, b = exposure_shares(ranked, flag, grades[qid])
        sl.append(a); sb.append(b); d.append(a - b)
        slot_s += sum(1 for x in ranked if flag.get(x))
        for r, x in enumerate(ranked, 1):
            bexp[brand.get(x, "unknown")] = bexp.get(brand.get(x, "unknown"), 0.0) + _pos_w(r)
            (rel_s if flag.get(x) else rel_o).append(grades[qid].get(x, 0))
    n = len(qs)
    if n == 0:
        return _insight("exposure_audit", title, "No judged queries available; nothing computed.", agent="eval-agent", tier="T1", source="ESCI qrels", n=0)
    catalog_rate = float(prods.sponsored.fillna(False).astype(bool).mean())
    ci = _boot_ci(d, seed)
    tot_b = sum(bexp.values()) or 1.0
    shares = sorted(((b, v / tot_b) for b, v in bexp.items()), key=lambda x: -x[1])
    hhi = sum(s * s for _, s in shares)
    top5 = sum(s for _, s in shares[:5])
    skew = ci[0] is not None and (ci[0] > 0 or ci[1] < 0)
    direction = "over-exposed" if statistics.mean(d) > 0 else "under-exposed"
    res = {"mode": mode, "n_queries": n, "k": k, "sponsored_exposure_live": round(statistics.mean(sl), 4), "sponsored_exposure_relevance_matched": round(statistics.mean(sb), 4),
           "exposure_gap": round(statistics.mean(d), 4), "exposure_gap_ci95": ci, "sponsored_slot_share": round(slot_s / (n * k), 4), "catalog_sponsored_rate": round(catalog_rate, 4),
           "mean_gain_sponsored": round(statistics.mean(rel_s), 3) if rel_s else None, "mean_gain_organic": round(statistics.mean(rel_o), 3) if rel_o else None,
           "n_sponsored_slots": len(rel_s), "brand_hhi": round(hhi, 4), "top5_brand_exposure": round(top5, 4), "top_brands": [[b, round(s, 4)] for b, s in shares[:5]],
           "skew_detected": skew, "baseline": "same live top-k re-ordered by ESCI gain (unjudged = 0); position weight 1/log2(r+1)",
           "not_measured": "1P vs 3P seller exposure: products.parquet has no seller/1P-3P field", "sponsored_flag": "synthetic ad placement on ESCI products (products.parquet sponsored/ad_id)"}
    ev = _evidence(6, "exposure", res)
    db.audit("eval-agent", "T1", "exposure_audit", mode, detail={k2: res[k2] for k2 in ("n_queries", "exposure_gap", "exposure_gap_ci95", "skew_detected")})
    summary = (f"Sponsored items get {res['sponsored_exposure_live']:.1%} of position-weighted exposure vs {res['sponsored_exposure_relevance_matched']:.1%} if the same results were ordered by relevance "
               f"(gap {res['exposure_gap']:+.4f} CI95 {ci}, n={n}): {'sponsored ' + direction + ' vs relevance' if skew else 'no detectable exposure skew'}. Remediation is a human decision.")
    return _insight("exposure_audit", title, summary, agent="eval-agent", tier="T1", source="search-svc /search (live) + products.parquet sponsored flag + ESCI qrels",
                    facts=[{"label": "sponsored exposure (live)", "value": f"{res['sponsored_exposure_live']:.2%}", "cite": "1/log2(r+1) weights"},
                           {"label": "relevance-matched baseline", "value": f"{res['sponsored_exposure_relevance_matched']:.2%}", "cite": "same items by ESCI gain"},
                           {"label": "exposure gap", "value": f"{res['exposure_gap']:+.4f} CI95 {ci}", "cite": "bootstrap 1000 over queries"},
                           {"label": "sponsored slot share / catalog rate", "value": f"{res['sponsored_slot_share']:.1%} / {catalog_rate:.1%}", "cite": "products.parquet"},
                           {"label": "mean ESCI gain sponsored / organic", "value": f"{res['mean_gain_sponsored']} / {res['mean_gain_organic']}", "cite": f"{len(rel_s)} sponsored slots"},
                           {"label": "brand exposure HHI / top-5 share", "value": f"{hhi:.4f} / {top5:.1%}", "cite": "seller-fairness proxy"}],
                    chart={"type": "bar", "unit": "sponsored exposure share", "series": [{"label": "live", "value": res["sponsored_exposure_live"]}, {"label": "relevance-matched", "value": res["sponsored_exposure_relevance_matched"]}, {"label": "catalog rate", "value": res["catalog_sponsored_rate"]}]},
                    table={"columns": ["brand", "exposure share"], "rows": res["top_brands"]},
                    findings=[{"severity": "medium" if skew else "info", "finding": summary, "cite": ev},
                              {"severity": "medium", "finding": "1P vs 3P seller exposure is NOT measured: the catalogue has no seller field. Brand concentration (HHI) is reported as a proxy.", "cite": "data/products.parquet columns"},
                              {"severity": "info", "finding": "The sponsored flag is synthetic ad placement on real ESCI products; the exposure statistics on it are real.", "cite": "data/SOURCE.txt"}],
                    citations=[{"source": "search-svc", "ref": f"/search mode={mode}"}, {"source": "data/products.parquet", "ref": "sponsored, brand"}, {"source": f"data/qrels_{split}.parquet", "ref": "ESCI gains"}, {"source": ev, "ref": "evidence"}],
                    result=res, n=n)


# ======================================================================= 7. prompt/agent config registry with eval-on-change
CONFIG_ROOT = ROOT
CONFIG_FILES = ("bff/src/ops/prompt.ts", "bff/src/agents/roles.ts", "bff/src/config.ts")
LEDGER = Path(DATA) / "token_ledger.jsonl"
MIN_TURNS = 10


def _cfg_table():
    db.execute("CREATE TABLE IF NOT EXISTS config_versions (version_id TEXT PRIMARY KEY, ts REAL, registered_at REAL, hash TEXT, files TEXT, note TEXT, actor TEXT)")


def config_snapshot() -> tuple[dict, str, float]:
    files = {f: (CONFIG_ROOT / f).read_text() for f in CONFIG_FILES if (CONFIG_ROOT / f).exists()}
    h = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:12]
    mtime = max(((CONFIG_ROOT / f).stat().st_mtime for f in files), default=time.time())
    return files, h, mtime


def models_of(files: dict) -> dict:
    import re

    src = files.get("bff/src/config.ts", "")
    return {m_.group(1): m_.group(2) for m_ in re.finditer(r'(\w+): process\.env\.\w+(?: \?\? process\.env\.\w+)* \?\? "([\w.-]+)"', src)}


def ledger_rows() -> list[dict]:
    from datetime import datetime

    out = []
    if LEDGER.exists():
        for l in LEDGER.read_text().splitlines():
            if l.strip():
                r = json.loads(l)
                try:
                    r["_t"] = datetime.fromisoformat(r["ts"].replace("Z", "+00:00")).timestamp()
                except (KeyError, ValueError):
                    continue
                out.append(r)
    return out


def eval_window(before: list[dict], after: list[dict], seed: int = 20260917) -> tuple[list, list]:
    """Per role: n, ok rate, mean cost, p95 total_ms before vs after a config change; regression flags with bootstrap CIs."""
    rows, regressions = [], []
    for role in sorted({r.get("role") for r in before + after if r.get("role")}):
        b = [r for r in before if r.get("role") == role]
        a = [r for r in after if r.get("role") == role]
        okb = sum(1 for r in b if r.get("ok")) / len(b) if b else None
        oka = sum(1 for r in a if r.get("ok")) / len(a) if a else None
        cb, ca = [float(r.get("cost_usd") or 0) for r in b], [float(r.get("cost_usd") or 0) for r in a]
        ci = _boot_diff(cb, ca, seed)
        enough = len(a) >= MIN_TURNS and len(b) >= MIN_TURNS
        status = "insufficient n" if not enough else "ok"
        if enough and okb is not None and oka is not None and oka < okb - 0.02 and 1 - wilson(len(a) - round(oka * len(a)), len(a))[0] < okb:
            status = "REGRESSION ok-rate"
        elif enough and ci[0] is not None and ci[0] > 0 and statistics.mean(ca) > 1.2 * statistics.mean(cb):
            status = "REGRESSION cost"
        row = [role, len(b), len(a), okb and round(okb, 3), oka and round(oka, 3), round(statistics.mean(cb), 5) if cb else None, round(statistics.mean(ca), 5) if ca else None,
               json.dumps(ci), _pct([r.get("total_ms") or 0 for r in b], 0.95), _pct([r.get("total_ms") or 0 for r in a], 0.95), status]
        rows.append(row)
        if status.startswith("REGRESSION"):
            regressions.append(role)
    return rows, regressions


def prompt_registry_diff(action: str = "diff", to_version: str | None = None) -> dict:
    import difflib

    _cfg_table()
    title = "Prompt/agent config registry"
    files, h, mtime = config_snapshot()
    versions = db.rows("SELECT * FROM config_versions ORDER BY registered_at")
    latest = versions[-1] if versions else None
    registered = None
    if not latest or latest["hash"] != h:
        vid = f"cfg{len(versions) + 1}"
        db.execute("INSERT INTO config_versions VALUES(?,?,?,?,?,?,?)", (vid, mtime, time.time(), h, json.dumps(files), "detected change" if latest else "baseline", "release-agent"))
        registered = vid
        versions = db.rows("SELECT * FROM config_versions ORDER BY registered_at")
    cur = versions[-1]
    prev = versions[-2] if len(versions) > 1 else None
    applied = None
    diff_to = prev
    appr = None
    if action == "rollback":
        target = next((v for v in versions if v["version_id"] == to_version), None)
        if not target:
            return _insight("prompt_registry_diff", title, f"Unknown config version {to_version!r}; known: {', '.join(v['version_id'] for v in versions)}.", agent="release-agent", tier="T2", source="ops.db config_versions", n=0)
        diff_to = target
        appr = db.approval_for("config_rollback", to_version)
        if appr and appr["status"] == "approved" and target["hash"] != h:
            for f, text in json.loads(target["files"]).items():
                (CONFIG_ROOT / f).write_text(text)
            files, h, mtime = config_snapshot()
            vid = f"cfg{len(versions) + 1}"
            db.execute("INSERT INTO config_versions VALUES(?,?,?,?,?,?,?)", (vid, mtime, time.time(), h, json.dumps(files), f"rollback to {to_version} ({appr['approval_id']})", appr["decided_by"] or "human"))
            applied = vid
            db.audit("release-agent", "T2", "config_rollback", to_version, appr["approval_id"], outcome="applied", detail={"new_version": vid, "hash": h})
            versions = db.rows("SELECT * FROM config_versions ORDER BY registered_at")
            cur, diff_to = versions[-1], versions[-2]
        elif target["hash"] != h:
            appr = db.request_approval("config_rollback", to_version, "release-agent", f"Roll prompt/agent config back from {cur['version_id']} ({h}) to {to_version} ({target['hash']})")
            db.audit("release-agent", "T2", "config_rollback", to_version, appr["approval_id"], outcome="awaiting_human_approval")
    diff_rows = []
    new = json.loads(cur["files"])
    old = json.loads(diff_to["files"]) if diff_to else new
    old_side, new_side = (new, old) if action == "rollback" and not applied else (old, new)
    for f in sorted(set(old_side) | set(new_side)):
        lines = list(difflib.unified_diff(old_side.get(f, "").splitlines(), new_side.get(f, "").splitlines(), lineterm="", n=0))
        plus = sum(1 for l in lines if l.startswith("+") and not l.startswith("+++"))
        minus = sum(1 for l in lines if l.startswith("-") and not l.startswith("---"))
        if plus or minus:
            sample = next((l[1:].strip()[:90] for l in lines if l[:1] in "+-" and l[:3] not in ("+++", "---") and l[1:].strip()), "")
            diff_rows.append([f, plus, minus, sample])
    models_old, models_new = models_of(old_side), models_of(new_side)
    model_changes = {k: [models_old.get(k), models_new.get(k)] for k in set(models_old) | set(models_new) if models_old.get(k) != models_new.get(k)}
    led = ledger_rows()
    change_ts = cur["ts"]
    start = prev["ts"] if prev else 0
    before = [r for r in led if start <= r["_t"] < change_ts]  # baseline version: every turn before its last file change
    after = [r for r in led if r["_t"] >= change_ts]
    eval_rows, regressions = eval_window(before, after)
    reg_appr = None
    if regressions:
        reg_appr = db.request_approval("config_regression", cur["version_id"], "release-agent", f"Config {cur['version_id']} regressed on {', '.join(regressions)}; merge blocked pending review")
    pending_eval = not regressions and all(r[-1] == "insufficient n" for r in eval_rows)
    verdict = ("rollback APPLIED as " + applied if applied else f"rollback to {to_version} awaiting human approval {appr['approval_id']}" if action == "rollback" and appr and appr["status"] != "approved"
               else f"rollback target {to_version} equals current config" if action == "rollback"
               else f"REGRESSION on {', '.join(regressions)}: merge BLOCKED pending {reg_appr['approval_id']}" if regressions
               else f"eval pending: fewer than {MIN_TURNS} ledger turns per role since the change" if pending_eval else "no regression in ledger eval") + ("" if prev else " (baseline version: evaluated across its last file change)")
    res = {"action": action, "current": cur["version_id"], "hash": h, "previous": prev and prev["version_id"], "registered_now": registered, "applied_rollback": applied,
           "versions": [[v["version_id"], v["hash"], time.strftime("%Y-%m-%d %H:%M", time.localtime(v["ts"])), v["note"]] for v in versions],
           "files_changed": diff_rows, "model_changes": model_changes, "models": models_new, "eval": {"columns": ["role", "n before", "n after", "ok before", "ok after", "cost before", "cost after", "Δcost CI95", "p95 ms before", "p95 ms after", "status"], "rows": eval_rows},
           "ledger_turns_before": len(before), "ledger_turns_after": len(after), "regressions": regressions, "regression_approval": reg_appr and reg_appr["approval_id"],
           "rollback_approval": appr and appr["approval_id"], "verdict": verdict, "tracked_files": list(CONFIG_FILES),
           "eval_method": "token_ledger.jsonl turns between the previous config's change time and this one vs after it, per role; ok-rate (Wilson) and cost (bootstrap)"}
    ev = _evidence(7, "config_registry", res)
    db.audit("release-agent", "T2", "prompt_registry_diff", cur["version_id"], ((appr if action == "rollback" else reg_appr) or {}).get("approval_id"), outcome="blocked_regression" if regressions else action, detail={"hash": h, "files_changed": len(diff_rows)})
    summary = f"Config {cur['version_id']} ({h}) vs {diff_to['version_id'] if diff_to else 'none'}: {len(diff_rows)} file(s) changed, eval over {len(before)} → {len(after)} ledger turns. {verdict}."
    return _insight("prompt_registry_diff", title, summary, agent="release-agent", tier="T2", source="bff prompts/models config + ops.db config_versions + data/token_ledger.jsonl",
                    facts=[{"label": "current version / hash", "value": f"{cur['version_id']} / {h}", "cite": "sha256 of tracked files"},
                           {"label": "versions registered", "value": len(versions), "cite": "ops.db config_versions"},
                           {"label": "files changed", "value": len(diff_rows), "cite": ", ".join(CONFIG_FILES)},
                           {"label": "model changes", "value": json.dumps(model_changes) if model_changes else "none", "cite": "bff/src/config.ts models"},
                           {"label": "ledger turns before / after", "value": f"{len(before)} / {len(after)}", "cite": "data/token_ledger.jsonl"},
                           {"label": "verdict", "value": verdict}],
                    table={"columns": res["eval"]["columns"], "rows": eval_rows} if eval_rows else {"columns": ["file", "+lines", "-lines", "first change"], "rows": diff_rows},
                    chart={"type": "bar", "unit": "turns per role after change", "series": [{"label": r[0], "value": r[2]} for r in eval_rows]} if eval_rows else None,
                    findings=[{"severity": "high" if regressions else "medium" if action == "rollback" and not applied else "info", "finding": verdict, "cite": ev}]
                    + [{"severity": "info", "finding": f"{r[0]} +{r[1]}/-{r[2]}: {r[3]}", "cite": r[0]} for r in diff_rows[:4]]
                    + [{"severity": "info", "finding": "Eval-on-change reads real turns from the token ledger (ok-rate, cost, latency); it is not a replayed golden conversation suite.", "cite": "data/token_ledger.jsonl"}],
                    citations=[{"source": f, "ref": "tracked config"} for f in CONFIG_FILES] + [{"source": "data/token_ledger.jsonl", "ref": f"{len(led)} turns"}, {"source": ev, "ref": "evidence"}],
                    result=res, approval_id=((appr if action == "rollback" else reg_appr) or {}).get("approval_id"), n=max(1, len(before) + len(after)))


# ======================================================================= 8. model SLOs + error budgets + release freeze
SEARCH_P95_MS = 150.0  # services/search-svc/mlops.py P95_MAX_MS (the eval gate's latency threshold)
SLOS = [
    {"slo": "search latency <= 150 ms", "objective": 0.95, "source": "data/online_sessions.jsonl ms"},
    {"slo": "agent turn success", "objective": 0.99, "source": "data/token_ledger.jsonl ok"},
    {"slo": "agent first token <= 10 s", "objective": 0.95, "source": "data/token_ledger.jsonl first_token_ms"},
]


def slo_events() -> dict[str, list[bool]]:
    sess = [json.loads(l) for l in SESSIONS.read_text().splitlines() if l.strip()] if SESSIONS.exists() else []
    sess.sort(key=lambda s: s.get("ingested_at", 0))
    led = sorted(ledger_rows(), key=lambda r: r["_t"])
    return {SLOS[0]["slo"]: [float(s.get("ms") or 0) <= SEARCH_P95_MS for s in sess if s.get("ms") is not None],
            SLOS[1]["slo"]: [bool(r.get("ok")) for r in led],
            SLOS[2]["slo"]: [(r.get("first_token_ms") or 0) <= 10_000 for r in led if r.get("first_token_ms") is not None]}


def budget(good: list[bool], objective: float, short: int = 50) -> dict:
    n = len(good)
    bad = n - sum(good)
    allowed = 1 - objective
    frac = bad / n if n else 0.0
    burn = frac / allowed if allowed else float("inf")
    tail = good[-short:]
    sburn = ((len(tail) - sum(tail)) / len(tail)) / allowed if tail else 0.0
    return {"n": n, "bad": bad, "bad_fraction": round(frac, 5), "bad_ci95": wilson(bad, n), "burn_rate": round(burn, 3), "short_window_burn": round(sburn, 3),
            "budget_remaining": round(1 - burn, 4), "exhausted": n > 0 and burn >= 1.0 - 1e-9}


def freeze_blocks() -> dict | None:
    """Used by tools.promote: the latest release freeze blocks promotion until a human approves its override."""
    r = db.rows("SELECT * FROM approvals WHERE kind='release_freeze_override' ORDER BY requested_at DESC LIMIT 1")
    return r[0] if r and r[0]["status"] in ("pending", "rejected") else None


def slo_budget_status() -> dict:
    title = "Model SLOs + error budgets"
    ev_ = slo_events()
    rows, out = [], []
    for s in SLOS:
        b = budget(ev_[s["slo"]], s["objective"])
        out.append({**s, **b})
        rows.append([s["slo"], f"{s['objective']:.0%}", b["n"], b["bad"], f"{b['bad_fraction']:.2%} CI95 {b['bad_ci95']}", b["burn_rate"], b["short_window_burn"], f"{b['budget_remaining']:.0%}", "EXHAUSTED" if b["exhausted"] else "ok"])
    exhausted = [o["slo"] for o in out if o["exhausted"]]
    appr = None
    if exhausted:
        appr = db.request_approval("release_freeze_override", "releases-" + time.strftime("%Y%m%d"), "release-agent",
                                   f"Release FREEZE: error budget exhausted on {', '.join(exhausted)}. promote is blocked until a human approves this override.")
        db.audit("release-agent", "T2", "release_freeze", appr["subject"], appr["approval_id"], outcome="frozen" if appr["status"] == "pending" else f"override_{appr['status']}", detail={"exhausted": exhausted})
    else:
        db.audit("release-agent", "T2", "slo_budget_status", "releases", outcome="within_budget")
    active = freeze_blocks()
    res = {"slos": out, "exhausted": exhausted, "freeze_active": bool(active), "freeze_approval": active and active["approval_id"], "override_approval": appr and appr["approval_id"],
           "not_measured": "conversion-rate SLO: no order/conversion events are logged by the demo", "window": "all logged events; short window = last 50"}
    ev = _evidence(8, "slo_budget", res)
    summary = (f"Error budget exhausted on {', '.join(exhausted)}: releases FROZEN, promote blocked until a human approves {active['approval_id']}." if active
               else f"Budget exhausted on {', '.join(exhausted)} but a human override is approved; promote not frozen." if exhausted
               else "All SLOs within error budget; no release freeze.")
    n = sum(o["n"] for o in out)
    return _insight("slo_budget_status", title, summary, agent="release-agent", tier="T2", source="data/online_sessions.jsonl + data/token_ledger.jsonl + ops.db approvals",
                    facts=[{"label": o["slo"], "value": f"burn {o['burn_rate']}x, {o['budget_remaining']:.0%} left (n={o['n']})", "cite": o["source"]} for o in out]
                    + [{"label": "release freeze", "value": f"ACTIVE ({active['approval_id']})" if active else "not active", "cite": "ops.db approvals release_freeze_override"}],
                    chart={"type": "bar", "unit": "burn rate (1.0 = budget spent)", "series": [{"label": o["slo"], "value": o["burn_rate"]} for o in out]},
                    table={"columns": ["SLO", "objective", "n", "bad", "bad % (Wilson CI)", "burn", "burn last 50", "budget left", "status"], "rows": rows},
                    findings=[{"severity": "high" if active else "info", "finding": summary, "cite": ev},
                              {"severity": "info", "finding": "No conversion SLO: the demo logs no order events, so CVR burn is not measured.", "cite": "data/online_sessions.jsonl"}],
                    citations=[{"source": "data/online_sessions.jsonl", "ref": "ms"}, {"source": "data/token_ledger.jsonl", "ref": "ok, first_token_ms"}, {"source": "services/search-svc/mlops.py", "ref": "P95_MAX_MS 150"}, {"source": ev, "ref": "evidence"}],
                    result=res, approval_id=active and active["approval_id"], n=n)


# ======================================================================= 9. golden-set regression + eval dataset versioning
def _gs_table():
    db.execute("CREATE TABLE IF NOT EXISTS golden_sets (hash TEXT PRIMARY KEY, ts REAL, split TEXT, n_queries INTEGER, n_judgments INTEGER, rows TEXT)")


def golden_rows(split: str, n_queries: int) -> tuple[list, str]:
    qs, grades = _test_queries(split, n_queries)
    rows = sorted([qid, t, pid, int(g)] for qid, t in qs for pid, g in grades[qid].items())
    return rows, hashlib.sha256(json.dumps(rows).encode()).hexdigest()[:12]


def dataset_diff(old: list, new: list) -> dict:
    o = {(r[0], r[2]): r[3] for r in old}
    nw = {(r[0], r[2]): r[3] for r in new}
    return {"queries_added": len({r[0] for r in new} - {r[0] for r in old}), "queries_removed": len({r[0] for r in old} - {r[0] for r in new}),
            "judgments_added": len(nw.keys() - o.keys()), "judgments_removed": len(o.keys() - nw.keys()), "relabelled": sum(1 for k in o.keys() & nw.keys() if o[k] != nw[k])}


def golden_set_diff(baseline: str = "rrf_rerank", candidate: str = "rrf", split: str = "test", n_queries: int = 200, fail_below: float = 0.5, seed: int = 20260917) -> dict:
    _gs_table()
    title = f"Golden-set regression: {candidate} vs {baseline}"
    rows, h = golden_rows(split, n_queries)
    known = db.rows("SELECT hash, ts, n_queries, n_judgments FROM golden_sets WHERE split=? ORDER BY ts DESC", (split,))
    new_version = h not in {k["hash"] for k in known}
    prev = next((k for k in known if k["hash"] != h), None)
    if new_version:
        db.execute("INSERT INTO golden_sets VALUES(?,?,?,?,?,?)", (h, time.time(), split, len({r[0] for r in rows}), len(rows), json.dumps(rows)))
    ddiff, bump = None, None
    if prev:
        old = json.loads(db.rows("SELECT rows FROM golden_sets WHERE hash=?", (prev["hash"],))[0]["rows"])
        ddiff = dataset_diff(old, rows)
        if new_version:
            bump = db.request_approval("golden_set_bump", h, "eval-agent", f"Golden set {split} changed {prev['hash']} -> {h}: {json.dumps(ddiff)}")
    qtext = {r[0]: r[1] for r in rows}
    grades: dict = {}
    for r in rows:
        grades.setdefault(r[0], {})[r[2]] = r[3]
    texts = list(qtext.values())
    try:
        rb, rc = _search_many(texts, baseline), _search_many(texts, candidate)
    except search_client.SearchUnavailable as e:
        return _unavailable("golden_set_diff", title, e, "eval-agent", "T1")
    per = []
    for qid, t in qtext.items():
        nb, nc = ndcg10(grades[qid], rb[t]) or 0.0, ndcg10(grades[qid], rc[t]) or 0.0
        per.append((qid, t, nb, nc))
    fb = {p[0] for p in per if p[2] < fail_below}
    fc = {p[0] for p in per if p[3] < fail_below}
    newly, fixed = sorted(fc - fb), sorted(fb - fc)
    d = [p[3] - p[2] for p in per]
    wins, losses = sum(1 for x in d if x > 1e-9), sum(1 for x in d if x < -1e-9)
    regression = len(newly) > len(fixed)
    n = len(per)
    res = {"golden_hash": h, "split": split, "n_queries": n, "n_judgments": len(rows), "new_dataset_version": new_version, "previous_hash": prev and prev["hash"], "dataset_diff": ddiff,
           "bump_approval": bump and bump["approval_id"], "versions_known": len(known) + (1 if new_version else 0), "baseline": baseline, "candidate": candidate, "fail_below": fail_below,
           "ndcg10_baseline": round(statistics.mean(p[2] for p in per), 4) if n else None, "ndcg10_candidate": round(statistics.mean(p[3] for p in per), 4) if n else None,
           "delta_mean": round(statistics.mean(d), 4) if n else None, "delta_ci95": _boot_ci(d, seed), "wins": wins, "losses": losses, "sign_test_p": round(sign_test_p(wins, losses), 6),
           "failing_baseline": len(fb), "failing_candidate": len(fc), "newly_failing": len(newly), "fixed": len(fixed), "regression": regression,
           "newly_failing_queries": [qtext[q] for q in newly[:20]], "fixed_queries": [qtext[q] for q in fixed[:20]]}
    ev = _evidence(9, "golden_set", res)
    db.audit("eval-agent", "T1", "golden_set_diff", h, bump and bump["approval_id"], outcome="regression" if regression else "no_regression", detail={k: res[k] for k in ("n_queries", "newly_failing", "fixed", "delta_mean")})
    summary = (f"Golden set {h} (n={n} queries, {len(rows)} judgments{', NEW version vs ' + prev['hash'] if new_version and prev else ', new baseline version' if new_version else ''}): {candidate} newly fails {len(newly)}, fixes {len(fixed)} vs {baseline} "
               f"(ΔNDCG@10 {res['delta_mean']:+.4f} CI95 {res['delta_ci95']}). {'REGRESSION flagged' if regression else 'No regression'}; a human approves dataset version bumps.")
    tbl = [["newly failing", qtext[q]] for q in newly[:8]] + [["fixed", qtext[q]] for q in fixed[:4]]
    return _insight("golden_set_diff", title, summary, agent="eval-agent", tier="T1", source="ESCI qrels golden set (hashed, versioned in ops.db) + search-svc /search (live)",
                    facts=[{"label": "golden set hash", "value": h, "cite": "sha256 of (query_id, query, product_id, gain)"},
                           {"label": "dataset diff vs previous", "value": json.dumps(ddiff) if ddiff else "no previous version", "cite": prev["hash"] if prev else "ops.db golden_sets"},
                           {"label": "NDCG@10 baseline / candidate", "value": f"{res['ndcg10_baseline']} / {res['ndcg10_candidate']}"},
                           {"label": "newly failing / fixed", "value": f"{len(newly)} / {len(fixed)}", "cite": f"NDCG@10 < {fail_below}"},
                           {"label": "sign test p", "value": res["sign_test_p"], "cite": f"{wins} wins / {losses} losses"},
                           {"label": "version bump approval", "value": bump["approval_id"] if bump else "not needed"}],
                    chart={"type": "bar", "unit": "queries", "series": [{"label": "newly failing", "value": len(newly)}, {"label": "fixed", "value": len(fixed)}, {"label": "failing both", "value": len(fb & fc)}]},
                    table={"columns": ["change", "query"], "rows": tbl or [["none", "-"]]},
                    findings=[{"severity": "high" if regression else "info", "finding": summary, "cite": ev},
                              {"severity": "info", "finding": "`make eval-ci` runs this check and exits non-zero on regression.", "cite": "Makefile eval-ci"}],
                    citations=[{"source": f"data/qrels_{split}.parquet", "ref": f"golden set {h}"}, {"source": "search-svc", "ref": f"/search mode={baseline},{candidate}"}, {"source": ev, "ref": "evidence"}],
                    result=res, approval_id=bump and bump["approval_id"], n=n)


# ======================================================================= 10. shadow deployment
SERVING_DEFAULT = {"embedding_model": "BAAI/bge-small-en-v1.5", "rrf_k": 60, "w_bm25": 1.0, "w_vector": 1.0, "reranker_model": "cross-encoder/ms-marco-MiniLM-L-6-v2", "rerank_depth": 50, "synonyms": {}}


def serving_mode(cfg: dict) -> tuple[str, dict]:
    """The live /search path a version config maps onto, and the config params that path cannot apply."""
    mode = "rrf_rerank" if cfg.get("reranker", True) else "rrf"
    skip = {"reranker_model", "rerank_depth"} if mode == "rrf" else set()
    return mode, {k: cfg[k] for k in SERVING_DEFAULT if k in cfg and k not in skip and cfg[k] != SERVING_DEFAULT[k]}


def _version(reg: dict, v: str) -> dict | None:
    vid = reg.get(v, v) if v in ("champion", "candidate") else v
    vs = reg.get("versions") or {}
    if isinstance(vs, dict):
        return vs.get(vid)
    return next((x for x in vs if x.get("version") == vid), None)


def _lines(p: Path) -> int:
    return sum(1 for _ in p.open()) if p.exists() else 0


def shadow_deploy_diff(candidate: str = "v2", champion: str = "champion", n_queries: int = 100, seed: int = 20260917) -> dict:
    title = f"Shadow deployment: {candidate} vs {champion}"
    reg = _registry_safe()
    vc, vx = _version(reg, champion), _version(reg, candidate)
    if not vc or not vx:
        return _insight("shadow_deploy_diff", title, f"Unknown version(s): {champion if not vc else ''} {candidate if not vx else ''}".strip(), agent="release-agent", tier="T1", source="registry", n=0)
    mc, uc = serving_mode(vc.get("config") or {})
    mx, ux = serving_mode(vx.get("config") or {})
    sess = [json.loads(l) for l in SESSIONS.read_text().splitlines() if l.strip()] if SESSIONS.exists() else []
    sess.sort(key=lambda s: s.get("ingested_at", 0))
    served = {}
    for s in sess:
        served[s["query"]] = s.get("product_ids") or []
    queries = list(served)[-n_queries:]
    if not queries:
        return _insight("shadow_deploy_diff", title, "No logged shopper queries in data/online_sessions.jsonl to mirror.", agent="release-agent", tier="T1", source="data/online_sessions.jsonl", n=0)
    sess_before, pol_before = _lines(SESSIONS), _lines(Path(DATA) / "policy_events.jsonl")

    def mirror(qt):
        rng = random.Random(f"{seed}{qt}")
        out = {}
        for arm, mode in sorted((("champion", mc), ("shadow", mx)), key=lambda _: rng.random()):
            t0 = time.perf_counter()
            r = search_client.call("POST", "/search", {"query": qt, "k": 10, "mode": mode}, timeout=120)
            out[arm] = ([x["product_id"] for x in r.get("results", [])], float(r.get("latency_ms") or (time.perf_counter() - t0) * 1000))
        return qt, out
    try:
        with ThreadPoolExecutor(4) as ex:
            got = dict(ex.map(mirror, queries))
    except search_client.SearchUnavailable as e:
        return _unavailable("shadow_deploy_diff", title, e, "release-agent", "T1")
    ov, ov_served, dl, lc, lx = [], [], [], [], []
    for qt in queries:
        (a, la), (b, lb) = got[qt]["champion"], got[qt]["shadow"]
        ov.append(len(set(a[:10]) & set(b[:10])) / 10)
        if served[qt]:
            ov_served.append(len(set(a[:10]) & set(served[qt][:10])) / 10)
        dl.append(lb - la); lc.append(la); lx.append(lb)
    impact_sessions, impact_policy = _lines(SESSIONS) - sess_before, _lines(Path(DATA) / "policy_events.jsonl") - pol_before
    n = len(queries)
    ci = _boot_ci(ov, seed)
    lci = _boot_ci(dl, seed + 1)
    p95c, p95x = _pct(lc, 0.95), _pct(lx, 0.95)
    ready = statistics.mean(ov) >= 0.5 and p95x <= max(SEARCH_P95_MS, 1.2 * p95c)
    res = {"champion": vc.get("version"), "candidate": vx.get("version"), "champion_mode": mc, "candidate_mode": mx, "params_not_applied": {"champion": uc, "candidate": ux},
           "n_queries": n, "overlap_at_10": round(statistics.mean(ov), 4), "overlap_ci95": ci, "overlap_below_0_5": sum(1 for o in ov if o < 0.5),
           "mirror_fidelity_overlap_vs_served": round(statistics.mean(ov_served), 4) if ov_served else None,
           "latency_p50_ms": {"champion": _pct(lc, 0.5), "shadow": _pct(lx, 0.5)}, "latency_p95_ms": {"champion": p95c, "shadow": p95x},
           "latency_diff_mean_ms": round(statistics.mean(dl), 2), "latency_diff_ci95": lci,
           "shopper_impact": {"responses_returned_to_shoppers": 0, "online_sessions_lines_added_during_run": impact_sessions, "policy_events_lines_added_during_run": impact_policy},
           "recommendation": "ready for canary review" if ready else "not ready for canary", "queries_source": "last unique shopper queries in data/online_sessions.jsonl (mirrored)"}
    ev = _evidence(10, "shadow", res)
    db.audit("release-agent", "T1", "shadow_deploy_diff", res["candidate"], outcome=res["recommendation"], detail={k: res[k] for k in ("n_queries", "overlap_at_10", "latency_diff_mean_ms")})
    summary = (f"Shadowed {res['candidate']} ({mx}) against {res['champion']} ({mc}) on n={n} mirrored shopper queries: overlap@10 {res['overlap_at_10']:.2f} CI95 {ci}, "
               f"p95 {p95x:.0f} vs {p95c:.0f} ms (Δ mean {res['latency_diff_mean_ms']:+.1f} ms CI95 {lci}). No shopper saw shadow results. Proposal: {res['recommendation']} (a human approves canary).")
    return _insight("shadow_deploy_diff", title, summary, agent="release-agent", tier="T1", source="search-svc /search (live, both arms) on mirrored online_sessions queries + registry",
                    facts=[{"label": "overlap@10", "value": f"{res['overlap_at_10']:.3f} CI95 {ci}", "cite": "bootstrap 1000"},
                           {"label": "latency p95 champion / shadow", "value": f"{p95c:.1f} / {p95x:.1f} ms", "cite": "search-svc latency_ms"},
                           {"label": "Δ latency (shadow − champion)", "value": f"{res['latency_diff_mean_ms']:+.1f} ms CI95 {lci}", "cite": "paired per query"},
                           {"label": "shopper impact", "value": "0 shadow responses served", "cite": f"sessions file +{impact_sessions} lines during run (other traffic)"},
                           {"label": "mirror fidelity", "value": res["mirror_fidelity_overlap_vs_served"], "cite": "champion arm vs logged served ids"},
                           {"label": "params not executable on live path", "value": json.dumps(res["params_not_applied"])}],
                    chart={"type": "bar", "unit": "ms", "series": [{"label": "champion p50", "value": _pct(lc, 0.5)}, {"label": "shadow p50", "value": _pct(lx, 0.5)}, {"label": "champion p95", "value": p95c}, {"label": "shadow p95", "value": p95x}]},
                    table={"columns": ["query", "overlap@10", "Δ ms"], "rows": [[q, o, round(x, 1)] for q, o, x in sorted(zip(queries, ov, dl), key=lambda r: r[1])[:10]]},
                    findings=[{"severity": "info", "finding": summary, "cite": ev},
                              {"severity": "medium" if uc or ux else "info", "finding": "The live /search path executes reranker on/off; version params " + (json.dumps(res["params_not_applied"]) + " are NOT applied in the shadow arms." if uc or ux else "fully match the executed arms."), "cite": "services/search-svc/engine.py defaults"}],
                    citations=[{"source": "data/online_sessions.jsonl", "ref": f"{n} mirrored queries"}, {"source": "search-svc", "ref": f"/search mode={mc},{mx}"}, {"source": "data/registry.json", "ref": f"{res['champion']}, {res['candidate']}"}, {"source": ev, "ref": "evidence"}],
                    result=res, n=n)


TOOLS = {"interleave_rankers": interleave_rankers, "ab_sequential_test": ab_sequential_test, "skew_check": skew_check,
         "lineage_query": lineage_query, "retrain_trigger": retrain_trigger, "exposure_audit": exposure_audit,
         "prompt_registry_diff": prompt_registry_diff, "slo_budget_status": slo_budget_status, "golden_set_diff": golden_set_diff,
         "shadow_deploy_diff": shadow_deploy_diff}


if __name__ == "__main__":  # used by the @nollm e2e checks: python -m ops_mcp.mlops_top10 <tool> '<json args>'
    import sys

    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    if sys.argv[1] == "eval-ci":  # make eval-ci: golden-set regression gate, exit 1 on regression
        r = golden_set_diff(**args)
        print(r["summary"])
        sys.exit(1 if r.get("result", {}).get("regression") or not r.get("n") else 0)
    out = TOOLS[sys.argv[1]](**args)
    print(json.dumps({k: v for k, v in out.items() if k != "graph"}, default=str))
