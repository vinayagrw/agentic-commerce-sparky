"""Data-generation / data-selection agent: runs the scripts behind playbook techniques 2, 3 and 6 and reads back
their measured reports.

Each script writes a JSON report under data/ that records its own inputs, seeds and timestamp. These helpers either
re-run the script (refresh=True) or return the report the last real run produced, always labelled with the run's own
`generated_at` so nothing is ever presented as fresher than it is. Nothing here fabricates a number: when a report
is missing, the caller gets `status: not_run` plus the exact command to produce it.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from .db import DATA, ROOT

SCRIPTS = ROOT / "scripts"
SEARCH_SVC_PY = ROOT / "services" / "search-svc" / ".venv" / "bin" / "python"


def _interpreter(needs_search_svc: bool) -> str:
    """select_data needs faiss/bm25s/sentence-transformers, which live in the search-svc venv."""
    if needs_search_svc and SEARCH_SVC_PY.exists():
        return str(SEARCH_SVC_PY)
    return sys.executable


def run_script(name: str, args: list[str], needs_search_svc: bool = False, timeout: int = 3600) -> dict:
    cmd = [_interpreter(needs_search_svc), str(SCRIPTS / name), *args]
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                       cwd=str(ROOT), env={**os.environ, "KMP_DUPLICATE_LIB_OK": "TRUE"})
    return {"returncode": p.returncode, "seconds": round(time.time() - t0, 1),
            "command": " ".join(cmd[1:]), "stdout_tail": (p.stdout or "")[-1200:],
            "stderr_tail": (p.stderr or "")[-600:] if p.returncode else None}


def report(path: Path, script: str, example_args: str) -> dict:
    if not path.exists():
        return {"status": "not_run",
                "hint": f"no report at {path.relative_to(ROOT)}; produce it with: python scripts/{script} {example_args}"}
    try:
        d = json.loads(path.read_text())
    except Exception as e:
        return {"status": "unreadable", "error": str(e), "path": str(path.relative_to(ROOT))}
    d["status"] = "ok"
    d["report_file"] = str(path.relative_to(ROOT))
    d["report_mtime"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(path.stat().st_mtime))
    return d


def _maybe_run(path: Path, script: str, args: list[str], refresh: bool, needs_search_svc: bool, timeout: int) -> dict | None:
    if not refresh and path.exists():
        return None
    r = run_script(script, args, needs_search_svc, timeout)
    if r["returncode"] != 0:
        return {"status": "run_failed", "run": r}
    return {"run": r}


# ---------------------------------------------------------------- technique 2
SYNTH = DATA / "synth_attributes.json"


def synth_attributes(sample: int = 25, max_attempts: int = 3, refresh: bool = False) -> dict:
    failed = _maybe_run(SYNTH, "synth_attributes.py", ["--sample", str(sample), "--max-attempts", str(max_attempts)],
                        refresh, False, timeout=2400)
    if failed and failed.get("status") == "run_failed":
        return failed
    d = report(SYNTH, "synth_attributes.py", "--sample 25")
    if failed:
        d["run"] = failed["run"]
    d.pop("items", None)                  # per-product detail stays in the file; the tool returns the summary
    return d


# ---------------------------------------------------------------- technique 3
DP = DATA / "dp_query_logs.json"


def dp_query_logs(epsilon: float = 1.0, delta: float = 1e-6, sample: int = 0, refresh: bool = False) -> dict:
    args = ["--epsilon", str(epsilon), "--delta", str(delta)] + (["--sample", str(sample)] if sample else [])
    failed = _maybe_run(DP, "dp_query_logs.py", args, refresh, False, timeout=600)
    if failed and failed.get("status") == "run_failed":
        return failed
    d = report(DP, "dp_query_logs.py", "--epsilon 1.0")
    if failed:
        d["run"] = failed["run"]
    if d.get("status") == "ok":
        d["utility_curve_csv"] = "data/dp_utility_curve.csv"
        log = d.get("released_log", {})
        d["released_log"] = {**log, "sample": log.get("sample", [])[:8]}
    return d


# ---------------------------------------------------------------- technique 6
SELECT = DATA / "selection_report.json"


def select_data(keep_frac: float = 0.4, n_queries: int = 200, sample: int = 0, refresh: bool = False) -> dict:
    args = ["--keep-frac", str(keep_frac), "--n-queries", str(n_queries)] + (["--sample", str(sample)] if sample else [])
    failed = _maybe_run(SELECT, "select_data.py", args, refresh, True, timeout=5400)
    if failed and failed.get("status") == "run_failed":
        return failed
    d = report(SELECT, "select_data.py", "--keep-frac 0.4")
    if failed:
        d["run"] = failed["run"]
    return d
