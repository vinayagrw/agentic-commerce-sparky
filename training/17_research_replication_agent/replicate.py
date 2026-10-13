#!/usr/bin/env python3
"""Technique 17 - research replication agent (SOTA playbook §17).

Drives a coding agent inside a budgeted, network-isolated sandbox to rebuild a paper's method
on PUBLIC data, then collects the artefacts and a rubric self-assessment for a HUMAN grader.
The output is a scaffold plus a score, never a verdict on whether the paper replicates.

What this script actually does on a GPU/sandbox target:
  1. validates task_spec.yaml (rubric weights, budget caps, forbidden list)
  2. materialises the sandbox workspace and the deliverable skeleton
  3. invokes the agent backend (`claude` CLI, or `openhands`, or a dry-run backend) with the
     spec as its brief and a hard wall-clock/spend cap
  4. checks every required deliverable exists, records a reproduction log
  5. runs the rubric grader over the artefacts and writes rubric_self_assessment.json
  6. applies the decision thresholds and prints discard / handoff

Why it is not run on this laptop: §17 budgets an L4 GPU for 8 h inside a T1 sandbox with
egress control. A MacBook has neither the GPU nor the isolation, and running an unbounded
agent outside the sandbox is exactly the §17 anti-pattern.

  python replicate.py --smoke
  python replicate.py --spec task_spec.yaml --backend claude --workspace /sandbox/repl
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import esci  # noqa: E402

HERE = Path(__file__).resolve().parent
TECHNIQUE = "17 research replication agent"
DEFAULT_SPEC = HERE / "task_spec.yaml"


def build_args() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--smoke", action="store_true")
    p.add_argument("--spec", default=str(DEFAULT_SPEC))
    p.add_argument("--workspace", default="out/replication")
    p.add_argument("--backend", default="claude", choices=["claude", "openhands", "dry-run"])
    p.add_argument("--allow-network", action="store_true",
                   help="NOT permitted for T1; present only so that the refusal is explicit")
    p.add_argument("--seed", type=int, default=20260915)
    return p


def load_spec(path: str | Path) -> dict:
    import yaml

    spec = yaml.safe_load(Path(path).read_text())
    if not isinstance(spec, dict):
        raise ValueError("spec is not a mapping")
    return spec


def validate_spec(spec: dict) -> dict:
    """Structural validation. Returns a findings dict; raises on a hard violation."""
    problems: list[str] = []
    required = ["task_id", "paper", "scope", "data", "autonomy_tier", "budget",
                "deliverables", "forbidden", "rubric", "grading", "decision_thresholds"]
    for k in required:
        if k not in spec:
            problems.append(f"missing top-level key {k!r}")

    weights = [float(n.get("weight", 0)) for n in spec.get("rubric", [])]
    total = round(sum(weights), 6)
    if abs(total - 1.0) > 1e-6:
        problems.append(f"rubric weights sum to {total}, expected 1.0")

    if spec.get("data") != "public_only":
        problems.append(f"data must be 'public_only' for T1, got {spec.get('data')!r}")
    if spec.get("autonomy_tier") != "T1":
        problems.append(f"autonomy_tier must be T1, got {spec.get('autonomy_tier')!r}")

    b = spec.get("budget", {})
    for k in ("usd_hard_cap", "wall_clock_h"):
        if not isinstance(b.get(k), (int, float)) or b[k] <= 0:
            problems.append(f"budget.{k} must be a positive number")

    leaves = [c for n in spec.get("rubric", []) for c in n.get("children", [])]
    if len(leaves) != len(set(leaves)):
        problems.append("duplicate rubric leaf ids")

    th = spec.get("decision_thresholds", {})
    if th.get("discard_lt", 0) > th.get("engineer_handoff_gte", 1):
        problems.append("discard_lt must be <= engineer_handoff_gte")

    if problems:
        raise ValueError("spec invalid: " + "; ".join(problems))

    return {
        "task_id": spec["task_id"],
        "paper": spec["paper"]["title"],
        "rubric_nodes": len(spec["rubric"]),
        "rubric_leaves": len(leaves),
        "rubric_weight_total": total,
        "deliverables": spec["deliverables"],
        "forbidden_rules": len(spec["forbidden"]),
        "budget": b,
        "thresholds": th,
    }


def sandbox_policy(a: argparse.Namespace, spec: dict) -> dict:
    """§17 AC3 / US-13.2-style isolation. Refuses the unsafe combination outright."""
    if a.allow_network and spec.get("autonomy_tier") == "T1":
        raise SystemExit(
            "refusing: --allow-network is incompatible with autonomy_tier T1. The agent gets a "
            "package mirror only (playbook §17: 'internet beyond the package mirror' is forbidden)."
        )
    return {
        "autonomy_tier": spec["autonomy_tier"],
        "egress": "package mirror only",
        "data_mounts": "public BEIR subset (read-only)",
        "proprietary_data_mounts": "none",
        "wall_clock_cap_h": spec["budget"]["wall_clock_h"],
        "usd_hard_cap": spec["budget"]["usd_hard_cap"],
        "gpu": spec["budget"].get("gpu"),
    }


def agent_brief(spec: dict) -> str:
    return "\n".join([
        f"# Replication task {spec['task_id']}",
        f"Paper: {spec['paper']['title']} ({spec['paper'].get('url','')})",
        "",
        "## Scope", spec["scope"], "",
        "## Deliverables (all required, at the workspace root)",
        *[f"- {d}" for d in spec["deliverables"]], "",
        "## Forbidden",
        *[f"- {f}" for f in spec["forbidden"]], "",
        "## You will be graded on",
        *[f"- {n['node']} (weight {n['weight']}): " + ", ".join(n["children"]) for n in spec["rubric"]],
        "",
        "Every number you put in results.json MUST be produced by a command written in "
        "README_repro.md. Record anything you could not reproduce in deviations.md. Do not "
        "claim the paper replicates; that judgement belongs to the human grader.",
    ])


def score_rubric(workspace: Path, spec: dict) -> dict:
    """Deterministic, evidence-based leaf checks over what the agent actually produced.

    Only leaves that can be checked mechanically (deliverable present, README commands exist,
    seeds logged) are auto-scored. Every other leaf is left `null` for the human grader - the
    script never invents a pass.
    """
    results: dict[str, dict] = {}
    for node in spec["rubric"]:
        leaves: dict[str, object] = {}
        for leaf in node["children"]:
            leaves[leaf] = None  # unknown until a human or the calibrated judge scores it
        results[node["node"]] = {"weight": node["weight"], "leaves": leaves}

    ex = results.get("execution", {}).get("leaves", {})
    if "runs_end_to_end_from_readme" in ex:
        rd = workspace / "README_repro.md"
        ex["runs_end_to_end_from_readme"] = bool(rd.exists() and "```" in rd.read_text(errors="ignore"))
    if "env_reproducible" in ex:
        ex["env_reproducible"] = (workspace / "env.lock").exists()
    if "seeds_logged" in ex:
        log = workspace / "results.json"
        ex["seeds_logged"] = bool(log.exists() and "seed" in log.read_text(errors="ignore").lower())

    auto = [v for n in results.values() for v in n["leaves"].values() if v is not None]
    return {
        "rubric": results,
        "auto_scored_leaves": len(auto),
        "human_pending_leaves": sum(1 for n in results.values() for v in n["leaves"].values() if v is None),
        "aggregate_score": None,
        "aggregate_score_note": (
            "null until the human grader and the calibrated judge score the remaining leaves "
            "(playbook §17 AC2, kappa_min "
            f"{spec['grading']['kappa_min']}). An agent self-score is advisory only."
        ),
    }


def run_agent(a: argparse.Namespace, spec: dict, workspace: Path) -> dict:
    brief = workspace / "BRIEF.md"
    brief.write_text(agent_brief(spec))
    cap_s = int(float(spec["budget"]["wall_clock_h"]) * 3600)

    if a.backend == "dry-run":
        return {"backend": "dry-run", "invoked": False,
                "note": "no agent was run; deliverable checks below reflect the empty workspace"}

    if a.backend == "claude":
        exe = shutil.which("claude")
        if not exe:
            raise SystemExit("backend 'claude' selected but the `claude` CLI is not on PATH")
        cmd = [exe, "-p", brief.read_text(), "--permission-mode", "acceptEdits"]
    else:
        exe = shutil.which("openhands")
        if not exe:
            raise SystemExit("backend 'openhands' selected but `openhands` is not on PATH")
        cmd = [exe, "--task-file", str(brief), "--max-iterations", "200"]

    env = {**os.environ, "HTTP_PROXY": os.environ.get("PACKAGE_MIRROR_PROXY", ""),
           "HTTPS_PROXY": os.environ.get("PACKAGE_MIRROR_PROXY", "")}
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=workspace, env=env, timeout=cap_s,
                          capture_output=True, text=True)
    (workspace / "agent_stdout.log").write_text(proc.stdout)
    (workspace / "agent_stderr.log").write_text(proc.stderr)
    return {"backend": a.backend, "invoked": True, "returncode": proc.returncode,
            "wall_clock_s": round(time.time() - t0, 1), "cap_s": cap_s}


def smoke(a: argparse.Namespace) -> int:
    spec = load_spec(a.spec)
    summary = validate_spec(spec)
    policy = sandbox_policy(a, spec)
    brief = agent_brief(spec)

    # Exercise the grader against a temporary empty workspace: it must auto-score the
    # mechanical leaves as False and leave everything else for the human.
    tmp = Path(a.workspace).resolve() / "_smoke"
    tmp.mkdir(parents=True, exist_ok=True)
    graded = score_rubric(tmp, spec)
    shutil.rmtree(tmp, ignore_errors=True)

    backends = {b: (shutil.which(b) or "not on PATH") for b in ("claude", "openhands")}

    return esci.smoke_report(
        f"{TECHNIQUE} - {summary['task_id']}",
        {
            "spec": json.dumps(summary, indent=2),
            "sandbox_policy": policy,
            "agent_brief": {"chars": len(brief), "lines": brief.count("\n") + 1,
                            "first_line": brief.splitlines()[0]},
            "grader_dry_run_on_empty_workspace": json.dumps(graded, indent=2),
            "backends_available_here": backends,
            "honesty_contract": {
                "agent_self_score": "advisory only",
                "aggregate_score_without_human": None,
                "published_claim": "scaffold quality score, never 'the paper replicates'",
                "baseline_cited": ("PaperBench, Starace et al., ICML 2025, arXiv 2504.01848: "
                                   "best agent 21.0% replication score, below the ML PhD baseline"),
            },
            "heavy_deps": esci.optional_imports(["yaml", "datasets", "torch"]),
            "verdict": "spec valid, rubric weights sum to 1.0, T1 policy enforced, grader leaves human leaves null",
        },
    )


def run(a: argparse.Namespace) -> int:
    spec = load_spec(a.spec)
    summary = validate_spec(spec)
    policy = sandbox_policy(a, spec)
    workspace = Path(a.workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "src").mkdir(exist_ok=True)

    print(json.dumps({"task": summary, "policy": policy}, indent=2))
    run_info = run_agent(a, spec, workspace)

    missing = [d for d in spec["deliverables"] if not (workspace / d.rstrip("/")).exists()]
    graded = score_rubric(workspace, spec)
    out = {
        "task_id": spec["task_id"],
        "run": run_info,
        "deliverables_missing": missing,
        "grading": graded,
        "decision": ("BLOCKED - deliverables missing, not gradeable" if missing
                     else "AWAITING HUMAN GRADER - thresholds "
                          f"{spec['decision_thresholds']} apply to the human-completed score"),
    }
    (workspace / "rubric_self_assessment.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))
    print(f"\nArtefacts in {workspace}. Log them to MLflow (§17 AC1) and hand to the research "
          f"owner. Do NOT report this as a replication result.")
    return 0


def main() -> int:
    a = build_args().parse_args()
    return smoke(a) if a.smoke else run(a)


if __name__ == "__main__":
    raise SystemExit(main())
