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
    deepevalProvider: "openai",
    deepevalModel: "gpt-4o",
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
      provider: "openai",
      agentModelConfig: {
        classification: { provider: "openai", model: "gpt-4o-mini" },
        landing: { provider: "google", model: "gemini-2.5-flash" },
        hosting: { provider: "google", model: "gemini-2.5-flash" },
        embedded: { provider: "google", model: "gemini-2.5-flash" },
        orchestrator: { provider: "openai", model: "gpt-4o" },
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
      deepevalProvider: "anthropic",
      deepevalModel: "claude-3-7-sonnet",
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
