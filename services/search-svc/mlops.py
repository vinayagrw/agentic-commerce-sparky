"""MLOps plane for search-svc: model-version registry (MLflow sqlite + JSON mirror), paired eval compare with bootstrap CI,
embedding drift (MMD + permutation test + label-free performance estimate), simulated canary, promote/rollback.

All numbers are computed on the real ESCI subset; none is canned.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import threading
import time
from collections import deque
from pathlib import Path

import numpy as np
import pandas as pd

np.seterr(over="ignore", invalid="ignore", divide="ignore")  # spurious Accelerate matmul FP warnings on macOS

from engine import DATA, EMB_MODEL, K_RRF, QUERY_PREFIX, RERANK_DEPTH, RERANK_MODEL, mrr, ndcg10

os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")
MLOPS_DIR = Path(os.environ.get("SPARKY_MLOPS_DIR", DATA))
REGISTERED_MODEL = "sparky-search-ranker"
NDCG_CI_FLOOR = -0.005   # gate: lower bound of the paired NDCG@10 delta CI must be >= this
P95_MAX_MS = 150.0       # gate + canary guardrail
CANARY_NDCG_DROP = 0.02  # canary guardrail: mean paired NDCG@10 delta (canary - champion shadow, same queries) floor
CANARY_MIN_SAMPLES = 20
CANARY_P95_REL = 1.2     # latency breach needs p95 > P95_MAX_MS AND > 1.2x champion p95 (robust to host contention)

DEFAULT_CONFIG = {
    "embedding_model": EMB_MODEL, "rrf_k": K_RRF, "w_bm25": 1.0, "w_vector": 1.0,
    "reranker": True, "reranker_model": RERANK_MODEL, "rerank_depth": RERANK_DEPTH, "synonyms": {},
}

SEASONAL_RX = (r"\b(?:back to school|school supplies|backpacks?|lunch ?box(?:es)?|pencils?|crayons?|notebooks?|binders?|dorm|"
               r"halloween|costumes?|christmas|xmas|holiday|thanksgiving|easter|valentines?|stocking stuffers?|advent|"
               r"hanukkah|ornaments?|gift wrap|pumpkin|graduation|4th of july|fourth of july)\b")


def cfg_hash(cfg: dict) -> str:
    return hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()[:12]


def now() -> float:
    return round(time.time(), 3)


# ============================ registry ============================
class Registry:
    """Champion/candidate registry. Source of truth is a JSON mirror (fast, process-local); every version is also an
    MLflow run (params, config artifact, metrics) and a registered model version with champion/candidate aliases."""

    def __init__(self, root: Path = MLOPS_DIR):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "registry.json"
        self.lock = threading.RLock()
        self._mlflow = None
        self.mlflow_error: str | None = None
        if self.path.exists():
            self.state = json.loads(self.path.read_text())
        else:
            self.state = {"versions": {}, "champion": None, "candidate": None, "history": []}
            v = self.create(DEFAULT_CONFIG, note="baseline: bge-small + BM25, RRF k=60, MiniLM-L6 rerank top-50")
            self.set_alias("champion", v["version"], actor="bootstrap", reason="initial champion")

    # ---- mlflow (best effort; registry still works if it fails) ----
    def mlflow(self):
        if self._mlflow is None and self.mlflow_error is None:
            try:
                import mlflow
                from mlflow import MlflowClient

                uri = f"sqlite:///{self.root / 'mlflow.db'}"
                mlflow.set_tracking_uri(uri)
                client = MlflowClient(tracking_uri=uri)
                exp = client.get_experiment_by_name("sparky-search")
                exp_id = exp.experiment_id if exp else client.create_experiment(
                    "sparky-search", artifact_location=(self.root / "mlruns").as_uri())
                try:
                    client.get_registered_model(REGISTERED_MODEL)
                except Exception:
                    client.create_registered_model(REGISTERED_MODEL, description="Sparky Next hybrid search ranker configs")
                self._mlflow = (mlflow, client, exp_id, uri)
            except Exception as e:  # pragma: no cover
                self.mlflow_error = repr(e)
        return self._mlflow

    def _save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2))
        tmp.replace(self.path)

    def create(self, config: dict, note: str = "", parent: str | None = None, actor: str = "api") -> dict:
        cfg = {**DEFAULT_CONFIG, **(config or {})}
        with self.lock:
            h = cfg_hash(cfg)
            vid = f"v{len(self.state['versions']) + 1}"
            rec = {"version": vid, "config": cfg, "config_hash": h, "created_at": now(), "status": "registered",
                   "note": note, "parent": parent, "actor": actor, "metrics": {}, "mlflow": {}}
            m = self.mlflow()
            if m:
                mlflow, client, exp_id, uri = m
                try:
                    run = client.create_run(exp_id, run_name=vid, tags={"version": vid, "config_hash": h, "note": note[:200]})
                    rid = run.info.run_id
                    for key, val in cfg.items():
                        client.log_param(rid, key, json.dumps(val) if isinstance(val, (dict, list)) else val)
                    client.log_dict(rid, cfg, "config.json")
                    mv = client.create_model_version(REGISTERED_MODEL, source=f"{run.info.artifact_uri}/config.json",
                                                     run_id=rid, tags={"version": vid, "config_hash": h})
                    client.set_terminated(rid)
                    rec["mlflow"] = {"run_id": rid, "model_version": mv.version, "tracking_uri": uri,
                                     "registered_model": REGISTERED_MODEL}
                except Exception as e:  # pragma: no cover
                    rec["mlflow"] = {"error": repr(e)}
            self.state["versions"][vid] = rec
            self._save()
            return rec

    def get(self, vid: str) -> dict:
        if vid in ("champion", "candidate"):
            vid = self.state.get(vid)
        if not vid or vid not in self.state["versions"]:
            raise KeyError(f"unknown version {vid}")
        return self.state["versions"][vid]

    def set_alias(self, alias: str, vid: str | None, actor: str, reason: str = ""):
        with self.lock:
            prev = self.state.get(alias)
            self.state[alias] = vid
            if vid:
                self.state["versions"][vid]["status"] = alias
            self.state["history"].append({"ts": now(), "alias": alias, "from": prev, "to": vid, "actor": actor, "reason": reason})
            m = self.mlflow()
            if m and vid and self.state["versions"][vid]["mlflow"].get("model_version"):
                try:
                    m[1].set_registered_model_alias(REGISTERED_MODEL, alias, self.state["versions"][vid]["mlflow"]["model_version"])
                except Exception:  # pragma: no cover
                    pass
            self._save()
            return prev

    def log_metrics(self, vid: str, metrics: dict):
        with self.lock:
            rec = self.state["versions"][vid]
            rec["metrics"].update(metrics)
            self._save()
            m = self.mlflow()
            if m and rec["mlflow"].get("run_id"):
                try:
                    for key, val in metrics.items():
                        if isinstance(val, (int, float)):
                            m[1].log_metric(rec["mlflow"]["run_id"], key, float(val))
                except Exception:  # pragma: no cover
                    pass

    def listing(self) -> dict:
        return {"champion": self.state["champion"], "candidate": self.state["candidate"],
                "versions": list(self.state["versions"].values()), "history": self.state["history"][-20:],
                "backend": {"mlflow": bool(self._mlflow), "mlflow_error": self.mlflow_error,
                            "tracking_uri": self._mlflow[3] if self._mlflow else None, "json_mirror": str(self.path)}}


# ============================ MLOps service ============================
class MLOps:
    def __init__(self, engine, root: Path = MLOPS_DIR):
        self.e = engine
        self.reg = Registry(root)
        self.root = Path(root)
        self.lock = threading.RLock()          # serialises model inference across API threads + canary thread
        self._per_query: dict = {}
        self._qemb: dict = {}
        self._calib = None
        self.injected_latency_ms = 0.0
        self.canary: dict | None = None

    # ---------------- candidates ----------------
    def create_candidate(self, config: dict, note: str = "", actor: str = "api") -> dict:
        champ = self.reg.state["champion"]
        rec = self.reg.create(config, note=note, parent=champ, actor=actor)
        t0 = time.perf_counter()
        with self.lock:  # warm: load any new embedding model / reranker and cache embeddings
            self.e.rank_cfg("back to school backpack", rec["config"], k=10)
        self.reg.set_alias("candidate", rec["version"], actor=actor, reason=note or "new candidate")
        reused = rec["config"]["embedding_model"] == EMB_MODEL
        return {**rec, "status": "candidate", "build": {"seconds": round(time.perf_counter() - t0, 2),
                "reused_cached_embeddings": reused, "embedding_cache": "data/embeddings.npy" if reused else "data/emb_cache/"}}

    # ---------------- per-query eval ----------------
    def per_query(self, vid: str, split: str = "test", n_queries: int = 200) -> dict:
        cfg = self.reg.get(vid)["config"]
        key = (cfg_hash(cfg), split, n_queries)
        if key not in self._per_query:
            qids, grades = self.e.eval_qids(split, n_queries)
            qtext = dict(zip(self.e.queries.query_id, self.e.queries["query"]))
            nd, rr, lat, kept = [], [], [], []
            for q in qids:
                with self.lock:
                    order, _, ms = self.e.rank_cfg(qtext[q], cfg, k=10)
                ranked = [self.e.ids[i] for i in order]
                v = ndcg10(grades[q], ranked)
                if v is None:
                    continue
                kept.append(int(q)); nd.append(v); rr.append(mrr(grades[q], ranked)); lat.append(ms)
            self._per_query[key] = {"qids": kept, "ndcg": np.array(nd), "mrr": np.array(rr), "lat": np.array(lat)}
        return self._per_query[key]

    @staticmethod
    def bootstrap_ci(d: np.ndarray, n_boot: int = 1000, seed: int = 20260915) -> dict:
        rng = np.random.default_rng(seed)
        means = d[rng.integers(0, len(d), size=(n_boot, len(d)))].mean(axis=1)
        lo, hi = np.percentile(means, [2.5, 97.5])
        return {"mean": round(float(d.mean()), 5), "ci95": [round(float(lo), 5), round(float(hi), 5)],
                "p_le_0": round(float((means <= 0).mean()), 4), "resamples": n_boot}

    def compare(self, champion: str = "champion", candidate: str = "candidate", split: str = "test", n_queries: int = 200) -> dict:
        a, b = self.reg.get(champion), self.reg.get(candidate)
        t0 = time.perf_counter()
        pa, pb = self.per_query(a["version"], split, n_queries), self.per_query(b["version"], split, n_queries)
        common = sorted(set(pa["qids"]) & set(pb["qids"]))
        ia = [pa["qids"].index(q) for q in common]
        ib = [pb["qids"].index(q) for q in common]
        dn = pb["ndcg"][ib] - pa["ndcg"][ia]
        dm = pb["mrr"][ib] - pa["mrr"][ia]
        lat = {}
        for name, p, idx in (("champion", pa, ia), ("candidate", pb, ib)):
            lat[name] = {"p50_ms": round(float(np.percentile(p["lat"][idx], 50)), 1),
                         "p95_ms": round(float(np.percentile(p["lat"][idx], 95)), 1)}
        ndcg_ci = self.bootstrap_ci(dn)
        checks = {"ndcg_ci_lower_ge_floor": bool(ndcg_ci["ci95"][0] >= NDCG_CI_FLOOR),
                  "p95_latency_le_max": bool(lat["candidate"]["p95_ms"] <= P95_MAX_MS)}
        out = {
            "champion": a["version"], "candidate": b["version"], "split": split, "n_queries": len(common),
            "metrics": {
                "ndcg10": {"champion": round(float(pa["ndcg"][ia].mean()), 4), "candidate": round(float(pb["ndcg"][ib].mean()), 4),
                           "delta": ndcg_ci, "wins": int((dn > 1e-9).sum()), "losses": int((dn < -1e-9).sum()),
                           "ties": int((np.abs(dn) <= 1e-9).sum())},
                "mrr": {"champion": round(float(pa["mrr"][ia].mean()), 4), "candidate": round(float(pb["mrr"][ib].mean()), 4),
                        "delta": self.bootstrap_ci(dm)},
            },
            "latency": lat,
            "gate": {"thresholds": {"ndcg_delta_ci_lower_ge": NDCG_CI_FLOOR, "p95_ms_le": P95_MAX_MS},
                     "checks": checks, "passed": all(checks.values())},
            "method": "paired per-query deltas on identical ESCI queries; percentile bootstrap, 1000 resamples, seed 20260915",
            "seconds": round(time.perf_counter() - t0, 2),
        }
        self.reg.log_metrics(b["version"], {f"{split}_ndcg10": out["metrics"]["ndcg10"]["candidate"],
                                            f"{split}_mrr": out["metrics"]["mrr"]["candidate"],
                                            f"{split}_ndcg10_delta_vs_{a['version']}": ndcg_ci["mean"],
                                            f"{split}_ndcg10_delta_ci_low": ndcg_ci["ci95"][0],
                                            f"{split}_p95_ms": lat["candidate"]["p95_ms"]})
        self.reg.log_metrics(a["version"], {f"{split}_ndcg10": out["metrics"]["ndcg10"]["champion"],
                                            f"{split}_p95_ms": lat["champion"]["p95_ms"]})
        return out

    # ---------------- SOTA techniques 8 / 9: paired measurement on the held-out ESCI queries ----------
    def _paired(self, out: dict, base: str, cand: str) -> dict:
        """Paired delta + percentile-bootstrap CI, computed with the SAME bootstrap_ci the
        champion/candidate gate uses, so the numbers are comparable across the whole repo."""
        a = np.array(out["per_query_ndcg"][base])
        b = np.array(out["per_query_ndcg"][cand])
        d = b - a
        ci = self.bootstrap_ci(d) if len(d) else {"mean": None, "ci95": [None, None], "p_le_0": None, "resamples": 0}
        sig = bool(len(d) and ci["ci95"][0] > 0)
        neg = bool(len(d) and ci["ci95"][1] < 0)
        return {"baseline_ndcg10": out["arms"][base]["ndcg10"], "variant_ndcg10": out["arms"][cand]["ndcg10"],
                "delta": ci, "n_queries": len(d),
                "wins": int((d > 1e-9).sum()), "losses": int((d < -1e-9).sum()), "ties": int((np.abs(d) <= 1e-9).sum()),
                "significant_at_95": sig, "significantly_negative_at_95": neg,
                "verdict": ("significant improvement" if sig else
                            "significant regression" if neg else
                            "null result: the 95% CI of the paired delta straddles zero"),
                "method": ("paired per-query NDCG@10 deltas on identical held-out ESCI queries; engine.ndcg10 "
                           "(exponential gain, same function as /eval/ndcg and /eval/compare); percentile bootstrap, "
                           "1000 resamples, seed 20260915")}

    def eval_contextual(self, variant: str, split: str = "test", n_queries: int = 200,
                        category: str | None = None) -> dict:
        """Technique 8. Two arms per rerank setting: baseline document text vs contextually enriched text.

        The reranker's input pair text (title + brand) is identical in both arms, so any delta comes
        from first-stage retrieval, which is the only thing enrichment changes.
        """
        from engine import provenance

        v = self.e.variant(variant)
        t0 = time.perf_counter()
        arms = {
            "baseline_rrf": lambda q: self.e.rank_variant(q, 10, None, False),
            "contextual_rrf": lambda q: self.e.rank_variant(q, 10, variant, False),
            "baseline_rrf_rerank": lambda q: self.e.rank_variant(q, 10, None, True),
            "contextual_rrf_rerank": lambda q: self.e.rank_variant(q, 10, variant, True),
        }
        with self.lock:
            out = self.e.paired_eval(arms, split, n_queries, category)
        man = v.manifest
        return {
            "technique": 8, "technique_name": "Contextual retrieval", "variant": variant,
            "split": split, "category": category, "n_queries": out["n_queries_scored"],
            "arms": out["arms"],
            "comparisons": {
                "retrieval_only_rrf": self._paired(out, "baseline_rrf", "contextual_rrf"),
                "production_path_rrf_rerank": self._paired(out, "baseline_rrf_rerank", "contextual_rrf_rerank"),
            },
            "enrichment": {"slice": man.get("slice"), "results": man.get("results"), "cost": man.get("cost"),
                           "generator": man.get("generator"), "verification": man.get("verification")},
            "caveats": [
                "Only the enriched slice differs between the arms; every other document keeps its baseline text.",
                "The cross-encoder pair text is unchanged, so enrichment can only move which documents reach the "
                "rerank window and in what first-stage order.",
                "The slice is the baseline candidate pool, so a document that ONLY enrichment would have surfaced "
                "was never enriched. That makes the measurement conservative, not optimistic.",
                "The playbook's own 'When NOT to use' for this technique names structured catalogue records. This "
                "is a structured catalogue.",
            ],
            "seconds": round(time.perf_counter() - t0, 2),
            "provenance": provenance("/eval/contextual", variant, technique=8),
        }

    def eval_late_interaction(self, split: str = "test", n_queries: int = 200, category: str | None = None,
                              depth: int = 50) -> dict:
        """Technique 9. MaxSim rescoring vs the current hybrid+rerank path, and vs RRF with no rescoring.

        Latency is measured with the document-token cache DISABLED, so the reported p50/p95 is the cold
        cost of the technique rather than the cost of a warm cache built by the eval loop itself.
        """
        from engine import LI_MAX_TOKENS, provenance

        t0 = time.perf_counter()
        arms = {
            "hybrid_rrf": lambda q: self.e.rank_variant(q, 10, None, False),
            "hybrid_rrf_rerank": lambda q: self.e.rank_variant(q, 10, None, True),
            "late_interaction_maxsim": lambda q: self.e.late_interaction(q, 10, None, depth, cache=False),
        }
        with self.lock:
            out = self.e.paired_eval(arms, split, n_queries, category)
        return {
            "technique": 9, "technique_name": "Late-interaction retrieval (ColBERT-style MaxSim over text)",
            "split": split, "category": category, "n_queries": out["n_queries_scored"], "rescore_depth": depth,
            "arms": out["arms"],
            "comparisons": {
                "vs_production_hybrid_rerank": self._paired(out, "hybrid_rrf_rerank", "late_interaction_maxsim"),
                "vs_first_stage_rrf_only": self._paired(out, "hybrid_rrf", "late_interaction_maxsim"),
            },
            "method": {"scoring": "score(q,d) = sum_i max_j <q_i, d_j> over L2-normalised token embeddings",
                       "encoder": "BAAI/bge-small-en-v1.5 token embeddings, [CLS]/[SEP] dropped, "
                                  f"max {LI_MAX_TOKENS} tokens per side",
                       "first_stage": "identical BM25 + dense RRF(k=60) as the baseline; only the rescorer differs",
                       "doc_text": "title + brand, identical to the cross-encoder pair text",
                       "latency": "document token embeddings recomputed per query (cache disabled) so p50/p95 is the cold path"},
            "colpali_disclaimer": ("ColPali is the VISION variant of this technique and is NOT run here. No image "
                                   "model runs in this repository, no page is rasterised, and no number produced by "
                                   "this endpoint is a visual-retrieval result."),
            "caveats": [
                "bge-small token vectors were trained for mean-pooled sentence similarity, not for late interaction. "
                "A trained ColBERT checkpoint has [Q]/[D] marker tokens and a learned 128-d projection this does not. "
                "This measures the SHAPE of the technique on the existing encoder, not ColBERTv2's published quality.",
            ],
            "seconds": round(time.perf_counter() - t0, 2),
            "provenance": provenance("/eval/late_interaction", None, technique=9),
        }

    # ---------------- drift ----------------
    def encode_queries(self, name: str, texts: list[str]) -> np.ndarray:
        if name not in self._qemb:
            with self.lock:
                self._qemb[name] = self.e.encoder.encode([QUERY_PREFIX + t for t in texts], batch_size=256,
                                                         normalize_embeddings=True, show_progress_bar=False).astype(np.float32)
        return self._qemb[name]

    def seasonal_queries(self) -> list[str]:
        f = self.root / "seasonal_queries.parquet"
        if not f.exists():
            raw = pd.read_parquet(DATA / "raw" / "shopping_queries_dataset_examples.parquet",
                                  columns=["query", "query_id", "product_locale", "split"])
            raw = raw[raw.product_locale == "us"].drop_duplicates("query_id")
            known = set(self.e.queries["query"].str.lower())
            s = raw[raw["query"].str.contains(SEASONAL_RX, case=False, regex=True) & ~raw["query"].str.lower().isin(known)]
            s = s.drop_duplicates("query").sample(frac=1.0, random_state=7).head(1500)
            s[["query_id", "query", "split"]].to_parquet(f)
        return pd.read_parquet(f)["query"].tolist()

    def streams(self):
        q = self.e.queries
        ref = q[q.split == "dev"].sort_values("query_id")["query"].tolist()
        ind = q[q.split == "test"].sort_values("query_id")["query"].tolist()
        random.Random(13).shuffle(ind)  # query_id order is ~alphabetical; windows must be i.i.d. samples
        return ref, ind, self.seasonal_queries()

    @staticmethod
    def mmd_perm(X: np.ndarray, Y: np.ndarray, n_perm: int = 300, seed: int = 0) -> dict:
        Z = np.vstack([X, Y]).astype(np.float64)
        sq = (Z * Z).sum(1)
        D = np.maximum(sq[:, None] + sq[None, :] - 2 * Z @ Z.T, 0)
        med = float(np.median(D[np.triu_indices(len(Z), 1)]))
        K = np.exp(-D / med)
        n = len(X)

        def stat(ix, iy):
            return K[np.ix_(ix, ix)].mean() + K[np.ix_(iy, iy)].mean() - 2 * K[np.ix_(ix, iy)].mean()

        idx = np.arange(len(Z))
        obs = stat(idx[:n], idx[n:])
        rng = np.random.default_rng(seed)
        ge = 0
        for _ in range(n_perm):
            p = rng.permutation(len(Z))
            ge += bool(stat(p[:n], p[n:]) >= obs)
        return {"mmd2": round(float(obs), 5), "p_value": round((ge + 1) / (n_perm + 1), 4), "permutations": n_perm,
                "kernel": "rbf", "bandwidth_median_sq_dist": round(med, 4)}

    def _features(self, qemb: np.ndarray) -> np.ndarray:
        S = qemb @ self.e.emb.T
        top = -np.sort(-np.partition(S, -10, axis=1)[:, -10:], axis=1)
        return np.column_stack([np.ones(len(S)), top[:, 0], top[:, 0] - top[:, 9]])

    def calibration(self) -> dict:
        """Label-free estimator: regress per-query champion NDCG@10 on retrieval-confidence features (top-1 cosine,
        top1-top10 margin) using labelled dev queries; apply to unlabelled stream windows."""
        champ = self.reg.state["champion"]
        if self._calib is None or self._calib["champion"] != champ:
            pq = self.per_query(champ, "dev", 200)
            qtext = dict(zip(self.e.queries.query_id, self.e.queries["query"]))
            X = self._features(self.encode_queries(f"calib_dev_{len(pq['qids'])}", [qtext[q] for q in pq["qids"]]))
            coef, *_ = np.linalg.lstsq(X, pq["ndcg"], rcond=None)
            pred = X @ coef
            r = float(np.corrcoef(pred, pq["ndcg"])[0, 1])
            self._calib = {"champion": champ, "coef": coef, "measured_ndcg": float(pq["ndcg"].mean()),
                           "n": len(pq["qids"]), "pearson_r": round(r, 3)}
        return self._calib

    def zero_result_rate(self, texts: list[str]) -> float:
        with self.lock:
            return float(np.mean([self.e.bm25_scores(t).max() <= 0 for t in texts]))

    def drift(self, stream: str = "seasonal", window: int = 150, n_windows: int = 6, n_perm: int = 300) -> dict:
        t0 = time.perf_counter()
        ref, ind, sea = self.streams()
        R = self.encode_queries("reference_dev", ref)
        IND = self.encode_queries("in_distribution_test", ind)
        SEA = self.encode_queries("seasonal", sea)
        cal = self.calibration()
        ref_feat = self._features(R)
        ref_proxy = float(ref_feat[:, 1].mean())
        ref_est = float(np.clip(ref_feat @ cal["coef"], 0, 1).mean())
        ref_zero = self.zero_result_rate(ref)
        rng = np.random.default_rng(11)
        timeline = []
        for w in range(n_windows):
            if stream == "seasonal":
                frac = w / max(1, n_windows - 1)
                ns = int(round(frac * window))
                si = rng.choice(len(SEA), ns, replace=False)
                ii = rng.choice(len(IND), window - ns, replace=False)
                texts = [sea[i] for i in si] + [ind[i] for i in ii]
                Y = np.vstack([SEA[si], IND[ii]])
            else:
                frac = 0.0
                ii = np.arange(w * window, (w + 1) * window) % len(IND)
                texts = [ind[i] for i in ii]
                Y = IND[ii]
            test = self.mmd_perm(R, Y, n_perm=n_perm, seed=w)
            feat = self._features(Y)
            est = float(np.clip(feat @ cal["coef"], 0, 1).mean())
            timeline.append({"window": w, "seasonal_fraction": round(frac, 2), "n": len(texts), **test,
                             "alert": bool(test["p_value"] < 0.05),
                             "zero_result_rate": round(self.zero_result_rate(texts), 4),
                             "top1_cosine_mean": round(float(feat[:, 1].mean()), 4),
                             "est_ndcg10": round(est, 4),
                             "sample_queries": texts[-3:]})
        last = timeline[-1]
        return {
            "stream": stream, "window": window, "reference": {"source": "ESCI dev queries in catalog subset", "n": len(ref),
                     "zero_result_rate": round(ref_zero, 4), "top1_cosine_mean": round(ref_proxy, 4),
                     "est_ndcg10": round(ref_est, 4), "measured_ndcg10_dev200": round(cal["measured_ndcg"], 4)},
            "stream_source": ("real ESCI US queries matching seasonal keywords (back-to-school/holiday), not in reference or eval set"
                              if stream == "seasonal" else "ESCI test queries (same distribution as reference)"),
            "current": {"mmd2": last["mmd2"], "p_value": last["p_value"], "alert": last["alert"],
                        "zero_result_rate": last["zero_result_rate"], "est_ndcg10": last["est_ndcg10"],
                        "est_ndcg10_delta": round(last["est_ndcg10"] - ref_est, 4),
                        "top1_cosine_delta": round(last["top1_cosine_mean"] - ref_proxy, 4)},
            "performance_estimator": {"method": "linear regression of per-query NDCG@10 on top-1 cosine and top1-top10 margin, "
                                                "fit on labelled dev queries (label-free at inference)",
                                      "fit_n": cal["n"], "pearson_r": cal["pearson_r"], "champion": cal["champion"]},
            "timeline": timeline, "seconds": round(time.perf_counter() - t0, 2),
        }

    # ---------------- canary ----------------
    def _canary_step(self, c: dict, rng: random.Random):
        q = c["replay"][c["cursor"] % len(c["replay"])]
        c["cursor"] += 1
        arm = "canary" if rng.random() * 100 < c["traffic_pct"] else "champion"
        cfg = self.reg.get(c["version"] if arm == "canary" else c["champion"])["config"]
        with self.lock:
            order, _, ms = self.e.rank_cfg(q["query"], cfg, k=10)
        if arm == "canary" and self.injected_latency_ms > 0:
            time.sleep(self.injected_latency_ms / 1000)
            ms += self.injected_latency_ms
        ranked = [self.e.ids[i] for i in order]
        v = ndcg10(q["grades"], ranked)
        a = c["arms"][arm]
        a["n"] += 1
        a["lat"].append(ms)
        if v is not None:
            a["ndcg"].append(v)
            if arm == "canary":  # shadow-score the champion on the same query -> paired NDCG delta (low variance)
                with self.lock:
                    corder, _, _ = self.e.rank_cfg(q["query"], self.reg.get(c["champion"])["config"], k=10)
                cv = ndcg10(q["grades"], [self.e.ids[i] for i in corder])
                a["paired_delta"].append(v - cv)

    def canary_start(self, version: str, traffic_pct: float, background: bool = True, actor: str = "api") -> dict:
        self.canary_stop("superseded")
        rec = self.reg.get(version)
        qids, grades = self.e.eval_qids("test", 1000)
        qtext = dict(zip(self.e.queries.query_id, self.e.queries["query"]))
        replay = [{"qid": int(q), "query": qtext[q], "grades": grades[q]} for q in qids]
        random.Random(3).shuffle(replay)
        c = {"version": rec["version"], "champion": self.reg.state["champion"], "traffic_pct": float(traffic_pct),
             "status": "running", "started_at": now(), "actor": actor, "cursor": 0, "replay": replay,
             "arms": {k: {"n": 0, "lat": deque(maxlen=200), "ndcg": deque(maxlen=200), "paired_delta": deque(maxlen=200)} for k in ("champion", "canary")},
             "stop": threading.Event(), "thread": None, "ended_reason": None}
        self.canary = c
        if background:
            def loop():
                rng = random.Random(5)
                while not c["stop"].is_set():
                    self._canary_step(c, rng)
                    time.sleep(0.01)
            c["thread"] = threading.Thread(target=loop, daemon=True, name="canary-traffic")
            c["thread"].start()
        return self.canary_status()

    def canary_traffic(self, n: int) -> dict:
        if not self.canary or self.canary["status"] != "running":
            raise RuntimeError("no running canary")
        rng = random.Random(self.canary["cursor"] + 17)
        for _ in range(n):
            self._canary_step(self.canary, rng)
        return self.canary_status()

    def canary_stop(self, reason: str, status: str = "stopped"):
        c = self.canary
        if c and c["status"] == "running":
            c["stop"].set()
            if c["thread"]:
                c["thread"].join(timeout=5)
            c["status"], c["ended_reason"], c["ended_at"] = status, reason, now()

    def canary_status(self) -> dict:
        c = self.canary
        if not c:
            return {"status": "idle", "injected_latency_ms": self.injected_latency_ms}
        arms = {}
        for k, a in c["arms"].items():
            lat, nd = list(a["lat"]), list(a["ndcg"])
            arms[k] = {"version": c["version"] if k == "canary" else c["champion"], "requests": a["n"],
                       "p50_ms": round(float(np.percentile(lat, 50)), 1) if lat else None,
                       "p95_ms": round(float(np.percentile(lat, 95)), 1) if lat else None,
                       "ndcg10": round(float(np.mean(nd)), 4) if nd else None}
        reasons = []
        ca, ch = arms["canary"], arms["champion"]
        pd_ = list(c["arms"]["canary"]["paired_delta"])
        ca["paired_ndcg_delta"] = round(float(np.mean(pd_)), 4) if pd_ else None
        if ca["requests"] >= CANARY_MIN_SAMPLES:
            if ca["p95_ms"] > P95_MAX_MS and (ch["p95_ms"] is None or ca["p95_ms"] > CANARY_P95_REL * ch["p95_ms"]):
                reasons.append(f"canary p95 {ca['p95_ms']}ms > {P95_MAX_MS:.0f}ms and > {CANARY_P95_REL}x champion p95 {ch['p95_ms']}ms")
            if len(pd_) >= CANARY_MIN_SAMPLES and ca["paired_ndcg_delta"] < -CANARY_NDCG_DROP:
                reasons.append(f"canary paired NDCG@10 delta {ca['paired_ndcg_delta']} < -{CANARY_NDCG_DROP}")
        return {"status": c["status"], "version": c["version"], "champion": c["champion"], "traffic_pct": c["traffic_pct"],
                "started_at": c["started_at"], "ended_reason": c["ended_reason"], "arms": arms,
                "injected_latency_ms": self.injected_latency_ms,
                "guardrail": {"p95_ms_max": P95_MAX_MS, "p95_rel_to_champion": CANARY_P95_REL, "paired_ndcg_delta_min": -CANARY_NDCG_DROP, "min_samples": CANARY_MIN_SAMPLES,
                              "breached": bool(reasons), "reasons": reasons},
                "traffic": "simulated replay of real ESCI test queries (NDCG from ESCI labels)"}

    # ---------------- promote / rollback ----------------
    def promote(self, version: str, actor: str = "api", reason: str = "") -> dict:
        rec = self.reg.get(version)
        prev = self.reg.state["champion"]
        if rec["version"] == prev:
            return {"status": "noop", "champion": prev}
        if self.canary and self.canary["version"] == rec["version"]:
            self.canary_stop("promoted", status="promoted")
        self.reg.set_alias("champion", rec["version"], actor=actor, reason=reason or "promote")
        if prev:
            self.reg.state["versions"][prev]["status"] = "retired"
        if self.reg.state["candidate"] == rec["version"]:
            self.reg.state["candidate"] = None
        self.reg._save()
        return {"status": "promoted", "champion": rec["version"], "previous_champion": prev}

    def rollback(self, version: str | None = None, reason: str = "", actor: str = "api") -> dict:
        c = self.canary
        if c and c["status"] == "running" and (version in (None, c["version"])):
            self.canary_stop(reason or "rollback", status="rolled_back")
            self.reg.state["versions"][c["version"]]["status"] = "rolled_back"
            if self.reg.state["candidate"] == c["version"]:
                self.reg.state["candidate"] = None
            self.reg.state["history"].append({"ts": now(), "alias": "canary", "from": c["version"], "to": None,
                                              "actor": actor, "reason": reason})
            self.reg._save()
            return {"status": "rolled_back", "scope": "canary", "version": c["version"], "champion": self.reg.state["champion"],
                    "reason": reason}
        champ = self.reg.state["champion"]
        if version not in (None, champ):
            return {"status": "noop", "detail": f"{version} is neither the running canary nor the champion"}
        prev = next((h["from"] for h in reversed(self.reg.state["history"]) if h["alias"] == "champion" and h["to"] == champ and h["from"]), None)
        if not prev:
            return {"status": "noop", "detail": "no previous champion to roll back to"}
        self.reg.set_alias("champion", prev, actor=actor, reason=reason or "rollback")
        self.reg.state["versions"][champ]["status"] = "rolled_back"
        self.reg._save()
        return {"status": "rolled_back", "scope": "champion", "version": champ, "champion": prev, "reason": reason}
