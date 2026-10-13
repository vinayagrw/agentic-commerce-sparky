"""Append-only policy event log.

Every decision the proxy makes -- allowed or refused -- is one JSON object on its own
line. The BFF tails this file so a refusal shows up in the run trace even though the
Claude CLI, not the BFF, is the MCP client.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path

_DEFAULT = Path(__file__).resolve().parents[4] / "data" / "policy_events.jsonl"


def path() -> Path:
    return Path(os.environ.get("POLICY_EVENTS_PATH") or _DEFAULT)


def log(decision: str, tool: str, role: str, args: dict, rule: str | None = None,
        reason: str | None = None, detail: dict | None = None) -> dict:
    ev = {
        "id": "pol_" + uuid.uuid4().hex[:12],
        "ts": time.time(),
        "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "decision": decision,          # "allow" | "refuse"
        "tool": tool,
        "role": role,
        "session_id": args.get("session_id"),
        "args": {k: v for k, v in args.items() if k != "_capabilities"},
        "capabilities": args.get("_capabilities") or {},
        "rule": rule,
        "reason": reason,
        "detail": detail or {},
    }
    p = path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a") as fh:
            fh.write(json.dumps(ev, default=str) + "\n")
    except OSError:
        pass  # the log is observability, never a reason to fail a tool call
    return ev


def read(session_id: str | None = None, since: float = 0.0, limit: int = 200) -> list[dict]:
    p = path()
    if not p.exists():
        return []
    out = []
    try:
        for line in p.read_text().splitlines():
            if not line.strip():
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("ts", 0) < since:
                continue
            if session_id and ev.get("session_id") not in (session_id, None):
                continue
            out.append(ev)
    except OSError:
        return []
    return out[-limit:]
