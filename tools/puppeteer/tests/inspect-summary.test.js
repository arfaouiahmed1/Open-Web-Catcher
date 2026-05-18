import test from "node:test";
import assert from "node:assert/strict";

import {
  summarizeClassificationInspect,
  summarizeLandingInspect,
  summarizeHostingInspect,
  summarizeEmbeddedInspect,
} from "../tools/inspect-summaries.js";

function makeLink(index, label, href, source = "content") {
  return {
    text: `${label} ${index}`,
    href,
    selector: `a:nth-of-type(${index + 1})`,
    xpath: `//a[${index + 1}]`,
    x: 100 + index,
    y: 200 + index,
    frame_path: "root",
    source,
  };
}

function largeLandingRaw() {
  const contentLinks = [];
  for (let i = 0; i < 180; i += 1) {
    contentLinks.push(
      makeLink(
        i,
        i % 2 === 0 ? "LIVE Team A vs Team B" : "Watch Match",
        `https://streamed.pk/watch/match-${i}`,
      ),
    );
  }
  for (let i = 0; i < 24; i += 1) {
    contentLinks.push(
      makeLink(i, "Football", `https://streamed.pk/category/football-${i}`),
    );
  }

  const navLinks = [
    makeLink(0, "Home", "https://streamed.pk/", "nav"),
    makeLink(1, "Schedule", "https://streamed.pk/schedule", "nav"),
    makeLink(2, "API", "https://streamed.pk/docs", "nav"),
    makeLink(3, "Status", "https://status.strmd.link/", "nav"),
  ];

  const buttons = Array.from({ length: 40 }, (_, index) => ({
    text: index % 2 === 0 ? `Filter ${index}` : `Load more ${index}`,
    selector: `button:nth-of-type(${index + 1})`,
    xpath: `//button[${index + 1}]`,
    x: 400 + index,
    y: 500 + index,
    frame_path: "root",
    kind: "button",
    data: {},
  }));

  return {
    url: "https://streamed.pk/",
    title: "Streamed - Watch Any Live Sport Online",
    screenshot_url: "https://res.cloudinary.com/demo/image/upload/landing.png",
    contentLinks,
    navLinks,
    buttons,
    elements: buttons,
    iframes: [],
    popups: [],
    pagination: {
      detected: true,
      type: "numbered",
      elements: [
        { text: "2", href: "https://streamed.pk/page/2", selector: "a.page-2", xpath: "//a[2]" },
        { text: "Next", href: "https://streamed.pk/page/2", selector: "a.next", xpath: "//a[3]" },
      ],
    },
    videos: [],
    frame_tree: [],
    hosting_signals: {
      has_video: false,
      has_player_iframe: false,
      player_iframe_src: null,
      visible_content_iframes: 0,
      player_libraries: false,
      server_tabs: false,
    },
    lazy_load_warmup: { scroll_steps: 12, reset_to_top: true },
  };
}

function hostingRaw() {
  const buttons = Array.from({ length: 28 }, (_, index) => ({
    text: `Server ${index + 1}`,
    selector: `.server-${index + 1}`,
    xpath: `//button[${index + 1}]`,
    x: 600 + index,
    y: 720,
    frame_path: "root",
    kind: "button",
    href: "",
    data: { server: `s${index + 1}` },
  }));

  return {
    url: "https://streamed.pk/watch/match-1",
    title: "Watch Match",
    screenshot_url: "https://res.cloudinary.com/demo/image/upload/hosting.png",
    contentLinks: [],
    navLinks: [],
    buttons,
    elements: buttons,
    iframes: [
      { src: "https://embed.example.com/player/1", selector: "iframe", xpath: "//iframe[1]", category: "content" },
    ],
    popups: [
      { text: "Close Ad", selector: ".modal", xpath: "//div[1]", close_selector: ".close", close_xpath: "//button[1]" },
    ],
    pagination: { detected: false, type: null, elements: [] },
    videos: [
      {
        selector: "video",
        xpath: "//video[1]",
        src: "https://cdn.example.com/master.m3u8",
        readyState: 4,
        networkState: 2,
        paused: false,
        x: 960,
        y: 540,
      },
    ],
    frame_tree: [
      {
        frame_path: "root.0",
        parent_frame_path: "root",
        depth: 1,
        is_main_frame: false,
        url: "https://embed.example.com/player/1",
        total_links: 0,
        total_buttons: 6,
        total_iframes: 0,
        video_count: 1,
        has_server_controls: true,
        has_player_library: true,
        purpose_hint: "player",
        sample_links: [],
        sample_buttons: buttons.slice(0, 6),
      },
    ],
    hosting_signals: {
      has_video: true,
      has_player_iframe: true,
      player_iframe_src: "https://embed.example.com/player/1",
      visible_content_iframes: 1,
      player_libraries: true,
      server_tabs: true,
    },
    lazy_load_warmup: { scroll_steps: 12, reset_to_top: true },
  };
}

function embeddedRaw() {
  const buttons = Array.from({ length: 20 }, (_, index) => ({
    text: index % 2 === 0 ? `Source ${index + 1}` : `Play ${index + 1}`,
    selector: `.source-${index + 1}`,
    xpath: `//button[${index + 1}]`,
    x: 700 + index,
    y: 680,
    frame_path: "root.0",
    kind: "button",
    href: "",
    data: { source: `src${index + 1}`, embed: index % 3 === 0 ? `emb${index}` : null },
  }));

  return {
    ...hostingRaw(),
    url: "https://embed.example.com/player/1",
    title: "Embedded Player",
    screenshot_url: "https://res.cloudinary.com/demo/image/upload/embedded.png",
    buttons,
    elements: buttons,
    frame_tree: [
      {
        frame_path: "root.0",
        parent_frame_path: "root",
        depth: 1,
        is_main_frame: false,
        url: "https://embed.example.com/player/1",
        total_links: 0,
        total_buttons: buttons.length,
        total_iframes: 0,
        video_count: 1,
        has_server_controls: true,
        has_player_library: true,
        purpose_hint: "player",
        sample_links: [],
        sample_buttons: buttons.slice(0, 10),
      },
    ],
  };
}

test("classification summary groups repeated links and fits compression budget", () => {
  const summary = summarizeClassificationInspect(largeLandingRaw());

  assert.equal(summary.context_type, "classification");
  assert.ok(Array.isArray(summary.link_groups));
  assert.ok(summary.link_groups.some((group) => group.label === "live_watch_cards"));
  assert.ok(summary.link_groups.some((group) => group.label === "sports_categories"));
  assert.ok(summary.top_candidates.watch.length >= 1);
  assert.ok(summary.stats.budget_fit);
  assert.ok(summary.stats.compressed_bytes <= 8 * 1024);
  assert.equal(summary.contentLinks, undefined);
});

test("landing summary returns grouped sections and top representatives only", () => {
  const summary = summarizeLandingInspect(largeLandingRaw());

  assert.equal(summary.context_type, "landing");
  assert.ok(Array.isArray(summary.grouped_sections.groups));
  assert.ok(Array.isArray(summary.match_groups));
  assert.ok(Array.isArray(summary.navigation_groups));
  assert.ok(Array.isArray(summary.top_match_candidates));
  assert.equal(summary.top_match_candidates[0].status, "live");
  assert.ok(summary.top_match_candidates[0].selector);
  assert.ok(summary.grouped_sections.groups.some((group) => group.label === "live_watch_cards"));
  assert.ok(summary.stats.budget_fit);
  assert.ok(summary.stats.compressed_bytes <= 18 * 1024);
  assert.equal(summary.match_candidates, undefined);
});

test("hosting summary preserves actionable server controls while compressing", () => {
  const summary = summarizeHostingInspect(hostingRaw());

  assert.equal(summary.context_type, "hosting");
  assert.ok(Array.isArray(summary.control_groups));
  assert.ok(summary.control_groups.some((group) => group.label === "server_switches"));
  assert.ok(Array.isArray(summary.top_server_controls));
  assert.ok(summary.top_server_controls.length >= 1);
  assert.ok(summary.top_server_controls[0].selector);
  assert.ok(summary.top_server_controls[0].xpath);
  assert.equal(typeof summary.top_server_controls[0].x, "number");
  assert.equal(typeof summary.top_server_controls[0].y, "number");
  assert.ok(summary.stats.budget_fit);
  assert.ok(summary.stats.compressed_bytes <= 14 * 1024);
  assert.equal(summary.server_controls, undefined);
});

test("embedded summary preserves source controls and frame focus groups", () => {
  const summary = summarizeEmbeddedInspect(embeddedRaw());

  assert.equal(summary.context_type, "embedded");
  assert.ok(Array.isArray(summary.control_groups));
  assert.ok(summary.control_groups.some((group) => group.label === "source_switches"));
  assert.ok(Array.isArray(summary.frame_focus_groups));
  assert.ok(Array.isArray(summary.top_source_controls));
  assert.ok(summary.top_source_controls.length >= 1);
  assert.ok(summary.stats.budget_fit);
  assert.ok(summary.stats.compressed_bytes <= 14 * 1024);
  assert.equal(summary.source_controls, undefined);
});
