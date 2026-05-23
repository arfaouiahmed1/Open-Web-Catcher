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
    reveal_controls: [
      {
        text: "More channels",
        selector: ".channels-toggle",
        xpath: "//button[1]",
        x: 480,
        y: 420,
        frame_path: "root",
        kind: "reveal_control",
        state: "collapsed",
        hidden_link_count: 2,
        visible_link_count: 0,
        data: { reveals_hidden_content: true },
        sample_links: [
          {
            text: "beIN SPORTS 1",
            href: "https://streamed.pk/watch/bein-sports-1",
            selector: ".hidden-channel a",
            xpath: "//div[1]/a[1]",
            x: 0,
            y: 0,
            frame_path: "root",
            visible: false,
          },
        ],
      },
    ],
    collapsed_sections: [
      {
        selector: ".channels-panel",
        xpath: "//div[2]",
        text: "Sports channels",
        state: "collapsed",
        link_count: 2,
        hidden_link_count: 2,
        button_count: 0,
        reveal_selector: ".channels-toggle",
        reveal_xpath: "//button[1]",
        sample_links: [
          {
            text: "beIN SPORTS 1",
            href: "https://streamed.pk/watch/bein-sports-1",
            selector: ".hidden-channel a",
            xpath: "//div[1]/a[1]",
            x: 0,
            y: 0,
            frame_path: "root",
            visible: false,
          },
          {
            text: "Sky Sports",
            href: "https://streamed.pk/watch/sky-sports",
            selector: ".hidden-channel a:nth-of-type(2)",
            xpath: "//div[1]/a[2]",
            x: 0,
            y: 0,
            frame_path: "root",
            visible: false,
          },
        ],
        hidden_link_samples: [
          {
            text: "beIN SPORTS 1",
            href: "https://streamed.pk/watch/bein-sports-1",
            selector: ".hidden-channel a",
            xpath: "//div[1]/a[1]",
            x: 0,
            y: 0,
            frame_path: "root",
            visible: false,
          },
        ],
      },
    ],
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

function multilingualHostingRaw() {
  const controls = [
    {
      text: "Admin HD Stream 1 English - Sky Sports Football",
      selector: ".provider-admin .stream-row:nth-child(1)",
      xpath: "//section[1]//button[1]",
      x: 360,
      y: 345,
      frame_path: "root",
      kind: "button",
      href: "",
      data: { source: "admin-1" },
    },
    {
      text: "Admin SD Stream 2 English - Sky Sports Football",
      selector: ".provider-admin .stream-row:nth-child(2)",
      xpath: "//section[1]//button[2]",
      x: 360,
      y: 390,
      frame_path: "root",
      kind: "button",
      href: "",
      data: { source: "admin-2" },
    },
    {
      text: "Delta Opcion 1 Espanol",
      selector: ".provider-delta .option-row",
      xpath: "//section[2]//a[1]",
      x: 360,
      y: 530,
      frame_path: "root",
      kind: "link",
      href: "https://streamed.pk/watch/match-1?source=delta",
      data: { source: "delta" },
    },
    {
      text: "Echo مصدر 1 جودة HD",
      selector: ".provider-echo .arabic-source",
      xpath: "//section[3]//button[1]",
      x: 360,
      y: 675,
      frame_path: "root",
      kind: "button",
      href: "",
      data: {},
    },
  ];

  return {
    ...hostingRaw(),
    title: "Live Hull City vs Middlesbrough Streams",
    buttons: controls,
    elements: controls,
    contentLinks: controls.filter((entry) => entry.kind === "link"),
    hosting_signals: {
      has_video: false,
      has_player_iframe: false,
      player_iframe_src: null,
      visible_content_iframes: 0,
      player_libraries: false,
      server_tabs: true,
    },
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
  assert.ok(Array.isArray(summary.candidate_ledger));
  assert.ok(Array.isArray(summary.candidate_groups));
    assert.equal(summary.top_match_candidates[0].status, "live");
    assert.ok(summary.top_match_candidates[0].selector);
  assert.ok(summary.candidate_ledger.length > summary.top_match_candidates.length);
  assert.ok(summary.candidate_ledger.some((candidate) => candidate.url_pattern.includes("/watch/match-{n}")));
  assert.ok(summary.candidate_groups.some((group) => group.count > 1));
  assert.ok(
    summary.grouped_sections.groups.some((group) =>
      ["live_watch_cards", "watch_links"].includes(group.label),
    ),
  );
    assert.ok(summary.action_groups.some((group) => group.label === "reveal_controls"));
    assert.ok(summary.reveal_actions[0].selector);
    assert.equal(summary.collapsed_sections[0].hidden_link_count, 2);
    assert.ok(summary.stats.budget_fit);
  assert.ok(summary.stats.compressed_bytes <= 32 * 1024);
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

test("hosting summary detects multilingual stream option rows as server switches", () => {
  const summary = summarizeHostingInspect(multilingualHostingRaw());

  assert.equal(summary.context_type, "hosting");
  assert.ok(summary.control_groups.some((group) => group.label === "server_switches"));
  const texts = summary.top_server_controls.map((item) => item.text).join(" ");
  assert.match(texts, /Stream 1/);
  assert.match(texts, /Opcion 1/);
  assert.match(texts, /مصدر 1/);
});

test("hosting summary exposes same-event route server links", () => {
  const raw = {
    ...hostingRaw(),
    url: "https://streamed.pk/watch/bologna-vs-inter-milan-2265406",
    contentLinks: [
      {
        text: "Admin Stream 1 HD English - Serie A",
        href: "https://streamed.pk/watch/bologna-vs-inter-milan-2265406/admin/1",
        selector: ".provider-admin a:nth-child(1)",
        xpath: "//section[1]//a[1]",
      },
      {
        text: "Admin Stream 2 SD English - Serie A",
        href: "https://streamed.pk/watch/bologna-vs-inter-milan-2265406/admin/2",
        selector: ".provider-admin a:nth-child(2)",
        xpath: "//section[1]//a[2]",
      },
      {
        text: "Delta Stream 1 HD English",
        href: "https://streamed.pk/watch/bologna-vs-inter-milan-2265406/delta/1",
        selector: ".provider-delta a:nth-child(1)",
        xpath: "//section[2]//a[1]",
      },
      {
        text: "Other match",
        href: "https://streamed.pk/watch/canadian-grand-prix-sprint-2408154/admin/1",
        selector: ".other",
        xpath: "//a[9]",
      },
    ],
  };

  const summary = summarizeHostingInspect(raw);

  assert.equal(summary.event_server_routes.length, 3);
  assert.deepEqual(
    summary.event_server_routes.map((route) => route.source_url),
    [
      "https://streamed.pk/watch/bologna-vs-inter-milan-2265406/admin/1",
      "https://streamed.pk/watch/bologna-vs-inter-milan-2265406/admin/2",
      "https://streamed.pk/watch/bologna-vs-inter-milan-2265406/delta/1",
    ],
  );
  assert.equal(summary.event_server_routes[0].source_group, "admin");
  assert.equal(summary.event_server_routes[0].source_index, 1);
  assert.equal(
    summary.event_server_routes[0].route_pattern,
    "https://streamed.pk/watch/bologna-vs-inter-milan-2265406/{provider}/{n}",
  );
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
