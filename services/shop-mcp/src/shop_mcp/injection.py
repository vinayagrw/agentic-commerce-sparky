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
    # --- B10, 2026-09-16: unbounded consumption had no pattern in ANY language ---
    ("unbounded_repetition", r"\b(repeat|repite|repetir|call|llama a|run|ejecuta|lanza|invoca)\b.{0,40}"
                             r"\b(\d{3,}|hundreds?|thousands?|cien|cientos|doscient[oa]s|trescient[oa]s|quinient[oa]s|mil|miles)\s+(times|veces)\b"),
]

# --- B10, 2026-09-16: Spanish and code-switched (Spanglish) forms -------------------------------------
# The adaptive red team got 54 attacks through by translating one or two trigger words ("agrega ... al
# carrito", "recuerda permanently", "ejecuta the promote tool"). These mirror the English intents above as
# VERB-CLASS x OBJECT-CLASS patterns where either side may be English or Spanish, so mixed forms match too.
# They run over an accent-folded view (see normalize), so they are written without accents.
# Imperatives only: past tense / infinitives ("agregue dos al carrito", "al completar la compra") are what
# ordinary Spanish reviews say, and are deliberately NOT matched. Signal names reuse the English ones so an
# English attack that also matches here is not double-scored.
_ES_ADD = r"agrega(?:r|me|lo|los|la|las)?|anade(?:lo|los|la|las)?|mete(?:lo|los)?|pon(?:lo|los|la|las)?|add"
_CART = r"al carrito|al carro|a la cesta|en (?:el|la|mi|tu) (?:carrito|carro|cesta)|to (?:the |my )?cart|in(?:to)? (?:the )?cart"
_USER = r"cliente|comprador|usuario|customer|user|shopper"
ML_PATTERNS = [
    ("override_instructions", r"\b(olvida|olvidate de|ignora|omite|descarta|desobedece|ignore|forget|disregard)\b.{0,30}"
                              r"\b(todas|anteriores|previas|previous|prior|all|las)\b.{0,20}"
                              r"\b(instrucciones|reglas|indicaciones|ordenes|instructions?|rules)\b"),
    ("role_hijack", r"\bahora eres\b|\bactua como\b|\bfinge ser\b|\bmodo (administrador|desarrollador|dios|admin)\b"),
    ("tool_invocation", r"\b(llama a|llamar a|ejecuta|invoca|utiliza|lanza|dispara|activa|call|invoke|run)\b.{0,25}"
                        r"\b(herramienta|funcion|tool|function|create_checkout_mandate|add_to_cart|approve_mandate|promote)\b"),
    ("cart_manipulation", rf"\b({_ES_ADD})\b.{{0,40}}\b({_CART})\b"
                          r"|\b(agrega|anade|mete|pon)\s+\d+\s+(unidades|articulos|productos|piezas|units?|items?)\b"),
    ("payment_action", r"\b(completa|confirma|finaliza|aprueba|realiza|procesa|termina|autoriza)(?:lo|la)?\b.{0,30}"
                       r"\b(compra|pago|pedido|orden|checkout|mandato|purchase|order|payment|mandate)\b"),
    ("secrecy", rf"\bsin (preguntar|avisar|consultar|confirmar|notificar|decirle)\b.{{0,12}}\b({_USER})\b"
                rf"|\bno (le )?(digas|avises|menciones|informes|cuentes)\b.{{0,20}}\b({_USER})\b"),
    ("exfiltration", r"\b(envia|enviar|manda|mandar|sube|publica|reenvia|comparte)\b.{0,50}"
                     r"(https?://|\btoken\b|\bcontrasena\b|\bclave( de)? api\b|\bapi key\b|\bpassword\b|\bnumero de tarjeta\b|\bcvv\b)"),
    ("authority_framing", r"\bno (requiere|necesita)\s+(confirmacion|aprobacion|permiso)\b"
                          r"|\bsin necesidad de (confirmacion|aprobacion)\b|\bpre-?aprobad[oa]\b"),
    ("false_continuation", r"\b(el|la) (asistente|agente|sesion) anterior\b.{0,40}\b(acepto|aprobo|confirmo|ya)\b"
                           r"|\bcontinua donde (lo )?(dejo|dejaste)\b"),
    ("memory_write", r"\b(recuerda|recuerde|memoriza|guarda|almacena|remember|store|save)\b\s+(esto\s+|que\s+|this\s+|that\s+)?"
                     r"(permanentemente|para siempre|de ahora en adelante|permanently|forever|from now on)\b"
                     rf"|\b(recuerda|memoriza|guarda|remember)\b.{{0,15}}\bque\s+(el|la)\s+({_USER})\b.{{0,30}}\b(solo|siempre|nunca)\b"),
    ("prompt_extraction", r"\b(imprime|muestra|muestrame|revela|repite|dime|escribe|copia|print|show|reveal|output)\b.{0,40}"
                          r"\b(prompt (del|de) sistema|indicacion(es)? del sistema|instrucciones (del|de) sistema"
                          r"|reglas de (clasificacion|ranking|ordenamiento)|system prompt|ranking rules)\b"
                          r"|\b(prompt|indicacion|instrucciones) (del|de) sistema\b.{0,60}\b(textualmente|literalmente|al pie de la letra|verbatim)\b"),
]
PATTERNS = PATTERNS + ML_PATTERNS
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


def _fold_accents(s: str) -> str:
    """NFKD, then drop combining marks: 'añade' -> 'anade', 'indicación' -> 'indicacion'."""
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


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
    # B10: accent folding, so "añade ... al carrito" and "anade ... al carrito" are the same string.
    views["accent_folded"] = _fold_accents(views["spacing_collapsed"])
    views["accent_folded_deleet"] = views["accent_folded"].translate(_LEET)
    for i, d in enumerate(_decode_encodings(base)):
        views[f"decoded_{i}"] = d
        views[f"decoded_{i}_deleet"] = _fold_accents(_collapse_spacing(d.translate(_HOMOGLYPHS))).translate(_LEET)
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
