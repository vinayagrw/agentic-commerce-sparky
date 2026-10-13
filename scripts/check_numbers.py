#!/usr/bin/env python3
"""B02: fail if the README or the app quotes a number that data/coverage.json does not say.

Two checks, both against the generated board (run build_coverage.py first):

1. README anchors. Every place the README quotes one of the presenter numbers is found by a pattern, and
   the quoted figure must equal the board's value at the precision the README wrote it. A pattern that
   matches nothing also fails: it means the README moved and the check would silently stop checking.

2. No duplicated literals in code. A numeric literal in web/src or bff/src (tests excluded) that equals a
   board measurement with 3+ significant decimals is a hand-typed copy and fails. So do the specific
   figures the review found typed into the UI ($45.00, $5.66, 97.4 ms, +900 ms, 350 ms, -30%).

Exit 0 = consistent, 1 = at least one mismatch (each printed).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOARD = ROOT / "data" / "coverage.json"
README = ROOT / "README.md"
CODE_DIRS = [ROOT / "web" / "src", ROOT / "bff" / "src"]
MINUS = "−"
NUM = r"([−-]?\d+(?:\.\d+)?)"


def fnum(s: str) -> float:
    return float(s.replace(MINUS, "-"))


def decimals(s: str) -> int:
    return len(s.split(".")[1]) if "." in s else 0


def same(written: str, value) -> bool:
    if value is None:
        return False
    return round(fnum(written), decimals(written)) == round(float(value), decimals(written))


def meas(board: dict, tid: int, pattern: str) -> dict:
    t = next(t for t in board["techniques"] if t["id"] == tid)
    return next(m for m in t["measurements"] if re.search(pattern, m["label"], re.I))


def anchors(board: dict) -> list[tuple[str, str, list]]:
    """(description, regex with capture groups, expected values per group)."""
    lc = board["lifecycle"]
    dr, g = lc["drift"], lc["reranker_off_gate"]
    k29 = meas(board, 29, r"kappa")
    asr = meas(board, 22, r"attack success")
    spike = next(e for e in board["evidence"] if e["key"] == "spike-llm-judge")
    sk = next(m for m in spike["measurements"] if m["label"].endswith("Cohen's kappa") and "itself" not in m["label"])
    irr = next(m for m in spike["measurements"] if "Irrelevant" in m["label"])
    out = [
        ("drift p-value", r"MMD[^\n|]{0,40}?p ?= ?\**" + NUM, [dr["p_value"]]),
        ("reranker-off delta + CI", r"[Rr]eranker[- ]off[^\n]{0,80}?Δ ?" + NUM + r",? CI(?:95)? \[" + NUM + r", " + NUM + r"\]",
         [g["delta"], g["ci95"][0], g["ci95"][1]]),
        ("lexical judge kappa", r"lexical[^\n]{0,80}?κ ?=? ?\**" + NUM, [k29["value"]]),
        ("adaptive ASR (technique 22 run)", r"ASR \**" + NUM + r"\** \(n=(\d+)\)", [asr["value"], asr["n"]]),
        ("spike LLM judge kappa + CI", r"κ \**" + NUM + r"\**, 95% cluster-bootstrap CI \**\[" + NUM + r", " + NUM + r"\]",
         [sk["value"], sk["ci95"][0], sk["ci95"][1]]),
        ("spike Irrelevant recall", r"Irrelevant pairs of only \**" + NUM, [irr["value"]]),
    ]
    bg = board.get("bypass_gate", {})
    if bg.get("status") == "real-measured":
        fr = bg["after"]["findings_replay"]
        out.append(("bypass replay after the detector change", r"(\d+) of (\d+) recorded bypasses still get through", [fr["bypassing"], fr["n"]]))
    return out


def check_readme(board: dict) -> list[str]:
    text = README.read_text()
    fails = []
    for desc, rx, expected in anchors(board):
        hits = list(re.finditer(rx, text))
        if not hits:
            fails.append(f"README: no quote of '{desc}' found (pattern {rx!r}); the check would be silently skipped")
            continue
        for h in hits:
            for grp, exp in zip(h.groups(), expected):
                if not same(grp, exp):
                    line = text.count("\n", 0, h.start()) + 1
                    fails.append(f"README.md:{line}: '{desc}' quotes {grp} but data/coverage.json says {exp}")
    return fails


def board_numbers(board: dict) -> set[str]:
    vals: set[str] = set()

    def add(v):
        if isinstance(v, float) and v == v:
            s = repr(abs(v))
            if "." in s and len(s.split(".")[1].rstrip("0")) >= 3 and "e" not in s:
                vals.add(s.rstrip("0"))

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k in ("value", "ci95", "delta", "p_value", "kappa") or k.endswith("_ms"):
                    for x in (v if isinstance(v, list) else [v]):
                        add(x)
                walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)

    walk(board["techniques"])
    walk(board.get("lifecycle", {}))
    walk(board.get("evidence", []))
    return vals


BANNED = [(r"45\.00", "$45.00 (unmeasured all-Claude cost)"), (r"\b5\.66\b", "$5.66 (unmeasured routed cost)"),
          (r"\b97\.4\b", "97.4 ms"), (r"\+900 ms|\b900\b", "900 ms injected latency (read demo_inputs)"),
          (r"\b350\b(?!\s*px)", "350 ms guardrail (read gate_config)"), (r"[−-]30%", "-30% cascade (wrong)")]


def check_code(board: dict) -> list[str]:
    nums = board_numbers(board)
    fails = []
    for d in CODE_DIRS:
        for f in d.rglob("*"):
            if f.suffix not in (".ts", ".tsx") or ".test." in f.name:
                continue
            for i, line in enumerate(f.read_text(errors="replace").splitlines(), 1):
                if line.strip().startswith(("*", "//", "/*")):
                    continue
                for lit in re.findall(r"(?<![\w.])\d+\.\d{3,}(?![\w.])", line):
                    if lit.rstrip("0") in nums:
                        fails.append(f"{f.relative_to(ROOT)}:{i}: literal {lit} duplicates a coverage.json measurement")
                if "/ops/" in str(f) or "/coverage/" in str(f):
                    for rx, why in BANNED:
                        if re.search(rx, line) and not re.search(r"(max-w|min-w|w-\[|h-\[|text-\[|duration|delay|z-)", line):
                            fails.append(f"{f.relative_to(ROOT)}:{i}: hand-typed {why}")
    return fails


def main() -> int:
    if not BOARD.exists():
        print("data/coverage.json missing: run build_coverage.py first", file=sys.stderr)
        return 1
    board = json.loads(BOARD.read_text())
    fails = check_readme(board) + check_code(board)
    if fails:
        print(f"FAIL: {len(fails)} number(s) disagree with data/coverage.json:", file=sys.stderr)
        for x in fails:
            print(f"  - {x}", file=sys.stderr)
        return 1
    print(f"OK: README anchors ({len(anchors(board))}) and web/bff literals agree with data/coverage.json.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
