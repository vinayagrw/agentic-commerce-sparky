"""Smoke test: launch shop-mcp over stdio, list its tools and call search_products.

Needs a live search-svc on :8801 (`make dev`): shop-mcp has no catalogue of its own.
Note that the Claude CLI is NOT given this server any more — it is given policy-mcp,
which proxies these tools and enforces policy first. Use services/policy-mcp/stdio_client.py
to smoke-test the path the agent actually takes.
"""
import asyncio
import os
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    params = StdioServerParameters(
        command=sys.executable,
        args=["-c", "from shop_mcp.server import main; main()"],
        env={**os.environ, "SEARCH_SVC_URL": os.environ.get("SEARCH_SVC_URL", "http://127.0.0.1:8801")},
    )
    async with stdio_client(params) as (r, w), ClientSession(r, w) as s:
        await s.initialize()
        tools = await s.list_tools()
        print("tools:", sorted(t.name for t in tools.tools))
        out = await s.call_tool("search_products", {"query": "gluten free tortillas", "k": 3})
        print(out.content[0].text[:500])


if __name__ == "__main__":
    asyncio.run(main())
