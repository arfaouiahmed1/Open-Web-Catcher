export const SERVER_TAB_FIELDS: Record<string, string[]> = {
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
  browser: ["browser_engine", "browser_runtime", "max_parallel_hosting_pages"],
  "mcp-tools": ["disabled_tools_by_browser_profile"],
};

// Allowlist of operator-editable browser runtime keys. Fingerprint, proxy,
// and media-retry persona knobs are intentionally excluded so they are never
// rendered or persisted from the UI; they remain server/environment managed.
export const BROWSER_RUNTIME_KEYS: string[] = [
  "launch_timeout_ms",
  "extra_launch_args",
  "adblock_allowlist_hosts",
  "streaming_safe_mode",
  "asset_diagnostics_enabled",
  "popup_blocking_enabled",
  "ubol_enabled",
  "stream_cors_patch_enabled",
  "stream_cors_include_credentials",
  "iframe_sandbox_patch_enabled",
  "iframe_auto_recovery_enabled",
  "iframe_recovery_timeout_ms",
  "media_capture_timeout_ms",
  "media_cors_patch_enabled",
  "media_playback_verification_enabled",
];

function normalizeBrowserRuntimeForSave(value: unknown): Record<string, Record<string, unknown>> {
  const runtime = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    ["playwright"].map((browser) => {
      const current =
        runtime[browser] && typeof runtime[browser] === "object"
          ? (runtime[browser] as Record<string, unknown>)
          : {};
      const next: Record<string, unknown> = {};
      BROWSER_RUNTIME_KEYS.forEach((key) => {
        if (current[key] !== undefined) next[key] = current[key];
      });
      return [browser, next];
    }),
  );
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(sortValue);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortValue((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function pickFields(source: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return fields.reduce<Record<string, unknown>>((acc, field) => {
    acc[field] = source?.[field];
    return acc;
  }, {});
}

export interface ServerConfigState {
  provider?: unknown;
  agentModelConfig?: Record<string, Record<string, unknown>>;
  fallbackTemperature?: unknown;
  llmTuning?: unknown;
  providerCacheEnabled?: unknown;
  geminiExplicitCacheEnabled?: unknown;
  geminiExplicitCacheTtl?: unknown;
  geminiExplicitCacheRefreshLead?: unknown;
  toolCacheEnabled?: unknown;
  toolCacheStable?: unknown;
  thinkingEnabled?: unknown;
  thinkingBudgetTokens?: unknown;
  maxParallelHostingPages?: unknown;
  browserEngine?: unknown;
  disabledToolsByBrowserProfile?: unknown;
  browserRuntime?: unknown;
}

export function buildServerConfigDraft(state: ServerConfigState): Record<string, unknown> {
  return {
    llm_provider: (state.provider as string | undefined) ?? "google",
    agent_model: (state.agentModelConfig?.classification?.model as string | undefined) ?? "",
    orchestrator_model: (state.agentModelConfig?.orchestrator?.model as string | undefined) ?? "",
    gemini_temperature: Number.parseFloat(String(state.fallbackTemperature ?? "0")) || 0,
    llm_tuning: state.llmTuning ?? {},
    agent_model_config: state.agentModelConfig ?? {},
    provider_cache_enabled: Boolean(state.providerCacheEnabled ?? true),
    gemini_explicit_cache_enabled: Boolean(state.geminiExplicitCacheEnabled ?? true),
    gemini_explicit_cache_ttl_seconds: Number((state.geminiExplicitCacheTtl as number | string | undefined) ?? 1800),
    gemini_explicit_cache_refresh_lead_seconds: Number(
      (state.geminiExplicitCacheRefreshLead as number | string | undefined) ?? 120,
    ),
    tool_result_cache_enabled: Boolean(state.toolCacheEnabled ?? true),
    tool_result_cache_min_identical_observations: Number((state.toolCacheStable as number | string | undefined) ?? 2),
    thinking_enabled: Boolean(state.thinkingEnabled ?? false),
    thinking_budget_tokens: Number((state.thinkingBudgetTokens as number | string | undefined) ?? 8000),
    max_parallel_hosting_pages: Number((state.maxParallelHostingPages as number | string | undefined) ?? 5),
    browser_engine: (state.browserEngine as string | undefined) ?? "playwright",
    disabled_tools_by_browser_profile: state.disabledToolsByBrowserProfile ?? {},
    browser_runtime: normalizeBrowserRuntimeForSave(state.browserRuntime),
  };
}

export function snapshotServerConfig(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const agentModelConfig = (p.agent_model_config ?? {}) as Record<string, Record<string, unknown>>;
  const classificationModel =
    (agentModelConfig?.classification?.model as string | undefined) ?? (p?.agent_model as string | undefined) ?? "";
  const orchestratorModel =
    (agentModelConfig?.orchestrator?.model as string | undefined) ??
    (p?.orchestrator_model as string | undefined) ??
    classificationModel;
  return sortValue({
    llm_provider: (p?.llm_provider as string | undefined) ?? "google",
    agent_model: classificationModel,
    orchestrator_model: orchestratorModel,
    gemini_temperature: Number.parseFloat(String(p?.gemini_temperature ?? "0")) || 0,
    llm_tuning: p?.llm_tuning ?? {},
    agent_model_config: p?.agent_model_config ?? {},
    provider_cache_enabled: Boolean(p?.provider_cache_enabled ?? true),
    gemini_explicit_cache_enabled: Boolean(p?.gemini_explicit_cache_enabled ?? true),
    gemini_explicit_cache_ttl_seconds: Number((p?.gemini_explicit_cache_ttl_seconds as number | undefined) ?? 1800),
    gemini_explicit_cache_refresh_lead_seconds: Number(
      (p?.gemini_explicit_cache_refresh_lead_seconds as number | undefined) ?? 120,
    ),
    tool_result_cache_enabled: Boolean(p?.tool_result_cache_enabled ?? true),
    tool_result_cache_min_identical_observations: Number(
      (p?.tool_result_cache_min_identical_observations as number | undefined) ?? 2,
    ),
    thinking_enabled: Boolean(p?.thinking_enabled ?? false),
    thinking_budget_tokens: Number((p?.thinking_budget_tokens as number | undefined) ?? 8000),
    max_parallel_hosting_pages: Number((p?.max_parallel_hosting_pages as number | undefined) ?? 5),
    browser_engine: (p?.browser_engine as string | undefined) ?? "playwright",
    disabled_tools_by_browser_profile: p?.disabled_tools_by_browser_profile ?? {},
    browser_runtime: normalizeBrowserRuntimeForSave(p?.browser_runtime),
  }) as Record<string, unknown>;
}

export function hasServerConfigChanged(
  baseline: Record<string, unknown> | null | undefined,
  draft: Record<string, unknown> | null | undefined,
): boolean {
  if (!baseline) return false;
  return stableStringify(snapshotServerConfig(baseline)) !== stableStringify(snapshotServerConfig(draft));
}

export function getDirtyTabs(
  baseline: Record<string, unknown> | null | undefined,
  draft: Record<string, unknown> | null | undefined,
): Record<string, boolean> {
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
      stableStringify(pickFields(normalizedBaseline, fields)) !==
        stableStringify(pickFields(normalizedDraft, fields)),
    ]),
  );
}
