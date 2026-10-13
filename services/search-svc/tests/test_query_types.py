"""B07 rules-based query-type classifier (query_types.classify) and the use_case head-phrase rewrite."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from query_types import CLASSES, classify, rules_summary  # noqa: E402


@pytest.mark.parametrize("q,expected", [
    ("how do i clean a cast iron pan", "non_product"),
    ("is this dishwasher safe?", "non_product"),
    ("screen protector for iphone 8 plus privacy", "compatibility"),
    ("oral b crossaction replacement heads", "compatibility"),
    ("galaxy s10c", "model_number"),
    ("asus laptop charger ux305c", "model_number"),
    ("hdmi coupler female to female", "abbreviation"),
    ("compression pump & vacuum bags", "abbreviation"),
    ("beef jerky for dad", "use_case"),
    ("baby shower gifts", "use_case"),
    ("144 hz computer monitor", "attribute"),
    ("black cotton king sheets", "attribute"),
    ("dog food", "product_type"),
    ("crockpot", "product_type"),
    ("truskin vitamin c cream", "other"),
])
def test_classify_examples(q, expected):
    assert classify(q) == expected


def test_units_and_ordinals_are_not_model_numbers():
    assert classify("20oz tumbler lids") != "model_number"
    assert classify("7th generation laundry detergent") != "model_number"
    assert classify("3d sound headphones") != "model_number"


def test_total_deterministic_and_documented():
    for q in ["", "   ", "???", "a", "USB-C 2-pack for Pixel 7"]:
        assert classify(q) in CLASSES
        assert classify(q) == classify(q)
    assert [r["class"] for r in rules_summary()] == CLASSES


def test_use_case_head_phrase():
    pytest.importorskip("engine")
    from slice_fixes import head_phrase, rewrite_bm25

    assert head_phrase("blackout curtains for bathroom windows") == "blackout curtains"
    assert head_phrase("baby shower gifts") == "baby shower"
    assert head_phrase("for") == "for"
    assert rewrite_bm25("beef jerky for dad", "head_boost") == "beef jerky beef jerky beef jerky for dad"
