# services/shop-mcp — shopper-facing commerce tools (MCP + HTTP)

Port 8802 (`shop-http`), or spawned as MCP (`stdio_client.py`). Python (uv).

## Key files
- `src/shop_mcp/server.py` — MCP tool registration.
- `src/shop_mcp/http_app.py` — HTTP wrapper (`shop-http`).
- `src/shop_mcp/tools.py`, `agent_api.py` — shopper tool implementations (search, cart, checkout).
- `src/shop_mcp/commerce.py`, `catalog_services.py` — cart/order and catalog logic.
- `src/shop_mcp/guard.py` — prompt-injection / qty-jump / budget guard checks (mirrors `bff/src/agents/guard.ts` events).
- `src/shop_mcp/injection.py` — planted-injection test fixtures (`scripts/plant_injections.py` output).
- `src/shop_mcp/db.py` — cart/session persistence.

## Commands
- Run: `SEARCH_SVC_URL=http://127.0.0.1:8801 uv run shop-http` (or `make dev`).
- Tests: `cd services/shop-mcp && uv run pytest -q`.

## Contracts
Guard event kinds (`injection`, `qty_jump`, `budget`, `capability*`, `tool_denied`) must match `bff/src/agui/bridge.ts`'s `GuardEvent["kind"]` — see `../../docs/CONTRACTS.md`.

## Don't read whole
- `.venv/` — never source.
- `conftest.py` fixtures only when a test actually fails.
