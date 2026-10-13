"""search-svc's span helper must stay byte-identical to the shared copy in shop-mcp, and a traced /search
records a retrieval span with per-leg counts and never the raw query."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))


def test_sparky_trace_is_identical_to_shop_mcp_copy():
    ours = (HERE / "sparky_trace.py").read_bytes()
    shared = (HERE.parent / "shop-mcp" / "src" / "shop_mcp" / "sparky_trace.py").read_bytes()
    assert ours == shared


def test_child_span_written_only_with_parent(tmp_path, monkeypatch):
    import sparky_trace

    monkeypatch.setenv("SPARKY_TRACE_DIR", str(tmp_path))
    monkeypatch.setenv("TRACE_FILE", "1")
    monkeypatch.delenv("TRACEPARENT", raising=False)
    with sparky_trace.span("retrieval search", "retrieval") as sp:
        sparky_trace.set_attrs(sp, {"x": 1})
    assert not list(tmp_path.glob("*.jsonl"))
    tp = "00-" + "ab" * 16 + "-" + "cd" * 8 + "-01"
    with sparky_trace.span("retrieval search", "retrieval", traceparent=tp, service="search-svc") as sp:
        sparky_trace.set_attrs(sp, {**sparky_trace.redact("secret shopper words", "sparky.retrieval.query"), "sparky.retrieval.bm25_count": 3})
    raw = "".join(f.read_text() for f in tmp_path.glob("*.jsonl"))
    assert "secret shopper words" not in raw
    (line,) = [json.loads(x) for x in raw.splitlines()]
    assert line["traceId"] == "ab" * 16 and line["parentId"] == "cd" * 8 and line["kind"] == "retrieval"
    assert line["attrs"]["sparky.retrieval.bm25_count"] == 3
