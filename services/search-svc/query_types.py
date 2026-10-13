"""Deterministic, rules-based ESCI query-type classifier (no LLM, no model, no data lookups).

Used by scripts/slice_report.py to slice held-out NDCG@10 by query type. Rules are evaluated in
the fixed priority order of RULES below; the FIRST rule that fires wins, so every query gets exactly
one class. The classifier has NOT been validated against human labels.

Classes (priority order):
  non_product   question / informational / navigational phrasing, not a product request
                (starts with how/what/why/when/where/who/which/can/does/is/are/should, or ends in "?")
  compatibility the product must fit another product: "for iphone 12", "compatible with",
                "replacement for", "fits", "works with", "<x> replacement <y>" or "for <brand-ish device>"
  model_number  contains a SKU/model token: a token mixing letters and digits ("s10c", "b07xyz",
                "rtx3080") or a hyphenated alnum code ("wh-1000xm4"), or a digit run of >= 4 not followed
                by a unit (so "1000 piece" is attribute, "4108" is model)
  abbreviation  a short all-consonant/letter token that reads as an acronym or symbol (usb, hdmi, led,
                ssd, xl, 4k-style handled above), or the query contains a symbol (& + # % $ / " ')
  use_case      purpose/recipient phrasing: "gift for", "for camping", "for kids", "for men",
                "for college", "for sleep", "for travel", ... (a "for <X>" where X is a person/activity
                noun from USE_CASE_TARGETS), or "gifts"
  attribute     attribute-heavy: >= 1 number+unit ("20 ounce", "144 hz", "4 slice") OR >= 2 attribute
                words (colour, material, size, pattern, dietary) - see ATTRIBUTE_WORDS
  product_type  short generic request: 1-2 tokens, none of the above (e.g. "dog food", "crockpot")
  other         everything else (typically brand + product, 3+ word descriptive queries)
"""
from __future__ import annotations

import re

CLASSES = ["non_product", "compatibility", "model_number", "abbreviation", "use_case", "attribute",
           "product_type", "other"]

QUESTION_START = {"how", "what", "why", "when", "where", "who", "which", "can", "does", "do", "is", "are",
                  "should", "best way", "whats", "what's"}
COMPAT_PATTERNS = [
    r"\bcompatible\b", r"\bcompatibility\b", r"\bfits\b", r"\bworks? with\b", r"\breplacement\b",
    r"\brefills?\b", r"\bfor (?:the )?(?:iphone|ipad|ipod|galaxy|samsung|pixel|macbook|mac|kindle|switch|"
    r"nintendo|ps[345]|xbox|airpods|apple watch|fitbit|dyson|roomba|keurig|instant pot|kitchenaid|"
    r"ninja|vitamix|canon|nikon|sony|gopro|surface|chromebook|dell|hp|lenovo|toyota|honda|ford|jeep|"
    r"tesla|echo|alexa|ring|nespresso|cricut|tv|car|truck)\b",
]
USE_CASE_TARGETS = (
    "men|man|women|woman|kids?|children|child|boys?|girls?|toddlers?|babies|baby|newborns?|infants?|teens?|"
    "adults?|seniors?|elderly|mom|moms|dad|dads|grandma|grandpa|him|her|dogs?|cats?|puppy|puppies|pets?|"
    "camping|hiking|travel|traveling|running|gym|workout|yoga|fishing|hunting|beach|school|college|office|"
    "work|home|kitchen|bathroom|bedroom|party|parties|wedding|christmas|halloween|birthday|sleep|sleeping|"
    "cleaning|cooking|baking|garden|gardening|outdoor|outdoors|car|shower|nursery|dorm|teachers?|nurses?|"
    "crafts?|painting|drawing|swimming|pool|summer|winter|rain|snow|pain|dry|sensitive|acne|hair|skin"
)
USE_CASE_PATTERNS = [r"\bgifts?\b", r"\bfor (?:a |the |my |your |little |big |small |large |older |young )?(?:"
                     + USE_CASE_TARGETS + r")\b", r"\bideas?\b", r"\bessentials\b"]
UNITS = (r"(?:oz|ounces?|fl|lbs?|pounds?|g|grams?|kgs?|mg|ml|l|liters?|litres?|gallons?|gal|qt|quarts?|in|inch|"
         r"inches|ft|feet|foot|cm|mm|m|meters?|yards?|hz|w|watts?|v|volts?|mah|gb|tb|mb|k|mp|pack|pk|packs|"
         r"count|ct|pcs|pieces?|piece|pc|sets?|slices?|panels?|cups?|tier|layers?|seater|person|quart|x)")
NUM_UNIT = re.compile(r"\b\d+(?:\.\d+)?\s?" + UNITS + r"\b|\b\d+(?:\.\d+)?(?:\"|')|\b\d+\s?x\s?\d+\b")
ATTRIBUTE_WORDS = {
    # colours
    "black", "white", "red", "blue", "green", "yellow", "pink", "purple", "orange", "grey", "gray", "brown",
    "beige", "gold", "silver", "navy", "teal", "clear", "rose", "tan", "cream", "ivory",
    # materials
    "cotton", "organic", "leather", "wood", "wooden", "metal", "steel", "stainless", "glass", "plastic",
    "silicone", "bamboo", "wool", "linen", "silk", "ceramic", "cast", "aluminum", "polyester", "velvet",
    "fleece", "suede", "denim", "marble", "copper", "brass", "vinyl", "rubber", "canvas", "microfiber",
    # sizes / shapes / patterns / dietary / style
    "small", "large", "medium", "mini", "big", "tall", "short", "long", "wide", "narrow", "king", "queen",
    "twin", "full", "size", "xl", "xxl", "xs", "plus", "round", "square", "rectangle", "oval", "floral",
    "striped", "plaid", "polka", "waterproof", "wireless", "portable", "adjustable", "heavy", "duty",
    "lightweight", "unscented", "scented", "fragrance", "free", "vegan", "gluten", "sugar", "keto",
    "dairy", "decaf", "extra", "soft", "hard", "thick", "thin", "matte", "glossy", "rechargeable",
}
KNOWN_ABBREV = {"usb", "hdmi", "led", "lcd", "ssd", "hdd", "ram", "cpu", "gpu", "tv", "dvd", "cd", "pc", "ac",
                "dc", "uv", "rgb", "nfc", "gps", "bpa", "spf", "cbd", "diy", "otc", "ipa", "pvc", "abs", "mct",
                "pla", "wifi", "hepa", "oled", "qled", "ps4", "ps5", "nba", "nfl", "mlb", "nhl", "ncaa", "atv",
                "rv", "suv", "edc", "ptfe", "pfoa", "aaa", "aa", "lr44", "cr2032", "hd", "uhd", "vr", "ar",
                "ev", "kn95", "n95", "b12", "d3", "k2", "xbox"}
SYMBOLS = re.compile(r"[&+#%$/\"'@!*]")
ALNUM = re.compile(r"^(?=.*[a-z])(?=.*\d)[a-z0-9\-\.]{2,}$")


def _tokens(q: str) -> list[str]:
    return re.findall(r"[a-z0-9][a-z0-9\-\.]*", q.lower())


def rule_non_product(q: str, toks: list[str]) -> bool:
    s = q.strip().lower()
    return s.endswith("?") or (bool(toks) and toks[0] in QUESTION_START) or s.startswith("best way")


def rule_compatibility(q: str, toks: list[str]) -> bool:
    s = q.lower()
    return any(re.search(p, s) for p in COMPAT_PATTERNS)


def _is_model_token(t: str) -> bool:
    t = t.strip("-.")
    if not ALNUM.match(t):
        return bool(re.fullmatch(r"\d{4,}", t))
    if NUM_UNIT.fullmatch(t):          # "20oz", "144hz", "4k" style units are attributes, not SKUs
        return False
    if re.fullmatch(r"\d+(?:st|nd|rd|th|s|d|t|in1)", t):   # ordinals / decades: "1st", "90s"
        return False
    return True


def rule_model_number(q: str, toks: list[str]) -> bool:
    s = q.lower()
    for t in toks:
        if t in KNOWN_ABBREV:
            continue
        if _is_model_token(t):
            if re.fullmatch(r"\d{4,}", t) and re.search(r"\b" + t + r"\s?" + UNITS + r"\b", s):
                continue
            return True
    return False


def rule_abbreviation(q: str, toks: list[str]) -> bool:
    return any(t in KNOWN_ABBREV for t in toks) or bool(SYMBOLS.search(q))


def rule_use_case(q: str, toks: list[str]) -> bool:
    s = q.lower()
    return any(re.search(p, s) for p in USE_CASE_PATTERNS)


def rule_attribute(q: str, toks: list[str]) -> bool:
    return bool(NUM_UNIT.search(q.lower())) or sum(t in ATTRIBUTE_WORDS for t in toks) >= 2


def rule_product_type(q: str, toks: list[str]) -> bool:
    return 1 <= len(toks) <= 2


RULES = [
    ("non_product", rule_non_product),
    ("compatibility", rule_compatibility),
    ("model_number", rule_model_number),
    ("abbreviation", rule_abbreviation),
    ("use_case", rule_use_case),
    ("attribute", rule_attribute),
    ("product_type", rule_product_type),
]


def classify(query: str) -> str:
    """Return exactly one class from CLASSES. Deterministic; first matching rule in RULES wins."""
    q = query or ""
    toks = _tokens(q)
    for name, fn in RULES:
        if fn(q, toks):
            return name
    return "other"


def rules_summary() -> list[dict]:
    """Human-readable rule list (priority order) for reports."""
    docs = {
        "non_product": "starts with a question word (how/what/why/can/does/is/...) or ends with '?'",
        "compatibility": "'compatible', 'fits', 'works with', 'replacement', 'refill', or 'for <known device/brand>'",
        "model_number": "a token mixing letters+digits (not a number+unit like 20oz/144hz, not an ordinal) or a bare 4+ digit run not followed by a unit",
        "abbreviation": "a known acronym token (usb, hdmi, led, spf, bpa, ...) or a symbol (& + # % $ / \" ')",
        "use_case": "'gift(s)', 'ideas', 'essentials', or 'for [a|my|...] <person/pet/activity/place/occasion>'",
        "attribute": ">=1 number+unit (20 ounce, 144 hz, 8 panel, 2 pack) or >=2 colour/material/size/style words",
        "product_type": "1-2 tokens and no rule above fired",
        "other": "fallback (typically brand + product or 3+ word descriptive queries)",
    }
    return [{"priority": i + 1, "class": c, "rule": docs[c]} for i, c in enumerate(CLASSES)]
