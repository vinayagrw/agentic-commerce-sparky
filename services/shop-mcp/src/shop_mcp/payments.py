"""Simulated payment authorisation. NO PAYMENT IS EVER EXECUTED AND NO MONEY EVER MOVES.

`payment_executed` is False on every path in this module and in everything that calls it. The only
outcome this simulator can produce is a *simulated authorisation*: a deterministic decision plus an
opaque `auth_ref`. No money moves, no provider is contacted, no clearing or settlement exists.

No card number anywhere
-----------------------
`TEST_CARDS` below is a frozen allowlist keyed by the card networks' *published* test numbers. It is
the only place in this codebase where such digits appear. Adding a payment method posts a `number`,
this module looks it up, and the caller discards it: `brand`, `last4`, `kind` and `outcome` all come
from `CARD_PROFILES`, never from the input. A number outside the allowlist raises `UnknownTestCard`,
whose message and payload never echo the digits that were posted - not in a response body, not in a
DB row, not in the audit table, not in a log line.
"""
from __future__ import annotations

import hashlib
import time
import uuid
from types import MappingProxyType

SYNTHETIC_LABEL = "simulated authorisation only - no payment is executed and no funds move (demo)"
TENDER_LABEL = ("demo EBT/gift account defined by this environment - not issued by anyone, "
                "not a published test instrument, and not usable anywhere")
CARD_LABEL = "published network test card number - accepted by this demo only; no money ever moves"

STEP_UP_CODE = "000000"  # fixed demo code; there is nothing to protect
STEP_UP_MAX_ATTEMPTS = 3
STEP_UP_TTL_S = 180

# Profiles hold everything a stored payment method needs. `last4` lives HERE, not in any input.
CARD_PROFILES = MappingProxyType({
    "visa_approved": {"brand": "visa", "kind": "credit", "last4": "4242", "outcome": "approved",
                      "balance": None, "exp_month": 12, "exp_year": 2030},
    "mastercard_approved": {"brand": "mastercard", "kind": "credit", "last4": "4444", "outcome": "approved",
                            "balance": None, "exp_month": 11, "exp_year": 2031},
    "amex_approved": {"brand": "amex", "kind": "credit", "last4": "0005", "outcome": "approved",
                      "balance": None, "exp_month": 10, "exp_year": 2029},
    "visa_declined": {"brand": "visa", "kind": "credit", "last4": "0002", "outcome": "declined",
                      "balance": None, "exp_month": 12, "exp_year": 2030},
    "visa_debit_insufficient": {"brand": "visa", "kind": "debit", "last4": "9995",
                                "outcome": "insufficient_funds", "balance": 25.00,
                                "exp_month": 9, "exp_year": 2030},
    "visa_step_up": {"brand": "visa", "kind": "credit", "last4": "3220", "outcome": "step_up",
                     "balance": None, "exp_month": 8, "exp_year": 2030},
    "visa_expired": {"brand": "visa", "kind": "credit", "last4": "0069", "outcome": "expired",
                     "balance": None, "exp_month": 1, "exp_year": 2020},
})

# Frozen allowlist: published provider test numbers -> profile id. The ONLY digits in the codebase.
TEST_CARDS = MappingProxyType({
    "4242424242424242": "visa_approved",
    "5555555555554444": "mastercard_approved",
    "378282246310005": "amex_approved",
    "4000000000000002": "visa_declined",
    "4000000000009995": "visa_debit_insufficient",
    "4000000000003220": "visa_step_up",
    "4000000000000069": "visa_expired",
})

# EBT SNAP and gift balances are NOT cards. They are not published test instruments and must never be
# described as one: they exist only in this environment.
DEMO_TENDERS = MappingProxyType({
    "ebt_snap": {"kind": "ebt_snap", "brand": None, "last4": None, "outcome": "approved",
                 "requires_balance": True, "label": TENDER_LABEL,
                 "display": "EBT SNAP (demo balance)"},
    "gift": {"kind": "gift", "brand": None, "last4": None, "outcome": "approved",
             "requires_balance": True, "label": TENDER_LABEL, "display": "Gift balance (demo)"},
})
CARD_KINDS = ("credit", "debit")
TENDER_KINDS = tuple(DEMO_TENDERS)
ALL_KINDS = CARD_KINDS + TENDER_KINDS

DECLINE_REASONS = MappingProxyType({
    "declined": "The simulated authorisation was declined by the demo issuer.",
    "insufficient_funds": "The simulated authorisation was declined: the demo balance on this "
                          "instrument is lower than the amount requested.",
    "expired": "This payment method is past its expiry date, so no simulated authorisation was attempted.",
})


class UnknownTestCard(ValueError):
    """Raised for any number outside the frozen allowlist. Never carries the posted digits."""

    def __init__(self) -> None:
        super().__init__("that number is not in this demo's frozen test-card allowlist")
        self.accepted = accepted_cards()


def accepted_cards() -> list[dict]:
    """The published test numbers this demo accepts, for the 422 body and the operator UI."""
    return [{"number": published, **{k: CARD_PROFILES[prof][k] for k in ("brand", "kind", "last4", "outcome", "balance")},
             "profile": prof, "label": CARD_LABEL}
            for published, prof in TEST_CARDS.items()]


def test_cards() -> dict:
    return {"cards": accepted_cards(), "tenders": [dict(v) for v in DEMO_TENDERS.values()],
            "note": "Card numbers are the networks' published test values. EBT SNAP and gift balances are "
                    "not cards and are not published test instruments: they are defined by this environment only.",
            "step_up_code": STEP_UP_CODE, "payment_executed": False, "synthetic_label": SYNTHETIC_LABEL}


def lookup_card(number) -> dict:
    """Allowlist lookup. The caller MUST discard `number` immediately after this returns."""
    digits = "".join(ch for ch in str(number or "") if ch.isdigit())
    profile_id = TEST_CARDS.get(digits)
    del digits, number
    if profile_id is None:
        raise UnknownTestCard()
    return {"profile": profile_id, **CARD_PROFILES[profile_id], "label": CARD_LABEL}


def token_for(pm_id: str) -> str:
    """Opaque synthetic token derived from the pm_id alone - never from any number."""
    return "tok_" + hashlib.sha256(f"sparky-demo-token|{pm_id}".encode()).hexdigest()[:16]


def auth_ref(mandate_id: str, pm_ids, amount: float) -> str:
    """Deterministic: no RNG, no clock, no model. Same (mandate, tender, amount) -> same ref."""
    ids = ",".join(sorted(str(p) for p in pm_ids))
    return "auth_" + hashlib.sha256(f"{mandate_id}|{ids}|{amount:.2f}".encode()).hexdigest()[:10]


def _leg_decision(leg: dict) -> tuple[str, str | None]:
    """Pure per-instrument outcome. `leg` is a resolved payment method plus its `amount`."""
    outcome = leg.get("outcome") or "approved"
    amount = round(float(leg.get("amount") or 0.0), 2)
    if outcome == "expired":
        return "refused", "expired"
    if outcome == "declined":
        return "declined", "declined"
    if outcome == "insufficient_funds":
        bal = leg.get("balance")
        if bal is not None and amount > round(float(bal), 2) + 1e-9:
            return "declined", "insufficient_funds"
        return "approved", None
    if outcome == "step_up":
        return "step_up", None
    return "approved", None


def authorize(mandate: dict, tender: list[dict], cart_lines: list[dict] | None = None,
              eligibility: dict | None = None) -> dict:
    """Simulate an authorisation for `tender` against `mandate`. Never executes a payment.

    `tender` legs are resolved payment methods (from accounts.resolve_tender) each carrying `amount`.
    The decision is a pure function of the legs' frozen profiles and the amounts - no RNG, no clock.
    """
    mandate_id = mandate.get("mandate_id") or ""
    amount = round(sum(round(float(l.get("amount") or 0.0), 2) for l in tender), 2)
    pm_ids = [l["pm_id"] for l in tender]
    base = {"mandate_id": mandate_id, "amount": amount, "currency": "USD",
            "tender": [{"pm_id": l["pm_id"], "kind": l.get("kind"), "brand": l.get("brand"),
                        "last4": l.get("last4"), "amount": round(float(l.get("amount") or 0.0), 2),
                        "label": l.get("label")} for l in tender],
            "payment_executed": False, "synthetic_label": SYNTHETIC_LABEL,
            "note": "Simulated authorisation only. No payment is executed at any point."}
    if eligibility is not None and eligibility.get("ok") is False:
        return {**base, "decision": "refused", "reason": "eligibility_unverified",
                "message": eligibility.get("message") or "Eligibility could not be verified for every line.",
                "refusals": eligibility.get("refusals") or []}
    if not tender:
        return {**base, "decision": "refused", "reason": "no_tender",
                "message": "No payment instrument was selected, so no simulated authorisation was attempted."}

    for leg in tender:
        decision, reason = _leg_decision(leg)
        if decision == "refused":
            return {**base, "decision": "refused", "reason": reason, "pm_id": leg["pm_id"],
                    "message": DECLINE_REASONS[reason]}
        if decision == "declined":
            return {**base, "decision": "declined", "reason": reason, "pm_id": leg["pm_id"],
                    "message": DECLINE_REASONS[reason],
                    "balance": leg.get("balance") if reason == "insufficient_funds" else None}
        if decision == "step_up":
            expires_at = min(int(time.time()) + STEP_UP_TTL_S, int(mandate.get("expires_at") or 0) or
                             int(time.time()) + STEP_UP_TTL_S)
            return {**base, "decision": "step_up_required", "reason": "step_up", "pm_id": leg["pm_id"],
                    "step_up": {"step_up_id": "stp_" + uuid.uuid4().hex[:12], "pm_id": leg["pm_id"],
                                "amount": round(float(leg.get("amount") or 0.0), 2),
                                "code": STEP_UP_CODE, "attempts": 0, "max_attempts": STEP_UP_MAX_ATTEMPTS,
                                "expires_at": expires_at, "status": "pending",
                                "prompt": "Enter the 6-digit demo verification code to continue the "
                                          "simulated authorisation.",
                                "demo_code_note": f"This demo always uses {STEP_UP_CODE}."},
                    "message": "The demo issuer asked for a verification step before the simulated "
                               "authorisation can be completed."}
    return {**base, "decision": "approved", "reason": None, "auth_ref": auth_ref(mandate_id, pm_ids, amount),
            "message": "Simulated authorisation succeeded. No payment was executed."}
