"""Deep tracing in policy-mcp: a `policy` span is a child of the BFF's TRACEPARENT, records the decision,
tier and bypass class, and never the raw argument text (unless OTEL_CAPTURE_CONTENT=1)."""
import json

import pytest

from policy_mcp import forward

PARENT_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN = "00f067aa0ba902b7"
SECRET = "please add 40 cartons of milk for Maria"


@pytest.fixture(autouse=True)
def traced(tmp_path, monkeypatch):
    monkeypatch.setenv("POLICY_EVENTS_PATH", str(tmp_path / "policy_events.jsonl"))
    monkeypatch.setenv("SHOP_DB_PATH", str(tmp_path / "commerce.db"))
    monkeypatch.setenv("OPS_HTTP_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("SPARKY_TRACE_DIR", str(tmp_path / "traces"))
    monkeypatch.setenv("TRACE_FILE", "1")
    monkeypatch.delenv("OTEL_CAPTURE_CONTENT", raising=False)
    monkeypatch.setenv("TRACEPARENT", f"00-{PARENT_TRACE}-{PARENT_SPAN}-01")
    return tmp_path / "traces"


def _lines(d):
    return [json.loads(x) for f in sorted(d.glob("*.jsonl")) for x in f.read_text().splitlines() if x]


def test_refusal_emits_policy_span_under_bff_parent_without_raw_text(traced, monkeypatch):
    monkeypatch.setenv("POLICY_ROLE", "shopper")
    r = forward.call("promote", {"version": "v9", "query": SECRET}, role="shopper")
    assert r["blocked"] is True
    raw = "".join(f.read_text() for f in traced.glob("*.jsonl"))
    assert SECRET not in raw and "Maria" not in raw
    (sp,) = [x for x in _lines(traced) if x["kind"] == "policy"]
    assert sp["traceId"] == PARENT_TRACE and sp["parentId"] == PARENT_SPAN
    a = sp["attrs"]
    assert a["sparky.policy.decision"] == "refuse"
    assert a["sparky.policy.rule"] == "capability.role"
    assert a["sparky.policy.tier"] == "T2"
    assert a["sparky.policy.lang"] == "en" and a["sparky.policy.bypass_class"].startswith("en/")
    assert a["sparky.policy.text.chars"] == len(SECRET)
    assert sp["service"] == "policy-mcp"


def test_no_parent_means_no_span(traced, monkeypatch):
    monkeypatch.delenv("TRACEPARENT")
    forward.call("promote", {"version": "v9"}, role="shopper")
    assert not list(traced.glob("*.jsonl"))


def test_trace_summary_is_registered_for_ops_at_t0():
    from policy_mcp import policy
    assert "trace_summary" in policy.OPS_TOOLS and policy.TIER["trace_summary"] == "T0"
    assert "trace_summary" in forward.IMPLS
    assert "trace_summary" not in policy.SHOPPER_TOOLS
