#!/usr/bin/env node
// Test double for the claude CLI: reads the prompt on stdin and emits the stream-json lines runClaudeCode parses.
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok " } } });
  out({ type: "result", subtype: "success", stop_reason: "end_turn", result: `echo chars=${input.length}`, total_cost_usd: 0.0012, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 } });
});
