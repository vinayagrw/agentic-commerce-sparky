"""Static scan of shop_mcp/**.py: nothing can ever say a payment happened, or hold a card number."""
from __future__ import annotations

import ast
import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "shop_mcp"
MODULES = sorted(SRC.rglob("*.py"))
# Column names that could hold a card number. `number`/`card` are included so a future column
# cannot sneak one in under a vaguer name either.
PAN_COLUMN_WORDS = ("pan", "card_number", "cardnumber", "cardno", "card_no", "ccnum", "credit_card",
                    "number", "card", "cvv", "cvc", "security_code")
CREATE_TABLE = re.compile(r"CREATE TABLE(?: IF NOT EXISTS)? (\w+)\s*\((.*?)\);", re.S | re.I)
ADD_COLUMN = re.compile(r"ADD COLUMN\s+(\w+)", re.I)


def test_modules_are_found():
    assert len(MODULES) >= 10 and (SRC / "payments.py") in MODULES


def test_every_payment_executed_assignment_is_false():
    """Covers both `"payment_executed": x` in a dict literal and `payment_executed=x` as a keyword."""
    seen = 0
    for path in MODULES:
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Dict):
                for key, value in zip(node.keys, node.values):
                    if isinstance(key, ast.Constant) and key.value == "payment_executed":
                        seen += 1
                        assert isinstance(value, ast.Constant) and value.value is False, \
                            f"{path.name}:{value.lineno} payment_executed is not the literal False"
            elif isinstance(node, ast.keyword) and node.arg == "payment_executed":
                seen += 1
                assert isinstance(node.value, ast.Constant) and node.value.value is False, \
                    f"{path.name}:{node.value.lineno}"
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                for tgt in (node.targets if isinstance(node, ast.Assign) else [node.target]):
                    if isinstance(tgt, ast.Subscript) and isinstance(tgt.slice, ast.Constant) \
                            and tgt.slice.value == "payment_executed":
                        seen += 1
                        assert isinstance(node.value, ast.Constant) and node.value.value is False, \
                            f"{path.name}:{node.lineno}"
    assert seen >= 15, f"only {seen} payment_executed literals found; the scan is not covering the code"


def test_payment_executed_true_appears_nowhere():
    for path in MODULES:
        text = path.read_text()
        assert not re.search(r"payment_executed[\"']?\s*[:=]\s*True", text), path.name
        assert "payment_executed=True" not in text, path.name


def test_no_module_declares_a_pan_or_card_number_column():
    for path in MODULES:
        text = path.read_text()
        for table, cols in CREATE_TABLE.findall(text):
            for decl in cols.split(","):
                name = decl.strip().split()[0].lower() if decl.strip() else ""
                assert name not in PAN_COLUMN_WORDS, f"{path.name}: {table}.{name}"
        for added in ADD_COLUMN.findall(text):
            assert added.lower() not in PAN_COLUMN_WORDS, f"{path.name}: ADD COLUMN {added}"


def test_the_only_card_numbers_are_the_frozen_allowlist_keys():
    """A 13-19 digit run may appear only as a key of payments.TEST_CARDS."""
    from shop_mcp import payments

    allowed = set(payments.TEST_CARDS)
    for path in MODULES:
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            for run in re.findall(r"\d{13,19}", line):
                assert path.name == "payments.py" and run in allowed, f"{path.name}:{lineno} {run[:2]}..."
    assert len(allowed) == 7


def test_user_facing_strings_never_claim_a_payment_happened():
    """"charged", "paid" and "transaction" are banned; the demo only ever simulates an authorisation."""
    banned = re.compile(r"\b(charged|charging|paid|transaction|transactions|settled|settlement)\b", re.I)
    exempt = {"injection.py"}  # prompt-injection detector patterns, not user-facing copy
    for path in MODULES:
        if path.name in exempt:
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                hit = banned.search(node.value)
                # Docstrings are developer-facing; the ban is on strings that can reach a user.
                assert not hit or _is_docstring(path, node), f"{path.name}:{node.lineno} {hit.group(0)!r}"


_DOCSTRING_LINES: dict[str, set[int]] = {}


def _is_docstring(path: Path, node: ast.Constant) -> bool:
    lines = _DOCSTRING_LINES.get(path.name)
    if lines is None:
        lines = set()
        tree = ast.parse(path.read_text())
        for n in ast.walk(tree):
            if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                d = ast.get_docstring(n, clean=False)
                if d is not None:
                    lines.add(n.body[0].value.lineno)
        _DOCSTRING_LINES[path.name] = lines
    return node.lineno in lines


def test_simulated_authorisation_is_the_wording_used():
    from shop_mcp import payments, storefront

    assert "simulated authorisation" in payments.SYNTHETIC_LABEL
    assert "no payment is executed" in payments.SYNTHETIC_LABEL
    assert "simulated" in storefront.FULFILMENT_LABEL and "simulated" in storefront.TENDER_LABEL


def test_every_new_payload_carries_a_synthetic_label():
    from shop_mcp import accounts, payments, storefront
    from _flow import bind, fill_cart, preview

    bind("s_lbl", "acct_maya")
    fill_cart("s_lbl", ("W-900002", 1))
    payloads = [accounts.list_accounts(), accounts.get_account("acct_maya"),
                accounts.payment_methods("acct_maya"), accounts.addresses("acct_maya"),
                accounts.get_payment_method("pm_maya_visa"), accounts.get_address("adr_maya_home"),
                payments.test_cards(), preview("s_lbl", ["pm_maya_visa"]),
                storefront.fulfilment_state(0.0, 0.0)]
    for p in payloads:
        assert p.get("synthetic_label") or p.get("label"), p.keys()
