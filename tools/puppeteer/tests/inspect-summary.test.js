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
    navLinks: [
      {
        text: "Argentina",
        nearby_text: "Live TV Argentina",
        href: "https://freeshot.live/live-tv/argentina",
        selector: ".dropdown-menu a:nth-child(4)",
        xpath: "//nav//a[4]",
      },
    ],
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
        sample_videos: [
          {
            selector: "video",
            xpath: "//video[1]",
            src: "https://cdn.example.com/frame-master.m3u8",
            readyState: 4,
            paused: true,
            x: 960,
            y: 540,
          },
        ],
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

test("landing summary keeps numbered pagination out of hosting candidates", () => {
  const raw = {
    ...largeLandingRaw(),
    url: "https://freeshot.live/live-tv",
    contentLinks: [
      {
        text: "ESPN ARG",
        nearby_text: "ESPN ARG",
        href: "https://freeshot.live/live-tv/espn-arg/871",
        selector: ".show-listing a:nth-child(1)",
        xpath: "//main//a[1]",
      },
      {
        text: "2",
        nearby_text: "1 2 3 4 5 6 7",
        href: "https://freeshot.live/live-tv?page=2",
        selector: ".pagination a:nth-child(2)",
        xpath: "//nav//a[2]",
      },
      {
        text: "»",
        nearby_text: "1 2 3 4 5 6 7",
        href: "https://freeshot.live/live-tv?page=73",
        selector: ".pagination .next",
        xpath: "//nav//a[9]",
      },
    ],
    navLinks: [],
    reveal_controls: [],
    collapsed_sections: [],
    pagination: {
      detected: true,
      type: "numbered",
      elements: [
        { text: "1", href: "https://freeshot.live/live-tv?page=1", selector: ".page-1", xpath: "//a[1]" },
        { text: "2", href: "https://freeshot.live/live-tv?page=2", selector: ".page-2", xpath: "//a[2]" },
        { text: "»", href: "https://freeshot.live/live-tv?page=73", selector: ".next", xpath: "//a[9]" },
      ],
    },
  };

  const summary = summarizeLandingInspect(raw);

  assert.equal(summary.pagination.detected, true);
  assert.equal(summary.pagination.type, "query");
  assert.equal(summary.pagination.next_url, "https://freeshot.live/live-tv?page=2");
  assert.equal(summary.pagination.url_pattern, "https://freeshot.live/live-tv?page={n}");
  assert.deepEqual(summary.candidate_ledger.map((candidate) => candidate.url), [
    "https://freeshot.live/live-tv/espn-arg/871",
  ]);
  assert.ok(summary.grouped_sections.groups.some((group) => group.label === "pagination_links"));
});

test("landing summary captures schedule provider buttons with row context", () => {
  const raw = {
    ...largeLandingRaw(),
    url: "https://freestreams-live1d.pk/",
    contentLinks: [
      {
        text: "TNT Sports",
        nearby_text: "12:30 Cycling: Tour of Slovenia | Stage 1 TNT Sports TNT Sports #2",
        row_text: "12:30 Cycling: Tour of Slovenia | Stage 1 TNT Sports TNT Sports #2",
        href: "https://freestreams-live1d.pk/bttwo/",
        selector: "tr:nth-child(1) a.button",
        xpath: "//tr[1]//a[1]",
        classes: "button",
      },
      {
        text: "DAZN EN",
        nearby_text: "18:00 World Cup Of Darts Sky Sports Sky Main Event DAZN EN",
        row_text: "18:00 World Cup Of Darts Sky Sports Sky Main Event DAZN EN",
        href: "https://freestreams-live1d.pk/dazn-en/",
        selector: "tr:nth-child(2) a.button:nth-child(3)",
        xpath: "//tr[2]//a[3]",
        classes: "button",
      },
    ],
    navLinks: [],
    reveal_controls: [],
    collapsed_sections: [],
    pagination: { detected: false, type: null, elements: [] },
  };

  const summary = summarizeLandingInspect(raw);

  assert.deepEqual(
    summary.candidate_ledger.map((candidate) => candidate.url),
    ["https://freestreams-live1d.pk/bttwo/", "https://freestreams-live1d.pk/dazn-en/"],
  );
  assert.equal(summary.candidate_ledger[0].scheduled_time, "12:30");
  assert.match(summary.candidate_ledger[0].nearby_text, /Tour of Slovenia/);
  assert.ok(summary.top_match_candidates.some((candidate) => candidate.url.endsWith("/dazn-en/")));
});

test("landing summary rejects article cards that only look live from title text", () => {
  const raw = {
    ...largeLandingRaw(),
    url: "https://martinchavez98.org/post/yacine-tv-premier-league-live",
    contentLinks: [
      {
        text: "Yacine TV World Cup 2026 live all matches HD",
        nearby_text: "Latest football news Yacine TV World Cup 2026 live all matches HD",
        row_text: "Latest football news Yacine TV World Cup 2026 live all matches HD",
        section_title: "Latest News",
        href: "https://martinchavez98.org/post/yacine-tv-world-cup-2026",
        selector: ".related-posts a:nth-child(1)",
        xpath: "//aside//a[1]",
        classes: "related-post-card",
      },
      {
        text: "Champions League Final 2026 live stream",
        nearby_text: "Related article Champions League Final 2026 live stream",
        row_text: "Related article Champions League Final 2026 live stream",
        section_title: "Popular articles",
        href: "https://martinchavez98.org/post/yacine-tv-champions-league-final-2026",
        selector: ".popular-posts a:nth-child(1)",
        xpath: "//aside//a[2]",
        classes: "news-card",
      },
      {
        text: "Team A vs Team B",
        nearby_text: "20:00 Team A vs Team B Watch Live",
        row_text: "20:00 Team A vs Team B Watch Live",
        section_title: "Live Matches",
        href: "https://martinchavez98.org/match/team-a-team-b",
        selector: ".match-card a:nth-child(1)",
        xpath: "//main//section[2]//a[1]",
        classes: "match-card live-match",
      },
    ],
    navLinks: [
      makeLink(0, "Home", "https://martinchavez98.org/", "nav"),
      makeLink(1, "Yacine TV live", "https://martinchavez98.org/post/yacine-tv-premier-league-live", "nav"),
    ],
    reveal_controls: [],
    collapsed_sections: [],
    pagination: { detected: false, type: null, elements: [] },
  };

  const summary = summarizeLandingInspect(raw);

  assert.deepEqual(summary.candidate_ledger.map((candidate) => candidate.url), [
    "https://martinchavez98.org/match/team-a-team-b",
  ]);
  assert.equal(summary.top_match_candidates[0].url, "https://martinchavez98.org/match/team-a-team-b");
  assert.ok(summary.navigation_groups.some((group) => group.label === "news_article_links"));
  assert.ok(
    summary.grouped_sections.groups.some(
      (group) => group.label === "news_article_links" && group.priority === "low",
    ),
  );
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
  assert.ok(Array.isArray(summary.server_frontier));
  assert.ok(summary.server_frontier.length >= summary.top_server_controls.length);
  assert.ok(summary.server_frontier.some((entry) => entry.label.includes("Server 1")));
  assert.ok(Array.isArray(summary.activation_candidates));
  assert.ok(summary.activation_candidates.some((entry) => entry.requires_agent_choice));
  assert.ok(summary.activation_candidates.some((entry) => entry.kind === "video"));
  assert.ok(
    summary.activation_candidates.some(
      (entry) => entry.kind === "video" && entry.frame_path === "root.0",
    ),
  );
  assert.ok(
    summary.iframe_groups.some(
      (group) =>
        group.frame_path === "root.0" &&
        Array.isArray(group.sample_videos) &&
        group.sample_videos.some((video) => video.frame_path === "root.0"),
    ),
  );
  assert.ok(Array.isArray(summary.blocker_candidates));
  assert.ok(summary.blocker_candidates.some((entry) => entry.close_selector === ".close"));
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
  assert.ok(summary.server_frontier.some((entry) => entry.label.includes("Admin HD Stream 1")));
  assert.ok(summary.server_frontier.some((entry) => entry.label.includes("Delta Opcion 1")));
  assert.match(texts, /مصدر 1/);
});

test("hosting summary promotes iframe-local source controls into server frontier", () => {
  const raw = {
    ...hostingRaw(),
    buttons: [],
    elements: [],
    contentLinks: [],
    frame_tree: [
      {
        frame_path: "root.0",
        parent_frame_path: "root",
        depth: 1,
        is_main_frame: false,
        url: "https://embed.example.com/player/1",
        total_links: 0,
        total_buttons: 2,
        total_iframes: 0,
        video_count: 1,
        has_server_controls: true,
        has_player_library: true,
        purpose_hint: "player",
        sample_links: [],
        sample_buttons: [
          {
            text: "Frame Source 2 HD",
            selector: ".source-list button:nth-child(2)",
            xpath: "//button[2]",
            x: 700,
            y: 740,
          },
        ],
      },
    ],
  };

  const summary = summarizeHostingInspect(raw);

  assert.ok(summary.top_server_controls.some((entry) => entry.frame_path === "root.0"));
  assert.ok(
    summary.server_frontier.some(
      (entry) => entry.frame_path === "root.0" && entry.label === "Frame Source 2 HD",
    ),
  );
});

test("hosting summary does not classify generic nav links as server controls", () => {
  const raw = {
    ...hostingRaw(),
    contentLinks: [
      {
        text: "DNS",
        href: "https://one.one.one.one/dns/",
        selector: ".Nav--link",
        xpath: "//nav/a[2]",
      },
      {
        text: "Families",
        href: "https://one.one.one.one/family/",
        selector: ".Nav--link",
        xpath: "//nav/a[3]",
      },
    ],
    buttons: [
      {
        text: "English",
        selector: ".language-selector",
        xpath: "//nav/div[1]",
        x: 1843,
        y: 37,
        frame_path: "root",
        kind: "button",
        href: "",
        data: {},
      },
    ],
    elements: [
      {
        text: "DNS",
        selector: ".Nav--link",
        xpath: "//nav/a[2]",
        x: 1618,
        y: 37,
        frame_path: "root",
        kind: "link",
        href: "https://one.one.one.one/dns/",
        data: {},
      },
    ],
    frame_tree: [],
    hosting_signals: {
      has_video: false,
      has_player_iframe: false,
      player_iframe_src: null,
      visible_content_iframes: 0,
      player_libraries: false,
      server_tabs: false,
    },
  };

  const summary = summarizeHostingInspect(raw);

  assert.equal(summary.top_server_controls.length, 0);
  assert.equal(summary.server_frontier.length, 0);
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
  assert.ok(
    summary.server_frontier.some(
      (entry) =>
        entry.frontier_source === "event_server_route" &&
        entry.source_url === "https://streamed.pk/watch/bologna-vs-inter-milan-2265406/admin/1",
    ),
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
  assert.ok(Array.isArray(summary.activation_candidates));
  assert.ok(summary.activation_candidates.some((entry) => entry.requires_agent_choice));
  assert.ok(Array.isArray(summary.blocker_candidates));
  assert.ok(summary.stats.budget_fit);
  assert.ok(summary.stats.compressed_bytes <= 14 * 1024);
  assert.equal(summary.source_controls, undefined);
});
