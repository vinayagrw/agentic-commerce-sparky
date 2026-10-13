SHELL := /bin/bash
export PATH := $(HOME)/.local/bin:$(PATH)
ROOT := $(shell pwd)

.PHONY: setup data dev eval test diag typecheck policy-smoke sota smoke-sota coverage-build e2e e2e-fast e2e-llm e2e-smoke-haiku e2e-agent e2e-batch e2e-affected token-bench test-quiet eval-ci docs-check

setup: ## Install JS deps, Python envs, fetch + index data
	npm install
	cd services/search-svc && uv sync
	cd services/shop-mcp && uv sync
	@if [ -d services/ops-mcp ]; then cd services/ops-mcp && uv sync; fi
	cd services/policy-mcp && uv sync
	$(MAKE) data

data:
	cd services/search-svc && uv run python ../../scripts/fetch_data.py
	cd services/search-svc && uv run python ../../scripts/build_index.py
	cd services/search-svc && uv run python ../../scripts/plant_injections.py   # beat 7: injected seller text in the real catalog

# ~/.npm is root-owned on this laptop: use a user-writable cache for every npm/npx call.
NPM_CACHE ?= $(HOME)/.npm-cache-sparky
export npm_config_cache := $(NPM_CACHE)

# policy-mcp has no port: the Claude CLI spawns it per run as its only MCP server.
dev: ## search-svc :8801, shop-http :8802, ops-http :8803, bff :8787, web :5173
	npx --cache $(NPM_CACHE) concurrently -k -n search,shop,ops,bff,web -c magenta,yellow,cyan,blue,green \
	  "cd services/search-svc && uv run uvicorn app:app --host 127.0.0.1 --port 8801" \
	  "cd services/shop-mcp && SEARCH_SVC_URL=http://127.0.0.1:8801 uv run shop-http" \
	  "cd services/ops-mcp && SEARCH_SVC_URL=http://127.0.0.1:8801 uv run ops-http" \
	  "npm run dev:bff" \
	  "npm run dev:web"

eval: ## CI gate: NDCG@10 paired CI vs champion + p95 + red team + agent pass^k (k=3); exit 1 on fail
	cd services/ops-mcp && uv run python ../../scripts/run_evals.py $(EVAL_ARGS)

EVAL_BASELINE ?= rrf_rerank
EVAL_CANDIDATE ?= rrf_rerank
eval-ci: ## MLO9 golden-set regression gate (live search-svc): exit 1 if EVAL_CANDIDATE newly fails more golden queries than it fixes
	cd services/ops-mcp && uv run --quiet python -m ops_mcp.mlops_top10 eval-ci '{"baseline":"$(EVAL_BASELINE)","candidate":"$(EVAL_CANDIDATE)"}'

ops: ## MLOps plane: ops-http :8803 (approvals, audit, guardrail watcher). search-svc must run on :8801
	cd services/ops-mcp && SEARCH_SVC_URL=http://127.0.0.1:8801 uv run ops-http

test: ## Targeted unit tests only (full CLI suites hang, see trust-graph RUNBOOK)
	npm run test:unit
	cd services/search-svc && uv run pytest -q
	cd services/shop-mcp && uv run pytest -q
	cd services/policy-mcp && uv run pytest -q
	@if [ -d services/ops-mcp/tests ]; then cd services/ops-mcp && uv run pytest -q; fi

tracing: ## Technique 29: local Jaeger for the BFF's OTel GenAI spans (UI http://127.0.0.1:16686)
	docker compose up -d jaeger
	@echo "now run the BFF with OTEL_ENABLED=1, e.g.  OTEL_ENABLED=1 npm run dev:bff"

coverage: ## Regenerate data/technique_coverage.json from live services (needs make dev + make tracing)
	cd services/ops-mcp && SEARCH_SVC_URL=http://127.0.0.1:8801 uv run python ../../scripts/technique_coverage.py

sota: ## Techniques 8/9/10: measure on the real held-out ESCI set -> services/search-svc/SOTA_MEASURED.json
	cd services/search-svc && uv run python ../../scripts/measure_techniques.py $(SOTA_ARGS)

smoke-sota: ## Fast honesty check: rebuild data/coverage.json and fail if any real-* claim has no resolvable code reference
	cd services/search-svc && uv run python ../../scripts/build_coverage.py
	python3 scripts/check_numbers.py   # B02: README + web/bff numbers must match data/coverage.json

coverage-build: smoke-sota ## Alias: merge the three sources into the canonical data/coverage.json

typecheck:
	npm run typecheck

diag:
	@curl -s http://127.0.0.1:8787/api/diag | python3 -m json.tool

policy-smoke: ## Prove the tool path: policy-mcp exposes only the role's tools and refuses a guard violation
	cd services/policy-mcp && SEARCH_SVC_URL=http://127.0.0.1:8801 uv run python stdio_client.py

# ---------------- E2E (live stack from `make dev`; nothing mocked) ----------------
E2E_BASE_URL ?= http://localhost:5173

e2e: ## Full Playwright suite (phase gates). The ONLY target that refreshes docs/recording/e2e-results.json, which feeds the Guide's spec badges
	cd web && E2E_BASE_URL=$(E2E_BASE_URL) npx playwright test $(E2E_ARGS)

e2e-fast: ## @nollm specs only: no Claude turns, seconds per spec
	cd web && E2E_BASE_URL=$(E2E_BASE_URL) npx playwright test --grep @nollm $(E2E_ARGS)

e2e-llm: ## @llm specs only: real Claude CLI turns (slow, costs money)
	cd web && E2E_BASE_URL=$(E2E_BASE_URL) npx playwright test --grep @llm $(E2E_ARGS)

e2e-smoke-haiku: ## @llm specs on an isolated bff/web (8797/5183) with EVERY role on haiku. Labelled haiku smoke, not the demo config
	E2E_MODEL=$${E2E_MODEL:-haiku} scripts/e2e_haiku_smoke.sh $(E2E_ARGS)

token-bench: ## Phase 2 token bench: 10 shopper turns + 5 ops prompts, live -> docs/evidence/token_bench_$(LABEL).json
	cd bff && npx tsx ../scripts/token_bench.ts --label $(LABEL)

test-quiet: ## All unit-test suites, one pass/fail line each; only first failure's detail on error
	@bash scripts/test-quiet.sh

e2e-agent: ## What a build agent runs: @nollm only, dot reporter, own results dir (safe alongside another agent). ~4.5 min
	cd web && E2E_BASE_URL=$(E2E_BASE_URL) E2E_RESULTS=../.e2e-results-$${AGENT:-a} PW_QUIET=1 PW_JSON=../.e2e-results-$${AGENT:-a}/report.json npx playwright test --grep @nollm $(E2E_ARGS)

e2e-batch: ## End-of-wave: @llm specs once, one retry so a flake reruns itself instead of costing an agent turn
	cd web && E2E_BASE_URL=$(E2E_BASE_URL) PW_RETRIES=1 PW_QUIET=1 PW_JSON=../.e2e-results-llm/report.json npx playwright test --grep @llm $(E2E_ARGS)

e2e-affected: ## Playwright, dot reporter, only the named specs: make e2e-affected SPECS="a b"
	cd web && E2E_BASE_URL=$(E2E_BASE_URL) PW_QUIET=1 PW_JSON=../.e2e-results/affected.json npx playwright test $(foreach s,$(SPECS),e2e/$(s).ts)

docs-check: ## Validate docs/features.json against USER_STORIES.md and e2e specs; exit 1 on drift
	python3 scripts/build_features_json.py --check
	python3 scripts/check_diagram_freshness.py
