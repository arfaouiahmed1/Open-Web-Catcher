/**
 * @vitest-environment node
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { resetApiBaseCache } from "@/lib/api";
import { ScreenshotGridTab } from "./screenshot-grid-tab";

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

describe("ScreenshotGridTab", () => {
  it("renders annotated ScreenshotCards via SSE events and blobref resolution", () => {
    const markup = html(
      <ScreenshotGridTab
        events={[
          { kind: "tool_call_started", details: { screenshot_url: "blobref:aaaa1111bbbb2222" } },
          { kind: "server_activated", details: { screenshot_url: "https://cdn.example/a.png" } },
        ] as unknown as Array<Record<string, unknown>>}
      />,
    );
    expect(markup).toContain('data-component="ScreenshotCard"');
    expect(markup).toContain('src="https://api.test.invalid/blobs/aaaa1111bbbb2222"');
    expect(markup).toContain('data-blob-key="aaaa1111bbbb2222"');
    expect(markup).toContain('src="https://cdn.example/a.png"');
    expect(markup).toContain("2 evidence frames");
    expect(markup).toContain('data-role="shot-grid"');
  });

  it("merges prop screenshots with event screenshots", () => {
    const markup = html(
      <ScreenshotGridTab
        screenshots={["blobref:deadbeef12345678", "https://x.example/b.png"]}
        events={[]}
      />,
    );
    expect(markup).toContain('src="https://api.test.invalid/blobs/deadbeef12345678"');
    expect(markup).toContain('src="https://x.example/b.png"');
  });

  it("shows empty ScreenshotCard when none", () => {
    const markup = html(<ScreenshotGridTab events={[]} screenshots={[]} />);
    expect(markup).toContain("No evidence screenshots captured yet");
    expect(markup).toContain('data-state="empty"');
  });
});
