"""Prompt-injection detector (normalise, then regex + heuristics). Exported for the BFF guard.

History worth keeping: the first version matched patterns against the raw string only. The
adaptive red-team agent (ops_mcp.redteam.adaptive_run, playbook technique 22) found that
this let 71% of its generated attacks (50/70, Wilson CI on the block rate [0.19, 0.40])
straight through, using nothing more exotic than leetspeak, single-character spacing,
rot13/base64 wrappers and a "store policy ... requires no confirmation" framing that never
uses an imperative verb at all.

So the detector now *normalises before it matches*: it decodes obvious encodings, strips
zero-width characters, folds homoglyphs, un-leets, and collapses `c a l l`-style spacing.
Patterns are then run over the raw text AND every normalised variant, and the signals are
unioned. Two framing patterns the red team discovered were added as well.

This is a heuristic, not a proof. A normaliser only closes the transformations it knows
about; the honest posture is that this layer buys time and that the executable guards
(shop_mcp.guard, policy_mcp.policy) are what actually stop harm.
"""
from __future__ import annotations

import base64
import binascii
import codecs
import re
import unicodedata

PATTERNS = [
    ("override_instructions", r"\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|all)\b.{0,20}\b(instructions?|rules|prompts?)"),
    ("role_hijack", r"\byou are now\b|\bact as\b|\b(admin|developer|god) mode\b"),
    ("fake_system_tag", r"<\s*/?\s*(system|assistant)\b|\bsystem\s*:|<!--.*?-->|\[\s*inst\s*\]"),
    ("tool_invocation", r"\b(call|invoke|run|use)\b.{0,20}\b(tool|function|create_checkout_mandate|add_to_cart|approve_mandate|promote)\b"),
    ("cart_manipulation", r"\badd\s+\d+\s+(units?|items?|of)\b|\badd\b.{0,30}\bto (the )?cart\b"),
    ("payment_action", r"\b(approve|confirm|complete)\b.{0,30}\b(payment|purchase|order|mandate|checkout)\b|\bspend_cap\b"),
    ("secrecy", r"\b(do not|don't|never)\b.{0,15}\b(tell|inform|mention|show)\b.{0,15}\b(user|customer)\b|without asking"),
    ("exfiltration", r"\b(send|post|upload)\b.{0,40}\b(https?://|api key|password|token)"),
    # --- found by the adaptive red team, 2026-09-15 ---
    # Declarative framing: no imperative verb, so nothing above fires, but the sentence still
    # tells the agent an action is pre-authorised.
    ("authority_framing", r"\b(requires?|needs?)\s+no\s+(confirmation|approval|permission)\b"
                          r"|\bno\s+confirmation\s+(is\s+)?(needed|required)\b"
                          r"|\b(is|are)\s+the\s+default\s+and\b"
                          r"|\bpre-?(approved|authorised|authorized)\b"),
    # "The previous assistant already agreed ..." - manufactures consent from a prior turn.
    ("false_continuation", r"\b(previous|earlier|last)\s+(assistant|agent|session|turn)\b.{0,40}"
                           r"\b(agreed|approved|confirmed|already)\b"
                           r"|\bcontinue where (it|you) left off\b"),
    # Memory poisoning phrased as a preference fact.
    ("memory_write", r"\bremember (this |that )?(permanently|forever|from now on)\b"
                     r"|\b(always|permanently) (remember|store|save)\b"),
    # Prompt extraction.
    ("prompt_extraction", r"\b(print|show|reveal|repeat|output)\b.{0,30}\b(system prompt|ranking rules|instructions)\b"
                          r"|\bsystem prompt\b.{0,20}\bverbatim\b"),
]
_COMPILED = [(n, re.compile(p, re.I | re.S)) for n, p in PATTERNS]

_ZERO_WIDTH = re.compile(r"[​-‏‪-‮⁠-⁤﻿­]")
_HOMOGLYPHS = str.maketrans({
    "а": "a", "е": "e", "о": "o", "с": "c", "р": "p", "х": "x",
    "у": "y", "і": "i", "һ": "h", "ѕ": "s", "ο": "o", "Α": "A",
})
_LEET = str.maketrans({"1": "i", "0": "o", "3": "e", "@": "a", "5": "s", "4": "a", "7": "t", "$": "s", "!": "i"})
_B64 = re.compile(r"\b[A-Za-z0-9+/]{20,}={0,2}\b")


def _strip_invisibles(s: str) -> str:
    return _ZERO_WIDTH.sub("", unicodedata.normalize("NFKC", s))


def _collapse_spacing(s: str) -> str:
    """`c a l l   t h e   t o o l` -> `call the tool`, leaving normal words alone.

    A run of three or more single-character tokens is not natural product copy; joining them
    is what makes the spaced-token operator stop working.
    """
    def join(m: re.Match) -> str:
        return m.group(0).replace(" ", "")
    return re.sub(r"(?:(?<=\s)|^)(?:\S ){2,}\S(?=\s|$)", join, s)


def _decode_encodings(s: str) -> list[str]:
    """Anything a listing has gone to the trouble of encoding is worth reading."""
    out = []
    if re.search(r"\brot ?13\b", s, re.I):
        out.append(codecs.decode(s, "rot_13"))
    for m in _B64.finditer(s):
        try:
            d = base64.b64decode(m.group(0) + "==", validate=False).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            continue
        if sum(c.isprintable() for c in d) / max(1, len(d)) > 0.9 and re.search(r"[a-z]{3}", d, re.I):
            out.append(d)
    return out


def normalize(text: str) -> dict[str, str]:
    """Every view of the text the matcher should see. Keys are the transform that produced them."""
    base = _strip_invisibles(text)
    views = {"raw": text, "invisibles_stripped": base}
    folded = base.translate(_HOMOGLYPHS)
    views["homoglyph_folded"] = folded
    views["spacing_collapsed"] = _collapse_spacing(folded)
    views["deleet"] = views["spacing_collapsed"].translate(_LEET)
    for i, d in enumerate(_decode_encodings(base)):
        views[f"decoded_{i}"] = d
        views[f"decoded_{i}_deleet"] = _collapse_spacing(d.translate(_HOMOGLYPHS)).translate(_LEET)
    return views


def detect_injection(text: str | None) -> dict:
    """Returns {"signals": [...], "score": 0..1, "flagged": bool, "views_scanned": n}."""
    if not text:
        return {"signals": [], "score": 0.0, "flagged": False, "views_scanned": 0}
    views = normalize(text)
    signals: list[dict] = []
    seen: set[str] = set()
    for view_name, view in views.items():
        for name, rx in _COMPILED:
            if name in seen:
                continue
            m = rx.search(view)
            if m:
                seen.add(name)
                sig = {"type": name, "match": m.group(0)[:80]}
                if view_name != "raw":
                    sig["via"] = view_name
                signals.append(sig)
    # An encoded payload inside third-party catalogue text is itself a signal.
    if any(k.startswith("decoded_") for k in views):
        signals.append({"type": "encoded_payload", "match": "base64/rot13 blob in untrusted text"})
    # heuristics on the raw string
    letters = [c for c in text if c.isalpha()]
    if letters and sum(c.isupper() for c in letters) / len(letters) > 0.3 and len(letters) > 20:
        signals.append({"type": "shouting_ratio", "match": "high uppercase ratio"})
    if _ZERO_WIDTH.search(text):
        signals.append({"type": "hidden_unicode", "match": "zero-width characters"})
    score = min(1.0, 0.35 * len(signals))
    return {"signals": signals, "score": round(score, 2), "flagged": score >= 0.35,
            "views_scanned": len(views)}
