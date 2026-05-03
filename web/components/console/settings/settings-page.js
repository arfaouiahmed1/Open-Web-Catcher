"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Key,
  Loader2,
  RefreshCw,
  Save,
  Settings2,
  ToggleLeft,
  ToggleRight,
  Wrench,
} from "lucide-react";

import { useNotifPrefs } from "@/components/notification-provider";
import {
  RunViewSettingsPanel,
  useRunViewSettings,
} from "@/components/run-view-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HelpIcon } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, apiUrl } from "@/lib/api";
import {
  buildServerConfigDraft,
  getDirtyTabs,
  snapshotServerConfig,
} from "@/lib/settings-page";

const PROVIDERS = [
  {
    id: "google",
    name: "Google Gemini",
    keyEnv: "GOOGLE_API_KEY",
    color: "var(--sky)",
    features: ["caching", "thinking", "grounding", "vision"],
  },
  {
    id: "openai",
    name: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    color: "var(--mint)",
    features: ["caching", "vision", "tools", "reasoning"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    color: "var(--signal)",
    features: ["caching", "thinking", "vision", "tools"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    color: "var(--violet)",
    features: ["unified-api", "100+ models"],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    keyEnv: "NVIDIA_API_KEY",
    color: "var(--mint)",
    features: ["local-compatible", "optimized"],
  },
  {
    id: "mistral",
    name: "Mistral AI",
    keyEnv: "MISTRAL_API_KEY",
    color: "var(--signal)",
    features: ["fast", "efficient", "multilingual"],
  },
  {
    id: "xai",
    name: "xAI / Grok",
    keyEnv: "XAI_API_KEY",
    color: "var(--ink)",
    features: ["large-context", "real-time"],
  },
  {
    id: "groq",
    name: "Groq",
    keyEnv: "GROQ_API_KEY",
    color: "var(--rose)",
    features: ["ultra-fast", "llama", "whisper"],
  },
  {
    id: "together",
    name: "Together AI",
    keyEnv: "TOGETHER_API_KEY",
    color: "var(--sky)",
    features: ["open-source", "fine-tuning"],
  },
  {
    id: "cohere",
    name: "Cohere",
    keyEnv: "COHERE_API_KEY",
    color: "var(--violet)",
    features: ["rag", "rerank", "embed"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    keyEnv: "DEEPSEEK_API_KEY",
    color: "var(--sky)",
    features: ["cost-efficient", "coding", "math"],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    keyEnv: "PERPLEXITY_API_KEY",
    color: "var(--violet)",
    features: ["search-augmented", "citations"],
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    keyEnv: "AZURE_OPENAI_API_KEY",
    color: "var(--sky)",
    features: ["enterprise", "compliance", "private"],
  },
];

const AGENT_SLOTS = [
  { id: "classification", label: "Classification", note: "Page typing" },
  { id: "landing", label: "Landing", note: "Link discovery" },
  { id: "hosting", label: "Hosting", note: "Direct extraction" },
  { id: "embedded", label: "Embedded", note: "Player recovery" },
  { id: "orchestrator", label: "Orchestrator", note: "Pipeline default" },
];

const MCP_TOOLS_BY_PROFILE = {
  classification: [
    "navigate",
    "inspect",
    "interact",
    "screenshot",
    "memory_lookup",
    "memory_update",
    "open_url",
    "get_page_context",
    "get_frame_tree",
    "query_elements",
    "get_element_detail",
    "scroll_page",
    "go_back",
    "wait_for_page_state",
  ],
  landing: [
    "navigate",
    "inspect_landing",
    "interact",
    "screenshot",
    "memory_lookup",
    "memory_update",
    "get_page_context",
    "query_elements",
    "get_element_detail",
    "get_frame_tree",
    "open_url",
    "go_back",
    "scroll_page",
    "scroll_to_element",
    "wait_for_page_state",
    "click_element",
    "click_css",
    "click_text",
    "click_xpath",
    "click_checkbox",
    "click_radio",
    "type_into",
    "select_option",
    "play_media",
    "swipe_region",
    "click_coordinates",
  ],
  hosting: [
    "navigate",
    "inspect_hosting",
    "interact",
    "screenshot",
    "memory_lookup",
    "memory_update",
    "harvest",
    "get_page_context",
    "query_elements",
    "get_element_detail",
    "get_frame_tree",
    "open_url",
    "go_back",
    "scroll_page",
    "scroll_to_element",
    "wait_for_page_state",
    "click_element",
    "click_css",
    "click_text",
    "click_xpath",
    "click_checkbox",
    "click_radio",
    "type_into",
    "select_option",
    "play_media",
    "swipe_region",
    "click_coordinates",
    "get_media_state",
    "capture_streams",
  ],
  embedded: [
    "navigate",
    "inspect_embedded",
    "interact",
    "screenshot",
    "memory_lookup",
    "memory_update",
    "harvest",
    "get_page_context",
    "query_elements",
    "get_element_detail",
    "get_frame_tree",
    "open_url",
    "go_back",
    "scroll_page",
    "scroll_to_element",
    "wait_for_page_state",
    "click_element",
    "click_css",
    "click_text",
    "click_xpath",
    "click_checkbox",
    "click_radio",
    "type_into",
    "select_option",
    "play_media",
    "swipe_region",
    "click_coordinates",
    "get_media_state",
    "capture_streams",
  ],
};

const PROFILE_LABELS = {
  classification: "Classification",
  landing: "Landing Page",
  hosting: "Hosting Page",
  embedded: "Embedded Page",
};

const BROWSER_OPTIONS = [
  { id: "puppeteer", name: "Puppeteer", note: "Port 3000 - mature, CDP-based" },
  {
    id: "playwright",
    name: "Playwright",
    note: "Port 3001 - context isolation, modern",
  },
];

const DEFAULT_PROXY_SOURCE_ORDER = [
  "openproxylist-https",
  "openproxylist-socks5",
  "speedx-http",
  "speedx-socks5",
];

const BUILTIN_PROXY_SOURCE_OPTIONS = [
  {
    value: "openproxylist-https",
    label: "OpenProxyList HTTPS",
    description: "Tested public HTTPS proxies from openproxylist.com",
  },
  {
    value: "openproxylist-socks4",
    label: "OpenProxyList SOCKS4",
    description: "SOCKS4 list from openproxylist.com",
  },
  {
    value: "openproxylist-socks5",
    label: "OpenProxyList SOCKS5",
    description: "SOCKS5 list from openproxylist.com",
  },
  {
    value: "speedx-http",
    label: "TheSpeedX HTTP",
    description: "Fast raw HTTP list from TheSpeedX/SOCKS-List",
  },
  {
    value: "speedx-socks4",
    label: "TheSpeedX SOCKS4",
    description: "SOCKS4 raw list from TheSpeedX/SOCKS-List",
  },
  {
    value: "speedx-socks5",
    label: "TheSpeedX SOCKS5",
    description: "SOCKS5 raw list from TheSpeedX/SOCKS-List",
  },
];

const SETTINGS_TABS = [
  { id: "models", label: "Models & Provider" },
  { id: "browser", label: "Browser" },
  { id: "evaluation", label: "Evaluation" },
  { id: "display", label: "Display" },
  { id: "api-keys", label: "API Keys" },
  { id: "notifications", label: "Notifications" },
  { id: "mcp-tools", label: "MCP Tools" },
];

const TAB_DETAILS = {
  models: {
    title: "Models and provider routing",
    description:
      "Set provider defaults, per-agent model assignments, and caching behavior for the active runtime.",
    storage: "server",
    saveLabel: "Save model settings",
  },
  browser: {
    title: "Browser runtime",
    description:
      "Choose the default engine and tune fingerprints, proxies, launch flags, iframe recovery, and media capture behavior.",
    storage: "server",
    saveLabel: "Save browser settings",
  },
  evaluation: {
    title: "Evaluation judge",
    description:
      "Configure the separate judge model used for DeepEval scoring and offline evaluation runs.",
    storage: "server",
    saveLabel: "Save evaluation settings",
  },
  display: {
    title: "Run detail display",
    description:
      "Control what appears on run detail pages and how aggressively the UI refreshes in this browser.",
    storage: "browser",
  },
  "api-keys": {
    title: "API key status",
    description:
      "See which providers are ready for live catalogs and runtime calls. This tab is informational only.",
    storage: "readonly",
  },
  notifications: {
    title: "Notifications",
    description:
      "Choose which pipeline milestones trigger toast notifications in this browser.",
    storage: "browser",
  },
  "mcp-tools": {
    title: "MCP tool availability",
    description:
      "Enable or disable browser tools independently for each profile and browser backend.",
    storage: "server",
    saveLabel: "Save MCP tool settings",
  },
};

const NOTIF_EVENTS = [
  {
    key: "pipeline_started",
    label: "Pipeline started",
    note: "Fired when a new pipeline begins",
  },
  {
    key: "agent_started",
    label: "Agent transitions (started)",
    note: "Each agent activation",
  },
  {
    key: "agent_finished",
    label: "Agent transitions (finished)",
    note: "Each agent completion",
  },
  {
    key: "agent_failed",
    label: "Agent failures",
    note: "When an agent errors out",
  },
  {
    key: "pipeline_finished",
    label: "Pipeline completed",
    note: "Successful pipeline end",
  },
  {
    key: "pipeline_failed",
    label: "Pipeline failed",
    note: "Fatal pipeline failure",
  },
  {
    key: "run_cancelled",
    label: "Run cancelled",
    note: "User or system cancellation",
  },
];

const EMPTY_TUNING = {
  provider_defaults: {},
  model_overrides: {},
  agent_overrides: {},
};

const DEFAULT_BROWSER_RUNTIME = {
  puppeteer: {
    launch_timeout_ms: 45000,
    extra_launch_args: [],
    adblock_enabled: false,
    adblock_allowlist_hosts: [],
    adblock_excluded_categories: ["nsfw", "gambling"],
    adblock_auto_recovery_enabled: true,
    adblock_auto_recovery_on_abort: true,
    adblock_auto_recovery_retry: true,
    fingerprint_rotation_mode: "origin",
    fingerprint_fallback_strategy: "profile",
    fingerprint_rotation_interval_ms: 180000,
    fingerprint_rotation_max_uses: 6,
    fingerprint_recent_pool_size: 12,
    proxy_enabled: false,
    proxy_source_mode: "hybrid",
    proxy_source_order: [...DEFAULT_PROXY_SOURCE_ORDER],
    proxy_custom_list: [],
    proxy_rotation_mode: "session",
    proxy_selection_strategy: "ordered",
    proxy_fallback_strategy: "direct",
    proxy_fetch_timeout_ms: 8000,
    proxy_validation_timeout_ms: 12000,
    proxy_cache_ttl_ms: 600000,
    proxy_max_candidates: 25,
    proxy_test_url: "https://api.ipify.org?format=json",
    streaming_safe_mode: "adaptive",
    media_proxy_strategy: "direct_first",
    asset_diagnostics_enabled: true,
    ubol_enabled: true,
    stream_cors_patch_enabled: false,
    stream_cors_include_credentials: false,
    iframe_sandbox_patch_enabled: true,
    iframe_auto_recovery_enabled: true,
    iframe_recovery_timeout_ms: 20000,
    media_capture_timeout_ms: 30000,
    media_retry_count: 3,
    media_retry_backoff_ms: [1000, 2000, 4000],
    media_cors_patch_enabled: false,
    media_playback_verification_enabled: true,
  },
  playwright: {
    launch_timeout_ms: 45000,
    extra_launch_args: [],
    adblock_enabled: false,
    adblock_allowlist_hosts: [],
    adblock_excluded_categories: ["nsfw", "gambling"],
    adblock_auto_recovery_enabled: true,
    adblock_auto_recovery_on_abort: true,
    adblock_auto_recovery_retry: true,
    fingerprint_rotation_mode: "origin",
    fingerprint_fallback_strategy: "profile",
    fingerprint_rotation_interval_ms: 180000,
    fingerprint_rotation_max_uses: 6,
    fingerprint_recent_pool_size: 12,
    proxy_enabled: false,
    proxy_source_mode: "hybrid",
    proxy_source_order: [...DEFAULT_PROXY_SOURCE_ORDER],
    proxy_custom_list: [],
    proxy_rotation_mode: "session",
    proxy_selection_strategy: "ordered",
    proxy_fallback_strategy: "direct",
    proxy_fetch_timeout_ms: 8000,
    proxy_validation_timeout_ms: 12000,
    proxy_cache_ttl_ms: 600000,
    proxy_max_candidates: 25,
    proxy_test_url: "https://api.ipify.org?format=json",
    streaming_safe_mode: "adaptive",
    media_proxy_strategy: "direct_first",
    asset_diagnostics_enabled: true,
    iframe_sandbox_patch_enabled: true,
    iframe_auto_recovery_enabled: true,
    iframe_recovery_timeout_ms: 20000,
    media_capture_timeout_ms: 30000,
    media_retry_count: 3,
    media_retry_backoff_ms: [1000, 2000, 4000],
    media_cors_patch_enabled: false,
    media_playback_verification_enabled: true,
  },
};

function cloneBrowserRuntime() {
  return {
    puppeteer: {
      ...DEFAULT_BROWSER_RUNTIME.puppeteer,
      extra_launch_args: [
        ...DEFAULT_BROWSER_RUNTIME.puppeteer.extra_launch_args,
      ],
      adblock_allowlist_hosts: [
        ...DEFAULT_BROWSER_RUNTIME.puppeteer.adblock_allowlist_hosts,
      ],
      adblock_excluded_categories: [
        ...DEFAULT_BROWSER_RUNTIME.puppeteer.adblock_excluded_categories,
      ],
      proxy_source_order: [
        ...DEFAULT_BROWSER_RUNTIME.puppeteer.proxy_source_order,
      ],
      proxy_custom_list: [
        ...DEFAULT_BROWSER_RUNTIME.puppeteer.proxy_custom_list,
      ],
      media_retry_backoff_ms: [
        ...DEFAULT_BROWSER_RUNTIME.puppeteer.media_retry_backoff_ms,
      ],
    },
    playwright: {
      ...DEFAULT_BROWSER_RUNTIME.playwright,
      extra_launch_args: [
        ...DEFAULT_BROWSER_RUNTIME.playwright.extra_launch_args,
      ],
      adblock_allowlist_hosts: [
        ...DEFAULT_BROWSER_RUNTIME.playwright.adblock_allowlist_hosts,
      ],
      adblock_excluded_categories: [
        ...DEFAULT_BROWSER_RUNTIME.playwright.adblock_excluded_categories,
      ],
      proxy_source_order: [
        ...DEFAULT_BROWSER_RUNTIME.playwright.proxy_source_order,
      ],
      proxy_custom_list: [
        ...DEFAULT_BROWSER_RUNTIME.playwright.proxy_custom_list,
      ],
      media_retry_backoff_ms: [
        ...DEFAULT_BROWSER_RUNTIME.playwright.media_retry_backoff_ms,
      ],
    },
  };
}

function normalizeStringList(value, fallback = []) {
  let rows = [];
  if (Array.isArray(value))
    rows = value.map((item) => String(item || "").trim());
  else if (typeof value === "string")
    rows = value.split(",").map((item) => item.trim());
  else rows = fallback;

  const seen = new Set();
  const deduped = [];
  rows.forEach((item) => {
    if (!item) return;
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(item);
  });
  return deduped;
}

function normalizeIntegerList(value, fallback = []) {
  let rows = [];
  if (Array.isArray(value)) rows = value;
  else if (typeof value === "string")
    rows = value.split(",").map((item) => item.trim());
  else rows = fallback;

  return rows
    .map((item) => Number.parseInt(String(item ?? "").trim(), 10))
    .filter((item) => Number.isFinite(item) && item >= 0);
}

function normalizeTuning(tuning) {
  if (!tuning || typeof tuning !== "object") return { ...EMPTY_TUNING };

  const providerDefaults = {};
  Object.entries(tuning.provider_defaults || {}).forEach(
    ([provider, value]) => {
      if (value && typeof value === "object")
        providerDefaults[String(provider).toLowerCase()] = { ...value };
    },
  );

  const modelOverrides = {};
  Object.entries(tuning.model_overrides || {}).forEach(([key, value]) => {
    if (value && typeof value === "object")
      modelOverrides[String(key).toLowerCase()] = { ...value };
  });

  const agentOverrides = {};
  Object.entries(tuning.agent_overrides || {}).forEach(([key, value]) => {
    if (value && typeof value === "object")
      agentOverrides[String(key).toLowerCase()] = { ...value };
  });

  return {
    provider_defaults: providerDefaults,
    model_overrides: modelOverrides,
    agent_overrides: agentOverrides,
  };
}

function normalizeAgentModelConfig(
  config,
  fallbackProvider = "google",
  fallbackAgentModel = "",
  fallbackOrchModel = "",
) {
  const defaults = {
    classification: { provider: fallbackProvider, model: fallbackAgentModel },
    landing: { provider: fallbackProvider, model: fallbackAgentModel },
    hosting: { provider: fallbackProvider, model: fallbackAgentModel },
    embedded: { provider: fallbackProvider, model: fallbackAgentModel },
    orchestrator: {
      provider: fallbackProvider,
      model: fallbackOrchModel || fallbackAgentModel,
    },
  };

  if (!config || typeof config !== "object") return defaults;

  const next = {};
  AGENT_SLOTS.forEach(({ id }) => {
    const row = config[id];
    next[id] = {
      provider: String(
        row?.provider || defaults[id].provider || fallbackProvider,
      ).toLowerCase(),
      model: String(row?.model || defaults[id].model || ""),
    };
  });
  return next;
}

function normalizeBrowserRuntime(value) {
  const base = cloneBrowserRuntime();
  if (!value || typeof value !== "object") return base;

  BROWSER_OPTIONS.forEach(({ id }) => {
    const current = value[id];
    if (!current || typeof current !== "object") return;
    base[id] = {
      ...base[id],
      ...current,
      extra_launch_args: normalizeStringList(
        current.extra_launch_args,
        base[id].extra_launch_args,
      ),
      adblock_allowlist_hosts: normalizeStringList(
        current.adblock_allowlist_hosts,
        base[id].adblock_allowlist_hosts,
      ),
      adblock_excluded_categories: normalizeStringList(
        current.adblock_excluded_categories,
        base[id].adblock_excluded_categories,
      ),
      proxy_source_order: normalizeStringList(
        current.proxy_source_order,
        base[id].proxy_source_order,
      ),
      proxy_custom_list: normalizeStringList(
        current.proxy_custom_list,
        base[id].proxy_custom_list,
      ),
      media_retry_backoff_ms: normalizeIntegerList(
        current.media_retry_backoff_ms,
        base[id].media_retry_backoff_ms,
      ),
    };
  });

  return base;
}

function normalizeDisabledToolsByBrowserProfile(value, legacy = {}) {
  const next = Object.fromEntries(
    BROWSER_OPTIONS.map(({ id }) => [
      id,
      Object.fromEntries(
        Object.keys(MCP_TOOLS_BY_PROFILE).map((profile) => [
          profile,
          normalizeStringList(legacy[profile] || []),
        ]),
      ),
    ]),
  );

  if (!value || typeof value !== "object") return next;

  Object.keys(MCP_TOOLS_BY_PROFILE).forEach((profile) => {
    if (Array.isArray(value[profile])) {
      BROWSER_OPTIONS.forEach(({ id }) => {
        next[id][profile] = normalizeStringList(value[profile]);
      });
    }
  });

  BROWSER_OPTIONS.forEach(({ id }) => {
    const browserRows = value[id];
    if (!browserRows || typeof browserRows !== "object") return;
    Object.keys(MCP_TOOLS_BY_PROFILE).forEach((profile) => {
      if (Array.isArray(browserRows[profile])) {
        next[id][profile] = normalizeStringList(browserRows[profile]);
      }
    });
  });

  return next;
}

function modelOverrideKey(provider, modelId) {
  return `${provider}::${modelId}`.toLowerCase();
}

function parseFieldValue(field, rawValue) {
  if (rawValue === "") return "";
  if (field.type === "integer") {
    const next = Number.parseInt(rawValue, 10);
    return Number.isNaN(next) ? "" : next;
  }
  if (field.type === "number") {
    const next = Number.parseFloat(rawValue);
    return Number.isNaN(next) ? "" : next;
  }
  return rawValue;
}

function fieldMatchesModel(field, modelId) {
  if (!field?.model_patterns?.length) return true;
  if (!modelId) return false;
  return field.model_patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(modelId);
    } catch {
      return false;
    }
  });
}

function ensureSelectedOption(options, value) {
  if (!value) return options;
  if (options.some((option) => option.value === value)) return options;
  return [
    ...options,
    {
      value,
      label: value,
      description: "Manual model ID",
      meta: "custom",
    },
  ];
}

function sourceTone(source) {
  if (source === "provider_api") return "ok";
  return "warn";
}

function sourceLabel(source) {
  if (source === "provider_api") return "Live provider catalog";
  return "Fallback catalog";
}

function providerOptionRows() {
  return PROVIDERS.map((provider) => ({
    value: provider.id,
    label: provider.name,
    description: provider.keyEnv,
  }));
}

function KeyStatus({ set }) {
  return set ? (
    <span
      className="flex items-center gap-1 text-[12px]"
      style={{ color: "var(--mint)" }}
    >
      <CheckCircle2 className="h-3 w-3" />
      set
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[12px] text-[var(--mute)]">
      <AlertCircle className="h-3 w-3" />
      not set
    </span>
  );
}

function SectionHeader({ children }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <h2
        className="shrink-0 text-[10.5px] font-bold uppercase tracking-[0.18em]"
        style={{ color: "var(--mute-2)" }}
      >
        {children}
      </h2>
      <div className="h-px flex-1" style={{ background: "var(--line)" }} />
    </div>
  );
}

function StatusPill({ tone = "neutral", children }) {
  const styles = {
    success: {
      background: "color-mix(in oklch, var(--mint) 12%, transparent)",
      borderColor: "color-mix(in oklch, var(--mint) 30%, transparent)",
      color: "var(--mint)",
    },
    warning: {
      background: "color-mix(in oklch, var(--signal) 12%, transparent)",
      borderColor: "color-mix(in oklch, var(--signal) 30%, transparent)",
      color: "var(--signal)",
    },
    info: {
      background: "color-mix(in oklch, var(--sky) 12%, transparent)",
      borderColor: "color-mix(in oklch, var(--sky) 30%, transparent)",
      color: "var(--sky)",
    },
    neutral: {
      background: "rgba(255,255,255,0.04)",
      borderColor: "var(--line)",
      color: "var(--mute)",
    },
  };

  const style = styles[tone] || styles.neutral;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium"
      style={style}
    >
      {children}
    </span>
  );
}

function ErrorNotice({ message }) {
  if (!message) return null;
  return (
    <div
      className="flex items-start gap-2 rounded-[14px] border px-4 py-3 text-[13px]"
      style={{
        borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)",
        background: "color-mix(in oklch, var(--rose) 10%, transparent)",
        color: "var(--rose)",
      }}
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function SettingsTabHero({
  tabId,
  dirty,
  saving,
  saved,
  onSave,
  otherDirtyCount = 0,
}) {
  const meta = TAB_DETAILS[tabId] || TAB_DETAILS.models;
  const isServerTab = meta.storage === "server";
  const isBrowserTab = meta.storage === "browser";

  return (
    <div
      className="flex flex-wrap items-start justify-between gap-4 pb-6"
      style={{ borderBottom: "1px solid var(--line)" }}
    >
      <div className="space-y-1.5 max-w-2xl">
        <div className="flex flex-wrap items-center gap-2">
          <h1
            className="text-[21px] font-semibold tracking-tight"
            style={{ color: "var(--ink)" }}
          >
            {meta.title}
          </h1>
          {dirty ? (
            <span
              className="rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              style={{
                background:
                  "color-mix(in oklch, var(--signal) 14%, transparent)",
                color: "var(--signal)",
                border:
                  "1px solid color-mix(in oklch, var(--signal) 25%, transparent)",
              }}
            >
              Unsaved
            </span>
          ) : isServerTab && saved ? (
            <span
              className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              style={{
                background: "color-mix(in oklch, var(--mint) 12%, transparent)",
                color: "var(--mint)",
              }}
            >
              <Check className="h-3 w-3" />
              Saved
            </span>
          ) : null}
        </div>
        <p
          className="text-[13.5px] leading-relaxed"
          style={{ color: "var(--mute)" }}
        >
          {meta.description}
        </p>
        {isBrowserTab ? (
          <p className="text-[11.5px]" style={{ color: "var(--mute-2)" }}>
            Preferences saved automatically to your browser.
          </p>
        ) : null}
        {isServerTab && dirty && otherDirtyCount > 0 ? (
          <p className="text-[11.5px]" style={{ color: "var(--signal)" }}>
            {otherDirtyCount} other tab{otherDirtyCount === 1 ? "" : "s"} also
            have unsaved changes.
          </p>
        ) : null}
      </div>

      {isServerTab ? (
        <Button variant="accent" onClick={onSave} disabled={saving || !dirty}>
          {saving ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Saving…
            </>
          ) : saved && !dirty ? (
            <>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Saved
            </>
          ) : (
            <>
              <Save className="mr-1.5 h-3.5 w-3.5" />
              {meta.saveLabel}
            </>
          )}
        </Button>
      ) : null}
    </div>
  );
}

function SettingsTabBar({ active, onChange, dirtyTabs = {} }) {
  const ICONS = {
    models: "◈",
    browser: "⬡",
    evaluation: "◎",
    display: "▣",
    "api-keys": "◇",
    notifications: "◉",
    "mcp-tools": "⬢",
  };

  return (
    <nav className="space-y-0.5">
      <div
        className="px-3 pb-4 mb-1"
        style={{ borderBottom: "1px solid var(--line)" }}
      >
        <div
          className="text-[10px] font-bold uppercase tracking-[0.2em]"
          style={{ color: "var(--mute-3)" }}
        >
          Configuration
        </div>
      </div>
      {SETTINGS_TABS.map((tab) => {
        const isActive = active === tab.id;
        const isDirty = dirtyTabs[tab.id];
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className="group w-full flex items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] font-medium transition-all duration-150"
            style={
              isActive
                ? {
                    background:
                      "color-mix(in oklch, var(--signal) 11%, transparent)",
                    color: "var(--signal)",
                    border:
                      "1px solid color-mix(in oklch, var(--signal) 20%, transparent)",
                  }
                : {
                    color: "var(--mute)",
                    border: "1px solid transparent",
                  }
            }
          >
            <span className="flex items-center gap-2.5">
              <span className="text-[11px] font-mono opacity-60">
                {ICONS[tab.id]}
              </span>
              {tab.label}
            </span>
            {isDirty ? (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: "var(--signal)" }}
                aria-label={`${tab.label} has unsaved changes`}
              />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

function TuningFieldGrid({ fields, values, onChange }) {
  if (!fields.length) {
    return (
      <div
        className="rounded-[12px] border px-3 py-4 text-[12px] text-[var(--mute)]"
        style={{ borderColor: "var(--line)" }}
      >
        No provider-aware controls for this selection yet.
      </div>
    );
  }

  const shouldUseSlider = (field) => {
    // Use sliders for temperature, top_p, and similar fractional fields
    const sliderKeys = ["temperature", "top_p", "top_k"];
    return (
      sliderKeys.some((key) => field.key.toLowerCase().includes(key)) &&
      field.type !== "enum"
    );
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) => {
        const value = values?.[field.key] ?? "";
        if (field.type === "enum") {
          return (
            <Select
              key={field.key}
              label={field.label}
              value={value}
              onChange={(next) => onChange(field, next)}
              options={(field.options || []).map((option) => ({
                value: option,
                label: option,
                description: field.description,
              }))}
              placeholder={`Select ${field.label.toLowerCase()}`}
            />
          );
        }

        // ── temperature / top_p / top_k → styled slider ──────────
        if (shouldUseSlider(field)) {
          return (
            <Slider
              key={field.key}
              label={field.label}
              value={typeof value === "number" ? value : Number(value) || 0}
              onChange={(next) => onChange(field, next)}
              min={field.min ?? 0}
              max={field.max ?? 1}
              step={field.step ?? 0.01}
              description={field.description}
            />
          );
        }

        return (
          <Input
            key={field.key}
            label={field.label}
            description={field.description}
            type="number"
            min={field.min}
            max={field.max}
            step={field.step || "any"}
            className="h-11 border-[var(--line)] bg-black/20 text-[13px] text-[var(--ink-dim)]"
            value={value}
            onChange={(event) =>
              onChange(field, parseFieldValue(field, event.target.value))
            }
          />
        );
      })}
    </div>
  );
}

function TuningCard({
  title,
  description,
  values,
  fields,
  onChange,
  onClear,
  clearLabel,
}) {
  return (
    <div
      className="rounded-[12px] border p-4 space-y-4"
      style={{
        borderColor: "var(--line)",
        background: "var(--card)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div
            className="text-[13px] font-semibold"
            style={{ color: "var(--ink)" }}
          >
            {title}
          </div>
          {description ? (
            <p className="mt-0.5 text-[12px]" style={{ color: "var(--mute)" }}>
              {description}
            </p>
          ) : null}
        </div>
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded-[8px] border px-2.5 py-1 text-[11px] transition-colors hover:opacity-80"
            style={{ borderColor: "var(--line)", color: "var(--mute)" }}
          >
            {clearLabel || "Clear"}
          </button>
        ) : null}
      </div>
      <TuningFieldGrid fields={fields} values={values} onChange={onChange} />
    </div>
  );
}

function MiniSegment({ options, active, onChange }) {
  return (
    <div
      className="flex gap-1.5 rounded-[12px] p-1.5"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid var(--line)",
        width: "fit-content",
      }}
    >
      {options.map((option) => {
        const isActive = option.id === active;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            className="flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium transition-all duration-150"
            style={
              isActive
                ? {
                    background:
                      "color-mix(in oklch, var(--signal) 14%, transparent)",
                    color: "var(--signal)",
                    border:
                      "1px solid color-mix(in oklch, var(--signal) 28%, transparent)",
                  }
                : { color: "var(--mute)", border: "1px solid transparent" }
            }
          >
            {option.label}
            {option.badge ? (
              <span
                className="rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                style={{
                  background:
                    "color-mix(in oklch, var(--rose) 20%, transparent)",
                  color: "var(--rose)",
                }}
              >
                {option.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function FieldNote({ children }) {
  if (!children) return null;
  return <p className="text-[11px] text-[var(--mute)]">{children}</p>;
}

function ToggleRow({ label, checked, onChange, description = "" }) {
  return (
    <div
      className="flex items-start gap-3 rounded-[12px] px-4 py-3"
      style={{
        border: `1px solid ${checked ? "color-mix(in oklch, var(--signal) 22%, var(--line))" : "var(--line)"}`,
        background: checked
          ? "color-mix(in oklch, var(--signal) 5%, rgba(255,255,255,0.01))"
          : "rgba(255,255,255,0.015)",
        transition: "background 0.18s, border-color 0.18s",
      }}
    >
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        className="mt-0.5 data-[state=checked]:bg-[var(--signal)] data-[state=unchecked]:bg-[color:var(--line-hi)]"
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span
          className="block text-[13px] font-medium leading-snug"
          style={{ color: "var(--ink)" }}
        >
          {label}
        </span>
        {description ? (
          <span
            className="block text-[11px] leading-relaxed"
            style={{ color: "var(--mute)" }}
          >
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function CostEstimator({ provider, model }) {
  const [inputTokens, setInputTokens] = useState(1000);
  const [outputTokens, setOutputTokens] = useState(1000);
  const [cachedTokens, setCachedTokens] = useState(0);
  const [costs, setCosts] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchCosts = useCallback(async () => {
    if (!provider || !model) return;
    setLoading(true);
    try {
      const response = await apiFetch(
        `/ui/settings/estimate-costs?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}&input_tokens=${inputTokens}&output_tokens=${outputTokens}&cached_input_tokens=${cachedTokens}`,
      );
      setCosts(response);
    } catch (error) {
      console.error("Cost estimation error:", error);
    } finally {
      setLoading(false);
    }
  }, [provider, model, inputTokens, outputTokens, cachedTokens]);

  useEffect(() => {
    const timer = setTimeout(fetchCosts, 500);
    return () => clearTimeout(timer);
  }, [fetchCosts]);

  if (!provider || !model) {
    return null;
  }

  return (
    <div
      className="space-y-4 rounded-[14px] border p-4"
      style={{
        borderColor: "var(--line)",
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <div className="text-[13px] font-medium text-[var(--ink)]">
        Estimated Cost
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Input
          label="Input tokens"
          type="number"
          min="0"
          step="100"
          value={inputTokens}
          onChange={(e) => setInputTokens(parseInt(e.target.value, 10) || 0)}
          className="h-9 border-[var(--line)] bg-black/20 text-[12px] text-[var(--ink-dim)]"
        />

        <Input
          label="Output tokens"
          type="number"
          min="0"
          step="100"
          value={outputTokens}
          onChange={(e) => setOutputTokens(parseInt(e.target.value, 10) || 0)}
          className="h-9 border-[var(--line)] bg-black/20 text-[12px] text-[var(--ink-dim)]"
        />

        <Input
          label="Cached tokens"
          type="number"
          min="0"
          step="100"
          value={cachedTokens}
          onChange={(e) => setCachedTokens(parseInt(e.target.value, 10) || 0)}
          className="h-9 border-[var(--line)] bg-black/20 text-[12px] text-[var(--ink-dim)]"
        />
      </div>

      {costs ? (
        <div
          className="grid gap-2 rounded-[10px] border p-3"
          style={{
            borderColor: "var(--line)",
            background: "rgba(255,255,255,0.01)",
          }}
        >
          <div className="flex items-center justify-between text-[12px]">
            <span style={{ color: "var(--mute)" }}>Input cost</span>
            <span style={{ color: "var(--ink-dim)", fontFamily: "monospace" }}>
              ${costs.input_cost_usd.toFixed(6)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span style={{ color: "var(--mute)" }}>Output cost</span>
            <span style={{ color: "var(--ink-dim)", fontFamily: "monospace" }}>
              ${costs.output_cost_usd.toFixed(6)}
            </span>
          </div>
          <div className="border-t border-[var(--line)]" />
          <div className="flex items-center justify-between text-[12px] font-medium">
            <span style={{ color: "var(--ink)" }}>Total</span>
            <span
              style={{
                color: "var(--signal)",
                fontFamily: "monospace",
                fontSize: "14px",
              }}
            >
              ${costs.total_cost_usd.toFixed(6)}
            </span>
          </div>
          {costs.pricing_source &&
            costs.pricing_source !== "no_pricing_available" && (
              <p className="mt-2 text-[10px]" style={{ color: "var(--mute)" }}>
                Pricing: {costs.pricing_source}
              </p>
            )}
          {costs.pricing_source === "no_pricing_available" && (
            <p className="mt-2 text-[10px]" style={{ color: "var(--rose)" }}>
              No pricing available for this model
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function FieldGroup({ title, description, children, accent = null }) {
  const accentBorder = accent
    ? `color-mix(in oklch, ${accent} 22%, var(--line))`
    : "var(--line)";
  const accentBg = accent
    ? `color-mix(in oklch, ${accent} 6%, rgba(255,255,255,0.02))`
    : "rgba(255,255,255,0.02)";
  return (
    <div
      className="overflow-hidden rounded-[16px] border"
      style={{ borderColor: accentBorder, background: "var(--card)" }}
    >
      <div
        className="border-b px-5 py-4"
        style={{
          borderColor: accentBorder,
          background: accentBg,
          ...(accent
            ? {
                borderLeft: `3px solid color-mix(in oklch, ${accent} 55%, transparent)`,
              }
            : {}),
        }}
      >
        <div
          className="text-[13.5px] font-semibold"
          style={{ color: "var(--ink)" }}
        >
          {title}
        </div>
        {description ? (
          <p className="mt-0.5 text-[12px]" style={{ color: "var(--mute)" }}>
            {description}
          </p>
        ) : null}
      </div>
      <div className="space-y-4 p-5">{children}</div>
    </div>
  );
}

function BrowserRuntimeInput({
  label,
  value,
  onChange,
  type = "text",
  min,
  max,
  step,
  placeholder = "",
  description = "",
}) {
  return (
    <Input
      label={label}
      description={description}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      type={type}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      className="h-9 border-[var(--line-hi)] bg-white/3 text-[12.5px] text-[var(--ink)]"
    />
  );
}

function BrowserRuntimeTextarea({
  label,
  value,
  onChange,
  placeholder,
  description = "",
}) {
  return (
    <div className="space-y-1.5">
      <Textarea
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        mono
        className="min-h-[88px] text-[12px]"
      />
      {description ? (
        <p
          className="text-[10.5px] leading-relaxed"
          style={{ color: "var(--mute-2)" }}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

function BrowserRuntimeSelect({
  label,
  value,
  onChange,
  options,
  placeholder = "Select option",
  description = "",
}) {
  return (
    <div className="space-y-1.5">
      <Select
        label={label}
        value={value}
        onChange={onChange}
        options={options}
        placeholder={placeholder}
      />
      {description ? (
        <p
          className="text-[10.5px] leading-relaxed"
          style={{ color: "var(--mute-2)" }}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState("models");
  const { prefs: notifPrefs, setPrefs: setNotifPrefs } = useNotifPrefs();

  const [config, setConfig] = useState(null);
  const [savedConfigSnapshot, setSavedConfigSnapshot] = useState(null);
  const [provider, setProvider] = useState("google");
  const [fallbackTemperature, setFallbackTemperature] = useState("0");
  const [llmTuning, setLlmTuning] = useState({ ...EMPTY_TUNING });
  const [agentModelConfig, setAgentModelConfig] = useState(
    normalizeAgentModelConfig(null),
  );
  const [providerCacheEnabled, setProviderCacheEnabled] = useState(true);
  const [geminiExplicitCacheEnabled, setGeminiExplicitCacheEnabled] =
    useState(true);
  const [geminiExplicitCacheTtl, setGeminiExplicitCacheTtl] = useState("1800");
  const [geminiExplicitCacheRefreshLead, setGeminiExplicitCacheRefreshLead] =
    useState("120");
  const [toolCacheEnabled, setToolCacheEnabled] = useState(true);
  const [toolCacheStable, setToolCacheStable] = useState("2");
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [thinkingBudgetTokens, setThinkingBudgetTokens] = useState("8000");
  const [maxParallelHostingPages, setMaxParallelHostingPages] = useState("5");
  const [deepevalProvider, setDeepevalProvider] = useState("openai");
  const [deepevalModel, setDeepevalModel] = useState("gpt-4o");
  const [deepevalTemperature, setDeepevalTemperature] = useState("0");
  const [browserEngine, setBrowserEngine] = useState("puppeteer");
  const [browserSettingsTab, setBrowserSettingsTab] = useState("puppeteer");
  const [browserRuntime, setBrowserRuntime] = useState(cloneBrowserRuntime());
  const [disabledToolsByBrowserProfile, setDisabledToolsByBrowserProfile] =
    useState(normalizeDisabledToolsByBrowserProfile({}));
  const [activeMcpBrowserTab, setActiveMcpBrowserTab] = useState("puppeteer");
  const [activeProfileTab, setActiveProfileTab] = useState("classification");
  const [providerCatalogs, setProviderCatalogs] = useState({});
  const [catalogLoading, setCatalogLoading] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedTab, setSavedTab] = useState("");
  const [configErr, setConfigErr] = useState("");

  const apiKeys = config?.api_keys || {};
  const activeProvider =
    PROVIDERS.find((item) => item.id === provider) || PROVIDERS[0];
  const activeCatalog = providerCatalogs[provider] || null;
  const activeBrowserRuntime =
    browserRuntime[browserSettingsTab] ||
    DEFAULT_BROWSER_RUNTIME[browserSettingsTab];
  const browserRuntimeSyncStatus = config?.browser_runtime_sync_status || null;
  const proxySourceReference = BUILTIN_PROXY_SOURCE_OPTIONS.map(
    (item) => `${item.value}: ${item.label}`,
  ).join(" | ");
  const activePolicyPreview = useMemo(() => {
    const mode = String(activeBrowserRuntime.streaming_safe_mode || "adaptive");
    if (mode === "always") return "Streaming-safe";
    if (mode === "never") return "Standard";
    return ["hosting", "embedded"].includes(activeProfileTab)
      ? "Streaming-safe"
      : "Standard";
  }, [activeBrowserRuntime.streaming_safe_mode, activeProfileTab]);
  const safeStreamingDifferences = useMemo(() => {
    const diffs = [];
    if (activeBrowserRuntime.adblock_enabled) diffs.push("adblock enabled");
    if (
      browserSettingsTab === "puppeteer" &&
      activeBrowserRuntime.stream_cors_patch_enabled
    )
      diffs.push("stream CORS patch enabled");
    if (activeBrowserRuntime.media_cors_patch_enabled)
      diffs.push("media CORS diagnostics patch enabled");
    if (
      activeBrowserRuntime.proxy_enabled &&
      activeBrowserRuntime.media_proxy_strategy === "proxy_first"
    )
      diffs.push("proxy-first media strategy");
    return diffs;
  }, [activeBrowserRuntime, browserSettingsTab]);

  const modelOverrideTargets = useMemo(() => {
    const byModel = new Map();
    AGENT_SLOTS.forEach(({ id, label }) => {
      const slot = agentModelConfig[id];
      if (!slot || slot.provider !== provider || !slot.model) return;
      const current = byModel.get(slot.model) || [];
      current.push(label);
      byModel.set(slot.model, current);
    });
    return Array.from(byModel.entries()).map(([modelId, labels]) => ({
      id: modelId,
      title: modelId,
      description: `Selected by ${labels.join(", ")}.`,
    }));
  }, [agentModelConfig, provider]);

  const providerDefaultFields = useMemo(
    () =>
      (activeCatalog?.hyperparameters || []).filter(
        (field) => !field.model_patterns?.length,
      ),
    [activeCatalog],
  );

  const serverDraft = useMemo(
    () =>
      buildServerConfigDraft({
        provider,
        fallbackTemperature,
        llmTuning,
        agentModelConfig,
        providerCacheEnabled,
        geminiExplicitCacheEnabled,
        geminiExplicitCacheTtl,
        geminiExplicitCacheRefreshLead,
        toolCacheEnabled,
        toolCacheStable,
        thinkingEnabled,
        thinkingBudgetTokens,
        maxParallelHostingPages,
        browserEngine,
        browserRuntime,
        disabledToolsByBrowserProfile,
        deepevalProvider,
        deepevalModel,
        deepevalTemperature,
      }),
    [
      agentModelConfig,
      browserEngine,
      browserRuntime,
      deepevalModel,
      deepevalProvider,
      deepevalTemperature,
      disabledToolsByBrowserProfile,
      fallbackTemperature,
      geminiExplicitCacheEnabled,
      geminiExplicitCacheRefreshLead,
      geminiExplicitCacheTtl,
      llmTuning,
      maxParallelHostingPages,
      provider,
      providerCacheEnabled,
      thinkingBudgetTokens,
      thinkingEnabled,
      toolCacheEnabled,
      toolCacheStable,
    ],
  );

  const dirtyTabs = useMemo(
    () => getDirtyTabs(savedConfigSnapshot, serverDraft),
    [savedConfigSnapshot, serverDraft],
  );
  const currentTabDirty = Boolean(dirtyTabs[activeTab]);
  const otherDirtyCount = useMemo(
    () =>
      Object.entries(dirtyTabs).filter(
        ([tabId, dirty]) => tabId !== activeTab && dirty,
      ).length,
    [activeTab, dirtyTabs],
  );

  useEffect(() => {
    if (savedTab && dirtyTabs[savedTab]) setSavedTab("");
  }, [dirtyTabs, savedTab]);

  async function loadProviderCatalog(providerId, { force = false } = {}) {
    if (!providerId) return null;
    if (!force && providerCatalogs[providerId])
      return providerCatalogs[providerId];

    setCatalogLoading(providerId);
    try {
      const payload = await apiFetch(
        `/ui/providers/models?provider=${encodeURIComponent(providerId)}`,
      );
      setProviderCatalogs((current) => ({ ...current, [providerId]: payload }));
      return payload;
    } catch (error) {
      const providerMeta = PROVIDERS.find((item) => item.id === providerId);
      const fallback = providerMeta?.keyEnv
        ? `Live model catalog unavailable. Add ${providerMeta.keyEnv} or use a manual model ID.`
        : "Live model catalog unavailable for this provider.";
      const payload = {
        models: [],
        defaults: {},
        error: fallback,
      };
      setProviderCatalogs((current) => ({ ...current, [providerId]: payload }));
      return payload;
    } finally {
      setCatalogLoading("");
    }
  }

  async function hydrateConfig(payload) {
    const fallbackProvider = payload.llm_provider || "google";
    const fallbackAgentModel = payload.agent_model || "";
    const fallbackOrchestratorModel =
      payload.orchestrator_model || fallbackAgentModel;
    const nextAgentConfig = normalizeAgentModelConfig(
      payload.agent_model_config,
      fallbackProvider,
      fallbackAgentModel,
      fallbackOrchestratorModel,
    );

    setConfig(payload);
    setSavedConfigSnapshot(snapshotServerConfig(payload));
    setProvider(fallbackProvider);
    setFallbackTemperature(String(payload.gemini_temperature ?? "0"));
    setLlmTuning(normalizeTuning(payload.llm_tuning));
    setAgentModelConfig(nextAgentConfig);
    setProviderCacheEnabled(Boolean(payload.provider_cache_enabled ?? true));
    setGeminiExplicitCacheEnabled(
      Boolean(payload.gemini_explicit_cache_enabled ?? true),
    );
    setGeminiExplicitCacheTtl(
      String(payload.gemini_explicit_cache_ttl_seconds ?? 1800),
    );
    setGeminiExplicitCacheRefreshLead(
      String(payload.gemini_explicit_cache_refresh_lead_seconds ?? 120),
    );
    setToolCacheEnabled(Boolean(payload.tool_result_cache_enabled ?? true));
    setToolCacheStable(
      String(payload.tool_result_cache_min_identical_observations ?? 2),
    );
    setThinkingEnabled(Boolean(payload.thinking_enabled ?? false));
    setThinkingBudgetTokens(String(payload.thinking_budget_tokens ?? 8000));
    setMaxParallelHostingPages(String(payload.max_parallel_hosting_pages ?? 5));
    setDeepevalProvider(payload.deepeval_provider || "openai");
    setDeepevalModel(payload.deepeval_model || "gpt-4o");
    setDeepevalTemperature(String(payload.deepeval_temperature ?? 0));
    setBrowserEngine(payload.browser_engine || "puppeteer");
    setBrowserSettingsTab(payload.browser_engine || "puppeteer");
    setBrowserRuntime(normalizeBrowserRuntime(payload.browser_runtime));
    setDisabledToolsByBrowserProfile(
      normalizeDisabledToolsByBrowserProfile(
        payload.disabled_tools_by_browser_profile,
        payload.disabled_tools_by_profile || {},
      ),
    );
    setActiveMcpBrowserTab(payload.browser_engine || "puppeteer");
    setSavedTab("");

    const providersToLoad = [
      ...new Set([
        fallbackProvider,
        ...Object.values(nextAgentConfig)
          .map((row) => row.provider)
          .filter(Boolean),
      ]),
    ];
    await Promise.all(
      providersToLoad.map((providerId) =>
        loadProviderCatalog(providerId, { force: true }).catch(() => null),
      ),
    );
  }

  async function loadConfig() {
    try {
      const payload = await apiFetch("/ui/config");
      await hydrateConfig(payload);
    } catch (error) {
      setConfigErr(error.message || "Could not load settings.");
    }
  }

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectProvider(nextProvider) {
    setProvider(nextProvider.id);
    setConfigErr("");
    await loadProviderCatalog(nextProvider.id).catch(() => null);
  }

  async function updateAgentProvider(agentId, nextProvider) {
    setConfigErr("");
    const catalog = await loadProviderCatalog(nextProvider).catch(() => null);
    const firstModel = catalog?.models?.[0]?.id || "";
    setAgentModelConfig((current) => {
      const next = { ...current };
      const existing = current[agentId] || {
        provider: nextProvider,
        model: "",
      };
      const currentModel = existing.model || "";
      const available = catalog?.models?.some(
        (item) => item.id === currentModel,
      );
      next[agentId] = {
        provider: nextProvider,
        model: available ? currentModel : firstModel,
      };
      return next;
    });
  }

  function updateAgentModel(agentId, modelId) {
    setAgentModelConfig((current) => ({
      ...current,
      [agentId]: {
        ...(current[agentId] || { provider, model: "" }),
        model: modelId,
      },
    }));
  }

  function updateAgentProviderDefault(field, value) {
    setLlmTuning((current) => {
      const next = normalizeTuning(current);
      const providerDefaults = { ...(next.provider_defaults[provider] || {}) };
      if (value === "") delete providerDefaults[field.key];
      else providerDefaults[field.key] = value;
      return {
        ...next,
        provider_defaults: {
          ...next.provider_defaults,
          [provider]: providerDefaults,
        },
      };
    });
  }

  function updateModelOverride(modelId, field, value) {
    const key = modelOverrideKey(provider, modelId);
    setLlmTuning((current) => {
      const next = normalizeTuning(current);
      const modelOverrides = { ...(next.model_overrides[key] || {}) };
      if (value === "") delete modelOverrides[field.key];
      else modelOverrides[field.key] = value;
      return {
        ...next,
        model_overrides: {
          ...next.model_overrides,
          [key]: modelOverrides,
        },
      };
    });
  }

  function clearModelOverride(modelId) {
    const key = modelOverrideKey(provider, modelId);
    setLlmTuning((current) => {
      const next = normalizeTuning(current);
      const modelOverrides = { ...next.model_overrides };
      delete modelOverrides[key];
      return { ...next, model_overrides: modelOverrides };
    });
  }

  function updateAgentOverride(agentId, field, value) {
    setLlmTuning((current) => {
      const next = normalizeTuning(current);
      const agentOverrides = { ...(next.agent_overrides[agentId] || {}) };
      if (value === "") delete agentOverrides[field.key];
      else agentOverrides[field.key] = value;
      return {
        ...next,
        agent_overrides: {
          ...next.agent_overrides,
          [agentId]: agentOverrides,
        },
      };
    });
  }

  function clearAgentOverride(agentId) {
    setLlmTuning((current) => {
      const next = normalizeTuning(current);
      const agentOverrides = { ...next.agent_overrides };
      delete agentOverrides[agentId];
      return { ...next, agent_overrides: agentOverrides };
    });
  }

  function updateBrowserRuntime(browserId, key, value) {
    setBrowserRuntime((current) => ({
      ...current,
      [browserId]: {
        ...current[browserId],
        [key]: value,
      },
    }));
  }

  function updateBrowserRuntimeList(browserId, key, value) {
    updateBrowserRuntime(browserId, key, normalizeStringList(value));
  }

  function updateBrowserRuntimeIntegerList(browserId, key, value) {
    updateBrowserRuntime(browserId, key, normalizeIntegerList(value));
  }

  function activeBrowserTools() {
    return (
      disabledToolsByBrowserProfile[activeMcpBrowserTab]?.[activeProfileTab] ||
      []
    );
  }

  function setDisabledToolsForCurrentBrowserProfile(nextTools) {
    setDisabledToolsByBrowserProfile((current) => ({
      ...current,
      [activeMcpBrowserTab]: {
        ...current[activeMcpBrowserTab],
        [activeProfileTab]: normalizeStringList(nextTools),
      },
    }));
  }

  function buildSavePayloadForTab(tabId) {
    switch (tabId) {
      case "models":
        return {
          llm_provider: serverDraft.llm_provider,
          agent_model: serverDraft.agent_model,
          orchestrator_model: serverDraft.orchestrator_model,
          gemini_temperature: serverDraft.gemini_temperature,
          llm_tuning: serverDraft.llm_tuning,
          agent_model_config: serverDraft.agent_model_config,
          provider_cache_enabled: serverDraft.provider_cache_enabled,
          gemini_explicit_cache_enabled:
            serverDraft.gemini_explicit_cache_enabled,
          gemini_explicit_cache_ttl_seconds:
            serverDraft.gemini_explicit_cache_ttl_seconds,
          gemini_explicit_cache_refresh_lead_seconds:
            serverDraft.gemini_explicit_cache_refresh_lead_seconds,
          tool_result_cache_enabled: serverDraft.tool_result_cache_enabled,
          tool_result_cache_min_identical_observations:
            serverDraft.tool_result_cache_min_identical_observations,
          thinking_enabled: serverDraft.thinking_enabled,
          thinking_budget_tokens: serverDraft.thinking_budget_tokens,
          max_parallel_hosting_pages: serverDraft.max_parallel_hosting_pages,
        };
      case "browser":
        return {
          browser_engine: serverDraft.browser_engine,
          browser_runtime: serverDraft.browser_runtime,
        };
      case "evaluation":
        return {
          deepeval_provider: serverDraft.deepeval_provider,
          deepeval_model: serverDraft.deepeval_model,
          deepeval_temperature: serverDraft.deepeval_temperature,
        };
      case "mcp-tools":
        return {
          disabled_tools_by_browser_profile:
            serverDraft.disabled_tools_by_browser_profile,
        };
      default:
        return null;
    }
  }

  async function saveConfig(tabId = activeTab) {
    const payloadToSave = buildSavePayloadForTab(tabId);
    if (!payloadToSave) return;

    setSaving(true);
    setConfigErr("");
    try {
      const response = await fetch(apiUrl("/ui/config"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadToSave),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.detail || `Status ${response.status}`);
      await hydrateConfig(payload);
      if (payload.config_persisted === false) {
        setConfigErr(
          payload.config_persist_error ||
            "Config updated in memory, but could not be persisted to disk.",
        );
      }
      setSavedTab(tabId);
      setTimeout(() => {
        setSavedTab((current) => (current === tabId ? "" : current));
      }, 2500);
    } catch (error) {
      setConfigErr(error.message || "Could not save config.");
    } finally {
      setSaving(false);
    }
  }

  const providerCardUsage = useMemo(() => {
    const counts = Object.fromEntries(PROVIDERS.map((item) => [item.id, 0]));
    Object.values(agentModelConfig).forEach((row) => {
      if (row?.provider && counts[row.provider] != null)
        counts[row.provider] += 1;
    });
    return counts;
  }, [agentModelConfig]);
  const currentTabSaved = savedTab === activeTab && !currentTabDirty;
  const showConfigError =
    Boolean(configErr) &&
    (!config || TAB_DETAILS[activeTab]?.storage === "server");

  return (
    <div className="flex gap-10 items-start">
      {/* ── LEFT SIDEBAR NAV ───────────────────────────────────── */}
      <div className="w-[188px] shrink-0 sticky top-6 self-start">
        <SettingsTabBar
          active={activeTab}
          onChange={setActiveTab}
          dirtyTabs={dirtyTabs}
        />
        <div
          className="mt-5 px-3 space-y-1.5"
          style={{ borderTop: "1px solid var(--line)", paddingTop: "16px" }}
        >
          <div
            className="flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[11px] font-medium"
            style={{
              background: providerCatalogs[provider]
                ? "color-mix(in oklch, var(--sky) 10%, transparent)"
                : "rgba(255,255,255,0.03)",
              color: providerCatalogs[provider] ? "var(--sky)" : "var(--mute)",
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: providerCatalogs[provider]
                  ? "var(--sky)"
                  : "var(--mute-3)",
                flexShrink: 0,
              }}
            />
            {providerCatalogs[provider] ? "Catalogs loaded" : "Loading…"}
          </div>
          <div
            className="flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[11px] font-medium"
            style={{
              background: Object.values(dirtyTabs).some(Boolean)
                ? "color-mix(in oklch, var(--signal) 10%, transparent)"
                : "color-mix(in oklch, var(--mint) 8%, transparent)",
              color: Object.values(dirtyTabs).some(Boolean)
                ? "var(--signal)"
                : "var(--mint)",
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: Object.values(dirtyTabs).some(Boolean)
                  ? "var(--signal)"
                  : "var(--mint)",
                flexShrink: 0,
              }}
            />
            {Object.values(dirtyTabs).some(Boolean)
              ? "Unsaved changes"
              : "All synced"}
          </div>
        </div>
      </div>

      {/* ── RIGHT CONTENT ─────────────────────────────────────── */}
      <div className="flex-1 min-w-0 space-y-7">
        <SettingsTabHero
          tabId={activeTab}
          dirty={currentTabDirty}
          saving={saving}
          saved={currentTabSaved}
          onSave={() => saveConfig(activeTab)}
          otherDirtyCount={otherDirtyCount}
        />
        <ErrorNotice message={showConfigError ? configErr : ""} />

        <div key={activeTab} className="animate-fade-up space-y-8">
          {activeTab === "models" ? (
            <section className="space-y-4">
              <SectionHeader>Provider Defaults</SectionHeader>

              <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {PROVIDERS.map((item) => {
                  const isActive = provider === item.id;
                  const usage = providerCardUsage[item.id] || 0;
                  const hasKey = !!apiKeys[item.id];
                  const accentColor = isActive
                    ? item.color || "var(--signal)"
                    : "var(--line)";
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectProvider(item)}
                      className="group w-full rounded-[12px] border p-3 text-left transition-all duration-150"
                      style={
                        isActive
                          ? {
                              borderColor: `color-mix(in oklch, ${item.color || "var(--signal)"} 40%, transparent)`,
                              background: `color-mix(in oklch, ${item.color || "var(--signal)"} 7%, transparent)`,
                              boxShadow: `0 0 0 1px color-mix(in oklch, ${item.color || "var(--signal)"} 18%, transparent)`,
                            }
                          : {
                              borderColor: "var(--line)",
                              background: "var(--card)",
                            }
                      }
                    >
                      {/* Header row */}
                      <div className="flex items-start justify-between gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{
                              background: isActive
                                ? item.color || "var(--signal)"
                                : hasKey
                                  ? "var(--mint)"
                                  : "var(--mute-3)",
                            }}
                          />
                          <span
                            className="text-[12.5px] font-semibold leading-snug"
                            style={{
                              color: isActive
                                ? item.color || "var(--signal)"
                                : "var(--ink)",
                            }}
                          >
                            {item.name}
                          </span>
                        </div>
                        {!hasKey && (
                          <span
                            className="rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide"
                            style={{
                              background: "rgba(255,255,255,0.04)",
                              color: "var(--mute-3)",
                              border: "1px solid var(--line)",
                            }}
                          >
                            no key
                          </span>
                        )}
                        {hasKey && (
                          <span
                            className="text-[10px]"
                            style={{ color: "var(--mint)" }}
                          >
                            ✓
                          </span>
                        )}
                      </div>

                      {/* Env key */}
                      <div
                        className="mt-1 font-mono text-[9.5px] truncate"
                        style={{ color: "var(--mute-3)" }}
                      >
                        {item.keyEnv}
                      </div>

                      {/* Feature tags */}
                      {item.features && item.features.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {item.features.slice(0, 3).map((feat) => (
                            <span
                              key={feat}
                              className="rounded px-1.5 py-0.5 text-[9px] font-medium"
                              style={{
                                background: isActive
                                  ? `color-mix(in oklch, ${item.color || "var(--signal)"} 12%, transparent)`
                                  : "rgba(255,255,255,0.04)",
                                color: isActive
                                  ? `color-mix(in oklch, ${item.color || "var(--signal)"} 80%, var(--mute))`
                                  : "var(--mute-2)",
                                border: `1px solid ${isActive ? `color-mix(in oklch, ${item.color || "var(--signal)"} 20%, transparent)` : "var(--line)"}`,
                              }}
                            >
                              {feat}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Usage */}
                      {usage > 0 && (
                        <div className="mt-2 flex items-center gap-1">
                          <span
                            className="h-1 w-1 rounded-full"
                            style={{ background: "var(--mint)" }}
                          />
                          <span
                            className="text-[10px]"
                            style={{ color: "var(--mint)" }}
                          >
                            {usage} agent{usage !== 1 ? "s" : ""}
                          </span>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              <FieldGroup
                title={`Provider defaults — ${activeProvider.name}`}
                description="Hyperparameters applied to every model from this provider unless overridden."
                accent="var(--signal)"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div />
                  <div className="flex items-center gap-2">
                    {activeCatalog ? (
                      <span
                        className={`owc-pill ${sourceTone(activeCatalog.source)}`}
                      >
                        <span className="dot" />
                        {sourceLabel(activeCatalog.source)}
                      </span>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        loadProviderCatalog(provider, { force: true })
                      }
                      disabled={catalogLoading === provider}
                    >
                      {catalogLoading === provider ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Refreshing
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-3.5 w-3.5" />
                          Refresh models
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {!apiKeys[provider] ? (
                  <div
                    className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[12.5px]"
                    style={{
                      borderColor:
                        "color-mix(in oklch, var(--signal) 35%, transparent)",
                      background:
                        "color-mix(in oklch, var(--signal) 10%, transparent)",
                      color: "var(--signal)",
                    }}
                  >
                    <Key className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      <strong>{activeProvider.keyEnv}</strong> is not set. Live
                      model loading may fall back to cached or bundled lists
                      until the key is available.
                    </span>
                  </div>
                ) : null}

                {activeCatalog?.error ? (
                  <div
                    className="rounded-lg border px-3 py-2.5 text-[12px]"
                    style={{
                      borderColor:
                        "color-mix(in oklch, var(--signal) 35%, transparent)",
                      background:
                        "color-mix(in oklch, var(--signal) 8%, transparent)",
                      color: "var(--ink-dim)",
                    }}
                  >
                    {activeCatalog.error}
                  </div>
                ) : null}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <div className="mb-2 flex items-center gap-1.5">
                      <span
                        className="text-[10px] font-semibold uppercase tracking-[0.14em]"
                        style={{ color: "var(--mute-2)" }}
                      >
                        Fallback temperature
                      </span>
                      <HelpIcon tip="Global temperature applied when no provider-specific or agent-specific override is set. 0 = deterministic, 1+ = creative." />
                    </div>
                    <Slider
                      value={Number(fallbackTemperature) || 0}
                      onChange={(next) => setFallbackTemperature(next)}
                      min={0}
                      max={2}
                      step={0.1}
                      description="Global temperature when no provider override is set"
                    />
                  </div>
                  <div>
                    <div className="mb-2 flex items-center gap-1.5">
                      <span
                        className="text-[10px] font-semibold uppercase tracking-[0.14em]"
                        style={{ color: "var(--mute-2)" }}
                      >
                        Tool cache stabilization
                      </span>
                      <HelpIcon tip="How many identical consecutive tool results must be seen before the response is cached. Higher = less aggressive caching." />
                    </div>
                    <Slider
                      value={Number(toolCacheStable) || 1}
                      onChange={(next) => setToolCacheStable(next)}
                      min={1}
                      max={10}
                      step={1}
                      description="Consecutive identical results before caching kicks in"
                    />
                  </div>
                </div>

                <TuningCard
                  title={`${activeProvider.name} defaults`}
                  description="Applied first for every model from this provider."
                  values={llmTuning.provider_defaults[provider] || {}}
                  fields={providerDefaultFields}
                  onChange={updateAgentProviderDefault}
                />

                {modelOverrideTargets.map((target) => {
                  const fields = (activeCatalog?.hyperparameters || []).filter(
                    (field) => fieldMatchesModel(field, target.id),
                  );
                  const values =
                    llmTuning.model_overrides[
                      modelOverrideKey(provider, target.id)
                    ] || {};
                  return (
                    <TuningCard
                      key={target.id}
                      title={`Model override - ${target.title}`}
                      description={target.description}
                      values={values}
                      fields={fields}
                      onChange={(field, value) =>
                        updateModelOverride(target.id, field, value)
                      }
                      onClear={() => clearModelOverride(target.id)}
                      clearLabel="Clear override"
                    />
                  );
                })}

                <div className="grid gap-3 sm:grid-cols-2">
                  <ToggleRow
                    label="Provider prompt caching"
                    checked={providerCacheEnabled}
                    onChange={setProviderCacheEnabled}
                    description="Hooks into provider-native caching (Anthropic cache_control, Gemini context caching). Reduces cost on repeated system prompts."
                  />
                  <ToggleRow
                    label="Deterministic tool result cache"
                    checked={toolCacheEnabled}
                    onChange={setToolCacheEnabled}
                    description="Caches identical browser-tool responses within the same session. Speeds up repeated DOM queries."
                  />
                </div>
              </FieldGroup>

              <FieldGroup
                title="Gemini Explicit Cache"
                description="Server-side cached context for Gemini models — reduces latency and cost on repeated system prompts."
                accent="var(--violet)"
              >
                <ToggleRow
                  label="Enabled"
                  checked={geminiExplicitCacheEnabled}
                  onChange={setGeminiExplicitCacheEnabled}
                  description="Activate explicit cached content for Gemini runs."
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <BrowserRuntimeInput
                    label="Cache TTL (seconds)"
                    value={geminiExplicitCacheTtl}
                    onChange={setGeminiExplicitCacheTtl}
                    type="number"
                    min="60"
                    step="60"
                    description="How long the server keeps the cached context alive (min 60 s)."
                  />
                  <BrowserRuntimeInput
                    label="Refresh lead (seconds)"
                    value={geminiExplicitCacheRefreshLead}
                    onChange={setGeminiExplicitCacheRefreshLead}
                    type="number"
                    min="5"
                    step="5"
                    description="Seconds before expiry when the runtime pre-warms a new cache entry."
                  />
                </div>
              </FieldGroup>

              <FieldGroup
                title="Extended Thinking"
                description="Enable model reasoning (Anthropic extended thinking, Gemini thinking budget). Increases token usage but improves reasoning quality."
                accent="var(--sky)"
              >
                <ToggleRow
                  label="Enable thinking"
                  checked={thinkingEnabled}
                  onChange={setThinkingEnabled}
                  description="Turns on extended reasoning for supported models."
                />
                {thinkingEnabled ? (
                  <div className="max-w-sm">
                    <BrowserRuntimeInput
                      label="Thinking budget (tokens)"
                      value={thinkingBudgetTokens}
                      onChange={setThinkingBudgetTokens}
                      type="number"
                      min="1000"
                      max="32000"
                      step="1000"
                      description="Max tokens for internal reasoning (1000–32000). Higher = deeper reasoning, more cost."
                    />
                  </div>
                ) : null}
              </FieldGroup>

              <FieldGroup
                title="Parallelism"
                description="Controls how many hosting pages run simultaneously. Lower reduces memory load; higher increases throughput."
                accent="var(--mint)"
              >
                <div className="max-w-sm">
                  <BrowserRuntimeInput
                    label="Max parallel hosting pages"
                    value={maxParallelHostingPages}
                    onChange={setMaxParallelHostingPages}
                    type="number"
                    min="1"
                    max="20"
                    step="1"
                    description="Default 5. Caps concurrent hosting-page and embedded-page agent executions."
                  />
                </div>
              </FieldGroup>

              <SectionHeader>Per-Agent Models</SectionHeader>
              <div className="grid gap-4 xl:grid-cols-2">
                {AGENT_SLOTS.map((slot) => {
                  const selection = agentModelConfig[slot.id] || {
                    provider,
                    model: "",
                  };
                  const slotCatalog =
                    providerCatalogs[selection.provider] || null;
                  const slotOptions = ensureSelectedOption(
                    (slotCatalog?.models || []).map((model) => ({
                      value: model.id,
                      label: model.label || model.id,
                      description: model.description || "",
                      meta: model.context_window
                        ? `context ${model.context_window}`
                        : "",
                    })),
                    selection.model,
                  );
                  const slotFields = (
                    slotCatalog?.hyperparameters || []
                  ).filter((field) =>
                    fieldMatchesModel(field, selection.model),
                  );
                  const slotOverrides =
                    llmTuning.agent_overrides[slot.id] || {};

                  return (
                    <div
                      key={slot.id}
                      className="space-y-4 rounded-[14px] border p-5"
                      style={{
                        borderColor: "var(--line)",
                        background: "var(--card)",
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div
                            className="text-[14px] font-semibold"
                            style={{ color: "var(--ink)" }}
                          >
                            {slot.label}
                          </div>
                          <div
                            className="mt-0.5 text-[11.5px]"
                            style={{ color: "var(--mute)" }}
                          >
                            {slot.note}
                          </div>
                        </div>
                        {slotCatalog ? (
                          <span
                            className={`owc-pill ${sourceTone(slotCatalog.source)}`}
                          >
                            <span className="dot" />
                            {sourceLabel(slotCatalog.source)}
                          </span>
                        ) : null}
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <Select
                          label="Provider"
                          value={selection.provider}
                          onChange={(next) =>
                            updateAgentProvider(slot.id, next)
                          }
                          options={providerOptionRows()}
                          placeholder="Select provider"
                        />
                        <Select
                          label="Model"
                          value={selection.model}
                          onChange={(next) => updateAgentModel(slot.id, next)}
                          options={slotOptions}
                          searchable
                          placeholder="Select model"
                          emptyMessage="No models available for this provider"
                        />
                      </div>

                      <Input
                        label="Custom model ID"
                        value={selection.model}
                        onChange={(event) =>
                          updateAgentModel(slot.id, event.target.value)
                        }
                        placeholder="Manual model name"
                        className="h-11 font-mono"
                      />

                      {slotCatalog?.error ? (
                        <div
                          className="rounded-lg border px-3 py-2.5 text-[12px]"
                          style={{
                            borderColor:
                              "color-mix(in oklch, var(--signal) 35%, transparent)",
                            background:
                              "color-mix(in oklch, var(--signal) 8%, transparent)",
                            color: "var(--ink-dim)",
                          }}
                        >
                          {slotCatalog.error}
                        </div>
                      ) : null}

                      <TuningCard
                        title={`${slot.label} override`}
                        description="Applied after provider defaults and model overrides."
                        values={slotOverrides}
                        fields={slotFields}
                        onChange={(field, value) =>
                          updateAgentOverride(slot.id, field, value)
                        }
                        onClear={() => clearAgentOverride(slot.id)}
                        clearLabel="Clear override"
                      />
                    </div>
                  );
                })}
              </div>

              <SectionHeader>Cost Calculator</SectionHeader>
              <p className="text-[13.5px] text-[var(--mute)]">
                Estimate API costs based on token usage for the default model.
              </p>
              <CostEstimator
                provider={provider}
                model={agentModelConfig.orchestrator?.model || ""}
              />
            </section>
          ) : null}

          {activeTab === "browser" ? (
            <section className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {BROWSER_OPTIONS.map((engine) => {
                  const isActive = browserEngine === engine.id;
                  return (
                    <button
                      key={engine.id}
                      type="button"
                      onClick={() => {
                        setBrowserEngine(engine.id);
                        setBrowserSettingsTab(engine.id);
                      }}
                      className="w-full rounded-[13px] border p-4 text-left transition-all duration-150"
                      style={
                        isActive
                          ? {
                              borderColor:
                                "color-mix(in oklch, var(--signal) 45%, transparent)",
                              background:
                                "color-mix(in oklch, var(--signal) 8%, transparent)",
                              boxShadow:
                                "0 0 0 1px color-mix(in oklch, var(--signal) 18%, transparent)",
                            }
                          : {
                              borderColor: "var(--line)",
                              background: "var(--card)",
                            }
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="text-[14px] font-semibold"
                          style={{
                            color: isActive ? "var(--signal)" : "var(--ink)",
                          }}
                        >
                          {engine.name}
                        </span>
                        {isActive ? <Badge tone="signal">Active</Badge> : null}
                      </div>
                      <p
                        className="mt-1 text-[12px]"
                        style={{ color: "var(--mute)" }}
                      >
                        {engine.note}
                      </p>
                    </button>
                  );
                })}
              </div>

              <MiniSegment
                active={browserSettingsTab}
                onChange={setBrowserSettingsTab}
                options={BROWSER_OPTIONS.map((item) => ({
                  id: item.id,
                  label: item.name,
                }))}
              />

              <FieldGroup
                title="Runtime Status"
                description="Fingerprint policy and sync state for the active backend."
                accent="var(--sky)"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <div
                    className="rounded-[12px] border p-4 text-[12px]"
                    style={{
                      borderColor: "var(--line)",
                      background: "rgba(255,255,255,0.02)",
                    }}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{
                          background: browserRuntimeSyncStatus?.stale
                            ? "var(--signal)"
                            : "var(--mint)",
                        }}
                      />
                      <span
                        className="font-semibold"
                        style={{ color: "var(--ink)" }}
                      >
                        Sync status
                      </span>
                    </div>
                    <p style={{ color: "var(--mute)" }}>
                      {browserRuntimeSyncStatus?.stale
                        ? "Bridge looks stale — regenerate before next session."
                        : "Bridge aligned with API settings."}
                    </p>
                    <div
                      className="mt-3 space-y-0.5 font-mono text-[10.5px]"
                      style={{ color: "var(--mute-2)" }}
                    >
                      <div>
                        source:{" "}
                        {browserRuntimeSyncStatus?.active_runtime_source ||
                          "unknown"}
                      </div>
                      <div>
                        synced:{" "}
                        {browserRuntimeSyncStatus?.synced_at || "not recorded"}
                      </div>
                    </div>
                  </div>
                  <div
                    className="rounded-[12px] border p-4 text-[12px]"
                    style={{
                      borderColor: "var(--line)",
                      background: "rgba(255,255,255,0.02)",
                    }}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: "var(--sky)" }}
                      />
                      <span
                        className="font-semibold"
                        style={{ color: "var(--ink)" }}
                      >
                        Policy preview
                      </span>
                    </div>
                    <p style={{ color: "var(--mute)" }}>
                      Active profile mode:{" "}
                      <span
                        className="font-semibold"
                        style={{ color: "var(--ink)" }}
                      >
                        {activePolicyPreview}
                      </span>
                    </p>
                    <p className="mt-2" style={{ color: "var(--mute-2)" }}>
                      {browserSettingsTab === "playwright"
                        ? "Playwright fingerprints are Chrome-aligned — spoofing Firefox on Chromium is more detectable."
                        : "Puppeteer fingerprints align to the actual launched Chrome version first."}
                    </p>
                  </div>
                </div>
                {safeStreamingDifferences.length ? (
                  <div
                    className="rounded-[10px] border px-4 py-3 text-[12px]"
                    style={{
                      borderColor:
                        "color-mix(in oklch, var(--signal) 28%, transparent)",
                      background:
                        "color-mix(in oklch, var(--signal) 7%, transparent)",
                      color: "var(--ink-dim)",
                    }}
                  >
                    <span
                      className="font-semibold"
                      style={{ color: "var(--signal)" }}
                    >
                      Differs from safe streaming defaults:{" "}
                    </span>
                    {safeStreamingDifferences.join(", ")}.
                  </div>
                ) : null}
              </FieldGroup>

              <FieldGroup
                title="Fingerprint"
                description="Control how often the browser identity rotates and how it falls back."
                accent="var(--violet)"
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <BrowserRuntimeInput
                    label="Launch timeout (ms)"
                    value={String(activeBrowserRuntime.launch_timeout_ms ?? "")}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "launch_timeout_ms",
                        Number.parseInt(value || "0", 10) || 0,
                      )
                    }
                    type="number"
                    min="1000"
                    step="1000"
                    description="How long the browser gets to launch before the session is abandoned."
                  />
                  <BrowserRuntimeSelect
                    label="Rotation mode"
                    value={
                      activeBrowserRuntime.fingerprint_rotation_mode || "origin"
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "fingerprint_rotation_mode",
                        value,
                      )
                    }
                    options={[
                      {
                        value: "origin",
                        label: "Per origin",
                        description: "Reuse until the site origin changes.",
                      },
                      {
                        value: "page",
                        label: "Per page",
                        description: "Rotate before every page acquisition.",
                      },
                      {
                        value: "interval",
                        label: "Timed",
                        description:
                          "Rotate after configured time or max uses.",
                      },
                      {
                        value: "never",
                        label: "Disabled",
                        description:
                          "Keep the same fingerprint for the session.",
                      },
                    ]}
                    placeholder="Select mode"
                    description="When the runtime refreshes the fingerprint and user-agent bundle."
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <BrowserRuntimeSelect
                    label="Fallback strategy"
                    value={
                      activeBrowserRuntime.fingerprint_fallback_strategy ||
                      "profile"
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "fingerprint_fallback_strategy",
                        value,
                      )
                    }
                    options={[
                      {
                        value: "profile",
                        label: "Coherent profile",
                        description:
                          "Fall back to a real Chrome header + JS profile.",
                      },
                      {
                        value: "none",
                        label: "Skip",
                        description: "Do nothing extra if generator fails.",
                      },
                    ]}
                    placeholder="Select fallback"
                    description="What to do when the full injector path fails."
                  />
                  <BrowserRuntimeInput
                    label="Rotation interval (ms)"
                    value={String(
                      activeBrowserRuntime.fingerprint_rotation_interval_ms ??
                        "",
                    )}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "fingerprint_rotation_interval_ms",
                        Number.parseInt(value || "0", 10) || 0,
                      )
                    }
                    type="number"
                    min="1000"
                    step="1000"
                    description="Upper bound on fingerprint lifetime in timed mode."
                  />
                  <BrowserRuntimeInput
                    label="Max uses"
                    value={String(
                      activeBrowserRuntime.fingerprint_rotation_max_uses ?? "",
                    )}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "fingerprint_rotation_max_uses",
                        Number.parseInt(value || "0", 10) || 0,
                      )
                    }
                    type="number"
                    min="1"
                    step="1"
                    description="Rotate once reused this many times."
                  />
                  <BrowserRuntimeInput
                    label="Recent pool size"
                    value={String(
                      activeBrowserRuntime.fingerprint_recent_pool_size ?? "",
                    )}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "fingerprint_recent_pool_size",
                        Number.parseInt(value || "0", 10) || 0,
                      )
                    }
                    type="number"
                    min="1"
                    step="1"
                    description="Avoid reusing fingerprints still in recent history."
                  />
                </div>
              </FieldGroup>

              <FieldGroup
                title="Proxy Rotation"
                description="Load, validate, and rotate proxies for isolated browser sessions."
                accent="var(--signal)"
              >
                <ToggleRow
                  label="Enable proxy pool"
                  checked={!!activeBrowserRuntime.proxy_enabled}
                  onChange={(value) =>
                    updateBrowserRuntime(
                      browserSettingsTab,
                      "proxy_enabled",
                      value,
                    )
                  }
                  description="Turn on remote/custom proxy loading, validation, rotation, and fallback handling."
                />
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <BrowserRuntimeSelect
                    label="Source mode"
                    value={activeBrowserRuntime.proxy_source_mode || "hybrid"}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "proxy_source_mode",
                        value,
                      )
                    }
                    options={[
                      {
                        value: "hybrid",
                        label: "Hybrid",
                        description: "Custom first, then remote lists.",
                      },
                      {
                        value: "remote",
                        label: "Remote only",
                        description: "Pull from built-in or custom URLs only.",
                      },
                      {
                        value: "custom",
                        label: "Custom only",
                        description: "Only manually entered proxies.",
                      },
                    ]}
                    placeholder="Select source mode"
                    description="Where to pull candidate proxies from."
                  />
                  <BrowserRuntimeSelect
                    label="Rotation mode"
                    value={
                      activeBrowserRuntime.proxy_rotation_mode || "session"
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "proxy_rotation_mode",
                        value,
                      )
                    }
                    options={[
                      {
                        value: "session",
                        label: "Per session",
                        description:
                          "Advance to next candidate each new session.",
                      },
                      {
                        value: "sticky",
                        label: "Sticky",
                        description:
                          "Prefer last working proxy until it fails.",
                      },
                      {
                        value: "failure",
                        label: "On failure",
                        description: "Retry last good proxy first.",
                      },
                      {
                        value: "never",
                        label: "Always first",
                        description: "Always start from first candidate.",
                      },
                    ]}
                    placeholder="Select rotation mode"
                    description="How selection advances between sessions."
                  />
                  <BrowserRuntimeSelect
                    label="Selection order"
                    value={
                      activeBrowserRuntime.proxy_selection_strategy || "ordered"
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "proxy_selection_strategy",
                        value,
                      )
                    }
                    options={[
                      {
                        value: "ordered",
                        label: "Ordered",
                        description: "Respect source order exactly.",
                      },
                      {
                        value: "random",
                        label: "Random",
                        description: "Shuffle candidates before trying.",
                      },
                    ]}
                    placeholder="Select order"
                    description="Ordered or shuffled candidate list."
                  />
                  <BrowserRuntimeSelect
                    label="Fallback"
                    value={
                      activeBrowserRuntime.proxy_fallback_strategy || "direct"
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "proxy_fallback_strategy",
                        value,
                      )
                    }
                    options={[
                      {
                        value: "direct",
                        label: "Direct browser",
                        description: "Continue without proxy if all fail.",
                      },
                      {
                        value: "fail",
                        label: "Fail closed",
                        description: "Do not fall back to direct.",
                      },
                    ]}
                    placeholder="Select fallback"
                    description="What happens after every candidate fails."
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <BrowserRuntimeInput
                    label="Fetch timeout (ms)"
                    value={String(
                      activeBrowserRuntime.proxy_fetch_timeout_ms ?? "",
                    )}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "proxy_fetch_timeout_ms",
                        Number.parseInt(value || "0", 10) || 0,
                      )
                    }
                    type="number"
                    min="1000"
                    step="1000"
                    description="Budget for downloading each remote source."
                  />
                  <BrowserRuntimeInput
                    label="Validation timeout (ms)"
                    value={String(
                      activeBrowserRuntime.proxy_validation_timeout_ms ?? "",
                    )}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "proxy_validation_timeout_ms",
                        Number.parseInt(value || "0", 10) || 0,
                      )
                    }
                    type="number"
                    min="1000"
                    step="1000"
                    description="Time before a candidate is marked bad."
                  />
                  <BrowserRuntimeInput
                    label="Source cache TTL (ms)"
                    value={String(
                      activeBrowserRuntime.proxy_cache_ttl_ms ?? "",
                    )}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "proxy_cache_ttl_ms",
                        Number.parseInt(value || "0", 10) || 0,
                      )
                    }
                    type="number"
                    min="1000"
                    step="1000"
                    description="How long remote downloads stay cached."
                  />
                  <BrowserRuntimeInput
                    label="Max candidates"
                    value={String(
                      activeBrowserRuntime.proxy_max_candidates ?? "",
                    )}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "proxy_max_candidates",
                        Number.parseInt(value || "0", 10) || 0,
                      )
                    }
                    type="number"
                    min="1"
                    step="1"
                    description="Upper bound on the candidate pool."
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <BrowserRuntimeInput
                    label="Validation URL"
                    value={String(activeBrowserRuntime.proxy_test_url ?? "")}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "proxy_test_url",
                        value,
                      )
                    }
                    placeholder="https://api.ipify.org?format=json"
                    description="Lightweight URL used to confirm a proxy works before handing it to tools."
                  />
                  <div className="space-y-1.5">
                    <div
                      className="text-[11.5px] font-semibold"
                      style={{ color: "var(--ink-dim)" }}
                    >
                      Built-in sources
                    </div>
                    <div
                      className="rounded-[10px] border px-3.5 py-2.5 font-mono text-[11px]"
                      style={{
                        borderColor: "var(--line-hi)",
                        background: "rgba(255,255,255,0.04)",
                        color: "var(--mute)",
                      }}
                    >
                      {proxySourceReference}
                    </div>
                    <p className="text-[11px]" style={{ color: "var(--mute)" }}>
                      Reference only — use source-order field below to choose
                      which IDs are tried.
                    </p>
                  </div>
                </div>
                <BrowserRuntimeTextarea
                  label="Proxy source order"
                  value={(activeBrowserRuntime.proxy_source_order || []).join(
                    ", ",
                  )}
                  onChange={(value) =>
                    updateBrowserRuntimeList(
                      browserSettingsTab,
                      "proxy_source_order",
                      value,
                    )
                  }
                  placeholder="openproxylist-https, openproxylist-socks5, speedx-http, speedx-socks5"
                  description="Comma-separated built-in source IDs or raw .txt URLs."
                />
                <BrowserRuntimeTextarea
                  label="Custom proxy list"
                  value={(activeBrowserRuntime.proxy_custom_list || []).join(
                    ", ",
                  )}
                  onChange={(value) =>
                    updateBrowserRuntimeList(
                      browserSettingsTab,
                      "proxy_custom_list",
                      value,
                    )
                  }
                  placeholder="http://user:pass@1.2.3.4:8080, socks5://5.6.7.8:1080"
                  description="Manual proxies prepended when source mode includes custom. Supports scheme://user:pass@host:port."
                />
              </FieldGroup>

              <FieldGroup
                title="Adaptive Streaming"
                description="Control how the runtime behaves on streaming and player-heavy pages."
                accent="var(--mint)"
              >
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <BrowserRuntimeSelect
                    label="Streaming-safe mode"
                    value={
                      activeBrowserRuntime.streaming_safe_mode || "adaptive"
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "streaming_safe_mode",
                        value,
                      )
                    }
                    options={[
                      {
                        value: "adaptive",
                        label: "Adaptive",
                        description:
                          "Safe mode for hosting, embedded, player-like pages.",
                      },
                      {
                        value: "always",
                        label: "Always",
                        description:
                          "Always prefer the safer streaming policy.",
                      },
                      {
                        value: "never",
                        label: "Never",
                        description:
                          "Keep standard policy even on player pages.",
                      },
                    ]}
                    placeholder="Select policy mode"
                    description="When to disable aggressive blockers and relax first-attempt media policy."
                  />
                  <BrowserRuntimeSelect
                    label="Media proxy strategy"
                    value={
                      activeBrowserRuntime.media_proxy_strategy ||
                      "direct_first"
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "media_proxy_strategy",
                        value,
                      )
                    }
                    options={[
                      {
                        value: "direct_first",
                        label: "Direct first",
                        description:
                          "Try direct playback first, proxy retries on failure.",
                      },
                      {
                        value: "proxy_first",
                        label: "Proxy first",
                        description:
                          "Start media sessions on a validated proxy immediately.",
                      },
                      {
                        value: "direct_only",
                        label: "Direct only",
                        description:
                          "Never promote to proxy retry automatically.",
                      },
                    ]}
                    placeholder="Select strategy"
                    description="How sessions treat proxies on stream-like pages."
                  />
                  <ToggleRow
                    label="Asset diagnostics"
                    checked={!!activeBrowserRuntime.asset_diagnostics_enabled}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "asset_diagnostics_enabled",
                        value,
                      )
                    }
                    description="Return script, stylesheet, and manifest failure summaries to explain blank renders."
                  />
                </div>
              </FieldGroup>

              <FieldGroup
                title="Ad-Blocking & Launch"
                description="Chromium launch flags, request blocker, and recovery behavior."
                accent="var(--rose)"
              >
                <BrowserRuntimeTextarea
                  label="Extra launch args"
                  value={(activeBrowserRuntime.extra_launch_args || []).join(
                    ", ",
                  )}
                  onChange={(value) =>
                    updateBrowserRuntimeList(
                      browserSettingsTab,
                      "extra_launch_args",
                      value,
                    )
                  }
                  placeholder="--disable-web-security, --lang=en-US"
                  description="Extra Chromium flags appended at launch. Keep minimal so the browser looks normal."
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <BrowserRuntimeInput
                    label="Allowlist hosts"
                    value={(
                      activeBrowserRuntime.adblock_allowlist_hosts || []
                    ).join(", ")}
                    onChange={(value) =>
                      updateBrowserRuntimeList(
                        browserSettingsTab,
                        "adblock_allowlist_hosts",
                        value,
                      )
                    }
                    placeholder="example.com, cdn.example.com"
                    description="Hosts that bypass blocking even when adblock is enabled."
                  />
                  <BrowserRuntimeInput
                    label="Excluded categories"
                    value={(
                      activeBrowserRuntime.adblock_excluded_categories || []
                    ).join(", ")}
                    onChange={(value) =>
                      updateBrowserRuntimeList(
                        browserSettingsTab,
                        "adblock_excluded_categories",
                        value,
                      )
                    }
                    placeholder="nsfw, gambling"
                    description="Filter categories to leave disabled when the blocker is active."
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <ToggleRow
                    label="Enable adblock"
                    checked={!!activeBrowserRuntime.adblock_enabled}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "adblock_enabled",
                        value,
                      )
                    }
                    description="Attach the request blocker for this runtime."
                  />
                  <ToggleRow
                    label="Auto recovery"
                    checked={
                      !!activeBrowserRuntime.adblock_auto_recovery_enabled
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "adblock_auto_recovery_enabled",
                        value,
                      )
                    }
                    description="Disable blocking temporarily when player requests look broken."
                  />
                  <ToggleRow
                    label="Recover on abort"
                    checked={
                      !!activeBrowserRuntime.adblock_auto_recovery_on_abort
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "adblock_auto_recovery_on_abort",
                        value,
                      )
                    }
                    description="Treat aborted player requests as a recovery trigger."
                  />
                  <ToggleRow
                    label="Retry after recovery"
                    checked={!!activeBrowserRuntime.adblock_auto_recovery_retry}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "adblock_auto_recovery_retry",
                        value,
                      )
                    }
                    description="Reload the page after disabling blocking so media requests can retry."
                  />
                  <ToggleRow
                    label="Iframe sandbox patch"
                    checked={
                      !!activeBrowserRuntime.iframe_sandbox_patch_enabled
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "iframe_sandbox_patch_enabled",
                        value,
                      )
                    }
                    description="Loosen player iframe sandbox restrictions that block playback."
                  />
                  {browserSettingsTab === "puppeteer" ? (
                    <ToggleRow
                      label="uBOL extension"
                      checked={!!browserRuntime.puppeteer?.ubol_enabled}
                      onChange={(value) =>
                        updateBrowserRuntime("puppeteer", "ubol_enabled", value)
                      }
                      description="Load bundled uBlock Origin Lite extension if present on disk."
                    />
                  ) : null}
                  {browserSettingsTab === "puppeteer" ? (
                    <ToggleRow
                      label="Stream CORS patch"
                      checked={
                        !!browserRuntime.puppeteer?.stream_cors_patch_enabled
                      }
                      onChange={(value) =>
                        updateBrowserRuntime(
                          "puppeteer",
                          "stream_cors_patch_enabled",
                          value,
                        )
                      }
                      description="Force CORS headers on stream requests. Use sparingly."
                    />
                  ) : null}
                  {browserSettingsTab === "puppeteer" ? (
                    <ToggleRow
                      label="Include stream credentials"
                      checked={
                        !!browserRuntime.puppeteer
                          ?.stream_cors_include_credentials
                      }
                      onChange={(value) =>
                        updateBrowserRuntime(
                          "puppeteer",
                          "stream_cors_include_credentials",
                          value,
                        )
                      }
                      description="Include credentials when the stream CORS patch is active."
                    />
                  ) : null}
                </div>
              </FieldGroup>

              <FieldGroup
                title="Recovery & Media"
                description="Iframe recovery, media capture, and navigation retry behavior."
                accent="var(--sky)"
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    {
                      label: "Transient errors",
                      note: "Auto-retries for ERR_FAILED, ERR_NETWORK, connection resets, DNS, timeout, and chrome-error:// failures.",
                    },
                    {
                      label: "Limited retries",
                      note: "ERR_TOO_MANY_REDIRECTS and ERR_UNKNOWN_URL_SCHEME retry fewer times before falling through.",
                    },
                    {
                      label: "Permanent failures",
                      note: "ERR_BLOCKED_BY_CLIENT, certificate, and invalid-argument failures stop immediately.",
                    },
                  ].map(({ label, note }) => (
                    <div
                      key={label}
                      className="rounded-[12px] border p-3.5"
                      style={{
                        borderColor: "var(--line)",
                        background: "rgba(255,255,255,0.02)",
                      }}
                    >
                      <div
                        className="mb-1.5 text-[12px] font-semibold"
                        style={{ color: "var(--ink)" }}
                      >
                        {label}
                      </div>
                      <p
                        className="text-[11.5px]"
                        style={{ color: "var(--mute)" }}
                      >
                        {note}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="text-[11.5px]" style={{ color: "var(--mute-2)" }}>
                  Built-in retry backoff: 1000 ms → 2000 ms → 4000 ms → 8000 ms.
                  Wait strategy degrades from network idle → DOM loaded → full
                  load.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <ToggleRow
                    label="Iframe auto-recovery"
                    checked={
                      !!activeBrowserRuntime.iframe_auto_recovery_enabled
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "iframe_auto_recovery_enabled",
                        value,
                      )
                    }
                    description="Retry iframe failures from sandbox, CORS-like blocking, and transient network errors."
                  />
                  <BrowserRuntimeInput
                    label="Iframe recovery timeout (ms)"
                    value={String(
                      activeBrowserRuntime.iframe_recovery_timeout_ms ?? "",
                    )}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "iframe_recovery_timeout_ms",
                        Number.parseInt(value || "0", 10) || 0,
                      )
                    }
                    type="number"
                    min="5000"
                    max="60000"
                    step="1000"
                    description="Max time for a recovery reload before reporting failure."
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <BrowserRuntimeInput
                    label="Media capture timeout (ms)"
                    value={String(
                      activeBrowserRuntime.media_capture_timeout_ms ?? "",
                    )}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "media_capture_timeout_ms",
                        Number.parseInt(value || "0", 10) || 0,
                      )
                    }
                    type="number"
                    min="5000"
                    max="120000"
                    step="1000"
                    description="How long the runtime listens for HLS, DASH, and direct media requests."
                  />
                  <BrowserRuntimeInput
                    label="Media retry count"
                    value={String(activeBrowserRuntime.media_retry_count ?? "")}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "media_retry_count",
                        Number.parseInt(value || "0", 10) || 0,
                      )
                    }
                    type="number"
                    min="0"
                    max="10"
                    step="1"
                    description="How many times play-media retries before surfacing the final failure."
                  />
                </div>
                <BrowserRuntimeInput
                  label="Media retry backoff (ms)"
                  value={(
                    activeBrowserRuntime.media_retry_backoff_ms || []
                  ).join(", ")}
                  onChange={(value) =>
                    updateBrowserRuntimeIntegerList(
                      browserSettingsTab,
                      "media_retry_backoff_ms",
                      value,
                    )
                  }
                  placeholder="1000, 2000, 4000"
                  description="Comma-separated per-attempt backoff delays between media playback retries."
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <ToggleRow
                    label="Verify media playback"
                    checked={
                      !!activeBrowserRuntime.media_playback_verification_enabled
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "media_playback_verification_enabled",
                        value,
                      )
                    }
                    description="Wait for play/playing signals before reporting success."
                  />
                  <ToggleRow
                    label="Detect media CORS errors"
                    checked={!!activeBrowserRuntime.media_cors_patch_enabled}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "media_cors_patch_enabled",
                        value,
                      )
                    }
                    description="Collect cross-origin stream diagnostics and flag suspicious missing CORS headers."
                  />
                </div>
              </FieldGroup>
            </section>
          ) : null}

          {activeTab === "evaluation" ? (
            <section className="space-y-5">
              <FieldGroup
                title="Judge Model"
                description="A separate LLM that scores pipeline outputs for hallucination, relevancy, faithfulness, and tool accuracy. GPT-4o or Claude Sonnet 3.5 recommended."
                accent="var(--violet)"
              >
                {/* Provider selector cards */}
                <div>
                  <label
                    className="mb-2.5 block text-[10px] font-semibold uppercase tracking-[0.14em]"
                    style={{ color: "var(--mute-2)" }}
                  >
                    Provider
                  </label>
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    {[
                      {
                        value: "openai",
                        label: "OpenAI",
                        model: "gpt-4o",
                        color: "var(--mint)",
                      },
                      {
                        value: "anthropic",
                        label: "Anthropic",
                        model: "claude-3-5-sonnet",
                        color: "var(--signal)",
                      },
                      {
                        value: "google",
                        label: "Google",
                        model: "gemini-2.5-pro",
                        color: "var(--sky)",
                      },
                      {
                        value: "openrouter",
                        label: "OpenRouter",
                        model: "any model",
                        color: "var(--violet)",
                      },
                    ].map((item) => {
                      const isActive = deepevalProvider === item.value;
                      return (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => setDeepevalProvider(item.value)}
                          className="rounded-[12px] border p-3 text-left transition-all duration-150"
                          style={
                            isActive
                              ? {
                                  borderColor: `color-mix(in oklch, ${item.color} 40%, transparent)`,
                                  background: `color-mix(in oklch, ${item.color} 8%, transparent)`,
                                  boxShadow: `0 0 0 1px color-mix(in oklch, ${item.color} 18%, transparent)`,
                                }
                              : {
                                  borderColor: "var(--line)",
                                  background: "rgba(255,255,255,0.02)",
                                }
                          }
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{
                                background: isActive
                                  ? item.color
                                  : "var(--mute-3)",
                              }}
                            />
                            <span
                              className="text-[13px] font-semibold"
                              style={{
                                color: isActive ? item.color : "var(--ink)",
                              }}
                            >
                              {item.label}
                            </span>
                          </div>
                          <div
                            className="mt-1.5 font-mono text-[10.5px]"
                            style={{
                              color: isActive
                                ? `color-mix(in oklch, ${item.color} 70%, var(--mute))`
                                : "var(--mute-2)",
                            }}
                          >
                            {item.model}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Model ID + Temperature side by side */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input
                    label="Model ID"
                    value={deepevalModel}
                    onChange={(e) => setDeepevalModel(e.target.value)}
                    placeholder="gpt-4o"
                    description="Exact model ID passed to the judge provider."
                    className="h-10 border-[var(--line-hi)] bg-white/3 font-mono text-[13px] text-[var(--ink)]"
                  />

                  <div className="space-y-2">
                    <Slider
                      label="Temperature"
                      value={Number(deepevalTemperature) || 0}
                      onChange={(next) => setDeepevalTemperature(next)}
                      min={0}
                      max={2}
                      step={0.05}
                      description="0 = deterministic · 2 = creative"
                    />
                    <p
                      className="text-[10.5px]"
                      style={{ color: "var(--mute-2)" }}
                    >
                      0 recommended for consistent evaluation scoring.
                    </p>
                  </div>
                </div>
              </FieldGroup>

              <FieldGroup
                title="Metrics"
                description="DeepEval metrics automatically scored against every evaluation case."
                accent="var(--sky)"
              >
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {[
                    {
                      name: "Hallucination",
                      desc: "Detects fabricated facts in generated output",
                      color: "var(--rose)",
                    },
                    {
                      name: "Answer Relevancy",
                      desc: "Measures output relevance to the input question",
                      color: "var(--sky)",
                    },
                    {
                      name: "Faithfulness",
                      desc: "Factual consistency relative to retrieved context",
                      color: "var(--mint)",
                    },
                    {
                      name: "Contextual Recall",
                      desc: "Coverage of ground truth in retrieved context",
                      color: "var(--violet)",
                    },
                    {
                      name: "Tool Accuracy",
                      desc: "Correct tool calls made vs expected set",
                      color: "var(--signal)",
                    },
                    {
                      name: "Reliability",
                      desc: "Consistent outputs across repeated executions",
                      color: "var(--signal-2)",
                    },
                  ].map((metric) => (
                    <div
                      key={metric.name}
                      className="flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5"
                      style={{
                        borderColor: "var(--line)",
                        background: "rgba(255,255,255,0.015)",
                      }}
                    >
                      <span
                        className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: metric.color }}
                      />
                      <div>
                        <div
                          className="text-[12.5px] font-semibold"
                          style={{ color: "var(--ink)" }}
                        >
                          {metric.name}
                        </div>
                        <div
                          className="mt-0.5 text-[11px] leading-snug"
                          style={{ color: "var(--mute)" }}
                        >
                          {metric.desc}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </FieldGroup>

              <FieldGroup
                title="Quick Start"
                description="Run DeepEval evaluations against your pipeline outputs."
                accent="var(--mint)"
              >
                <div
                  className="overflow-hidden rounded-[12px] border"
                  style={{
                    borderColor: "var(--line)",
                    background: "rgba(0,0,0,0.22)",
                  }}
                >
                  <div
                    className="flex items-center gap-2 border-b px-4 py-2.5"
                    style={{
                      borderColor: "var(--line)",
                      background: "rgba(255,255,255,0.02)",
                    }}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: "var(--rose)" }}
                    />
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: "var(--signal)" }}
                    />
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: "var(--mint)" }}
                    />
                    <span
                      className="ml-2 font-mono text-[10px]"
                      style={{ color: "var(--mute-2)" }}
                    >
                      terminal
                    </span>
                  </div>
                  <div className="space-y-1.5 p-4">
                    {[
                      "pip install deepeval",
                      "deepeval login",
                      "deepeval test run tests/test_model.py",
                    ].map((cmd) => (
                      <div
                        key={cmd}
                        className="flex items-center gap-3 font-mono text-[12.5px]"
                      >
                        <span
                          className="select-none"
                          style={{ color: "var(--signal)" }}
                        >
                          $
                        </span>
                        <span style={{ color: "var(--ink-dim)" }}>{cmd}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </FieldGroup>
            </section>
          ) : null}

          {activeTab === "mcp-tools" ? (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <SectionHeader>MCP Tools</SectionHeader>
                <span className="text-[11px]" style={{ color: "var(--mute)" }}>
                  Disabled tools are excluded from the selected browser profile
                  at runtime
                </span>
              </div>

              <MiniSegment
                active={activeMcpBrowserTab}
                onChange={setActiveMcpBrowserTab}
                options={BROWSER_OPTIONS.map((item) => ({
                  id: item.id,
                  label: item.name,
                  badge:
                    Object.keys(MCP_TOOLS_BY_PROFILE).reduce(
                      (count, profile) => {
                        return (
                          count +
                          (disabledToolsByBrowserProfile[item.id]?.[profile]
                            ?.length || 0)
                        );
                      },
                      0,
                    ) || "",
                }))}
              />

              <MiniSegment
                active={activeProfileTab}
                onChange={setActiveProfileTab}
                options={Object.keys(MCP_TOOLS_BY_PROFILE).map((profile) => ({
                  id: profile,
                  label: PROFILE_LABELS[profile],
                  badge:
                    disabledToolsByBrowserProfile[activeMcpBrowserTab]?.[
                      profile
                    ]?.length ||
                    0 ||
                    "",
                }))}
              />

              <div
                className="rounded-[14px] border p-4"
                style={{
                  borderColor: "var(--line)",
                  background: "var(--card)",
                  boxShadow: "var(--shadow-card)",
                }}
              >
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Wrench
                      className="h-3.5 w-3.5"
                      style={{ color: "var(--signal)" }}
                    />
                    <span
                      className="text-[13px] font-medium"
                      style={{ color: "var(--ink)" }}
                    >
                      {
                        BROWSER_OPTIONS.find(
                          (item) => item.id === activeMcpBrowserTab,
                        )?.name
                      }{" "}
                      - {PROFILE_LABELS[activeProfileTab]}
                    </span>
                    <span
                      className="font-mono text-[11px]"
                      style={{ color: "var(--mute)" }}
                    >
                      {MCP_TOOLS_BY_PROFILE[activeProfileTab].length -
                        activeBrowserTools().length}
                      {" / "}
                      {MCP_TOOLS_BY_PROFILE[activeProfileTab].length} enabled
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="rounded-lg px-2.5 py-1 text-[11px] transition-colors"
                      style={{
                        color: "var(--mint)",
                        border:
                          "1px solid color-mix(in oklch, var(--mint) 25%, transparent)",
                        background:
                          "color-mix(in oklch, var(--mint) 8%, transparent)",
                      }}
                      onClick={() =>
                        setDisabledToolsForCurrentBrowserProfile([])
                      }
                    >
                      Enable all
                    </button>
                    <button
                      type="button"
                      className="rounded-lg px-2.5 py-1 text-[11px] transition-colors"
                      style={{
                        color: "var(--mute)",
                        border: "1px solid var(--line)",
                      }}
                      onClick={() =>
                        setDisabledToolsForCurrentBrowserProfile(
                          MCP_TOOLS_BY_PROFILE[activeProfileTab],
                        )
                      }
                    >
                      Disable all
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {MCP_TOOLS_BY_PROFILE[activeProfileTab].map((toolName) => {
                    const disabled = activeBrowserTools().includes(toolName);
                    return (
                      <button
                        key={toolName}
                        type="button"
                        onClick={() => {
                          const currentDisabled = activeBrowserTools();
                          const nextDisabled = disabled
                            ? currentDisabled.filter(
                                (item) => item !== toolName,
                              )
                            : [...currentDisabled, toolName];
                          setDisabledToolsForCurrentBrowserProfile(
                            nextDisabled,
                          );
                        }}
                        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-[11px] transition-all duration-150"
                        style={
                          disabled
                            ? {
                                background: "rgba(255,255,255,0.02)",
                                color: "var(--mute-3)",
                                border: "1px solid var(--line)",
                                textDecoration: "line-through",
                                opacity: 0.55,
                              }
                            : {
                                background:
                                  "color-mix(in oklch, var(--sky) 10%, transparent)",
                                color: "var(--sky)",
                                border:
                                  "1px solid color-mix(in oklch, var(--sky) 25%, transparent)",
                              }
                        }
                      >
                        {disabled ? (
                          <ToggleLeft
                            className="h-3 w-3 shrink-0"
                            style={{ color: "var(--mute-3)" }}
                          />
                        ) : (
                          <ToggleRight className="h-3 w-3 shrink-0" />
                        )}
                        {toolName}
                      </button>
                    );
                  })}
                </div>

                <p
                  className="mt-3 text-[11.5px]"
                  style={{ color: "var(--mute)" }}
                >
                  Tool visibility is now tracked independently for Puppeteer and
                  Playwright.
                </p>
              </div>
            </section>
          ) : null}

          {activeTab === "api-keys" ? (
            <section className="space-y-4">
              <SectionHeader>API Key Status</SectionHeader>
              <p className="text-[13px]" style={{ color: "var(--mute)" }}>
                Keys are loaded from environment variables at server start. Add
                them to your{" "}
                <code
                  className="font-mono text-[12px] rounded px-1 py-0.5"
                  style={{
                    background: "rgba(255,255,255,0.06)",
                    color: "var(--ink-dim)",
                  }}
                >
                  .env
                </code>{" "}
                file and rebuild to activate a provider.
              </p>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {PROVIDERS.map((item) => {
                  const hasKey = !!apiKeys[item.id];
                  return (
                    <div
                      key={item.id}
                      className="flex items-start gap-3 rounded-[12px] border p-3.5"
                      style={{
                        borderColor: hasKey
                          ? `color-mix(in oklch, ${item.color || "var(--mint)"} 22%, var(--line))`
                          : "var(--line)",
                        background: hasKey
                          ? `color-mix(in oklch, ${item.color || "var(--mint)"} 5%, transparent)`
                          : "var(--card)",
                      }}
                    >
                      <span
                        className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
                        style={{
                          background: hasKey
                            ? item.color || "var(--mint)"
                            : "var(--mute-3)",
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <div
                            className="text-[13px] font-semibold"
                            style={{ color: "var(--ink)" }}
                          >
                            {item.name}
                          </div>
                          <KeyStatus set={hasKey} />
                        </div>
                        <div
                          className="mt-0.5 font-mono text-[10px]"
                          style={{ color: "var(--mute-3)" }}
                        >
                          {item.keyEnv}
                        </div>
                        {item.features && item.features.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {item.features.map((feat) => (
                              <span
                                key={feat}
                                className="rounded px-1.5 py-0.5 text-[9px] font-medium"
                                style={{
                                  background: "rgba(255,255,255,0.04)",
                                  color: "var(--mute-2)",
                                  border: "1px solid var(--line)",
                                }}
                              >
                                {feat}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {activeTab === "display" ? <DisplaySettingsSection /> : null}

          {activeTab === "notifications" ? (
            <section className="space-y-4">
              <SectionHeader>Notification Preferences</SectionHeader>
              <p className="text-[13.5px]" style={{ color: "var(--mute)" }}>
                Choose which pipeline events trigger toast notifications. Tool
                call events are never notified.
              </p>
              <div className="space-y-2">
                {NOTIF_EVENTS.map(({ key, label, note }) => (
                  <ToggleRow
                    key={key}
                    label={label}
                    checked={!!notifPrefs[key]}
                    onChange={(checked) =>
                      setNotifPrefs({ ...notifPrefs, [key]: checked })
                    }
                    description={note}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ── Display settings section ─────────────────────────────────────────────── */
function DisplaySettingsSection() {
  const { settings, update, reset } = useRunViewSettings();

  return (
    <section className="space-y-6">
      <div>
        <SectionHeader>Run View Display</SectionHeader>
        <p
          className="mt-1 text-[13.5px] leading-relaxed"
          style={{ color: "var(--mute)" }}
        >
          Control what panels and behaviors appear on the run detail pages.
          Settings are stored in your browser.
        </p>
      </div>

      <RunViewSettingsPanel settings={settings} update={update} reset={reset} />
      {/*

          {saved ? "✓ Saved to browser" : "Save display preferences"}
          (Auto-saved on change — this confirms)
      */}
      <div
        className="rounded-[12px] border p-4 space-y-2"
        style={{ borderColor: "var(--line)", background: "var(--card)" }}
      >
        <div
          className="text-[12px] font-semibold"
          style={{ color: "var(--ink-dim)" }}
        >
          About Browser Live View
        </div>
        <p
          className="text-[12px] leading-relaxed"
          style={{ color: "var(--mute)" }}
        >
          The browser live view panel polls the active run for the latest
          screenshot the headless browser captured. It shows the current URL
          being visited, the tool being executed (with highlights), and
          auto-refreshes while the run is live. Screenshots are captured by the
          agent during tool calls — not a continuous screen stream.
        </p>
        <p
          className="text-[12px] leading-relaxed"
          style={{ color: "var(--mute)" }}
        >
          Tool activity overlays display the tool name, action label, and target
          selector or URL from the tool call arguments so you can follow exactly
          what the agent is doing in the browser.
        </p>
      </div>
    </section>
  );
}
