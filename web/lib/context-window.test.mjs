import test from "node:test";
import assert from "node:assert/strict";

import {
  callContextWindow,
  callInputTokens,
  callModel,
  callOutputTokens,
} from "./context-window.js";

test("reads context fields from db rows and normalized llm event rows", () => {
  assert.equal(callModel({ model_name: "gemini-3.5-flash" }), "gemini-3.5-flash");
  assert.equal(callModel({ model: "gemini-3.5-flash" }), "gemini-3.5-flash");
  assert.equal(callInputTokens({ input_tokens: 1200 }), 1200);
  assert.equal(callInputTokens({ inputTokens: 1300 }), 1300);
  assert.equal(callOutputTokens({ output_tokens: 80 }), 80);
  assert.equal(callOutputTokens({ outputTokens: 90 }), 90);
  assert.equal(callContextWindow({ context_window: 1048576 }), 1048576);
  assert.equal(callContextWindow({ contextWindow: 1048576 }), 1048576);
});
