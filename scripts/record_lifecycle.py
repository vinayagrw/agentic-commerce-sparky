#!/usr/bin/env python3
"""Record the lifecycle numbers the presenter quotes, from the LIVE services, into data/lifecycle_measured.json.

Before this script the README quoted a drift p-value and a reranker-off gate delta from one live run that
no artefact kept, so the coverage board could not show them and nothing checked the README against them.
This makes them regenerable: build_coverage.py reads this file, and scripts/check_numbers.py fails if the
README or the web app quote a different value.

Measures, against search-svc (:8801):
  - drift: POST /drift, the seasonal stream, the same window/n_windows the ops drift agent uses;
  - gate:  POST /eval/compare, the current champion vs the registry's reranker-off version (the demo's
           "worse candidate"), paired bootstrap CI. Uses explicit version ids, so no alias is moved.

Usage (from services/ops-mcp, whose venv has httpx):
    uv run python ../../scripts/record_lifecycle.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "lifecycle_measured.json"
SVC = os.environ.get("SEARCH_SVC_URL", "http://127.0.0.1:8801").rstrip("/")


def call(method: str, path: str, body: dict | None = None) -> dict:
    r = httpx.request(method, SVC + path, json=body, timeout=900)
    r.raise_for_status()
    return r.json()


def main() -> int:
    try:
        reg = call("GET", "/models")
    except httpx.HTTPError as e:
        print(f"search-svc unreachable at {SVC}: {e!r}. Run `make dev`. Nothing written.", file=sys.stderr)
        return 1
    champion = reg["champion"]
    worse = [v for v in reg["versions"] if v["config"].get("reranker") is False and "reranker off" in (v.get("note") or "")]
    if not worse:
        print("no reranker-off version in the registry; nothing written", file=sys.stderr)
        return 1
    worse_v = worse[0]["version"]

    t0 = time.time()
    drift = call("POST", "/drift", {"stream": "seasonal", "window": 150, "n_windows": 6})
    t_drift = round(time.time() - t0, 1)
    t0 = time.time()
    cmp = call("POST", "/eval/compare", {"champion": champion, "candidate": worse_v, "split": "test", "n_queries": 200})
    t_cmp = round(time.time() - t0, 1)

    cur, ref = drift["current"], drift.get("reference", {})
    nd = cmp["metrics"]["ndcg10"]
    doc = {
        "generated_by": "scripts/record_lifecycle.py",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "search_svc": SVC,
        "drift": {
            "endpoint": "POST /drift",
            "stream": "seasonal", "window": 150, "n_windows": 6,
            "mmd2": cur.get("mmd2"), "p_value": cur.get("p_value"), "alert": cur.get("alert"),
            "n_perm": drift.get("n_perm") or 300,
            "window_size": drift.get("window"),
            "est_ndcg10_now": cur.get("est_ndcg10"),
            "est_ndcg10_reference": ref.get("est_ndcg10") if isinstance(ref, dict) else None,
            "caveat": "The seasonal stream is a constructed query set, not observed production traffic.",
            "seconds": t_drift,
        },
        "reranker_off_gate": {
            "endpoint": "POST /eval/compare",
            "champion": cmp["champion"], "candidate": cmp["candidate"],
            "candidate_note": worse[0].get("note"),
            "n_queries": cmp["n_queries"],
            "ndcg10_champion": nd["champion"], "ndcg10_candidate": nd["candidate"],
            "delta": nd["delta"]["mean"], "ci95": nd["delta"]["ci95"],
            "gate_passed": cmp["gate"]["passed"], "checks": cmp["gate"]["checks"],
            "thresholds": cmp["gate"]["thresholds"],
            "method": cmp["method"],
            "seconds": t_cmp,
        },
    }
    OUT.write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({"drift_p": doc["drift"]["p_value"], "alert": doc["drift"]["alert"],
                      "gate": {k: doc["reranker_off_gate"][k] for k in ("champion", "candidate", "delta", "ci95", "gate_passed")}}))
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
