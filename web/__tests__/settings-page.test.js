import { describe, expect, it } from "vitest";
import {
  buildServerConfigDraft,
  getDirtyTabs,
  hasServerConfigChanged,
  snapshotServerConfig,
} from "@/lib/settings-page";

function makeState(overrides = {}) {
  return {
    provider: "google",
    fallbackTemperature: "0",
    llmTuning: {
      provider_defaults: {},
      model_overrides: {},
      agent_overrides: {},
    },
    agentModelConfig: {
      classification: { provider: "google", model: "gemini-2.5-flash" },
      landing: { provider: "google", model: "gemini-2.5-flash" },
      hosting: { provider: "google", model: "gemini-2.5-flash" },
      embedded: { provider: "google", model: "gemini-2.5-flash" },
      orchestrator: { provider: "google", model: "gemini-2.5-pro" },
    },
    providerCacheEnabled: true,
    geminiExplicitCacheEnabled: true,
    geminiExplicitCacheTtl: "1800",
    geminiExplicitCacheRefreshLead: "120",
    toolCacheEnabled: true,
    toolCacheStable: "2",
    browserEngine: "puppeteer",
    browserRuntime: {
      puppeteer: { launch_timeout_ms: 45000 },
      playwright: { launch_timeout_ms: 45000 },
    },
    disabledToolsByBrowserProfile: {
      puppeteer: { classification: [], landing: [], hosting: [], embedded: [] },
      playwright: { classification: [], landing: [], hosting: [], embedded: [] },
    },
    deepevalProvider: "google",
    deepevalModel: "gemini-2.5-flash",
    deepevalTemperature: "0",
    ...overrides,
  };
}

describe("settings-page save state helpers", () => {
  it("detects no changes for a fresh snapshot", () => {
    const draft = buildServerConfigDraft(makeState());
    const baseline = snapshotServerConfig(draft);

    expect(hasServerConfigChanged(baseline, draft)).toBe(false);
    expect(getDirtyTabs(baseline, draft)).toEqual({
      models: false,
      browser: false,
      evaluation: false,
      "mcp-tools": false,
    });
  });

  it("marks only the browser tab dirty when runtime settings change", () => {
    const baseline = snapshotServerConfig(buildServerConfigDraft(makeState()));
    const draft = buildServerConfigDraft(makeState({
      browserRuntime: {
        puppeteer: { launch_timeout_ms: 60000 },
        playwright: { launch_timeout_ms: 45000 },
      },
    }));

    expect(getDirtyTabs(baseline, draft)).toEqual({
      models: false,
      browser: true,
      evaluation: false,
      "mcp-tools": false,
    });
  });

  it("normalizes browser runtime to the single validated sticky proxy strategy", () => {
    const draft = buildServerConfigDraft(makeState({
      browserRuntime: {
        puppeteer: {
          launch_timeout_ms: 45000,
          proxy_rotation_mode: "session",
          proxy_selection_strategy: "random",
          proxy_fallback_strategy: "fail",
        },
        playwright: {
          launch_timeout_ms: 45000,
          proxy_rotation_mode: "never",
          proxy_selection_strategy: "random",
          proxy_fallback_strategy: "fail",
        },
      },
    }));

    expect(draft.browser_runtime.puppeteer.proxy_rotation_mode).toBe("sticky");
    expect(draft.browser_runtime.puppeteer.proxy_selection_strategy).toBe("ordered");
    expect(draft.browser_runtime.puppeteer.proxy_fallback_strategy).toBe("direct");
    expect(draft.browser_runtime.playwright.proxy_rotation_mode).toBe("sticky");
    expect(draft.browser_runtime.playwright.proxy_selection_strategy).toBe("ordered");
    expect(draft.browser_runtime.playwright.proxy_fallback_strategy).toBe("direct");
  });

  it("marks only MCP tools dirty when tool availability changes", () => {
    const baseline = snapshotServerConfig(buildServerConfigDraft(makeState()));
    const draft = buildServerConfigDraft(makeState({
      disabledToolsByBrowserProfile: {
        puppeteer: { classification: ["navigate"], landing: [], hosting: [], embedded: [] },
        playwright: { classification: [], landing: [], hosting: [], embedded: [] },
      },
    }));

    expect(getDirtyTabs(baseline, draft)).toEqual({
      models: false,
      browser: false,
      evaluation: false,
      "mcp-tools": true,
    });
  });

  it("marks only the models tab dirty when provider routing changes", () => {
    const baseline = snapshotServerConfig(buildServerConfigDraft(makeState()));
    const draft = buildServerConfigDraft(makeState({
      provider: "google",
      agentModelConfig: {
        classification: { provider: "google", model: "gemini-2.5-pro" },
        landing: { provider: "google", model: "gemini-2.5-flash" },
        hosting: { provider: "google", model: "gemini-2.5-flash" },
        embedded: { provider: "google", model: "gemini-2.5-flash" },
        orchestrator: { provider: "google", model: "gemini-2.5-pro" },
      },
    }));

    expect(getDirtyTabs(baseline, draft)).toEqual({
      models: true,
      browser: false,
      evaluation: false,
      "mcp-tools": false,
    });
  });

  it("marks only the evaluation tab dirty when the judge model changes", () => {
    const baseline = snapshotServerConfig(buildServerConfigDraft(makeState()));
    const draft = buildServerConfigDraft(makeState({
      deepevalProvider: "google",
      deepevalModel: "gemini-2.5-pro",
      deepevalTemperature: "0.2",
    }));

    expect(getDirtyTabs(baseline, draft)).toEqual({
      models: false,
      browser: false,
      evaluation: true,
      "mcp-tools": false,
    });
  });
});
