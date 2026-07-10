import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeObservedChange, trackNewTabs } from "../shared/tool-runtime.js";

function fakePage({ url, title = "", blockedAttempts = [] } = {}) {
  let currentUrl = url;
  let closed = false;
  return {
    url: () => currentUrl,
    title: async () => title,
    isClosed: () => closed,
    close: async () => {
      closed = true;
    },
    waitForLoadState: async () => {},
    evaluate: async () => blockedAttempts,
    setUrl: (nextUrl) => {
      currentUrl = nextUrl;
    },
  };
}

test("observed_change preserves popup/window telemetry and legacy new_tab_urls", () => {
  const before = { url: "https://sports.example/watch/1", dom_epoch: "a" };
  const after = { url: "https://sports.example/watch/1", dom_epoch: "b" };
  const newTabUrls = ["https://cdn.example/embed/player/1"];
  const telemetry = {
    opened_targets: [
      {
        initial_url: "about:blank",
        final_url: "https://cdn.example/embed/player/1",
        title: "Player",
        opener_url: before.url,
        classification: "same_content_player",
        adopted: true,
        closed: false,
      },
    ],
    blocked_popup_attempts: [
      {
        url: "https://ads.example/popunder",
        blocked: true,
        reason: "window_open_blocked",
      },
    ],
    selected_target: { final_url: "https://cdn.example/embed/player/1" },
    target_decision: "adopt_same_content_player",
    active_page_url: "https://cdn.example/embed/player/1",
    opener_url: before.url,
  };

  const observed = makeObservedChange(before, after, newTabUrls, telemetry);

  assert.equal(observed.popup_opened, true);
  assert.deepEqual(observed.new_tab_urls, newTabUrls);
  assert.deepEqual(observed.opened_targets, telemetry.opened_targets);
  assert.deepEqual(observed.blocked_popup_attempts, telemetry.blocked_popup_attempts);
  assert.deepEqual(observed.selected_target, telemetry.selected_target);
  assert.equal(observed.target_decision, "adopt_same_content_player");
  assert.equal(observed.active_page_url, "https://cdn.example/embed/player/1");
  assert.equal(observed.opener_url, before.url);
});

test("play_media registry contract requires an exact target or returns candidates", () => {
  const registryPath = path.resolve("tool-registry.js");
  const text = fs.readFileSync(registryPath, "utf8");

  assert.match(text, /play_media: spec/);
  assert.match(text, /activation_candidates and needs_agent_choice without clicking guessed controls/);
  assert.match(text, /x: z\.number\(\)\.optional\(\)/);
  assert.match(text, /y: z\.number\(\)\.optional\(\)/);
});

test("tab tracker adopts same-content player and closes ad targets", async () => {
  const context = new EventEmitter();
  const opener = fakePage({ url: "https://sports.example/watch/game-1", title: "Game 1" });
  const adPage = fakePage({ url: "https://sports.example/promo/download", title: "Download" });
  const playerPage = fakePage({
    url: "https://cdn-player.example/embed/player/game-1",
    title: "Player",
  });
  const tracker = trackNewTabs(context, { openerPage: opener, adopt: true, closeUnadopted: true });

  context.emit("page", adPage);
  context.emit("page", playerPage);
  const activePage = await tracker.settle({ timeoutMs: 50 });
  tracker.dispose();

  assert.equal(activePage, playerPage);
  assert.equal(tracker.active_page_url, "https://cdn-player.example/embed/player/game-1");
  assert.equal(tracker.target_decision, "adopt_same_content_player");
  assert.equal(tracker.selected_target.action, "adopted");
  assert.equal(tracker.selected_target.final_url, "https://cdn-player.example/embed/player/game-1");
  assert.equal(adPage.isClosed(), true);
  assert.equal(playerPage.isClosed(), false);
  assert.deepEqual(tracker.new_tab_urls, [
    "https://sports.example/promo/download",
    "https://cdn-player.example/embed/player/game-1",
  ]);
});

test("tab tracker exposes decoded player urls from adopted popup redirects", async () => {
  const context = new EventEmitter();
  const opener = fakePage({ url: "https://sports.example/watch/game-1", title: "Game 1" });
  const encoded = [
    Buffer.from("سيرفر 1 =").toString("base64"),
    Buffer.from(" https://player.syria-player.live/albaplayer/beinmax1/").toString("base64"),
  ].join("__");
  const popupPage = fakePage({
    url: `https://elsaudia.net/read925/55.php?hash=${encoded}`,
    title: "Get Business Loan",
  });
  const tracker = trackNewTabs(context, { openerPage: opener, adopt: true, closeUnadopted: true });

  context.emit("page", popupPage);
  const activePage = await tracker.settle({ timeoutMs: 50 });
  tracker.dispose();

  assert.equal(activePage, popupPage);
  assert.equal(tracker.target_decision, "adopt_same_content_player");
  assert.equal(tracker.selected_target.classification, "encoded_player_redirect");
  assert.deepEqual(tracker.selected_target.extracted_player_urls, [
    "https://player.syria-player.live/albaplayer/beinmax1/",
  ]);
  assert.equal(tracker.opened_targets[0].adopted, true);
  assert.deepEqual(tracker.opened_targets[0].extracted_player_urls, [
    "https://player.syria-player.live/albaplayer/beinmax1/",
  ]);
});

test("tab tracker reports blocked window.open attempts without hijacking active page", async () => {
  const context = new EventEmitter();
  const opener = fakePage({
    url: "https://sports.example/watch/game-1",
    title: "Game 1",
    blockedAttempts: [
      {
        url: "https://ads.example/popunder",
        target: "_blank",
        features: "",
        timestamp: Date.now(),
        blocked: true,
        reason: "window_open_blocked",
      },
    ],
  });
  const tracker = trackNewTabs(context, { openerPage: opener, adopt: true, closeUnadopted: true });

  const activePage = await tracker.settle({ timeoutMs: 50 });
  tracker.dispose();

  assert.equal(activePage, opener);
  assert.equal(tracker.active_page_url, "https://sports.example/watch/game-1");
  assert.equal(tracker.target_decision, "blocked_popup_attempts_only");
  assert.equal(tracker.blocked_popup_attempts[0].url, "https://ads.example/popunder");
  assert.equal(tracker.blocked_popup_attempts[0].action, "blocked");
  assert.equal(tracker.blocked_popup_attempts[0].classification, "ad_or_drift");
  assert.equal(tracker.opened_targets.length, 0);
});
