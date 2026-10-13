import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against LIVE services (nothing mocked). Default baseURL is http://localhost:5173 (`make dev`'s web port);
 * override with E2E_BASE_URL, e.g. the isolated haiku-smoke ports used by `make e2e-smoke-haiku`:
 *   search-svc 8811, shop-http 8812, bff 8797 (SEARCH_SVC_URL/SHOP_HTTP_URL pointed at them), web 5183 (BFF_PROXY=http://localhost:8797).
 * @agent specs run real Claude CLI turns: slow, and they need `claude` logged in.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // PW_WORKERS/PW_RETRIES let a caller trade isolation for speed without editing this file.
  // Defaults stay 2 workers / 0 retries: the specs share one live stack (cart, ops.db, registry),
  // so raising workers is only safe for read-only @nollm runs. E2E_RESULTS keeps two concurrent
  // runs (e.g. two agents) from writing the same artefact folder.
  fullyParallel: false,
  workers: Number(process.env.PW_WORKERS ?? 2),
  retries: Number(process.env.PW_RETRIES ?? 0),
  // PW_QUIET picks the dot reporter WITHOUT dropping the JSON one. Passing --reporter=dot on the
  // command line replaces this whole list, which silently stopped docs/recording/e2e-results.json
  // (the artefact the Guide's pass/fail badges read) from ever refreshing. PW_JSON sends a partial
  // run's report somewhere else so it cannot overwrite the canonical full-suite artefact.
  reporter: [[process.env.PW_QUIET ? "dot" : "list"], ["json", { outputFile: process.env.PW_JSON ?? "../docs/recording/e2e-results.json" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  outputDir: process.env.E2E_RESULTS ?? "../.e2e-results",
});
