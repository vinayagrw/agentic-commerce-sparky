#!/usr/bin/env bash
# Runs every unit-test suite, printing one pass/fail summary line per suite.
# On failure, prints only the FIRST failing suite's raw output (not all of them),
# to keep agent context small. Does not change test behavior, only reporting.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILED_NAME=""
FAILED_OUT=""
OVERALL=0

run_suite() {
  local name="$1"; shift
  local out rc
  out="$("$@" 2>&1)"
  rc=$?
  if [ $rc -eq 0 ]; then
    local n
    n=$(printf '%s\n' "$out" | grep -Eio '[0-9]+ passing' | head -1)
    echo "PASS  $name  ${n:-ok}"
  else
    echo "FAIL  $name  (exit $rc)"
    OVERALL=1
    if [ -z "$FAILED_NAME" ]; then
      FAILED_NAME="$name"
      FAILED_OUT="$out"
    fi
  fi
}

run_suite "bff unit"        npm run test:unit --workspace bff
run_suite "search-svc pytest" bash -c 'cd services/search-svc && uv run pytest -q'
run_suite "shop-mcp pytest"   bash -c 'cd services/shop-mcp && uv run pytest -q'
run_suite "policy-mcp pytest" bash -c 'cd services/policy-mcp && uv run pytest -q'
if [ -d services/ops-mcp/tests ]; then
  run_suite "ops-mcp pytest" bash -c 'cd services/ops-mcp && uv run pytest -q'
fi

echo "---"
if [ $OVERALL -ne 0 ]; then
  echo "First failure: $FAILED_NAME"
  echo "$FAILED_OUT" | tail -60
fi
exit $OVERALL
