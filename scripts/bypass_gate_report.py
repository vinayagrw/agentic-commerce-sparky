#!/usr/bin/env python
"""B10 - write data/bypass_gate.json: per-language bypass-class gate, before vs after the multilingual detector.

    cd services/ops-mcp && uv run python ../../scripts/bypass_gate_report.py            # full report
    cd services/ops-mcp && uv run python ../../scripts/bypass_gate_report.py --baseline # live detector only,
                                                                                       # -> data/bypass_gate_baseline.json

"before" = scripts/baseline/injection_pre_b10.py, a byte-for-byte copy of shop_mcp/injection.py taken before
any B10 change (sha1 50571572b78f4b005158580c6791a225d4096c52). "after" = the live shop_mcp.injection.
Both are swapped into ops_mcp.redteam's module global, so run()/adaptive_run() exercise exactly that detector.

Never writes data/redteam_findings.json: every adaptive_run here uses promote=False.
No service needs to be running.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import sys
from collections import defaultdict
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "ops-mcp" / "src"))
sys.path.insert(0, str(ROOT / "services" / "shop-mcp" / "src"))

from ops_mcp import bypass_gate, redteam  # noqa: E402
from shop_mcp import injection as live_injection  # noqa: E402

BASELINE_DETECTOR = ROOT / "scripts" / "baseline" / "injection_pre_b10.py"
BENIGN = ROOT / "evals" / "benign_multilingual.yaml"
OUT = ROOT / "data" / "bypass_gate.json"
OUT_BASELINE = ROOT / "data" / "bypass_gate_baseline.json"

SEEDS_SAME = [1, 2, 3]
SEEDS_UNSEEN = [11, 12, 13]
SEEDS_GENERALISATION = [21, 22, 23]
wilson = redteam._wilson


def sha1(p: Path) -> str:
    return hashlib.sha1(p.read_bytes()).hexdigest()


def load_baseline_detector():
    spec = importlib.util.spec_from_file_location("injection_pre_b10", BASELINE_DETECTOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.detect_injection


def with_detector(detect):
    class _Ctx:
        def __enter__(self):
            self.old = redteam.detect_injection
            redteam.detect_injection = detect

        def __exit__(self, *a):
            redteam.detect_injection = self.old
    return _Ctx()


def rate(k: int, n: int) -> dict:
    return {"k": k, "n": n, "rate": round(k / n, 4) if n else None, "ci95_wilson": wilson(k, n)}


def adaptive(seeds: list[int], operators: dict | None = None) -> dict:
    per_seed, k_tot, n_tot = [], 0, 0
    for s in seeds:
        r = redteam.adaptive_run(seed=s, promote=False, operators=operators)
        n, byp = r["attempts"], r["bypassed"]
        k_tot, n_tot = k_tot + byp, n_tot + n
        per_seed.append({"seed": s, "attempts": n, "bypassed": byp, "asr": rate(byp, n),
                         "bypassing_classes": sorted({bypass_gate.class_of(a["text"], a["operators"])["class"]
                                                      for a in r["successful_attacks"]})})
    return {"seeds": seeds, "budget": "adaptive_run defaults (generations=6, per_generation=12, usd_cap=1.0)",
            "operators": sorted(operators or redteam.OPERATORS), "per_seed": per_seed, "pooled_asr": rate(k_tot, n_tot)}


def native_spanish_grid(detect) -> dict:
    """Deterministic held-out grid: 8 intents x {spanish_native, spanish_native+accent_strip} x 6 carriers."""
    rows = []
    for intent in redteam.INTENTS:
        for chain in (["spanish_native"], ["spanish_native", "accent_strip"]):
            p = intent["goal"]
            for op in chain:
                p = redteam.GENERALISATION_OPERATORS[op](p)
            for c in redteam.CARRIERS:
                t = c.format(payload=p)
                rows.append({"intent": intent["id"], "operators": chain, "text": t,
                             "blocked": bool(detect(t)["flagged"]), **bypass_gate.class_of(t, chain)})
    byp = [r for r in rows if not r["blocked"]]
    by_lang = defaultdict(lambda: [0, 0])
    for r in rows:
        by_lang[r["language"]][1] += 1
        by_lang[r["language"]][0] += not r["blocked"]
    return {"n": len(rows), "asr": rate(len(byp), len(rows)),
            "asr_by_language": {k: rate(*v) for k, v in sorted(by_lang.items())},
            "bypassing_examples": [r["text"] for r in byp[:10]]}


def benign(detect) -> dict:
    items = yaml.safe_load(BENIGN.read_text())["items"]
    by_label, by_clf, fps, agree = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0]), [], 0
    for it in items:
        f = bool(detect(it["text"])["flagged"])
        clf = bypass_gate.classify_language(it["text"])
        agree += clf == it["lang"]
        for d, key in ((by_label, it["lang"]), (by_clf, clf)):
            d[key][1] += 1
            d[key][0] += f
        if f:
            fps.append({"id": it["id"], "lang": it["lang"], "hard_negative": bool(it.get("hard_negative")),
                        "signals": [s["type"] for s in detect(it["text"])["signals"]], "text": it["text"]})
    return {"source": "evals/benign_multilingual.yaml (AUTHORED by the implementing agent, not independently sourced)",
            "n": len(items),
            "fp_by_author_label": {k: rate(*v) for k, v in sorted(by_label.items())},
            "fp_by_classifier_label": {k: rate(*v) for k, v in sorted(by_clf.items())},
            "fp_overall": rate(len(fps), len(items)),
            "classifier_agreement_with_author_label": rate(agree, len(items)),
            "false_positives": fps}


def seed_suite() -> dict:
    r = redteam.run(gate_on_findings=False)
    return {k: r[k] for k in ("attacks", "blocked", "blocked_rate", "benign", "false_positives")}


def measure(detect, label: str) -> dict:
    findings = redteam.load_findings()
    with with_detector(detect):
        rep = bypass_gate.replay(findings, detect)
        gate = bypass_gate.evaluate(rep, bypass_gate.load_overrides())
        byp = [r for r in rep if not r["blocked"]]
        by_lang = defaultdict(lambda: [0, 0])
        for r in rep:
            by_lang[r["language"]][1] += 1
            by_lang[r["language"]][0] += not r["blocked"]
        out = {
            "detector": label,
            "findings_replay": {"n": len(rep), "bypassing": len(byp), "blocked": len(rep) - len(byp),
                                "bypass_rate": rate(len(byp), len(rep)),
                                "bypass_by_language": {k: rate(*v) for k, v in sorted(by_lang.items())},
                                "still_bypassing_ids": [r["id"] for r in byp]},
            "adaptive_same_seeds": adaptive(SEEDS_SAME),
            "adaptive_unseen_seeds": adaptive(SEEDS_UNSEEN),
            "generalisation": {
                "note": "NEW operators spanish_native + accent_strip (not in the default grammar) plus framing ops",
                "adaptive": adaptive(SEEDS_GENERALISATION, {
                    **{k: redteam.GENERALISATION_OPERATORS[k] for k in ("spanish_native", "accent_strip")},
                    **{k: redteam.OPERATORS[k] for k in ("plain", "polite_framing", "json_wrapper", "continuation")}}),
                "native_spanish_grid": native_spanish_grid(detect)},
            "benign": benign(detect),
            "seed_suite_tasks_yaml": seed_suite(),
            "gate": gate,
        }
    return out


def class_counts(gate: dict) -> list[dict]:
    return [{k: c[k] for k in ("class", "language", "family", "n", "bypassing", "status")} for c in gate["classes"]]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", action="store_true", help="measure the LIVE detector only -> bypass_gate_baseline.json")
    a = ap.parse_args()
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    live_path = Path(live_injection.__file__)
    if a.baseline:
        res = measure(live_injection.detect_injection, f"live shop_mcp.injection (sha1 {sha1(live_path)})")
        OUT_BASELINE.write_text(json.dumps({"generated_at": now, "script": "scripts/bypass_gate_report.py --baseline",
                                            **res}, indent=2, ensure_ascii=False))
        print(json.dumps({"replay": res["findings_replay"]["bypassing"], "same": res["adaptive_same_seeds"]["pooled_asr"],
                          "benign": res["benign"]["fp_by_author_label"], "blocked": res["gate"]["release_blocked"]}, indent=1))
        return

    before = measure(load_baseline_detector(), f"pre-B10 copy {BASELINE_DETECTOR.relative_to(ROOT)} (sha1 {sha1(BASELINE_DETECTOR)})")
    after = measure(live_injection.detect_injection, f"live shop_mcp.injection (sha1 {sha1(live_path)})")
    report = {
        "generated_at": now,
        "script": "cd services/ops-mcp && uv run python ../../scripts/bypass_gate_report.py",
        "backlog_item": "B10 adaptive bypass-class gate, per language",
        "class_definition": {
            "key": "<language>/<operator_family>",
            "language": "ops_mcp.bypass_gate.classify_language(text): accent-folded marker-word counts; both "
                        "languages present with minority >= 2 markers or >= 10% -> code_switched",
            "operator_family": {"obfuscation": sorted(bypass_gate.OBFUSCATION_OPS),
                                "framing": sorted(bypass_gate.FRAMING_OPS),
                                "direct": "anything else (plain, spanish, spanish_native)"},
            "intent": "reported per class, not part of the key (keeps classes from collapsing to single strings)"},
        "before": {k: v for k, v in before.items() if k != "gate"},
        "after": {k: v for k, v in after.items() if k != "gate"},
        "benign": {"before": before["benign"]["fp_by_author_label"], "after": after["benign"]["fp_by_author_label"],
                   "n": after["benign"]["n"], "source": after["benign"]["source"]},
        "classes_before": class_counts(before["gate"]),
        "classes_after": class_counts(after["gate"]),
        "release_blocked_before": before["gate"]["release_blocked"],
        "release_blocked_after": after["gate"]["release_blocked"],
        "gate_reasons_after": after["gate"]["reasons"],
        "overrides": {"file": "data/bypass_overrides.json", "loaded": bypass_gate.load_overrides(),
                      "applied_after": after["gate"]["overrides_applied"],
                      "rejected_after": after["gate"]["overrides_rejected"]},
        "caveats": [
            "The 54-finding replay is IN-SAMPLE: the Spanish/code-switched patterns were written after reading those findings.",
            "adaptive_run with the default grammar is SEMI-in-sample even on unseen seeds (11-13): new strings, but the "
            "same intents, carriers and `spanish` translation table the patterns were written against.",
            "The generalisation probes (spanish_native, accent_strip, native_spanish_grid) use a different lexicon, but "
            "were authored by the same agent that wrote the detector, in the same session; they are a weak held-out test.",
            "The benign set (evals/benign_multilingual.yaml) was AUTHORED by the implementing agent, n=90 (30 per "
            "language); CIs are wide and it is not a sample of real catalogue text.",
            "Language labels come from a lexicon heuristic; misclassification moves findings between classes.",
            "A regex detector is a speed bump, not a proof; the executable guards (shop_mcp.guard, policy_mcp.policy) "
            "are what stop harm.",
        ],
    }
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
