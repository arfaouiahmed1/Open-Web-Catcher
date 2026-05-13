export const SERVER_TAB_FIELDS = {
  models: [
    "llm_provider",
    "agent_model",
    "orchestrator_model",
    "gemini_temperature",
    "llm_tuning",
    "agent_model_config",
    "provider_cache_enabled",
    "gemini_explicit_cache_enabled",
    "gemini_explicit_cache_ttl_seconds",
    "gemini_explicit_cache_refresh_lead_seconds",
    "tool_result_cache_enabled",
    "tool_result_cache_min_identical_observations",
    "thinking_enabled",
    "thinking_budget_tokens",
    "max_parallel_hosting_pages",
  ],
  browser: [
    "browser_engine",
    "browser_runtime",
  ],
  "mcp-tools": [
    "disabled_tools_by_browser_profile",
  ],
};

const DEFAULT_PROXY_SOURCE_ORDER = [
  "openproxylist-https",
  "proxifly-http",
  "monosans-http",
  "speedx-http",
  "openproxylist-socks5",
  "proxifly-socks5",
  "monosans-socks5",
  "speedx-socks5",
  "proxifly-socks4",
];

function normalizeBrowserRuntimeForSave(value) {
  const runtime = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    ["puppeteer", "playwright"].map((browser) => {
      const current = runtime[browser] && typeof runtime[browser] === "object"
        ? runtime[browser]
        : {};
      return [
        browser,
        {
          ...current,
          proxy_source_mode: current.proxy_source_mode || "hybrid",
          proxy_source_order: Array.isArray(current.proxy_source_order)
            ? current.proxy_source_order
            : [...DEFAULT_PROXY_SOURCE_ORDER],
          proxy_custom_list: Array.isArray(current.proxy_custom_list)
            ? current.proxy_custom_list
            : [],
          proxy_rotation_mode: "sticky",
          proxy_selection_strategy: "ordered",
          proxy_fallback_strategy: "direct",
        },
      ];
    }),
  );
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function pickFields(source, fields) {
  return fields.reduce((acc, field) => {
    acc[field] = source?.[field];
    return acc;
  }, {});
}

export function buildServerConfigDraft(state) {
  return {
    llm_provider: state.provider || "google",
    agent_model: state.agentModelConfig?.classification?.model || "",
    orchestrator_model: state.agentModelConfig?.orchestrator?.model || "",
    gemini_temperature: Number.parseFloat(state.fallbackTemperature || "0") || 0,
    llm_tuning: state.llmTuning || {},
    agent_model_config: state.agentModelConfig || {},
    provider_cache_enabled: Boolean(state.providerCacheEnabled ?? true),
    gemini_explicit_cache_enabled: Boolean(state.geminiExplicitCacheEnabled ?? true),
    gemini_explicit_cache_ttl_seconds: Number(state.geminiExplicitCacheTtl || 1800),
    gemini_explicit_cache_refresh_lead_seconds: Number(state.geminiExplicitCacheRefreshLead || 120),
    tool_result_cache_enabled: Boolean(state.toolCacheEnabled ?? true),
    tool_result_cache_min_identical_observations: Number(state.toolCacheStable || 2),
    thinking_enabled: Boolean(state.thinkingEnabled ?? false),
    thinking_budget_tokens: Number(state.thinkingBudgetTokens || 8000),
    max_parallel_hosting_pages: Number(state.maxParallelHostingPages || 5),
    browser_engine: state.browserEngine || "puppeteer",
    disabled_tools_by_browser_profile: state.disabledToolsByBrowserProfile || {},
    browser_runtime: normalizeBrowserRuntimeForSave(state.browserRuntime),
  };
}

export function snapshotServerConfig(payload) {
  return sortValue({
    llm_provider: payload?.llm_provider || "google",
    agent_model: payload?.agent_model || "",
    orchestrator_model: payload?.orchestrator_model || "",
    gemini_temperature: Number.parseFloat(String(payload?.gemini_temperature ?? "0")) || 0,
    llm_tuning: payload?.llm_tuning || {},
    agent_model_config: payload?.agent_model_config || {},
    provider_cache_enabled: Boolean(payload?.provider_cache_enabled ?? true),
    gemini_explicit_cache_enabled: Boolean(payload?.gemini_explicit_cache_enabled ?? true),
    gemini_explicit_cache_ttl_seconds: Number(payload?.gemini_explicit_cache_ttl_seconds ?? 1800),
    gemini_explicit_cache_refresh_lead_seconds: Number(payload?.gemini_explicit_cache_refresh_lead_seconds ?? 120),
    tool_result_cache_enabled: Boolean(payload?.tool_result_cache_enabled ?? true),
    tool_result_cache_min_identical_observations: Number(payload?.tool_result_cache_min_identical_observations ?? 2),
    thinking_enabled: Boolean(payload?.thinking_enabled ?? false),
    thinking_budget_tokens: Number(payload?.thinking_budget_tokens ?? 8000),
    max_parallel_hosting_pages: Number(payload?.max_parallel_hosting_pages ?? 5),
    browser_engine: payload?.browser_engine || "puppeteer",
    disabled_tools_by_browser_profile: payload?.disabled_tools_by_browser_profile || {},
    browser_runtime: normalizeBrowserRuntimeForSave(payload?.browser_runtime),
  });
}

export function hasServerConfigChanged(baseline, draft) {
  if (!baseline) return false;
  return stableStringify(snapshotServerConfig(baseline)) !== stableStringify(snapshotServerConfig(draft));
}

export function getDirtyTabs(baseline, draft) {
  if (!baseline) {
    return {
      models: false,
      browser: false,
      "mcp-tools": false,
    };
  }

  const normalizedBaseline = snapshotServerConfig(baseline);
  const normalizedDraft = snapshotServerConfig(draft);

  return Object.fromEntries(
    Object.entries(SERVER_TAB_FIELDS).map(([tabId, fields]) => [
      tabId,
      stableStringify(pickFields(normalizedBaseline, fields)) !== stableStringify(pickFields(normalizedDraft, fields)),
    ])
  );
}
