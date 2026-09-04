import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ModelsTab } from "./models-tab";

const baseProps = {
  provider: "google",
  providers: [
    { id: "google", name: "Google Gemini", keyEnv: "GOOGLE_API_KEY", color: "#4285F4", category: "Frontier", features: ["caching"] },
    { id: "openai", name: "OpenAI", keyEnv: "OPENAI_API_KEY", color: "#10a37f", category: "Frontier", features: ["tools"] },
  ],
  agentModelConfig: {
    classification: { provider: "google", model: "gemini-2.5-flash" },
    landing: { provider: "google", model: "gemini-2.5-flash" },
    hosting: { provider: "google", model: "gemini-2.5-flash" },
    embedded: { provider: "google", model: "gemini-2.5-flash" },
    orchestrator: { provider: "google", model: "gemini-2.5-flash" },
  },
  fallbackTemperature: "0.7",
  promptCacheEnabled: true,
  toolCacheEnabled: true,
  toolCacheStable: "2",
  thinkingEnabled: false,
  thinkingBudgetTokens: "8000",
  maxParallelHostingPages: "5",
  catalogModels: [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", context_window: 1000000, capabilities: { supports_tools: true } },
  ],
  catalogQuery: "",
  selectedCatalogModelId: "gemini-2.5-flash",
  catalogAssignmentTarget: "global",
  catalogLoading: "",
  pricingSyncLoading: "",
  activeCatalog: { source: "provider_api" },
  activePricingStatus: { model_count: 1 },
  apiKeys: { google: true },
  dirtyCount: 2,
  dirty: true,
  saving: false,
  warnings: [],
  modelSelectionDetails: {},
  savedGlobal: "gemini-2.5-flash",
  savedOrchestrator: "gemini-2.5-flash",
  onProviderChange: vi.fn(),
  onApplyToAllAgents: vi.fn(),
  onUpdateAgentModel: vi.fn(),
  onUpdateAgentProvider: vi.fn(),
  onInheritToggle: vi.fn(),
  onFallbackTemperature: vi.fn(),
  onPromptCache: vi.fn(),
  onToolCache: vi.fn(),
  onToolCacheStable: vi.fn(),
  onThinking: vi.fn(),
  onThinkingBudget: vi.fn(),
  onMaxParallel: vi.fn(),
  onCatalogQuery: vi.fn(),
  onSelectCatalogModel: vi.fn(),
  onCatalogTarget: vi.fn(),
  onApplyCatalogToTarget: () => {},
  onRefreshCatalog: () => {},
  onSyncPricing: () => {},
  onDiscard: () => {},
  onSave: () => {},
};

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("Settings ModelsTab (Phase 1 rebuild)", () => {
  it("renders the global default, routing, runtime, and catalog workspace", () => {
    const markup = html(<ModelsTab {...baseProps} />);
    expect(markup).toContain("Global default model");
    expect(markup).toContain("Apply to all agents");
    expect(markup).toContain("Agent model routing");
    expect(markup).toContain("Inherit");
    expect(markup).toContain("Runtime &amp; caching controls");
    expect(markup).toContain("Temperature");
    expect(markup).toContain("LiteLLM prompt caching");
    expect(markup).toContain("Live catalog &amp; pricing reference");
  });

  it("shows the sticky save bar with the dirty count", () => {
    const markup = html(<ModelsTab {...baseProps} />);
    expect(markup).toContain("2 unsaved changes");
    expect(markup).toContain("Save model settings");
    expect(markup).toContain("Discard changes");
  });

  it("surfaces validation errors for out-of-range knobs", () => {
    const markup = html(<ModelsTab {...baseProps} fallbackTemperature="9" maxParallelHostingPages="99" />);
    expect(markup).toContain("0.0 and 2.0");
    expect(markup).toContain("1 to 16");
    expect(markup).toContain("Fix validation");
  });

  it("renders per-agent inherit state for custom overrides", () => {
    const markup = html(
      <ModelsTab
        {...baseProps}
        agentModelConfig={{
          ...baseProps.agentModelConfig,
          landing: { provider: "openai", model: "gpt-4o-mini" },
        }}
      />,
    );
    expect(markup).toContain("Custom override");
    expect(markup).toContain("gpt-4o-mini");
  });
});
