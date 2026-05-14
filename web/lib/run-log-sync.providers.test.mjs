import test from "node:test";
import assert from "node:assert/strict";

import { collectRunProviderUrls } from "./run-log-sync.js";

test("collectRunProviderUrls ignores generic page urls and keeps provider-like stream targets only", () => {
  const urls = collectRunProviderUrls({
    runUrl: "https://streamed.pk/",
    snapshot: {
      all_streams: [],
      provider_analysis: [],
    },
    events: [
      {
        details: {
          url: "https://streamed.pk/",
          provider_url: "https://cdn.example.com/master.m3u8",
          iframe_url: "https://player.example.com/embed/123",
        },
        message: "Visited https://streamed.pk/",
      },
    ],
  });

  assert.deepEqual(urls, [
    "https://cdn.example.com/master.m3u8",
    "https://player.example.com/embed/123",
  ]);
});
