import assert from "node:assert/strict";
import { test } from "node:test";
import { authProbeOk } from "./diag.js";

const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" });

test("a clean result line is healthy", () => {
  assert.equal(authProbeOk(result, 0), true);
});

test("a diagnostic line AFTER the result does not read as logged out (CLI 2.1.246)", () => {
  const out = `${result}\nClient.listTools() called but server does not advertise tools capability - returning empty list`;
  assert.equal(authProbeOk(out, 0), true);
});

test("an error result, a non-zero exit, or no result line at all is not healthy", () => {
  assert.equal(authProbeOk(JSON.stringify({ type: "result", is_error: true }), 0), false);
  assert.equal(authProbeOk(result, 1), false);
  assert.equal(authProbeOk("Invalid API key · Please run /login", 1), false);
  assert.equal(authProbeOk("", 0), false);
});
