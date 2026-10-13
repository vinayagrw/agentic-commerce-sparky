"""Smoke test: launch ops-mcp over stdio, list tools, run drift -> propose remediation -> build (blocked) -> audit.
Needs search-svc on :8801."""
import asyncio
import json
import os
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HERE = Path(__file__).parent


async def main():
    params = StdioServerParameters(command="uv", args=["--directory", str(HERE), "run", "ops-mcp"], env={**os.environ})
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            tools = await s.list_tools()
            print("TOOLS:", [t.name for t in tools.tools])

            async def call(name, args):
                res = json.loads((await s.call_tool(name, args)).content[0].text)
                print(f"\n== {name} ->", json.dumps(res)[:500])
                return res

            d = await call("compute_drift", {"stream": "seasonal"})
            p = await call("propose_remediation", {"alert_id": d.get("alert_id") or "latest"})
            if p.get("proposals"):
                await call("build_candidate", {"remediation_id": p["proposals"][0]["remediation_id"]})
            await call("get_audit_log", {"limit": 5})


asyncio.run(main())
