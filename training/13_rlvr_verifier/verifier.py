"""Programmatic verifier for technique 13 (playbook §13).

Playbook §13 step 1: "Write the verifier first, with unit tests and adversarial cases."
This module is that verifier. It is deterministic, has no network access, no model calls and
no randomness, so it can be signed and versioned as its own artefact (§13 AC2) and run inside
a network-isolated sandbox (§13 US-13.2).

Reward shape (mirrors the playbook's worked example, adapted to the Sparky filter schema):
    -1.0            invalid JSON or schema violation  (hard penalty)
    +0.2            schema-valid
    +0.5 * F1       agreement with the gold filter derived from E-judged products
    +0.15           evidence span is a literal substring of the query (grounding)
    +0.15           price_max within tolerance of the gold catalogue price

Run the self-tests:   python verifier.py --selftest
"""
from __future__ import annotations

import json
import re
from typing import Any

VERIFIER_ID = "sparky-filter-verifier"
VERIFIER_VERSION = "v1"
SCHEMA_ID = "filter_v1.json"

CATEGORIES = {"grocery", "home_kitchen", "baby", "health_household", "pet", "electronics_accessories"}
DIETARY = {"gluten_free", "vegan", "organic"}
PRICE_TOLERANCE = 0.25  # relative

_JSON_BLOCK = re.compile(r"\{.*\}", re.S)


def _extract_json(completion: str) -> Any:
    """Parse the first JSON object in the completion. Fenced blocks are tolerated; anything
    else is a hard failure (we do not 'repair' output, that would hide reward hacking)."""
    m = _JSON_BLOCK.search(completion or "")
    if not m:
        raise ValueError("no JSON object found")
    return json.loads(m.group(0))


def validate_schema(obj: Any, schema: dict | None = None) -> None:
    """jsonschema when available; otherwise an equivalent hand-rolled check so the verifier
    never silently degrades to 'everything passes'."""
    if schema is not None:
        try:
            import jsonschema

            jsonschema.validate(obj, schema)
            return
        except ImportError:
            pass
    if not isinstance(obj, dict):
        raise ValueError("not an object")
    required = {"category", "price_max", "dietary", "brand", "evidence"}
    if set(obj) != required:
        raise ValueError(f"key set mismatch: {sorted(set(obj) ^ required)}")
    if obj["category"] not in CATEGORIES:
        raise ValueError(f"bad category {obj['category']!r}")
    pm = obj["price_max"]
    if pm is not None and not (isinstance(pm, (int, float)) and not isinstance(pm, bool) and 0 <= pm <= 10000):
        raise ValueError("bad price_max")
    d = obj["dietary"]
    if not isinstance(d, list) or len(set(d)) != len(d) or any(x not in DIETARY for x in d):
        raise ValueError("bad dietary")
    b = obj["brand"]
    if b is not None and not (isinstance(b, str) and len(b) <= 80):
        raise ValueError("bad brand")
    ev = obj["evidence"]
    if not isinstance(ev, str) or not (1 <= len(ev) <= 200):
        raise ValueError("bad evidence")


def _field_set(obj: dict) -> set[tuple[str, str]]:
    """Flatten a filter into comparable (field, value) atoms for F1."""
    atoms: set[tuple[str, str]] = {("category", str(obj.get("category", "")).lower())}
    if obj.get("brand"):
        atoms.add(("brand", str(obj["brand"]).strip().lower()))
    for t in obj.get("dietary") or []:
        atoms.add(("dietary", str(t).lower()))
    return atoms


def f1(pred: dict, gold: dict) -> float:
    p, g = _field_set(pred), _field_set(gold)
    if not p and not g:
        return 1.0
    tp = len(p & g)
    if tp == 0:
        return 0.0
    prec, rec = tp / len(p), tp / len(g)
    return 2 * prec * rec / (prec + rec)


def verify(completion: str, gold: dict | str, query: str, schema: dict | None = None) -> float:
    """Return the scalar reward for one completion. Never raises."""
    if isinstance(gold, str):
        gold = json.loads(gold)
    try:
        out = _extract_json(completion)
        validate_schema(out, schema)
    except Exception:
        return -1.0

    r = 0.2
    r += 0.5 * f1(out, gold)

    ev = str(out.get("evidence", "")).strip().lower()
    # Grounding: the justification must literally appear in the query. This is the term that
    # stops the degenerate "schema-valid but empty" reward hack called out in §13 Risks.
    r += 0.15 if ev and ev in (query or "").lower() else 0.0

    gp, pp = gold.get("price_max"), out.get("price_max")
    if gp is None and pp is None:
        r += 0.15
    elif gp is not None and pp is not None and gp > 0:
        r += 0.15 if abs(pp - gp) / gp <= PRICE_TOLERANCE else 0.0

    return round(float(r), 6)


def reward_fn(completions, gold, query, **_) -> list[float]:
    """TRL GRPOTrainer reward-function signature: extra dataset columns arrive as kwargs
    (here `gold` and `query`), and the return is one float per completion."""
    texts = [c[-1]["content"] if isinstance(c, list) else c for c in completions]
    return [verify(t, g, q) for t, g, q in zip(texts, gold, query)]


# --------------------------------------------------------------------------------------
# Adversarial + unit tests (playbook §13 step 1 and AC2)
# --------------------------------------------------------------------------------------

GOLD = {"category": "grocery", "price_max": 10.0, "dietary": ["organic"], "brand": "Coghlan's"}
QUERY = "organic multi spice under 10 dollars"

PERFECT = json.dumps({"category": "grocery", "price_max": 10.0, "dietary": ["organic"],
                      "brand": "Coghlan's", "evidence": "organic multi spice"})


def _selftest() -> int:
    cases: list[tuple[str, str, float, str]] = [
        ("perfect", PERFECT, 1.0, "eq"),
        ("not json", "I think grocery.", -1.0, "eq"),
        ("bad category", json.dumps({**json.loads(PERFECT), "category": "toys"}), -1.0, "eq"),
        ("extra key", json.dumps({**json.loads(PERFECT), "sponsored": True}), -1.0, "eq"),
        ("missing key", json.dumps({"category": "grocery"}), -1.0, "eq"),
        ("bad dietary value", json.dumps({**json.loads(PERFECT), "dietary": ["keto"]}), -1.0, "eq"),
        ("duplicate dietary", json.dumps({**json.loads(PERFECT), "dietary": ["organic", "organic"]}), -1.0, "eq"),
        ("negative price", json.dumps({**json.loads(PERFECT), "price_max": -5}), -1.0, "eq"),
        ("bool price (adversarial)", json.dumps({**json.loads(PERFECT), "price_max": True}), -1.0, "eq"),
        # reward hacks that MUST score below the honest answer rather than being rejected outright
        ("hallucinated evidence", json.dumps({**json.loads(PERFECT), "evidence": "free shipping"}), 1.0, "lt"),
        ("empty-ish but valid", json.dumps({"category": "pet", "price_max": None, "dietary": [],
                                            "brand": None, "evidence": "organic"}), 0.5, "lt"),
        ("wrong price", json.dumps({**json.loads(PERFECT), "price_max": 900.0}), 1.0, "lt"),
        ("fenced json", "```json\n" + PERFECT + "\n```", 1.0, "eq"),
    ]
    failures = 0
    for name, comp, ref, op in cases:
        got = verify(comp, GOLD, QUERY)
        ok = abs(got - ref) < 1e-6 if op == "eq" else got < ref
        print(f"  {'PASS' if ok else 'FAIL'}  {name:28s} reward={got:+.4f} ({op} {ref})")
        failures += 0 if ok else 1
    # ordering invariant: the honest answer must beat every hack
    honest = verify(PERFECT, GOLD, QUERY)
    for name, comp, _, op in cases:
        if op == "lt" and verify(comp, GOLD, QUERY) >= honest:
            print(f"  FAIL  ordering: {name} >= honest")
            failures += 1
    print(f"verifier {VERIFIER_ID}/{VERIFIER_VERSION}: {len(cases)} cases, {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    import sys

    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    print(__doc__)
