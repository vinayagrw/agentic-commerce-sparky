#!/usr/bin/env bash
# E2E_MODEL=haiku smoke: the @llm specs against an ISOLATED bff (:8797) + web (:5183) whose every agent role
# runs on haiku. Labelled as a haiku smoke everywhere (results file, annotation); it is NOT the demo
# configuration and its pass rate says nothing about the sonnet Shopper / Ops Copilot.
# Needs search-svc :8801, shop-http :8802, ops-http :8803 up (make dev).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${E2E_MODEL:-haiku}"
LOG="$ROOT/docs/recording"
mkdir -p "$LOG"
( cd "$ROOT/bff" && BFF_PORT=8797 AGENT_MODEL="$MODEL" SHOPPER_MODEL="$MODEL" OPS_MODEL="$MODEL" PLANNER_MODEL="$MODEL" CRITIC_MODEL="$MODEL" npx tsx src/server.ts >"$LOG/e2e-haiku-bff.log" 2>&1 ) &
BFF=$!
( cd "$ROOT/web" && BFF_PROXY=http://localhost:8797 npx vite --port 5183 --strictPort >"$LOG/e2e-haiku-web.log" 2>&1 ) &
WEB=$!
trap 'kill $BFF $WEB 2>/dev/null || true' EXIT
for i in $(seq 1 90); do curl -sf http://localhost:8797/api/health >/dev/null && curl -sf http://localhost:5183 >/dev/null && break; sleep 1; done
cd "$ROOT/web"
E2E_MODEL_LABEL="$MODEL smoke (not the demo configuration)" E2E_BASE_URL=http://localhost:5183 \
  npx playwright test --grep @llm --reporter=list "$@" \
  | tee "$LOG/e2e-haiku-smoke.log"
