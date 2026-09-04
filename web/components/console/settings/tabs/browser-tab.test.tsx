import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { BrowserTab } from "./browser-tab";

const baseRuntime = {
  launch_timeout_ms: 45000,
  extra_launch_args: [],
  adblock_allowlist_hosts: [],
  streaming_safe_mode: "adaptive",
  asset_diagnostics_enabled: true,
  popup_blocking_enabled: true,
  ubol_enabled: true,
  stream_cors_patch_enabled: false,
  stream_cors_include_credentials: false,
  iframe_sandbox_patch_enabled: true,
  iframe_auto_recovery_enabled: true,
  iframe_recovery_timeout_ms: 20000,
  media_capture_timeout_ms: 45000,
  media_cors_patch_enabled: false,
  media_playback_verification_enabled: true,
};

const baseProps = {
  runtime: baseRuntime,
  maxParallelHostingPages: "5",
  source: "runtime",
  dirty: false,
  saving: false,
  syncStatus: null,
  onRuntimeChange: vi.fn(),
  onRuntimeListChange: vi.fn(),
  onMaxParallelChange: vi.fn(),
  onSave: vi.fn(),
};

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("Settings BrowserTab (Phase 1 rebuild)", () => {
  it("enforces the Playwright-only engine banner with no selector", () => {
    const markup = html(<BrowserTab {...baseProps} />);
    expect(markup).toContain("Playwright 1.62.1");
    expect(markup).toContain("Isolated Sessions");
    expect(markup).toContain("ADR-003");
    expect(markup).not.toContain("BROWSER_OPTIONS");
    expect(markup).not.toContain("engine toggle");
  });

  it("renders every backend-connected control group", () => {
    const markup = html(<BrowserTab {...baseProps} />);
    expect(markup).toContain("Max parallel pages");
    expect(markup).toContain("Launch timeout");
    expect(markup).toContain("Streaming safe mode");
    expect(markup).toContain("Extra launch args");
    expect(markup).toContain("uBOL adblocker");
    expect(markup).toContain("Popup blocking");
    expect(markup).toContain("Asset diagnostics");
    expect(markup).toContain("Adblock allowlist hosts");
    expect(markup).toContain("Media capture timeout");
    expect(markup).toContain("Media playback verification");
    expect(markup).toContain("Media CORS patch");
    expect(markup).toContain("Stream CORS patch");
    expect(markup).toContain("Stream CORS include credentials");
    expect(markup).toContain("Iframe auto-recovery");
    expect(markup).toContain("Iframe recovery timeout");
    expect(markup).toContain("Iframe sandbox patch");
  });

  it("surfaces validation errors and reflects dirty state", () => {
    const markup = html(<BrowserTab {...baseProps} maxParallelHostingPages="99" dirty />);
    expect(markup).toContain("1 to 16");
    expect(markup).toContain("unsaved");
    expect(markup).toContain("Fix validation");
  });

  it("shows the saved state and source badge when clean", () => {
    const markup = html(<BrowserTab {...baseProps} />);
    expect(markup).toContain("saved");
    expect(markup).toContain("runtime");
  });
});
