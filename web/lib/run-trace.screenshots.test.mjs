import test from "node:test";
import assert from "node:assert/strict";

import { collectScreenshotUrls } from "./run-trace.js";
import { extractToolCalls } from "./run-trace.js";

function toList(value) {
  return Array.from(collectScreenshotUrls(value, new Set()));
}

test("extracts screenshot_url from escaped result_full JSON", () => {
  const payload = {
    result_full:
      '{"context_type":"landing","screenshot_url":"https://res.cloudinary.com/demo/image/upload/v1/live-a.png","candidates":{"content_urls":["https://api.ppv.to/assets/thumb/ignored.jpg"]}}',
  };
  const urls = toList(payload);
  assert.deepEqual(urls, [
    "https://res.cloudinary.com/demo/image/upload/v1/live-a.png",
  ]);
});

test("extracts screenshot from content text wrapper", () => {
  const payload = {
    content: [
      {
        type: "text",
        text: '{"screenshot":"data:image/png;base64,AAAA"}',
      },
    ],
  };
  const urls = toList(payload);
  assert.deepEqual(urls, ["data:image/png;base64,AAAA"]);
});

test("carries agent invocation attribution onto screenshot tool calls", () => {
  const events = [
    {
      seq: 1,
      actor: "hosting",
      kind: "tool_call_started",
      agent_run_id: 42,
      details: {
        agent_type: "hosting_page",
        invocation_index: 2,
        tool_call_id: "call-1",
        tool_name: "inspect_hosting",
        tool_args: { url: "https://example.test/watch/1" },
      },
    },
    {
      seq: 2,
      actor: "hosting",
      kind: "tool_call_finished",
      agent_run_id: 42,
      details: {
        agent_type: "hosting_page",
        invocation_index: 2,
        tool_call_id: "call-1",
        tool_name: "inspect_hosting",
        result_full: '{"screenshot_url":"https://res.cloudinary.com/demo/image/upload/v1/hosting.png"}',
      },
    },
  ];
  const calls = extractToolCalls(events);
  assert.equal(calls[0].agentRunId, 42);
  assert.equal(calls[0].invocationIndex, 2);
  assert.deepEqual(calls[0].screenshots, [
    "https://res.cloudinary.com/demo/image/upload/v1/hosting.png",
  ]);
});

test("does not treat content_urls image links as screenshots", () => {
  const payload = {
    candidates: {
      content_urls: [
        "https://api.ppv.to/assets/thumb/99b8ff8b7419cb571fc4a30b51ea82a00-thumbnail.jpg",
      ],
    },
  };
  const urls = toList(payload);
  assert.equal(urls.length, 0);
});

test("supports inspect variant top-level screenshot_url", () => {
  const variants = [
    { context_type: "inspect", screenshot_url: "https://res.cloudinary.com/demo/image/upload/v1/inspect.png" },
    { context_type: "landing", screenshot_url: "https://res.cloudinary.com/demo/image/upload/v1/landing.png" },
    { context_type: "hosting", screenshot_url: "https://res.cloudinary.com/demo/image/upload/v1/hosting.png" },
    { context_type: "embedded", screenshot_url: "https://res.cloudinary.com/demo/image/upload/v1/embedded.png" },
  ];
  const urls = toList(variants);
  assert.equal(urls.length, 4);
});
