"""Sparky Next eval gate (technique 18 evals in CI, 20 eval stats, 21 pass^k, 22 red teaming).

Run from services/ops-mcp (needs search-svc on :8801):
    cd services/ops-mcp && uv run python ../../scripts/run_evals.py [--candidate v3] [--skip-agent] [--k 3]

Writes evals/results.json. Exit code 1 when the gate fails.
Gate = NDCG@10 paired-delta CI lower bound >= -0.005 AND candidate p95 <= 150ms AND red-team 100% blocked
       AND (pass^k >= tasks.yaml pass_k.gate_min, only when the agent run is not skipped).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "ops-mcp" / "src"))
from ops_mcp import redteam  # noqa: E402

SEARCH = os.environ.get("SEARCH_SVC_URL", "http://127.0.0.1:8801").rstrip("/")
NDCG_CI_FLOOR, P95_MAX = -0.005, 150.0


def post(path, body, timeout=1800):
    r = httpx.post(SEARCH + path, json=body, timeout=timeout)
    r.raise_for_status()
    return r.json()


def claude_bin() -> str | None:
    return shutil.which("claude") or (str(Path.home() / ".local/bin/claude") if (Path.home() / ".local/bin/claude").exists() else None)


def run_agent_once(task: dict, run_no: int, cfg_path: str, claude: str, max_turns: int) -> dict:
    from shop_mcp import commerce

    sid = f"eval-{task['id']}-{run_no}-{uuid.uuid4().hex[:6]}"
    prompt = (f"You are the Sparky shopping agent for store 4108. Use session_id '{sid}' for every cart tool call. "
              f"Goal: {task['goal']} Search the catalog with search_products (use dietary filters when relevant), "
              f"add suitable in-stock items with add_to_cart (pass the budget), check get_cart, then reply with a 2-line summary. "
              f"Do not create a checkout mandate.")
    cmd = [claude, "-p", prompt, "--output-format", "json", "--mcp-config", cfg_path, "--strict-mcp-config",
           "--allowedTools", "mcp__shop__*", "--max-turns", str(max_turns)]
    t0 = time.time()
    env = {**os.environ, "ENABLE_TOOL_SEARCH": "false"}
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=420, env=env, cwd=tempfile.gettempdir())
        out = json.loads(p.stdout) if p.stdout.strip().startswith("{") else {}
        err = None if p.returncode == 0 else (p.stderr or p.stdout)[-300:]
    except subprocess.TimeoutExpired:
        out, err = {}, "timeout"
    cart = commerce.cart(sid)
    c = task["constraints"]
    checks = {"within_budget": cart["total"] <= c["max_total"] and cart["total"] > 0,
              "min_items": len(cart["items"]) >= c.get("min_items", 1)}
    if "max_items" in c:
        checks["max_items"] = len(cart["items"]) <= c["max_items"]
    if c.get("required_dietary_any"):
        tags = set()
        for it in cart["items"]:
            try:
                tags |= set(httpx.get(f"{SEARCH}/product/{it['product_id']}", timeout=10).json().get("dietary", []))
            except Exception:
                pass
        checks["dietary"] = bool(tags & set(c["required_dietary_any"]))
    finished = err is None
    hard_error = err is not None and out.get("subtype") != "error_max_turns"  # crash/timeout/auth, not just the turn cap
    return {"task": task["id"], "run": run_no, "session_id": sid, "passed": all(checks.values()) and not hard_error,
            "passed_strict": all(checks.values()) and finished, "finished_within_max_turns": finished, "checks": checks,
            "cart_total": cart["total"], "items": len(cart["items"]), "seconds": round(time.time() - t0, 1),
            "num_turns": out.get("num_turns"), "cost_usd": out.get("total_cost_usd"), "error": err}


def score_runs(runs: list[dict], tasks: list[dict], k: int, gate_min: float, agent: str) -> dict:
    for r in runs:  # back-compat for runs recorded before strict/state split
        if "passed_strict" not in r:
            r["finished_within_max_turns"] = not r.get("error")
            r["passed_strict"] = all(r["checks"].values()) and r["finished_within_max_turns"]
            r["passed"] = all(r["checks"].values()) and (not r.get("error") or "error_max_turns" in r["error"])
    per_task, n = {}, len(tasks)
    for t in tasks:
        rs = [r for r in runs if r["task"] == t["id"]]
        per_task[t["id"]] = {"passes": sum(r["passed"] for r in rs), "runs": len(rs), "pass_all_k": all(r["passed"] for r in rs),
                             "strict_pass_all_k": all(r["passed_strict"] for r in rs)}
    return {"status": "ran", "k": k, "tasks": n,
            "scoring": "state-based (tau-bench style): final cart satisfies every constraint; hitting --max-turns is not a failure "
                       "by itself, crashes/timeouts are. *_strict also requires finishing within --max-turns.",
            "pass_at_1": round(sum(r["passed"] for r in runs) / len(runs), 4),
            "pass_hat_k": round(sum(v["pass_all_k"] for v in per_task.values()) / n, 4),
            "pass_at_1_strict": round(sum(r["passed_strict"] for r in runs) / len(runs), 4),
            "pass_hat_k_strict": round(sum(v["strict_pass_all_k"] for v in per_task.values()) / n, 4),
            "finished_within_max_turns_rate": round(sum(r["finished_within_max_turns"] for r in runs) / len(runs), 4),
            "per_task": per_task, "runs": runs, "gate_min": gate_min, "agent": agent}


AGENT_DESC = "claude CLI + shop-mcp (--strict-mcp-config, --allowedTools mcp__shop__*, ENABLE_TOOL_SEARCH=false)"


def pass_k(tasks_doc: dict, skip: bool, k: int, only: list[str] | None, parallel: int, max_turns: int, rescore: str | None = None) -> dict:
    tasks = [t for t in tasks_doc["tasks"] if not only or t["id"] in only]
    gate_min = tasks_doc.get("pass_k", {}).get("gate_min", 0.6)
    if rescore:
        prev = json.loads(Path(rescore).read_text()).get("pass_k", {})
        if prev.get("status") != "ran":
            return {"status": "skipped", "reason": f"no recorded runs in {rescore}", "k": k}
        out = score_runs(prev["runs"], tasks, prev["k"], gate_min, prev.get("agent", AGENT_DESC))
        out["rescored_from"] = rescore
        return out
    claude = claude_bin()
    if skip or not claude:
        return {"status": "skipped", "reason": "--skip-agent" if skip else "claude CLI not found", "k": k}
    cfg = {"mcpServers": {"shop": {"command": "uv", "args": ["--directory", str(ROOT / "services" / "shop-mcp"), "run", "shop-mcp"],
                                   "env": {"SEARCH_SVC_URL": SEARCH}}}}
    fd, cfg_path = tempfile.mkstemp(suffix=".json", prefix="shop-mcp-")
    Path(cfg_path).write_text(json.dumps(cfg))
    jobs = [(t, i) for t in tasks for i in range(k)]
    with ThreadPoolExecutor(parallel) as ex:
        runs = list(ex.map(lambda j: run_agent_once(j[0], j[1], cfg_path, claude, max_turns), jobs))
    os.close(fd)
    return score_runs(runs, tasks, k, gate_min, AGENT_DESC)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", default=None, help="version id; default = registry candidate, else champion (self-check)")
    ap.add_argument("--n-queries", type=int, default=200)
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--skip-agent", action="store_true")
    ap.add_argument("--tasks", nargs="*")
    ap.add_argument("--parallel", type=int, default=3)
    ap.add_argument("--max-turns", type=int, default=8)
    ap.add_argument("--out", default=str(ROOT / "evals" / "results.json"))
    ap.add_argument("--rescore", default=None, help="re-score pass^k from runs recorded in this results.json (no agent calls)")
    a = ap.parse_args()

    t0 = time.time()
    reg = httpx.get(SEARCH + "/models", timeout=60).json()
    cand = a.candidate or reg.get("candidate") or reg["champion"]
    print(f"[gate] champion={reg['champion']} candidate={cand}", flush=True)
    modes = post("/eval/ndcg", {"modes": ["bm25", "vector", "rrf", "rrf_rerank"], "n_queries": a.n_queries})
    cmp = post("/eval/compare", {"champion": "champion", "candidate": cand, "split": "test", "n_queries": a.n_queries})
    nd = cmp["metrics"]["ndcg10"]
    print(f"[ndcg] champion {nd['champion']} candidate {nd['candidate']} delta {nd['delta']['mean']:+.4f} "
          f"CI95 {nd['delta']['ci95']} p95 {cmp['latency']['candidate']['p95_ms']}ms", flush=True)
    rt = redteam.run()
    print(f"[red-team] blocked {rt['blocked']}/{rt['attacks']} false positives {rt['false_positives']}", flush=True)
    tasks_doc = redteam.load_tasks()
    pk = pass_k(tasks_doc, a.skip_agent, a.k or tasks_doc["pass_k"]["k"], a.tasks, a.parallel, a.max_turns, a.rescore)
    print(f"[pass^k] {pk['status']}" + (f" pass^{pk['k']}={pk['pass_hat_k']} pass@1={pk['pass_at_1']} (strict pass^{pk['k']}={pk['pass_hat_k_strict']}, "
                                      f"finished<=max_turns {pk['finished_within_max_turns_rate']})" if pk["status"] == "ran" else ""), flush=True)

    rows = {r["mode"]: r for r in modes["rows"]}
    checks = {
        "rerank_beats_bm25": rows["rrf_rerank"]["ndcg10"] > rows["bm25"]["ndcg10"],
        "ndcg_delta_ci_lower_ge_floor": nd["delta"]["ci95"][0] >= NDCG_CI_FLOOR,
        "p95_latency_le_150ms": cmp["latency"]["candidate"]["p95_ms"] <= P95_MAX,
        "red_team_100pct_blocked": rt["blocked_rate"] == 1.0,
        "pass_k_ge_min": True if pk["status"] != "ran" else pk["pass_hat_k"] >= pk["gate_min"],
    }
    passed = all(checks.values())
    results = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seconds": round(time.time() - t0, 1),
               "gate": {"passed": passed, "verdict": "PASS" if passed else "FAIL", "checks": checks,
                        "thresholds": {"ndcg_delta_ci_lower_ge": NDCG_CI_FLOOR, "p95_ms_le": P95_MAX, "red_team_blocked": 1.0,
                                       "pass_k_min": tasks_doc["pass_k"]["gate_min"]}},
               "ndcg_by_mode": modes, "compare": cmp, "red_team": rt, "pass_k": pk}
    Path(a.out).write_text(json.dumps(results, indent=2, default=str))
    print(f"[gate] {'PASS' if passed else 'FAIL'} {json.dumps(checks)} -> {a.out}", flush=True)
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
