import assert from "node:assert/strict";

import {
  buildDataResponses,
  buildInspectResponse,
  buildNetworkSummary,
  normalizeInspectConfig,
} from "../tools/inspect.js";

const normalized = normalizeInspectConfig({
  wait_ms: "2500",
  max_depth: "9",
  max_children_per_node: "0",
  include_network: "false",
  include_response_bodies: "true",
  include_frames: "true",
  include_shadow_dom: "false",
  scroll: "yes",
  scroll_steps: "20",
  allow_safe_interactions: "1",
  safe_interaction_limit: "-1",
  include_screenshot: "false",
});

assert.equal(normalized.wait_ms, 2500);
assert.equal(normalized.max_depth, 9);
assert.equal(normalized.max_children_per_node, 0);
assert.equal(normalized.include_network, false);
assert.equal(normalized.include_response_bodies, true);
assert.equal(normalized.include_frames, true);
assert.equal(normalized.include_shadow_dom, false);
assert.equal(normalized.scroll, true);
assert.equal(normalized.scroll_steps, 20);
assert.equal(normalized.allow_safe_interactions, true);
assert.equal(normalized.safe_interaction_limit, 0);
assert.equal(normalized.include_screenshot, false);

const network = buildNetworkSummary(
  [
    {
      request_id: "req-1",
      url: "https://example.com/",
      method: "GET",
      resource_type: "document",
      frame_url: "https://example.com/",
      initiator: "navigation",
      timestamp: 1000,
    },
    {
      request_id: "req-2",
      url: "https://example.com/app.js",
      method: "GET",
      resource_type: "script",
      frame_url: "https://example.com/",
      initiator: "script",
      timestamp: 1300,
    },
  ],
  [
    {
      request_id: "req-2",
      url: "https://example.com/api/live",
      status: 200,
      content_type: "application/json",
      resource_type: "fetch",
      frame_url: "https://example.com/",
      body_preview: '{"ok":true}',
      body_truncated: false,
    },
  ],
  1000,
);

assert.equal(network.resource_summary.document, 1);
assert.equal(network.resource_summary.script, 1);
assert.equal(network.requests[1].timestamp_offset_ms, 300);
assert.equal(network.responses[0].status, 200);

const dataResponses = buildDataResponses([
  {
    request_id: "req-2",
    url: "https://example.com/api/live",
    content_type: "application/json",
    status: 200,
    body_preview:
      '{"title":"Live Match","url":"https://cdn.example.com/master.m3u8"}',
  },
  {
    request_id: "req-3",
    url: "https://example.com/api/bad",
    content_type: "application/json",
    status: 200,
    body_preview: "{bad json",
  },
]);

assert.equal(dataResponses.length, 2);
assert.equal(dataResponses[0].json_preview.type, "object");
assert.equal(dataResponses[1].parse_error, "invalid_json_preview");

const response = buildInspectResponse({
  config: normalized,
  requestedUrl: "https://example.com/requested",
  finalUrl: "https://example.com/final",
  pageContext: {
    language: "en",
    direction: "ltr",
    viewport: { width: 1920, height: 1080 },
    timestamp: "2025-01-01T00:00:00.000Z",
    title: "Example title",
  },
  loadState: {
    domcontentloaded: true,
    load: true,
    network_idle_reached: true,
    waited_ms: 2500,
    console_errors: [],
    page_errors: [],
  },
  observation: {
    metadata: { title: "Example title", description: "desc" },
    document_stats: { link_count: 3, interactive_count: 2 },
    outline: { headings: [], landmarks: [] },
    tree: { node_id: "node-1", tag: "body", children: [] },
    regions: [{ selector: "nav", tag: "nav", links_count: 1 }],
    repeated_structures: [],
    tables: [],
    links: [
      {
        href: "https://example.com/watch",
        text: "Watch",
        selector: "a.watch",
        bbox: { x: 10, y: 20, width: 50, height: 10 },
        region_selector: "nav",
      },
    ],
    interactive_elements: [
      {
        selector: "button",
        xpath: "//button[1]",
        text: "Play",
        tag: "button",
        visible: true,
        disabled: false,
        attributes: { role: "button" },
        bbox: { x: 30, y: 40, width: 80, height: 20 },
      },
    ],
    forms: [],
    media: {
      iframes: [],
      videos: [],
      audio: [],
      images: [],
      sources: [],
      tracks: [],
    },
    shadow_roots: [],
    scripts: {
      external: [],
      inline_summaries: [],
      script_url_strings: [],
      script_object_keys: [],
    },
    pruning: { max_depth: 5 },
  },
  frames: [],
  network,
  dataResponses,
  mutationObservations: [],
  storage: {
    local_storage_keys: [],
    session_storage_keys: [],
    cookies_summary: [],
  },
  snapshots: {
    initial_tree: null,
    after_wait_tree: null,
    after_scroll_tree: null,
    after_interaction_tree: null,
  },
  screenshotUrl: "https://img.example.com/shot.png",
  pageDigest: {
    text_sample: "Example text sample",
    html_size: 1234,
    node_count: 56,
  },
  frameRecords: [
    {
      frame_path: "root",
      video_count: 0,
      total_links: 1,
      total_buttons: 1,
    },
  ],
});

assert.equal(response.schema_version, "clean_browser_observation/v1");
assert.equal(response.page.final_url, "https://example.com/final");
assert.equal(response.url, "https://example.com/final");
assert.equal(response.title, "Example title");
assert.equal(response.screenshot_url, "https://img.example.com/shot.png");
assert.equal(response.contentLinks.length, 1);
assert.equal(response.navLinks.length, 1);
assert.equal(response.buttons.length, 1);
assert.equal(response.stats.frames_total, 1);
assert.equal(response.stats.lazy_load_clicks, 0);
assert.equal(response.network.requests.length, 2);
assert.equal(response.data_responses.length, 2);
assert.equal(response.inspect_config.wait_ms, 2500);

console.log("Validated inspect observation helper contracts.");
