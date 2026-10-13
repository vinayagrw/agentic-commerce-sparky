"""Sparky span helper for the Python services (opentelemetry-sdk + the shared JSONL writer).

One copy lives in services/shop-mcp/src/shop_mcp/sparky_trace.py (imported by shop-mcp, ops-mcp and
policy-mcp); services/search-svc/sparky_trace.py is a byte-identical copy (a test checks that).

Spans go to data/traces/YYYY-MM-DD.jsonl, the same file and line schema as bff/src/trace/jsonl.ts:
  {traceId, spanId, parentId, name, kind, service, start, end, attrs, status, events?}

Tracing here is strictly CHILD tracing: a span is only recorded when there is a parent, from an
explicit W3C traceparent (HTTP header) or the TRACEPARENT env the BFF writes into policy-mcp's
per-run MCP config. No parent -> no span, so an untraced call costs one dict lookup. TRACE_FILE=0
switches recording off entirely. Redaction mirrors bff/src/otel.ts redact(): hashes and lengths,
raw text only with OTEL_CAPTURE_CONTENT=1.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

KIND = "sparky.kind"
_PROP = TraceContextTextMapPropagator()
_provider: TracerProvider | None = None
_service = "sparky-py"


def enabled() -> bool:
    return os.environ.get("TRACE_FILE", "1") != "0"


def capture_content() -> bool:
    return os.environ.get("OTEL_CAPTURE_CONTENT") == "1"


def _repo_root() -> Path:
    for p in Path(__file__).resolve().parents:
        if (p / "Makefile").exists() and (p / "services").is_dir():
            return p
    return Path.cwd()


def trace_dir() -> Path:
    return Path(os.environ.get("SPARKY_TRACE_DIR") or _repo_root() / "data" / "traces")


def max_bytes() -> int:
    return int(float(os.environ.get("TRACE_FILE_MAX_MB", "50")) * 1024 * 1024)


def append_lines(lines: list[dict], d: Path | None = None) -> None:
    if not lines:
        return
    d = d or trace_dir()
    d.mkdir(parents=True, exist_ok=True)
    day = time.strftime("%Y-%m-%d", time.gmtime())
    f = d / f"{day}.jsonl"
    try:
        if f.exists() and f.stat().st_size > max_bytes():
            f.replace(d / f"{day}.1.jsonl")
    except OSError:
        pass  # another process rotated first
    with f.open("a") as fh:
        fh.write("".join(json.dumps(line, default=str, separators=(",", ":")) + "\n" for line in lines))


def to_line(span: Any, service: str) -> dict:
    ctx = span.get_span_context()
    attrs = dict(span.attributes or {})
    kind = str(attrs.pop(KIND, "other"))
    code = span.status.status_code.name if span.status else "UNSET"
    line = {
        "traceId": format(ctx.trace_id, "032x"),
        "spanId": format(ctx.span_id, "016x"),
        "parentId": format(span.parent.span_id, "016x") if span.parent else None,
        "name": span.name,
        "kind": kind,
        "service": str((span.resource.attributes or {}).get("service.name", service)),
        "start": round(span.start_time / 1e6, 3),
        "end": round((span.end_time or span.start_time) / 1e6, 3),
        "attrs": {k: (list(v) if isinstance(v, tuple) else v) for k, v in attrs.items()},
        "status": {"OK": "ok", "ERROR": "error"}.get(code, "unset"),
    }
    if span.events:
        line["events"] = [{"name": e.name, "t": round(e.timestamp / 1e6, 3), "attrs": dict(e.attributes or {})} for e in span.events]
    return line


class JsonlExporter(SpanExporter):
    def __init__(self, service: str):
        self.service = service

    def export(self, spans):  # noqa: D401 - SDK interface
        if not enabled():
            return SpanExportResult.SUCCESS
        try:
            append_lines([to_line(s, self.service) for s in spans])
            return SpanExportResult.SUCCESS
        except OSError:
            return SpanExportResult.FAILURE

    def shutdown(self):
        return None


def init(service: str) -> None:
    """Install the provider once per process. Safe to call repeatedly."""
    global _provider, _service
    if _provider is not None:
        return
    _service = service
    _provider = TracerProvider(resource=Resource.create({"service.name": service}))
    # Simple (synchronous) processor: policy-mcp lives for one CLI run and must not lose spans on exit.
    _provider.add_span_processor(SimpleSpanProcessor(JsonlExporter(service)))


def _tracer():
    return (_provider or TracerProvider()).get_tracer("sparky", "0.1.0")


def context_from(traceparent: str | None):
    if not traceparent:
        return None
    ctx = _PROP.extract({"traceparent": traceparent})
    return ctx if trace.get_current_span(ctx).get_span_context().is_valid else None


def _parent(traceparent: str | None):
    """Explicit traceparent, else the active span, else TRACEPARENT from the env (policy-mcp)."""
    ctx = context_from(traceparent)
    if ctx is not None:
        return ctx
    if trace.get_current_span().get_span_context().is_valid:
        return otel_context.get_current()
    return context_from(os.environ.get("TRACEPARENT"))


def clean(attrs: dict | None) -> dict:
    out = {}
    for k, v in (attrs or {}).items():
        if v is None:
            continue
        if isinstance(v, (bool, int, float)):
            out[k] = v
        elif isinstance(v, str):
            out[k] = v[:256]
        elif isinstance(v, (list, tuple)) and all(isinstance(x, (str, int, float, bool)) for x in v):
            out[k] = list(v)[:50]
    return out


class _NoSpan:
    def set_attributes(self, *_a, **_k):
        pass

    def set_attribute(self, *_a, **_k):
        pass

    def add_event(self, *_a, **_k):
        pass


@contextmanager
def span(name: str, kind: str, attrs: dict | None = None, traceparent: str | None = None, service: str | None = None) -> Iterator[Any]:
    """Record a child span of `kind`. Yields a no-op object when there is no parent or tracing is off."""
    if not enabled():
        yield _NoSpan()
        return
    parent = _parent(traceparent)
    if parent is None:
        yield _NoSpan()
        return
    init(service or _service)
    with _tracer().start_as_current_span(name, context=parent, attributes={**clean(attrs), KIND: kind},
                                         record_exception=False, set_status_on_exception=True) as s:
        yield s


def set_attrs(s: Any, attrs: dict) -> None:
    s.set_attributes(clean(attrs))


def inject_headers(headers: dict | None = None) -> dict:
    """Add a traceparent header for the active span (no-op when there is none)."""
    h = dict(headers or {})
    if trace.get_current_span().get_span_context().is_valid:
        _PROP.inject(h)
    return h


def sha16(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def redact(text: str | None, prefix: str = "sparky.prompt") -> dict:
    if not text:
        return {}
    out: dict = {f"{prefix}.sha256_16": sha16(text), f"{prefix}.chars": len(text)}
    if capture_content():
        out[f"{prefix}.text"] = text[:2000]
    return out
