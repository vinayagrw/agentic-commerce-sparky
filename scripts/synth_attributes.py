#!/usr/bin/env python3
"""Technique 2: VERIFIED synthetic data. Generate the product attributes the ESCI catalogue is missing
(dietary flags, pack size, key features) with Claude, then keep only what survives verification.

Three independent filters, in order, per generation attempt:
  1. schema check          - well-formed JSON with the expected shape and value types
  2. deterministic grounding - every claim must be traceable to the REAL product text:
        * dietary tags must come from a closed vocabulary AND have a supporting keyword in the text
        * pack_size.value must appear as a number in the text, and its unit must appear too
        * every key_feature must be short and mostly made of words that occur in the product text
  3. LLM verifier          - a SECOND Claude call that never sees the generator's reasoning; it is shown the
                             product text and the claims and must answer accept/reject with reasons
Rejected generations are resampled (rejection sampling) up to --max-attempts, with the rejection reason fed back.

Usage (from services/ops-mcp, needs the claude CLI on PATH or at ~/.local/bin/claude):
    uv run python ../../scripts/synth_attributes.py [--sample 40] [--max-attempts 3] [--parallel 6]
Writes data/synth_attributes.json. Idempotent for a given --seed (same product sample); costs are measured, not estimated.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

# closed vocabulary + the evidence each tag needs to find in the real product text
DIETARY_EVIDENCE = {
    "gluten_free": ["gluten free", "gluten-free", "glutenfree"],
    "vegan": ["vegan"],
    "vegetarian": ["vegetarian"],
    "organic": ["organic"],
    "kosher": ["kosher"],
    "halal": ["halal"],
    "dairy_free": ["dairy free", "dairy-free", "lactose free", "lactose-free", "non-dairy", "non dairy"],
    "nut_free": ["nut free", "nut-free", "peanut free", "peanut-free"],
    "keto": ["keto", "ketogenic"],
    "sugar_free": ["sugar free", "sugar-free", "no sugar added", "zero sugar", "unsweetened"],
    "low_sodium": ["low sodium", "low-sodium", "reduced sodium"],
    "non_gmo": ["non gmo", "non-gmo", "nongmo"],
}
UNITS = ["oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds", "g", "gram", "grams", "kg", "ml", "l", "liter",
         "litre", "fl oz", "count", "ct", "pack", "packs", "piece", "pieces", "bag", "bags", "box", "boxes",
         "bottle", "bottles", "can", "cans", "capsule", "capsules", "tablet", "tablets", "serving", "servings"]
STOPWORDS = {"a", "an", "and", "for", "of", "the", "to", "with", "in", "on", "is", "are", "this", "that", "it",
             "or", "by", "from", "at", "as", "be", "your", "you", "each", "per", "no", "not"}

SYSTEM = "You are a catalogue data extraction tool. You output ONE JSON object and nothing else. No prose, no markdown fences."

GEN_PROMPT = """Extract structured attributes for this product. Use ONLY facts stated in the product text below.
Never guess. If the text does not state something, use null or an empty list.

PRODUCT TEXT
---
{text}
---

Return exactly this JSON shape:
{{"dietary": [<zero or more of: {vocab}>],
  "pack_size": {{"value": <number stated in the text>, "unit": "<unit word as it appears in the text>"}} or null,
  "key_features": ["<up to 3 short phrases, max 8 words each, each using wording from the product text>"]}}

Rules: a dietary tag is allowed ONLY if the product text literally says so. pack_size must be a number that appears in
the text. key_features must paraphrase the text closely, not add new claims.{feedback}"""

VERIFY_PROMPT = """You are an independent verifier. Below is a product's real catalogue text and a set of attribute
claims someone generated from it. Decide whether EVERY claim is directly supported by the text.

PRODUCT TEXT
---
{text}
---

CLAIMS
---
{claims}
---

Reject if any dietary tag is not literally stated, if pack_size is not a number stated in the text, or if any
key_feature asserts something the text does not say. Accept only if all claims are supported.

Return exactly: {{"verdict": "accept" or "reject", "reasons": ["<short reason>", ...]}}"""


def claude_bin() -> str | None:
    p = shutil.which("claude")
    if p:
        return p
    home = Path.home() / ".local/bin/claude"
    return str(home) if home.exists() else None


class Claude:
    """Thin, lean wrapper around the claude CLI. Tracks measured spend."""

    def __init__(self, model: str, cwd: str, cfg: str):
        self.bin = claude_bin()
        self.model, self.cwd, self.cfg = model, cwd, cfg
        self.cost = 0.0
        self.calls = 0

    def ask(self, prompt: str, timeout: int = 180) -> tuple[str | None, float]:
        cmd = [self.bin, "-p", prompt, "--output-format", "json", "--model", self.model,
               "--mcp-config", self.cfg, "--strict-mcp-config", "--allowedTools", "",
               "--setting-sources", "", "--disable-slash-commands", "--max-turns", "1",
               "--system-prompt", SYSTEM]
        env = {**os.environ, "ENABLE_TOOL_SEARCH": "false"}
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env, cwd=self.cwd)
            d = json.loads(p.stdout) if p.stdout.strip().startswith("{") else {}
        except Exception:
            return None, 0.0
        c = float(d.get("total_cost_usd") or 0.0)
        self.cost += c
        self.calls += 1
        return (d.get("result") if not d.get("is_error") else None), c


def parse_json(s: str | None) -> dict | None:
    if not s:
        return None
    s = s.strip()
    m = re.search(r"\{.*\}", s, re.S)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
        return v if isinstance(v, dict) else None
    except Exception:
        return None


def product_text(r: dict) -> str:
    bullets = str(r.get("bullets") or "").replace("\n", " ")
    return f"Title: {r['title']}\nBrand: {r['brand']}\nCategory: {r['category']}\n" \
           f"Description: {str(r.get('description') or '')[:600]}\nBullets: {bullets[:600]}"


def deterministic_check(claim: dict, text: str) -> list[str]:
    """Return a list of failure reasons; empty means the claim is grounded in the real product text."""
    low = text.lower()
    words = set(re.findall(r"[a-z0-9]+", low))
    reasons = []

    if not isinstance(claim.get("dietary", []), list) or not isinstance(claim.get("key_features", []), list):
        return ["schema: dietary and key_features must be lists"]

    for tag in claim.get("dietary") or []:
        if tag not in DIETARY_EVIDENCE:
            reasons.append(f"dietary tag outside vocabulary: {tag}")
        elif not any(ev in low for ev in DIETARY_EVIDENCE[tag]):
            reasons.append(f"dietary tag unsupported by text: {tag}")

    ps = claim.get("pack_size")
    if ps is not None:
        if not isinstance(ps, dict) or "value" not in ps or "unit" not in ps:
            reasons.append("schema: pack_size must be null or {value, unit}")
        else:
            try:
                val = float(ps["value"])
            except (TypeError, ValueError):
                reasons.append(f"pack_size.value not numeric: {ps.get('value')!r}")
                val = None
            unit = str(ps.get("unit") or "").lower().strip()
            if val is not None:
                nums = {float(n) for n in re.findall(r"\d+(?:\.\d+)?", low)}
                if val not in nums:
                    reasons.append(f"pack_size.value {val} does not appear in the product text")
            if unit not in UNITS:
                reasons.append(f"pack_size.unit outside vocabulary: {unit!r}")
            elif unit not in low and unit.rstrip("s") not in low:
                reasons.append(f"pack_size.unit not in the product text: {unit!r}")

    feats = claim.get("key_features") or []
    if len(feats) > 3:
        reasons.append(f"too many key_features: {len(feats)}")
    for f in feats:
        if not isinstance(f, str) or not f.strip():
            reasons.append("key_feature empty or not a string")
            continue
        toks = [t for t in re.findall(r"[a-z0-9]+", f.lower()) if t not in STOPWORDS]
        if len(f.split()) > 8:
            reasons.append(f"key_feature longer than 8 words: {f[:40]!r}")
        if toks:
            grounded = sum(1 for t in toks if t in words) / len(toks)
            if grounded < 0.6:
                reasons.append(f"key_feature only {grounded:.0%} grounded in product text: {f[:40]!r}")
    return reasons


def process(row: dict, cl: Claude, max_attempts: int) -> dict:
    text = product_text(row)
    attempts, feedback = [], ""
    for n in range(1, max_attempts + 1):
        raw, gcost = cl.ask(GEN_PROMPT.format(text=text, vocab=", ".join(DIETARY_EVIDENCE), feedback=feedback))
        claim = parse_json(raw)
        rec = {"attempt": n, "cost_usd": round(gcost, 6)}
        if claim is None:
            rec.update(stage="schema", accepted=False, reasons=["generator returned unparseable output"])
            attempts.append(rec)
            feedback = "\nYour last answer was not valid JSON. Return ONLY the JSON object."
            continue
        det = deterministic_check(claim, text)
        if det:
            rec.update(stage="deterministic", accepted=False, reasons=det, claim=claim)
            attempts.append(rec)
            feedback = "\nYour last answer was rejected because: " + "; ".join(det[:3]) + ". Fix it."
            continue
        vraw, vcost = cl.ask(VERIFY_PROMPT.format(text=text, claims=json.dumps(claim)))
        rec["cost_usd"] = round(gcost + vcost, 6)
        v = parse_json(vraw) or {}
        verdict = str(v.get("verdict", "")).lower()
        if verdict == "accept":
            rec.update(stage="verifier", accepted=True, reasons=[], claim=claim)
            attempts.append(rec)
            return {"product_id": row["product_id"], "title": row["title"][:90], "category": row["category"],
                    "accepted": True, "attempts": attempts, "accepted_claim": claim}
        reasons = [str(r)[:160] for r in (v.get("reasons") or ["verifier rejected without a reason"])]
        rec.update(stage="verifier", accepted=False, reasons=reasons, claim=claim)
        attempts.append(rec)
        feedback = "\nAn independent verifier rejected your last answer because: " + "; ".join(reasons[:3]) + ". Fix it."
    return {"product_id": row["product_id"], "title": row["title"][:90], "category": row["category"],
            "accepted": False, "attempts": attempts, "accepted_claim": None}


def summarize(items: list[dict], t0: float, args, cl: Claude, sampled_from: int) -> dict:
    n = len(items)
    acc = [i for i in items if i["accepted"]]
    rej = [i for i in items if not i["accepted"]]
    first_try = sum(1 for i in acc if len(i["attempts"]) == 1)
    reason_counts: dict[str, int] = {}
    stage_counts: dict[str, int] = {}
    for it in items:
        for a in it["attempts"]:
            if a["accepted"]:
                continue
            stage_counts[a["stage"]] = stage_counts.get(a["stage"], 0) + 1
            for r in a["reasons"]:
                key = re.sub(r"[:\s].*$", "", r) if r.startswith(("dietary", "pack_size", "key_feature", "schema")) else r
                key = {"dietary": "dietary tag unsupported or out of vocabulary",
                       "pack_size": "pack_size not grounded in text",
                       "key_feature": "key_feature not grounded / too long",
                       "schema": "schema violation"}.get(key, r[:80])
                reason_counts[key] = reason_counts.get(key, 0) + 1
    attempts_total = sum(len(i["attempts"]) for i in items)
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "seconds": round(time.time() - t0, 1),
        "inputs": {"source": "data/products.parquet", "catalogue_size": sampled_from, "sample": n, "seed": args.seed,
                   "max_attempts": args.max_attempts, "model": args.model, "parallel": args.parallel,
                   "categories": args.categories or "all",
                   "filter": "products with real ESCI description or bullets and no existing dietary tag"},
        "method": {"generator": "claude CLI, 1 turn, no tools",
                   "verification": ["schema check", "deterministic grounding against the real product text",
                                    "independent LLM verifier call (fresh context, sees only text + claims)"],
                   "rejection_sampling": f"resample up to {args.max_attempts} times with the rejection reason fed back"},
        "results": {
            "products": n,
            "accepted": len(acc),
            "acceptance_rate": round(len(acc) / n, 4) if n else 0.0,
            "accepted_first_attempt": first_try,
            "first_attempt_acceptance_rate": round(first_try / n, 4) if n else 0.0,
            "generations_attempted": attempts_total,
            "per_generation_acceptance_rate": round(len(acc) / attempts_total, 4) if attempts_total else 0.0,
            "mean_attempts_per_product": round(attempts_total / n, 2) if n else 0.0,
            "rejections_by_stage": stage_counts,
            "rejection_reasons": dict(sorted(reason_counts.items(), key=lambda kv: -kv[1])),
        },
        "cost": {"claude_calls": cl.calls, "total_usd": round(cl.cost, 4),
                 "usd_per_accepted_attribute_set": round(cl.cost / len(acc), 5) if acc else None},
        "rejected_examples": [{"product_id": i["product_id"], "title": i["title"],
                               "attempts": [{"stage": a["stage"], "reasons": a["reasons"][:3],
                                             "claim": a.get("claim")} for a in i["attempts"]]}
                              for i in rej[:8]],
        "accepted_examples": [{"product_id": i["product_id"], "title": i["title"], "claim": i["accepted_claim"],
                               "attempts_needed": len(i["attempts"])} for i in acc[:8]],
        "items": items,
        "note": "The catalogue's existing `dietary` column is SYNTHETIC demo data. This script generates attributes "
                "from the REAL ESCI title/description/bullets text and only keeps generations that survive all three "
                "verification stages, so the accepted set is grounded in real text.",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=25)
    ap.add_argument("--categories", nargs="*", default=["grocery", "health_household"],
                    help="sample from these categories (dietary/pack-size claims are meaningful there); [] = all")
    ap.add_argument("--max-attempts", type=int, default=3)
    ap.add_argument("--parallel", type=int, default=6)
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--seed", type=int, default=20260915)
    ap.add_argument("--out", default=str(DATA / "synth_attributes.json"))
    a = ap.parse_args()

    if not claude_bin():
        raise SystemExit("claude CLI not found (looked on PATH and at ~/.local/bin/claude)")

    p = pd.read_parquet(DATA / "products.parquet")
    total = len(p)
    has_text = (p["description"].fillna("").str.len() > 40) | (p["bullets"].fillna("").str.len() > 40)
    no_diet = p["dietary"].map(len) == 0
    keep = has_text & no_diet
    if a.categories:
        keep &= p["category"].isin(a.categories)
    pool = p[keep]
    rows = pool.sample(n=min(a.sample, len(pool)), random_state=a.seed).to_dict("records")
    print(f"[synth] pool {len(pool):,}/{total:,} products -> sample {len(rows)} (seed {a.seed})", flush=True)

    cfg = Path(tempfile.gettempdir()) / "synth-nomcp.json"
    cfg.write_text('{"mcpServers":{}}')
    cl = Claude(a.model, tempfile.gettempdir(), str(cfg))

    t0 = time.time()
    warm, wc = cl.ask("Reply with exactly: OK")          # warm the prompt cache so the parallel calls read it
    print(f"[synth] cache warm-up {'ok' if warm else 'failed'} (${wc:.4f})", flush=True)
    with ThreadPoolExecutor(a.parallel) as ex:
        items = list(ex.map(lambda r: process(r, cl, a.max_attempts), rows))

    out = summarize(items, t0, a, cl, total)
    Path(a.out).write_text(json.dumps(out, indent=2, default=str))
    r = out["results"]
    print(f"[synth] acceptance {r['accepted']}/{r['products']} = {r['acceptance_rate']:.1%} "
          f"(first attempt {r['first_attempt_acceptance_rate']:.1%}, {r['mean_attempts_per_product']} attempts/product)", flush=True)
    print(f"[synth] rejections by stage {r['rejections_by_stage']}", flush=True)
    print(f"[synth] top reasons {json.dumps(dict(list(r['rejection_reasons'].items())[:5]))}", flush=True)
    print(f"[synth] {cl.calls} claude calls, ${cl.cost:.4f} -> {a.out}", flush=True)


if __name__ == "__main__":
    main()
