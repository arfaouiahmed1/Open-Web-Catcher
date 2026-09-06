import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiKeysTab, ApiKeysTabProvider } from "./api-keys-tab";

const mockProviders: ApiKeysTabProvider[] = [
  {
    id: "google",
    name: "Google Gemini",
    keyEnv: "GOOGLE_API_KEY",
    color: "#4285F4",
    category: "Frontier",
    features: ["caching", "multimodal"],
  },
  {
    id: "openai",
    name: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    color: "#10a37f",
    category: "Frontier",
    features: ["tools", "reasoning"],
  },
  {
    id: "groq",
    name: "Groq",
    keyEnv: "GROQ_API_KEY",
    color: "#f55036",
    category: "Speed",
    features: ["fast"],
  },
];

const defaultProps = {
  providers: mockProviders,
  apiKeys: { google: "configured" },
  keyEdits: { google: null, openai: null, groq: null },
  baseUrlEdits: {},
  showKey: {},
  keyTestState: {},
  providerKeyQuery: "",
  providerKeyCategory: "All",
  providerKeyStatus: "All",
  configuredBaseUrls: {},
  registryBaseUrls: {},
  onQuery: vi.fn(),
  onCategory: vi.fn(),
  onStatus: vi.fn(),
  onKeyEdit: vi.fn(),
  onKeyClear: vi.fn(),
  onKeyUndo: vi.fn(),
  onToggleShow: vi.fn(),
  onBaseUrlEdit: vi.fn(),
  onTest: vi.fn(),
  onClearFilters: vi.fn(),
};

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("ApiKeysTab", () => {
  it("renders provider list grouped by category", () => {
    const markup = html(<ApiKeysTab {...defaultProps} />);
    expect(markup).toContain("Google Gemini");
    expect(markup).toContain("OpenAI");
    expect(markup).toContain("Groq");
    expect(markup).toContain("Frontier");
    expect(markup).toContain("Speed");
  });

  it("masks keys with password type by default and changes to text when showKey is true", () => {
    const hiddenMarkup = html(<ApiKeysTab {...defaultProps} showKey={{ google: false }} />);
    expect(hiddenMarkup).toContain('name="provider.google.apiKey"');
    expect(hiddenMarkup).toContain('type="password"');

    const shownMarkup = html(<ApiKeysTab {...defaultProps} showKey={{ google: true }} />);
    expect(shownMarkup).toContain('name="provider.google.apiKey"');
    expect(shownMarkup).toContain('type="text"');
  });

  it("filters on effective draft state when key is edited in draft", () => {
    // OpenAI is missing on server, but edited in draft
    const markupWithDraft = html(
      <ApiKeysTab
        {...defaultProps}
        providerKeyStatus="Configured"
        keyEdits={{ openai: "sk-draft-key" }}
      />
    );
    expect(markupWithDraft).toContain("OpenAI");
  });

  it("renders test verified and failed badges accessibly", () => {
    const markup = html(
      <ApiKeysTab
        {...defaultProps}
        keyTestState={{ google: "ok", openai: "error" }}
      />
    );
    expect(markup).toContain("verified");
    expect(markup).toContain("failed");
  });
});
