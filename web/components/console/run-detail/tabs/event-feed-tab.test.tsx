/**
 * @vitest-environment node
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { resetApiBaseCache } from "@/lib/api";
import { RunEventFeedTab } from "./event-feed-tab";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const API_BASE = "https://api.test.invalid";
const savedBase = process.env.NEXT_PUBLIC_API_BASE_URL;
const savedApi = process.env.API_BASE_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = API_BASE;
  process.env.API_BASE_URL = API_BASE;
  resetApiBaseCache();
});
afterEach(() => {
  if (savedBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
  else process.env.NEXT_PUBLIC_API_BASE_URL = savedBase;
  if (savedApi === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = savedApi;
  resetApiBaseCache();
});

describe("RunEventFeedTab", () => {
  it("renders typed events with inline screenshot cards and data-typed markers", () => {
    const markup = html(
      <RunEventFeedTab
        events={[
          { seq: 1, kind: "server_activated", message: "Server activated", details: { server_label: "srv-a", playback_confirmed: true }, actor: "hosting", timestamp: "2026-08-29T10:00:00Z" },
          { seq: 2, kind: "stream_extracted", message: "Stream extracted", details: { stream_url: "https://cdn.example/hls.m3u8", protocol: "hls", quality: "720p" }, actor: "hosting" },
          { seq: 3, kind: "tool_call_started", message: "click", details: { tool_name: "click", tool_args: { selector: "#play" }, screenshot_url: "blobref:0a1b2c3d4e5f6071" }, actor: "hosting_page" },
          { seq: 4, kind: "hosting_page_discovered", message: "discovered", details: { url: "https://host.example/watch" }, actor: "landing" },
          { seq: 5, kind: "player_failed", message: "failed", details: { reason: "timeout" }, actor: "embedded" },
        ] as unknown as Array<Record<string, unknown>>}
      />,
    );
    // EventFeedItem markers
    expect(markup).toContain('data-component="EventFeedItem"');
    expect(markup).toContain('data-kind="server_activated"');
    expect(markup).toContain('data-kind="stream_extracted"');
    expect(markup).toContain('data-kind="hosting_page_discovered"');
    expect(markup).toContain('data-kind="player_failed"');
    // Typed badge/data-typed
    expect(markup).toContain('data-typed="true"');
    // Blobrefs load through the authenticated transport instead of an img URL.
    expect(markup).toContain('data-component="ScreenshotCard"');
    expect(markup).toContain('data-state="loading"');
    expect(markup).not.toContain('src="https://api.test.invalid/blobs/0a1b2c3d4e5f6071"');
    expect(markup).toContain('data-role="inline-screenshots"');
  });

  it("handles queue/pool/cost typed kinds and normal events", () => {
    const markup = html(
      <RunEventFeedTab
        events={[
          { seq: 10, kind: "queue_enqueued", details: { role: "hosting", url: "https://h.example/1" } },
          { seq: 11, kind: "cost_threshold_exceeded", details: { spent_usd: 1.5 } },
        ] as unknown as Array<Record<string, unknown>>}
      />,
    );
    expect(markup).toContain('data-kind="queue_enqueued"');
    expect(markup).toContain('data-kind="cost_threshold_exceeded"');
    expect(markup).toContain('data-typed="true"');
  });

  it("shows empty state when no events", () => {
    const markup = html(<RunEventFeedTab events={[]} />);
    expect(markup).toContain("No events yet");
    expect(markup).toContain('data-state="empty"');
  });

  it("caps at maxItems with omitted indicator", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, kind: "run_started", message: `ev ${i + 1}` }));
    const markup = html(<RunEventFeedTab events={many as unknown as Array<Record<string, unknown>>} maxItems={2} />);
    expect(markup).toContain("+3 earlier hidden");
    expect(markup).toContain("ev 5");
    expect(markup).not.toContain("ev 1");
  });
});
