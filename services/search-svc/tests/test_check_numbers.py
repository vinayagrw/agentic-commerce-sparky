"""B02: the README and web/bff code quote only numbers data/coverage.json says (scripts/check_numbers.py)."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def _load():
    spec = importlib.util.spec_from_file_location("check_numbers", ROOT / "scripts" / "check_numbers.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_readme_and_code_agree_with_coverage():
    assert _load().main() == 0


def test_mismatch_is_detected():
    cn = _load()
    assert cn.same("−0.0302", -0.0302) and not cn.same("−0.0302", -0.03428)
    assert cn.same("0.146", 0.1463)
