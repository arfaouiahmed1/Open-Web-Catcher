import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { resetApiBaseCache } from "@/lib/api";
import { ScreenshotCard, resolveScreenshotSrc } from "./ScreenshotCard";

const html = (element: React.ReactElement) => renderToStaticMarkup(element);
const TEST_API_BASE = "https://api.test.invalid";
const originalApiBase = process.env.API_BASE_URL;
const originalPublicApiBase = process.env.NEXT_PUBLIC_API_BASE_URL;

beforeEach(() => {
  process.env.API_BASE_URL = TEST_API_BASE;
  process.env.NEXT_PUBLIC_API_BASE_URL = TEST_API_BASE;
  resetApiBaseCache();
});

afterEach(() => {
  if (originalApiBase === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = originalApiBase;
  if (originalPublicApiBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
  else process.env.NEXT_PUBLIC_API_BASE_URL = originalPublicApiBase;
  resetApiBaseCache();
});

describe("resolveScreenshotSrc", () => {
  it("resolves blobref pointers against the bare /blobs route (no /api prefix)", () => {
    expect(resolveScreenshotSrc("blobref:0a1b2c3d4e5f6071")).toBe(
      "https://api.test.invalid/blobs/0a1b2c3d4e5f6071",
    );
    expect(resolveScreenshotSrc("BLOBREF:ABCDEF0123456789")).toBe(
      "https://api.test.invalid/blobs/ABCDEF0123456789",
    );
  });

  it("passes through plain URLs and rejects empties", () => {
    expect(resolveScreenshotSrc("https://x.example/shot.png")).toBe(
      "https://x.example/shot.png",
    );
    expect(resolveScreenshotSrc(null)).toBeNull();
    expect(resolveScreenshotSrc("   ")).toBeNull();
  });
});

describe("ScreenshotCard", () => {
  it("renders an img with alt and caption in success state", () => {
    const markup = html(
      <ScreenshotCard src="https://x.example/shot.png" alt="player frame" caption="t=42s" />,
    );
    expect(markup).toContain('data-state="success"');
    expect(markup).toContain('src="https://x.example/shot.png"');
    expect(markup).toContain('alt="player frame"');
    expect(markup).toContain("<figcaption");
    expect(markup).toContain("t=42s");
  });

  it("stamps data-blob-key and waits for authenticated blob loading", () => {
    const markup = html(
      <ScreenshotCard src="blobref:0a1b2c3d4e5f6071" alt="frame" />,
    );
    expect(markup).toContain('data-state="loading"');
    expect(markup).not.toContain('src="https://api.test.invalid/blobs/0a1b2c3d4e5f6071"');
  });

  it("supports loading / error / empty states", () => {
    const loading = html(<ScreenshotCard alt="" state="loading" />);
    expect(loading).toContain('data-state="loading"');
    expect(loading).toContain("Loading screenshot…");

    const error = html(<ScreenshotCard alt="" state="error" errorLabel="404" />);
    expect(error).toContain('data-state="error"');
    expect(error).toContain("404");
    expect(error).not.toContain("<img");

    // Missing source without explicit state derives empty.
    expect(html(<ScreenshotCard alt="" />)).toContain('data-state="empty"');
  });
});
