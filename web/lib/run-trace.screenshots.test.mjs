import test from "node:test";
import assert from "node:assert/strict";

import { collectScreenshotUrls } from "./run-trace.js";

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
