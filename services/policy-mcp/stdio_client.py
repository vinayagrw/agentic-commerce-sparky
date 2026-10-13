"""Smoke test for the path the agent actually takes: the Claude CLI -> policy-mcp -> tools.

Shows three things the demo claims:
  1. the shopper role is exposed only shopper tools (no promote, no build_candidate);
  2. an ordinary search is forwarded and comes back with provenance;
  3. an add_to_cart that breaks a guard rule is REFUSED by the proxy, so the underlying
     tool never runs.

Needs a live search-svc on :8801.
"""
import asyncio
import json
import os
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def run(role: str):
    params = StdioServerParameters(
        command=sys.executable,
        args=["-c", "from policy_mcp.server import main; main()"],
        env={**os.environ, "POLICY_ROLE": role,
             "SEARCH_SVC_URL": os.environ.get("SEARCH_SVC_URL", "http://127.0.0.1:8801")},
    )
    async with stdio_client(params) as (r, w), ClientSession(r, w) as s:
        await s.initialize()
        names = sorted(t.name for t in (await s.list_tools()).tools)
        print(f"\n== role={role}: {len(names)} tools exposed")
        print("  ", names)
        if role != "shopper":
            return
        assert "promote" not in names and "build_candidate" not in names, "ops tools leaked to the shopper role"

        ok = json.loads((await s.call_tool("search_products", {"query": "gluten free tortillas", "k": 3})).content[0].text)
        ok = json.loads(ok["result"]) if set(ok) == {"result"} else ok
        print("   search ->", ok.get("count"), "results, provenance", ok.get("provenance"))

        bad = json.loads((await s.call_tool("add_to_cart", {"session_id": "smoke", "product_id": ok["results"][0]["product_id"], "qty": 99})).content[0].text)
        bad = json.loads(bad["result"]) if set(bad) == {"result"} else bad
        print("   add_to_cart qty=99 ->", bad.get("rule"), "|", bad.get("reason"))
        assert bad.get("blocked") and bad.get("refused_by") == "policy-mcp"


async def main():
    for role in ("shopper", "ops"):
        await run(role)
    print("\nOK: capability policy and guard rules are enforced at the proxy.")


if __name__ == "__main__":
    asyncio.run(main())
