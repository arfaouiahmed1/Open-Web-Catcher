"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { JsonViewer } from "@/components/json-viewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HelpIcon } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, apiUrl } from "@/lib/api";

const PROVIDERS = [
  { id: "google", name: "Google Gemini", keyEnv: "GOOGLE_API_KEY" },
  { id: "openai", name: "OpenAI", keyEnv: "OPENAI_API_KEY" },
  { id: "anthropic", name: "Anthropic", keyEnv: "ANTHROPIC_API_KEY" },
  { id: "openrouter", name: "OpenRouter", keyEnv: "OPENROUTER_API_KEY" },
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
    "navigate", "inspect", "interact", "screenshot", "memory_lookup", "memory_update",
    "open_url", "get_page_context", "get_frame_tree", "query_elements",
    "get_element_detail", "scroll_page", "go_back", "wait_for_page_state",
  ],
  landing: [
    "navigate", "inspect_landing", "interact", "screenshot", "memory_lookup", "memory_update",
    "get_page_context", "query_elements", "get_element_detail", "get_frame_tree",
    "open_url", "go_back", "scroll_page", "scroll_to_element", "wait_for_page_state",
    "click_element", "click_css", "click_text", "click_xpath", "click_checkbox",
    "click_radio", "type_into", "select_option", "play_media", "swipe_region", "click_coordinates",
  ],
  hosting: [
    "navigate", "inspect_hosting", "interact", "screenshot", "memory_lookup", "memory_update",
    "harvest", "get_page_context", "query_elements", "get_element_detail", "get_frame_tree",
    "open_url", "go_back", "scroll_page", "scroll_to_element", "wait_for_page_state",
    "click_element", "click_css", "click_text", "click_xpath", "click_checkbox",
    "click_radio", "type_into", "select_option", "play_media", "swipe_region",
    "click_coordinates", "get_media_state", "capture_streams",
  ],
  embedded: [
    "navigate", "inspect_embedded", "interact", "screenshot", "memory_lookup", "memory_update",
    "harvest", "get_page_context", "query_elements", "get_element_detail", "get_frame_tree",
    "open_url", "go_back", "scroll_page", "scroll_to_element", "wait_for_page_state",
    "click_element", "click_css", "click_text", "click_xpath", "click_checkbox",
    "click_radio", "type_into", "select_option", "play_media", "swipe_region",
    "click_coordinates", "get_media_state", "capture_streams",
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
  { id: "playwright", name: "Playwright", note: "Port 3001 - context isolation, modern" },
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
  { id: "api-keys", label: "API Keys" },
  { id: "notifications", label: "Notifications" },
  { id: "mcp-tools", label: "MCP Tools" },
];

const NOTIF_EVENTS = [
  { key: "pipeline_started", label: "Pipeline started", note: "Fired when a new pipeline begins" },
  { key: "agent_started", label: "Agent transitions (started)", note: "Each agent activation" },
  { key: "agent_finished", label: "Agent transitions (finished)", note: "Each agent completion" },
  { key: "agent_failed", label: "Agent failures", note: "When an agent errors out" },
  { key: "pipeline_finished", label: "Pipeline completed", note: "Successful pipeline end" },
  { key: "pipeline_failed", label: "Pipeline failed", note: "Fatal pipeline failure" },
  { key: "run_cancelled", label: "Run cancelled", note: "User or system cancellation" },
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
    ubol_enabled: true,
    stream_cors_patch_enabled: false,
    stream_cors_include_credentials: false,
    iframe_sandbox_patch_enabled: true,
  },
  playwright: {
    launch_timeout_ms: 45000,
    extra_launch_args: [],
    adblock_enabled: true,
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
    iframe_sandbox_patch_enabled: true,
  },
};

function cloneBrowserRuntime() {
  return {
    puppeteer: {
      ...DEFAULT_BROWSER_RUNTIME.puppeteer,
      extra_launch_args: [...DEFAULT_BROWSER_RUNTIME.puppeteer.extra_launch_args],
      adblock_allowlist_hosts: [...DEFAULT_BROWSER_RUNTIME.puppeteer.adblock_allowlist_hosts],
      adblock_excluded_categories: [...DEFAULT_BROWSER_RUNTIME.puppeteer.adblock_excluded_categories],
      proxy_source_order: [...DEFAULT_BROWSER_RUNTIME.puppeteer.proxy_source_order],
      proxy_custom_list: [...DEFAULT_BROWSER_RUNTIME.puppeteer.proxy_custom_list],
    },
    playwright: {
      ...DEFAULT_BROWSER_RUNTIME.playwright,
      extra_launch_args: [...DEFAULT_BROWSER_RUNTIME.playwright.extra_launch_args],
      adblock_allowlist_hosts: [...DEFAULT_BROWSER_RUNTIME.playwright.adblock_allowlist_hosts],
      adblock_excluded_categories: [...DEFAULT_BROWSER_RUNTIME.playwright.adblock_excluded_categories],
      proxy_source_order: [...DEFAULT_BROWSER_RUNTIME.playwright.proxy_source_order],
      proxy_custom_list: [...DEFAULT_BROWSER_RUNTIME.playwright.proxy_custom_list],
    },
  };
}

function normalizeStringList(value, fallback = []) {
  let rows = [];
  if (Array.isArray(value)) rows = value.map((item) => String(item || "").trim());
  else if (typeof value === "string") rows = value.split(",").map((item) => item.trim());
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

function normalizeTuning(tuning) {
  if (!tuning || typeof tuning !== "object") return { ...EMPTY_TUNING };

  const providerDefaults = {};
  Object.entries(tuning.provider_defaults || {}).forEach(([provider, value]) => {
    if (value && typeof value === "object") providerDefaults[String(provider).toLowerCase()] = { ...value };
  });

  const modelOverrides = {};
  Object.entries(tuning.model_overrides || {}).forEach(([key, value]) => {
    if (value && typeof value === "object") modelOverrides[String(key).toLowerCase()] = { ...value };
  });

  const agentOverrides = {};
  Object.entries(tuning.agent_overrides || {}).forEach(([key, value]) => {
    if (value && typeof value === "object") agentOverrides[String(key).toLowerCase()] = { ...value };
  });

  return {
    provider_defaults: providerDefaults,
    model_overrides: modelOverrides,
    agent_overrides: agentOverrides,
  };
}

function normalizeAgentModelConfig(config, fallbackProvider = "google", fallbackAgentModel = "", fallbackOrchModel = "") {
  const defaults = {
    classification: { provider: fallbackProvider, model: fallbackAgentModel },
    landing: { provider: fallbackProvider, model: fallbackAgentModel },
    hosting: { provider: fallbackProvider, model: fallbackAgentModel },
    embedded: { provider: fallbackProvider, model: fallbackAgentModel },
    orchestrator: { provider: fallbackProvider, model: fallbackOrchModel || fallbackAgentModel },
  };

  if (!config || typeof config !== "object") return defaults;

  const next = {};
  AGENT_SLOTS.forEach(({ id }) => {
    const row = config[id];
    next[id] = {
      provider: String(row?.provider || defaults[id].provider || fallbackProvider).toLowerCase(),
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
      extra_launch_args: normalizeStringList(current.extra_launch_args, base[id].extra_launch_args),
      adblock_allowlist_hosts: normalizeStringList(current.adblock_allowlist_hosts, base[id].adblock_allowlist_hosts),
      adblock_excluded_categories: normalizeStringList(current.adblock_excluded_categories, base[id].adblock_excluded_categories),
      proxy_source_order: normalizeStringList(current.proxy_source_order, base[id].proxy_source_order),
      proxy_custom_list: normalizeStringList(current.proxy_custom_list, base[id].proxy_custom_list),
    };
  });

  return base;
}

function normalizeDisabledToolsByBrowserProfile(value, legacy = {}) {
  const next = Object.fromEntries(
    BROWSER_OPTIONS.map(({ id }) => [
      id,
      Object.fromEntries(Object.keys(MCP_TOOLS_BY_PROFILE).map((profile) => [profile, normalizeStringList(legacy[profile] || [])])),
    ])
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
    <span className="flex items-center gap-1 text-[12px]" style={{ color: "var(--mint)" }}>
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
    <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
      {children}
    </h2>
  );
}

function SettingsTabBar({ active, onChange }) {
  const ref = useRef(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  useEffect(() => {
    if (!ref.current) return;
    const buttons = ref.current.querySelectorAll("button");
    const index = SETTINGS_TABS.findIndex((tab) => tab.id === active);
    if (index >= 0 && buttons[index]) {
      setIndicator({ left: buttons[index].offsetLeft, width: buttons[index].offsetWidth });
    }
  }, [active]);

  return (
    <div
      ref={ref}
      className="relative flex flex-wrap items-center gap-0.5 rounded-xl border p-1"
      style={{ background: "var(--card)", borderColor: "var(--line)" }}
    >
      <span
        className="pointer-events-none absolute rounded-lg"
        style={{
          left: indicator.left,
          width: indicator.width,
          top: 4,
          bottom: 4,
          background: "color-mix(in oklch, var(--signal) 14%, transparent)",
          border: "1px solid color-mix(in oklch, var(--signal) 28%, transparent)",
          transition: "left 200ms cubic-bezier(0.4,0,0.2,1), width 200ms cubic-bezier(0.4,0,0.2,1)",
        }}
      />
      {SETTINGS_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className="relative z-10 rounded-lg px-3.5 py-1.5 text-[12.5px] font-medium transition-colors duration-150"
          style={{ color: active === tab.id ? "var(--signal)" : "var(--mute)" }}
        >
          {tab.label}
        </button>
      ))}
    </div>
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

        return (
          <div key={field.key} className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
              {field.label}
            </label>
            <input
              value={value}
              onChange={(event) => onChange(field, parseFieldValue(field, event.target.value))}
              type="number"
              min={field.min}
              max={field.max}
              step={field.step || "any"}
              className="h-11 w-full rounded-[12px] border px-3 text-[13px] focus:outline-none"
              style={{
                borderColor: "var(--line)",
                background: "rgba(0,0,0,0.2)",
                color: "var(--ink-dim)",
              }}
            />
            {field.description && (
              <p className="text-[11px] text-[var(--mute)]">{field.description}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TuningCard({ title, description, values, fields, onChange, onClear, clearLabel }) {
  return (
    <div
      className="rounded-[14px] border p-4"
      style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.02)" }}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium text-[var(--ink)]">{title}</div>
          {description ? <p className="mt-1 text-[12px] text-[var(--mute)]">{description}</p> : null}
        </div>
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded-[10px] border px-2.5 py-1 text-[11px] transition-colors"
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
    <div className="flex gap-1 rounded-xl p-1" style={{ background: "var(--card)", border: "1px solid var(--line)" }}>
      {options.map((option) => {
        const isActive = option.id === active;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all duration-150"
            style={isActive
              ? {
                  background: "color-mix(in oklch, var(--signal) 14%, transparent)",
                  color: "var(--signal)",
                  border: "1px solid color-mix(in oklch, var(--signal) 30%, transparent)",
                }
              : { color: "var(--mute)", border: "1px solid transparent" }}
          >
            {option.label}
            {option.badge ? (
              <span
                className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
                style={{
                  background: "color-mix(in oklch, var(--rose) 20%, transparent)",
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
    <label
      className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border px-3 py-2.5"
      style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.02)", color: "var(--ink-dim)" }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-[var(--signal)]"
      />
      <span className="space-y-1">
        <span className="block text-[13px]">{label}</span>
        <FieldNote>{description}</FieldNote>
      </span>
    </label>
  );
}

function BrowserRuntimeInput({ label, value, onChange, type = "text", min, max, step, placeholder = "", description = "" }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
        {label}
      </label>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        className="h-11 w-full rounded-[12px] border px-3 text-[13px] focus:outline-none"
        style={{
          borderColor: "var(--line)",
          background: "rgba(0,0,0,0.2)",
          color: "var(--ink-dim)",
        }}
      />
      <FieldNote>{description}</FieldNote>
    </div>
  );
}

function BrowserRuntimeTextarea({ label, value, onChange, placeholder, description = "" }) {
  return (
    <div className="space-y-1.5">
      <Textarea
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-h-[104px]"
      />
      <FieldNote>{description}</FieldNote>
    </div>
  );
}

function BrowserRuntimeSelect({ label, value, onChange, options, placeholder = "Select option", description = "" }) {
  return (
    <div className="space-y-1.5">
      <Select
        label={label}
        value={value}
        onChange={onChange}
        options={options}
        placeholder={placeholder}
      />
      <FieldNote>{description}</FieldNote>
    </div>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("models");
  const { prefs: notifPrefs, setPrefs: setNotifPrefs } = useNotifPrefs();

  const [config, setConfig] = useState(null);
  const [provider, setProvider] = useState("google");
  const [fallbackTemperature, setFallbackTemperature] = useState("0");
  const [llmTuning, setLlmTuning] = useState({ ...EMPTY_TUNING });
  const [agentModelConfig, setAgentModelConfig] = useState(normalizeAgentModelConfig(null));
  const [providerCacheEnabled, setProviderCacheEnabled] = useState(true);
  const [geminiExplicitCacheEnabled, setGeminiExplicitCacheEnabled] = useState(true);
  const [geminiExplicitCacheTtl, setGeminiExplicitCacheTtl] = useState("1800");
  const [geminiExplicitCacheRefreshLead, setGeminiExplicitCacheRefreshLead] = useState("120");
  const [toolCacheEnabled, setToolCacheEnabled] = useState(true);
  const [toolCacheStable, setToolCacheStable] = useState("2");
  const [deepevalProvider, setDeepevalProvider] = useState("openai");
  const [deepevalModel, setDeepevalModel] = useState("gpt-4o");
  const [deepevalTemperature, setDeepevalTemperature] = useState("0");
  const [browserEngine, setBrowserEngine] = useState("puppeteer");
  const [browserSettingsTab, setBrowserSettingsTab] = useState("puppeteer");
  const [browserRuntime, setBrowserRuntime] = useState(cloneBrowserRuntime());
  const [disabledToolsByBrowserProfile, setDisabledToolsByBrowserProfile] = useState(
    normalizeDisabledToolsByBrowserProfile({})
  );
  const [activeMcpBrowserTab, setActiveMcpBrowserTab] = useState("puppeteer");
  const [activeProfileTab, setActiveProfileTab] = useState("classification");
  const [providerCatalogs, setProviderCatalogs] = useState({});
  const [catalogLoading, setCatalogLoading] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [configErr, setConfigErr] = useState("");

  const apiKeys = config?.api_keys || {};
  const activeProvider = PROVIDERS.find((item) => item.id === provider) || PROVIDERS[0];
  const activeCatalog = providerCatalogs[provider] || null;
  const activeBrowserRuntime = browserRuntime[browserSettingsTab] || DEFAULT_BROWSER_RUNTIME[browserSettingsTab];
  const proxySourceReference = BUILTIN_PROXY_SOURCE_OPTIONS
    .map((item) => `${item.value}: ${item.label}`)
    .join(" | ");

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
    () => (activeCatalog?.hyperparameters || []).filter((field) => !field.model_patterns?.length),
    [activeCatalog]
  );

  async function loadProviderCatalog(providerId, { force = false } = {}) {
    if (!providerId) return null;
    if (!force && providerCatalogs[providerId]) return providerCatalogs[providerId];

    setCatalogLoading(providerId);
    try {
      const payload = await apiFetch(`/ui/providers/models?provider=${encodeURIComponent(providerId)}`);
      setProviderCatalogs((current) => ({ ...current, [providerId]: payload }));
      return payload;
    } catch (error) {
      setConfigErr(error.message || "Could not load provider models.");
      throw error;
    } finally {
      setCatalogLoading("");
    }
  }

  async function hydrateConfig(payload) {
    const fallbackProvider = payload.llm_provider || "google";
    const fallbackAgentModel = payload.agent_model || "";
    const fallbackOrchestratorModel = payload.orchestrator_model || fallbackAgentModel;
    const nextAgentConfig = normalizeAgentModelConfig(
      payload.agent_model_config,
      fallbackProvider,
      fallbackAgentModel,
      fallbackOrchestratorModel
    );

    setConfig(payload);
    setProvider(fallbackProvider);
    setFallbackTemperature(String(payload.gemini_temperature ?? "0"));
    setLlmTuning(normalizeTuning(payload.llm_tuning));
    setAgentModelConfig(nextAgentConfig);
    setProviderCacheEnabled(Boolean(payload.provider_cache_enabled ?? true));
    setGeminiExplicitCacheEnabled(Boolean(payload.gemini_explicit_cache_enabled ?? true));
    setGeminiExplicitCacheTtl(String(payload.gemini_explicit_cache_ttl_seconds ?? 1800));
    setGeminiExplicitCacheRefreshLead(String(payload.gemini_explicit_cache_refresh_lead_seconds ?? 120));
    setToolCacheEnabled(Boolean(payload.tool_result_cache_enabled ?? true));
    setToolCacheStable(String(payload.tool_result_cache_min_identical_observations ?? 2));
    setDeepevalProvider(payload.deepeval_provider || "openai");
    setDeepevalModel(payload.deepeval_model || "gpt-4o");
    setDeepevalTemperature(String(payload.deepeval_temperature ?? 0));
    setBrowserEngine(payload.browser_engine || "puppeteer");
    setBrowserSettingsTab(payload.browser_engine || "puppeteer");
    setBrowserRuntime(normalizeBrowserRuntime(payload.browser_runtime));
    setDisabledToolsByBrowserProfile(
      normalizeDisabledToolsByBrowserProfile(payload.disabled_tools_by_browser_profile, payload.disabled_tools_by_profile || {})
    );
    setActiveMcpBrowserTab(payload.browser_engine || "puppeteer");

    const providersToLoad = [...new Set([
      fallbackProvider,
      ...Object.values(nextAgentConfig).map((row) => row.provider).filter(Boolean),
    ])];
    await Promise.all(providersToLoad.map((providerId) => loadProviderCatalog(providerId, { force: true }).catch(() => null)));
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
      const existing = current[agentId] || { provider: nextProvider, model: "" };
      const currentModel = existing.model || "";
      const available = catalog?.models?.some((item) => item.id === currentModel);
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

  function activeBrowserTools() {
    return disabledToolsByBrowserProfile[activeMcpBrowserTab]?.[activeProfileTab] || [];
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

  async function saveConfig() {
    setSaving(true);
    setConfigErr("");
    try {
      const classificationModel = agentModelConfig.classification?.model || "";
      const orchestratorModel = agentModelConfig.orchestrator?.model || "";
      const response = await fetch(apiUrl("/ui/config"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llm_provider: provider,
          agent_model: classificationModel,
          orchestrator_model: orchestratorModel,
          gemini_temperature: Number.parseFloat(fallbackTemperature || "0") || 0,
          llm_tuning: llmTuning,
          agent_model_config: agentModelConfig,
          provider_cache_enabled: providerCacheEnabled,
          gemini_explicit_cache_enabled: geminiExplicitCacheEnabled,
          gemini_explicit_cache_ttl_seconds: Number(geminiExplicitCacheTtl || 1800),
          gemini_explicit_cache_refresh_lead_seconds: Number(geminiExplicitCacheRefreshLead || 120),
          tool_result_cache_enabled: toolCacheEnabled,
          tool_result_cache_min_identical_observations: Number(toolCacheStable || 2),
          browser_engine: browserEngine,
          disabled_tools_by_browser_profile: disabledToolsByBrowserProfile,
          browser_runtime: browserRuntime,
          deepeval_provider: deepevalProvider,
          deepeval_model: deepevalModel,
          deepeval_temperature: Number.parseFloat(deepevalTemperature || "0") || 0,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `Status ${response.status}`);
      await hydrateConfig(payload);
      if (payload.config_persisted === false) {
        setConfigErr(payload.config_persist_error || "Config updated in memory, but could not be persisted to disk.");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (error) {
      setConfigErr(error.message || "Could not save config.");
    } finally {
      setSaving(false);
    }
  }

  const providerCardUsage = useMemo(() => {
    const counts = Object.fromEntries(PROVIDERS.map((item) => [item.id, 0]));
    Object.values(agentModelConfig).forEach((row) => {
      if (row?.provider && counts[row.provider] != null) counts[row.provider] += 1;
    });
    return counts;
  }, [agentModelConfig]);

  return (
    <div className="space-y-8">
      <div>
        <span className="owc-eyebrow">settings - runtime config</span>
        <h1 className="mt-2 text-3xl font-semibold text-[var(--ink)]">
          Configuration
        </h1>
      </div>

      <SettingsTabBar active={activeTab} onChange={setActiveTab} />

      <div key={activeTab} className="animate-fade-up space-y-8">
        {activeTab === "models" ? (
          <section className="space-y-4">
            <SectionHeader>Provider Defaults</SectionHeader>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {PROVIDERS.map((item) => {
                const isActive = provider === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectProvider(item)}
                    className="w-full rounded-[14px] border p-4 text-left transition-colors"
                    style={isActive
                      ? {
                          borderColor: "color-mix(in oklch, var(--signal) 55%, transparent)",
                          background: "color-mix(in oklch, var(--signal) 9%, transparent)",
                        }
                      : { borderColor: "var(--line)", background: "var(--card)" }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13.5px] font-medium text-[var(--ink)]">{item.name}</span>
                      <div className="flex items-center gap-2">
                        <KeyStatus set={apiKeys[item.id]} />
                        {isActive ? <Badge tone="signal">Active</Badge> : null}
                      </div>
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-[var(--mute)]">{item.keyEnv}</div>
                    <div className="mt-3 text-[12px] text-[var(--ink-dim)]">
                      {providerCardUsage[item.id] || 0} agents using this provider
                    </div>
                  </button>
                );
              })}
            </div>

            <div
              className="space-y-5 rounded-[14px] border p-4"
              style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Settings2 className="h-3.5 w-3.5" style={{ color: "var(--signal)" }} />
                  <span className="text-[13.5px] font-medium text-[var(--ink)]">
                    Provider defaults - {activeProvider.name}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {activeCatalog ? (
                    <span className={`owc-pill ${sourceTone(activeCatalog.source)}`}>
                      <span className="dot" />
                      {sourceLabel(activeCatalog.source)}
                    </span>
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => loadProviderCatalog(provider, { force: true })}
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
                    borderColor: "color-mix(in oklch, var(--signal) 35%, transparent)",
                    background: "color-mix(in oklch, var(--signal) 10%, transparent)",
                    color: "var(--signal)",
                  }}
                >
                  <Key className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <strong>{activeProvider.keyEnv}</strong> is not set. Live model loading may fall back to cached or bundled lists until the key is available.
                  </span>
                </div>
              ) : null}

              {activeCatalog?.error ? (
                <div
                  className="rounded-lg border px-3 py-2.5 text-[12px]"
                  style={{
                    borderColor: "color-mix(in oklch, var(--signal) 35%, transparent)",
                    background: "color-mix(in oklch, var(--signal) 8%, transparent)",
                    color: "var(--ink-dim)",
                  }}
                >
                  {activeCatalog.error}
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
                    Fallback temperature
                    <HelpIcon tip="Global temperature applied when no provider-specific or agent-specific override is set. 0 = deterministic, 1+ = creative." />
                  </label>
                  <input
                    value={fallbackTemperature}
                    onChange={(event) => setFallbackTemperature(event.target.value)}
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    className="h-11 w-full rounded-[12px] border px-3 text-[13px] focus:outline-none"
                    style={{
                      borderColor: "var(--line)",
                      background: "rgba(0,0,0,0.2)",
                      color: "var(--ink-dim)",
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
                    Tool cache stabilization threshold
                    <HelpIcon tip="How many identical consecutive tool results must be seen before the response is cached. Higher = less aggressive caching." />
                  </label>
                  <input
                    value={toolCacheStable}
                    onChange={(event) => setToolCacheStable(event.target.value)}
                    type="number"
                    min="1"
                    step="1"
                    className="h-11 w-full rounded-[12px] border px-3 text-[13px] focus:outline-none"
                    style={{
                      borderColor: "var(--line)",
                      background: "rgba(0,0,0,0.2)",
                      color: "var(--ink-dim)",
                    }}
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
                const fields = (activeCatalog?.hyperparameters || []).filter((field) => fieldMatchesModel(field, target.id));
                const values = llmTuning.model_overrides[modelOverrideKey(provider, target.id)] || {};
                return (
                  <TuningCard
                    key={target.id}
                    title={`Model override - ${target.title}`}
                    description={target.description}
                    values={values}
                    fields={fields}
                    onChange={(field, value) => updateModelOverride(target.id, field, value)}
                    onClear={() => clearModelOverride(target.id)}
                    clearLabel="Clear override"
                  />
                );
              })}

              <div className="grid gap-3 sm:grid-cols-2">
                <ToggleRow
                  label="Enable provider prompt caching"
                  checked={providerCacheEnabled}
                  onChange={setProviderCacheEnabled}
                  description="Hooks into provider-native caching (Anthropic cache_control, Gemini context caching). Reduces cost on repeated system prompts."
                />
                <ToggleRow
                  label="Enable deterministic tool result cache"
                  checked={toolCacheEnabled}
                  onChange={setToolCacheEnabled}
                  description="Caches identical browser-tool responses across calls in the same session. Speeds up repeated DOM queries."
                />
              </div>

              <div
                className="space-y-4 rounded-[12px] border p-4"
                style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.02)" }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium text-[var(--ink)]">Gemini explicit cache</div>
                    <p className="mt-0.5 text-[12px] text-[var(--mute)]">
                      Server-side cached context for Gemini models — reduces latency and cost on repeated system prompts.
                    </p>
                  </div>
                  <ToggleRow
                    label="Enabled"
                    checked={geminiExplicitCacheEnabled}
                    onChange={setGeminiExplicitCacheEnabled}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
                      Cache TTL (seconds)
                    </label>
                    <input
                      value={geminiExplicitCacheTtl}
                      onChange={(event) => setGeminiExplicitCacheTtl(event.target.value)}
                      type="number"
                      min="60"
                      step="60"
                      disabled={!geminiExplicitCacheEnabled}
                      className="h-11 w-full rounded-[12px] border px-3 text-[13px] focus:outline-none disabled:opacity-40"
                      style={{
                        borderColor: "var(--line)",
                        background: "rgba(0,0,0,0.2)",
                        color: "var(--ink-dim)",
                      }}
                    />
                    <p className="text-[11px] text-[var(--mute)]">How long the server keeps the cached context alive (min 60 s).</p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
                      Refresh lead (seconds)
                    </label>
                    <input
                      value={geminiExplicitCacheRefreshLead}
                      onChange={(event) => setGeminiExplicitCacheRefreshLead(event.target.value)}
                      type="number"
                      min="5"
                      step="5"
                      disabled={!geminiExplicitCacheEnabled}
                      className="h-11 w-full rounded-[12px] border px-3 text-[13px] focus:outline-none disabled:opacity-40"
                      style={{
                        borderColor: "var(--line)",
                        background: "rgba(0,0,0,0.2)",
                        color: "var(--ink-dim)",
                      }}
                    />
                    <p className="text-[11px] text-[var(--mute)]">Seconds before expiry when the runtime pre-warms a new cache entry.</p>
                  </div>
                </div>
              </div>
            </div>

            <SectionHeader>Per-Agent Models</SectionHeader>
            <div className="grid gap-4 xl:grid-cols-2">
              {AGENT_SLOTS.map((slot) => {
                const selection = agentModelConfig[slot.id] || { provider, model: "" };
                const slotCatalog = providerCatalogs[selection.provider] || null;
                const slotOptions = ensureSelectedOption(
                  (slotCatalog?.models || []).map((model) => ({
                    value: model.id,
                    label: model.label || model.id,
                    description: model.description || "",
                    meta: model.context_window ? `context ${model.context_window}` : "",
                  })),
                  selection.model
                );
                const slotFields = (slotCatalog?.hyperparameters || []).filter((field) => fieldMatchesModel(field, selection.model));
                const slotOverrides = llmTuning.agent_overrides[slot.id] || {};

                return (
                  <div
                    key={slot.id}
                    className="space-y-4 rounded-[14px] border p-4"
                    style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[13.5px] font-medium text-[var(--ink)]">{slot.label}</div>
                        <div className="mt-1 text-[11.5px] text-[var(--mute)]">{slot.note}</div>
                      </div>
                      {slotCatalog ? (
                        <span className={`owc-pill ${sourceTone(slotCatalog.source)}`}>
                          <span className="dot" />
                          {sourceLabel(slotCatalog.source)}
                        </span>
                      ) : null}
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <Select
                        label="Provider"
                        value={selection.provider}
                        onChange={(next) => updateAgentProvider(slot.id, next)}
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
                      onChange={(event) => updateAgentModel(slot.id, event.target.value)}
                      placeholder="Manual model name"
                      className="h-11 font-mono"
                    />

                    {slotCatalog?.error ? (
                      <div
                        className="rounded-lg border px-3 py-2.5 text-[12px]"
                        style={{
                          borderColor: "color-mix(in oklch, var(--signal) 35%, transparent)",
                          background: "color-mix(in oklch, var(--signal) 8%, transparent)",
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
                      onChange={(field, value) => updateAgentOverride(slot.id, field, value)}
                      onClear={() => clearAgentOverride(slot.id)}
                      clearLabel="Clear override"
                    />
                  </div>
                );
              })}
            </div>

            {configErr ? (
              <div
                className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]"
                style={{
                  borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)",
                  background: "color-mix(in oklch, var(--rose) 10%, transparent)",
                  color: "var(--rose)",
                }}
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {configErr}
              </div>
            ) : null}

            <div className="flex items-center gap-3 pt-1">
              <Button variant="accent" onClick={saveConfig} disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Saving
                  </>
                ) : saved ? (
                  <>
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                    Saved
                  </>
                ) : (
                  <>
                    <Save className="mr-1.5 h-3.5 w-3.5" />
                    Apply config
                  </>
                )}
              </Button>
              <p className="text-[12px] text-[var(--mute)]">
                Changes apply immediately in memory and persist to <code className="font-mono">configs/settings.yaml</code>.
              </p>
            </div>
          </section>
        ) : null}

        {activeTab === "browser" ? (
          <section className="space-y-4">
            <SectionHeader>Browser Engine</SectionHeader>
            <p className="text-[13.5px] text-[var(--mute)]">
              Switch the active automation backend and tune engine-specific launch behavior for the next browser session.
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              {BROWSER_OPTIONS.map((engine) => (
                <button
                  key={engine.id}
                  type="button"
                  onClick={() => {
                    setBrowserEngine(engine.id);
                    setBrowserSettingsTab(engine.id);
                  }}
                  className="w-full rounded-[14px] border p-4 text-left transition-colors"
                  style={browserEngine === engine.id
                    ? {
                        borderColor: "color-mix(in oklch, var(--signal) 55%, transparent)",
                        background: "color-mix(in oklch, var(--signal) 9%, transparent)",
                      }
                    : { borderColor: "var(--line)", background: "var(--card)" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-[var(--ink)]">{engine.name}</span>
                    {browserEngine === engine.id ? <Badge tone="signal">Active</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-[12px] text-[var(--mute)]">{engine.note}</p>
                </button>
              ))}
            </div>

            <MiniSegment
              active={browserSettingsTab}
              onChange={setBrowserSettingsTab}
              options={BROWSER_OPTIONS.map((item) => ({ id: item.id, label: item.name }))}
            />

            <div
              className="space-y-4 rounded-[14px] border p-4"
              style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
            >
              <div className="flex items-center gap-2">
                <Wrench className="h-3.5 w-3.5" style={{ color: "var(--signal)" }} />
                <span className="text-[13px] font-medium text-[var(--ink)]">
                  {BROWSER_OPTIONS.find((item) => item.id === browserSettingsTab)?.name} runtime
                </span>
              </div>

              <div
                className="rounded-[12px] border px-3 py-3 text-[12px]"
                style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.02)" }}
              >
                <div className="font-medium text-[var(--ink)]">Fingerprint policy</div>
                <p className="mt-1 text-[12px] text-[var(--mute)]">
                  {browserSettingsTab === "playwright"
                    ? "This Playwright runtime is currently Chromium-backed. We keep Playwright fingerprints Chrome-aligned on purpose because spoofing Firefox on a Chromium engine is easier to flag than a coherent real-Chrome profile."
                    : "Puppeteer fingerprints are now aligned to the actual launched Chrome version first, then fall back to official stable metadata only when the live version cannot be detected."}
                </p>
              </div>

              <SectionHeader>Fingerprint</SectionHeader>
              <div className="grid gap-4 sm:grid-cols-2">
                <BrowserRuntimeInput
                  label="Launch timeout (ms)"
                  value={String(activeBrowserRuntime.launch_timeout_ms ?? "")}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "launch_timeout_ms", Number.parseInt(value || "0", 10) || 0)}
                  type="number"
                  min="1000"
                  step="1000"
                  description="How long the browser gets to launch before the session is abandoned."
                />
                <BrowserRuntimeSelect
                  label="Fingerprint rotation"
                  value={activeBrowserRuntime.fingerprint_rotation_mode || "origin"}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "fingerprint_rotation_mode", value)}
                  options={[
                    { value: "origin", label: "Origin", description: "Reuse a fingerprint until the site origin changes." },
                    { value: "page", label: "Per page", description: "Rotate before every page acquisition." },
                    { value: "interval", label: "Timed", description: "Rotate after the configured time or max uses." },
                    { value: "never", label: "Disabled", description: "Keep the same fingerprint for the session." },
                  ]}
                  placeholder="Select mode"
                  description="Controls when the runtime refreshes the browser fingerprint and user-agent bundle."
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <BrowserRuntimeSelect
                  label="Fingerprint fallback"
                  value={activeBrowserRuntime.fingerprint_fallback_strategy || "profile"}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "fingerprint_fallback_strategy", value)}
                  options={[
                    { value: "profile", label: "Coherent profile", description: "Fallback to a real Chrome header + JS profile." },
                    { value: "none", label: "Skip", description: "Do nothing extra if generator or injector fails." },
                  ]}
                  placeholder="Select fallback"
                  description="Recommended: keep a coherent Chrome identity even when the full fingerprint injector path fails."
                />
                <BrowserRuntimeInput
                  label="Rotation interval (ms)"
                  value={String(activeBrowserRuntime.fingerprint_rotation_interval_ms ?? "")}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "fingerprint_rotation_interval_ms", Number.parseInt(value || "0", 10) || 0)}
                  type="number"
                  min="1000"
                  step="1000"
                  description="Upper bound on how long a fingerprint can stay active in timed mode."
                />
                <BrowserRuntimeInput
                  label="Max fingerprint uses"
                  value={String(activeBrowserRuntime.fingerprint_rotation_max_uses ?? "")}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "fingerprint_rotation_max_uses", Number.parseInt(value || "0", 10) || 0)}
                  type="number"
                  min="1"
                  step="1"
                  description="Rotate once a fingerprint has been reused this many times."
                />
                <BrowserRuntimeInput
                  label="Recent pool size"
                  value={String(activeBrowserRuntime.fingerprint_recent_pool_size ?? "")}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "fingerprint_recent_pool_size", Number.parseInt(value || "0", 10) || 0)}
                  type="number"
                  min="1"
                  step="1"
                  description="Avoid immediately reusing fingerprints that are still in the recent history pool."
                />
              </div>

              <SectionHeader>Proxy Rotation</SectionHeader>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <ToggleRow
                  label="Enable proxy pool"
                  checked={!!activeBrowserRuntime.proxy_enabled}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "proxy_enabled", value)}
                  description="Turn on remote/custom proxy loading, validation, rotation, and fallback handling for isolated browser sessions."
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <BrowserRuntimeSelect
                  label="Source mode"
                  value={activeBrowserRuntime.proxy_source_mode || "hybrid"}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "proxy_source_mode", value)}
                  options={[
                    { value: "hybrid", label: "Hybrid", description: "Use custom proxies first, then remote lists." },
                    { value: "remote", label: "Remote only", description: "Pull candidates from built-in or custom URLs only." },
                    { value: "custom", label: "Custom only", description: "Only use the proxies you entered manually." },
                  ]}
                  placeholder="Select source mode"
                  description="Where the runtime should pull candidate proxies from."
                />
                <BrowserRuntimeSelect
                  label="Rotation mode"
                  value={activeBrowserRuntime.proxy_rotation_mode || "session"}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "proxy_rotation_mode", value)}
                  options={[
                    { value: "session", label: "Per session", description: "Start each new isolated session from the next candidate." },
                    { value: "sticky", label: "Sticky", description: "Prefer the last known working proxy until it fails." },
                    { value: "failure", label: "On failure", description: "Retry the last good proxy first, then move on if needed." },
                    { value: "never", label: "Always first", description: "Always begin from the first candidate in the ordered list." },
                  ]}
                  placeholder="Select rotation mode"
                  description="How proxy selection advances between sessions."
                />
                <BrowserRuntimeSelect
                  label="Selection order"
                  value={activeBrowserRuntime.proxy_selection_strategy || "ordered"}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "proxy_selection_strategy", value)}
                  options={[
                    { value: "ordered", label: "Ordered", description: "Respect the source order exactly." },
                    { value: "random", label: "Random", description: "Shuffle candidates before trying them." },
                  ]}
                  placeholder="Select order"
                  description="Whether candidate proxies are tried in source order or shuffled first."
                />
                <BrowserRuntimeSelect
                  label="Fallback strategy"
                  value={activeBrowserRuntime.proxy_fallback_strategy || "direct"}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "proxy_fallback_strategy", value)}
                  options={[
                    { value: "direct", label: "Direct browser", description: "If every proxy fails, continue without a proxy." },
                    { value: "fail", label: "Fail closed", description: "Do not fall back to the shared direct browser." },
                  ]}
                  placeholder="Select fallback"
                  description="What happens after every candidate has failed validation."
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <BrowserRuntimeInput
                  label="Fetch timeout (ms)"
                  value={String(activeBrowserRuntime.proxy_fetch_timeout_ms ?? "")}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "proxy_fetch_timeout_ms", Number.parseInt(value || "0", 10) || 0)}
                  type="number"
                  min="1000"
                  step="1000"
                  description="Time budget for downloading each remote proxy source."
                />
                <BrowserRuntimeInput
                  label="Validation timeout (ms)"
                  value={String(activeBrowserRuntime.proxy_validation_timeout_ms ?? "")}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "proxy_validation_timeout_ms", Number.parseInt(value || "0", 10) || 0)}
                  type="number"
                  min="1000"
                  step="1000"
                  description="How long a candidate gets to load the validation URL before it is marked bad."
                />
                <BrowserRuntimeInput
                  label="Source cache TTL (ms)"
                  value={String(activeBrowserRuntime.proxy_cache_ttl_ms ?? "")}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "proxy_cache_ttl_ms", Number.parseInt(value || "0", 10) || 0)}
                  type="number"
                  min="1000"
                  step="1000"
                  description="How long remote source downloads stay cached before the runtime refreshes them."
                />
                <BrowserRuntimeInput
                  label="Max candidates"
                  value={String(activeBrowserRuntime.proxy_max_candidates ?? "")}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "proxy_max_candidates", Number.parseInt(value || "0", 10) || 0)}
                  type="number"
                  min="1"
                  step="1"
                  description="Upper bound on how many proxies are loaded into the candidate pool at once."
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <BrowserRuntimeInput
                  label="Validation URL"
                  value={String(activeBrowserRuntime.proxy_test_url ?? "")}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "proxy_test_url", value)}
                  placeholder="https://api.ipify.org?format=json"
                  description="A lightweight URL used to confirm that a proxy can actually open pages before the session is handed to tools."
                />
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
                    Built-in sources
                  </label>
                  <div
                    className="rounded-[12px] border px-3 py-2.5 text-[12px]"
                    style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.2)", color: "var(--ink-dim)" }}
                  >
                    {proxySourceReference}
                  </div>
                  <FieldNote>Reference only. Use the source-order field below to choose which built-in source IDs are tried.</FieldNote>
                </div>
              </div>

              <BrowserRuntimeTextarea
                label="Proxy source order"
                value={(activeBrowserRuntime.proxy_source_order || []).join(", ")}
                onChange={(value) => updateBrowserRuntimeList(browserSettingsTab, "proxy_source_order", value)}
                placeholder="openproxylist-https, openproxylist-socks5, speedx-http, speedx-socks5"
                description="Comma-separated built-in source IDs or raw .txt URLs. Available IDs: openproxylist-https, openproxylist-socks4, openproxylist-socks5, speedx-http, speedx-socks4, speedx-socks5."
              />

              <BrowserRuntimeTextarea
                label="Custom proxy list"
                value={(activeBrowserRuntime.proxy_custom_list || []).join(", ")}
                onChange={(value) => updateBrowserRuntimeList(browserSettingsTab, "proxy_custom_list", value)}
                placeholder="http://user:pass@1.2.3.4:8080, socks5://5.6.7.8:1080, 9.9.9.9:3128"
                description="Manual proxies to prepend when source mode includes custom. Supports scheme://user:pass@host:port and bare host:port entries."
              />

              <SectionHeader>Launch And Blocking</SectionHeader>
              <BrowserRuntimeTextarea
                label="Extra launch args"
                value={(activeBrowserRuntime.extra_launch_args || []).join(", ")}
                onChange={(value) => updateBrowserRuntimeList(browserSettingsTab, "extra_launch_args", value)}
                placeholder="--disable-web-security, --lang=en-US"
                description="Extra Chromium flags appended at launch. Keep these minimal so the browser still looks normal."
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <BrowserRuntimeInput
                  label="Adblock allowlist hosts"
                  value={(activeBrowserRuntime.adblock_allowlist_hosts || []).join(", ")}
                  onChange={(value) => updateBrowserRuntimeList(browserSettingsTab, "adblock_allowlist_hosts", value)}
                  placeholder="example.com, cdn.example.com"
                  description="Hosts that should bypass blocking even when adblock is enabled."
                />
                <BrowserRuntimeInput
                  label="Excluded adblock categories"
                  value={(activeBrowserRuntime.adblock_excluded_categories || []).join(", ")}
                  onChange={(value) => updateBrowserRuntimeList(browserSettingsTab, "adblock_excluded_categories", value)}
                  placeholder="nsfw, gambling"
                  description="Filter categories to leave disabled when the blocker is active."
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <ToggleRow
                  label="Enable adblock"
                  checked={!!activeBrowserRuntime.adblock_enabled}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "adblock_enabled", value)}
                  description="Attach the request blocker for this browser runtime."
                />
                <ToggleRow
                  label="Auto recovery"
                  checked={!!activeBrowserRuntime.adblock_auto_recovery_enabled}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "adblock_auto_recovery_enabled", value)}
                  description="Disable blocking temporarily when player or iframe requests look broken."
                />
                <ToggleRow
                  label="Recover on abort"
                  checked={!!activeBrowserRuntime.adblock_auto_recovery_on_abort}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "adblock_auto_recovery_on_abort", value)}
                  description="Treat aborted player requests as a recovery trigger as well."
                />
                <ToggleRow
                  label="Retry after recovery"
                  checked={!!activeBrowserRuntime.adblock_auto_recovery_retry}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "adblock_auto_recovery_retry", value)}
                  description="Reload the page after disabling blocking so media requests can retry."
                />
                <ToggleRow
                  label="Iframe sandbox patch"
                  checked={!!activeBrowserRuntime.iframe_sandbox_patch_enabled}
                  onChange={(value) => updateBrowserRuntime(browserSettingsTab, "iframe_sandbox_patch_enabled", value)}
                  description="Loosen likely player iframe sandbox restrictions that often block playback or stream discovery."
                />
                {browserSettingsTab === "puppeteer" ? (
                  <ToggleRow
                    label="uBOL extension"
                    checked={!!browserRuntime.puppeteer?.ubol_enabled}
                    onChange={(value) => updateBrowserRuntime("puppeteer", "ubol_enabled", value)}
                    description="Load the bundled uBlock Origin Lite extension if it exists on disk."
                  />
                ) : null}
                {browserSettingsTab === "puppeteer" ? (
                  <ToggleRow
                    label="Stream CORS patch"
                    checked={!!browserRuntime.puppeteer?.stream_cors_patch_enabled}
                    onChange={(value) => updateBrowserRuntime("puppeteer", "stream_cors_patch_enabled", value)}
                    description="Force CORS-style headers on stream requests. Useful only for specific broken sites and easy to over-apply."
                  />
                ) : null}
                {browserSettingsTab === "puppeteer" ? (
                  <ToggleRow
                    label="Include stream credentials"
                    checked={!!browserRuntime.puppeteer?.stream_cors_include_credentials}
                    onChange={(value) => updateBrowserRuntime("puppeteer", "stream_cors_include_credentials", value)}
                    description="Include credentials when the stream CORS patch is active. Leave off unless the target site explicitly needs it."
                  />
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === "evaluation" ? (
          <section className="space-y-6">
            <div>
              <SectionHeader>DeepEval Configuration</SectionHeader>
              <p className="mt-1.5 text-[13.5px] text-[var(--mute)]">
                Configure the judge LLM used by DeepEval for metric evaluation (hallucination, answer relevancy, faithfulness, etc.).
              </p>
            </div>

            <div
              className="space-y-5 rounded-[14px] border p-4"
              style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
            >
              <div className="flex items-center gap-2">
                <Settings2 className="h-3.5 w-3.5" style={{ color: "var(--signal)" }} />
                <span className="text-[13.5px] font-medium text-[var(--ink)]">Judge model</span>
              </div>
              <p className="text-[12.5px] text-[var(--mute)]">
                DeepEval uses a separate LLM to score your pipeline outputs. This model should be capable and accurate — GPT-4o or Claude Sonnet are recommended.
              </p>

              <div className="grid gap-4 sm:grid-cols-2">
                <Select
                  label="Provider"
                  value={deepevalProvider}
                  onChange={setDeepevalProvider}
                  options={[
                    { value: "openai",    label: "OpenAI",        description: "GPT-4o, GPT-4o-mini, etc." },
                    { value: "anthropic", label: "Anthropic",     description: "Claude Opus, Sonnet, Haiku" },
                    { value: "google",    label: "Google Gemini", description: "Gemini 2.5 Pro / Flash" },
                    { value: "openrouter",label: "OpenRouter",    description: "Any model via OpenRouter" },
                  ]}
                  placeholder="Select provider"
                />
                <Input
                  label="Model ID"
                  value={deepevalModel}
                  onChange={(e) => setDeepevalModel(e.target.value)}
                  placeholder="gpt-4o"
                  className="font-mono"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
                    Judge temperature
                  </label>
                  <input
                    value={deepevalTemperature}
                    onChange={(e) => setDeepevalTemperature(e.target.value)}
                    type="number"
                    min="0"
                    max="2"
                    step="0.05"
                    className="h-11 w-full rounded-[12px] border px-3 text-[13px] focus:outline-none"
                    style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.2)", color: "var(--ink-dim)" }}
                  />
                  <p className="text-[11px] text-[var(--mute)]">Lower is more deterministic. 0 is recommended for evaluation consistency.</p>
                </div>
              </div>
            </div>

            <div
              className="rounded-[14px] border p-4"
              style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.02)" }}
            >
              <div className="mb-3 text-[13px] font-medium text-[var(--ink)]">Quick-start commands</div>
              <div className="space-y-2 font-mono text-[12px]" style={{ color: "var(--ink-dim)" }}>
                {[
                  "pip install deepeval",
                  "deepeval login",
                  "deepeval test run tests/test_model.py",
                ].map((cmd) => (
                  <div key={cmd} className="flex items-center gap-3 rounded-[8px] border px-3 py-2" style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.2)" }}>
                    <span style={{ color: "var(--signal)", userSelect: "none" }}>$</span>
                    <span>{cmd}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button variant="accent" onClick={saveConfig} disabled={saving}>
                {saving ? (
                  <><span className="owc-spinner owc-spinner-sm" />Saving</>
                ) : saved ? (
                  <><Check className="mr-1.5 h-3.5 w-3.5" />Saved</>
                ) : (
                  <><Save className="mr-1.5 h-3.5 w-3.5" />Save evaluation config</>
                )}
              </Button>
            </div>
          </section>
        ) : null}

        {activeTab === "mcp-tools" ? (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <SectionHeader>MCP Tools</SectionHeader>
              <span className="text-[11px]" style={{ color: "var(--mute)" }}>
                Disabled tools are excluded from the selected browser profile at runtime
              </span>
            </div>

            <MiniSegment
              active={activeMcpBrowserTab}
              onChange={setActiveMcpBrowserTab}
              options={BROWSER_OPTIONS.map((item) => ({
                id: item.id,
                label: item.name,
                badge: Object.keys(MCP_TOOLS_BY_PROFILE).reduce((count, profile) => {
                  return count + (disabledToolsByBrowserProfile[item.id]?.[profile]?.length || 0);
                }, 0) || "",
              }))}
            />

            <MiniSegment
              active={activeProfileTab}
              onChange={setActiveProfileTab}
              options={Object.keys(MCP_TOOLS_BY_PROFILE).map((profile) => ({
                id: profile,
                label: PROFILE_LABELS[profile],
                badge: (disabledToolsByBrowserProfile[activeMcpBrowserTab]?.[profile]?.length || 0) || "",
              }))}
            />

            <div
              className="rounded-[14px] border p-4"
              style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wrench className="h-3.5 w-3.5" style={{ color: "var(--signal)" }} />
                  <span className="text-[13px] font-medium" style={{ color: "var(--ink)" }}>
                    {BROWSER_OPTIONS.find((item) => item.id === activeMcpBrowserTab)?.name} - {PROFILE_LABELS[activeProfileTab]}
                  </span>
                  <span className="font-mono text-[11px]" style={{ color: "var(--mute)" }}>
                    {MCP_TOOLS_BY_PROFILE[activeProfileTab].length - activeBrowserTools().length}
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
                      border: "1px solid color-mix(in oklch, var(--mint) 25%, transparent)",
                      background: "color-mix(in oklch, var(--mint) 8%, transparent)",
                    }}
                    onClick={() => setDisabledToolsForCurrentBrowserProfile([])}
                  >
                    Enable all
                  </button>
                  <button
                    type="button"
                    className="rounded-lg px-2.5 py-1 text-[11px] transition-colors"
                    style={{ color: "var(--mute)", border: "1px solid var(--line)" }}
                    onClick={() => setDisabledToolsForCurrentBrowserProfile(MCP_TOOLS_BY_PROFILE[activeProfileTab])}
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
                          ? currentDisabled.filter((item) => item !== toolName)
                          : [...currentDisabled, toolName];
                        setDisabledToolsForCurrentBrowserProfile(nextDisabled);
                      }}
                      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-[11px] transition-all duration-150"
                      style={disabled
                        ? {
                            background: "rgba(255,255,255,0.02)",
                            color: "var(--mute-3)",
                            border: "1px solid var(--line)",
                            textDecoration: "line-through",
                            opacity: 0.55,
                          }
                        : {
                            background: "color-mix(in oklch, var(--sky) 10%, transparent)",
                            color: "var(--sky)",
                            border: "1px solid color-mix(in oklch, var(--sky) 25%, transparent)",
                          }}
                    >
                      {disabled ? (
                        <ToggleLeft className="h-3 w-3 shrink-0" style={{ color: "var(--mute-3)" }} />
                      ) : (
                        <ToggleRight className="h-3 w-3 shrink-0" />
                      )}
                      {toolName}
                    </button>
                  );
                })}
              </div>

              <p className="mt-3 text-[11.5px]" style={{ color: "var(--mute)" }}>
                Tool visibility is now tracked independently for Puppeteer and Playwright.
              </p>
            </div>
          </section>
        ) : null}

        {activeTab === "api-keys" ? (
          <section className="space-y-3">
            <SectionHeader>API Key Status</SectionHeader>
            <div
              className="divide-y overflow-hidden rounded-[14px] border"
              style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
            >
              {PROVIDERS.map((item) => (
                <div key={item.id} className="flex items-center justify-between px-[18px] py-3" style={{ borderColor: "var(--line)" }}>
                  <div>
                    <div className="text-[13px] font-medium text-[var(--ink)]">{item.name}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-[var(--mute)]">{item.keyEnv}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <KeyStatus set={apiKeys[item.id]} />
                    {!apiKeys[item.id] ? (
                      <span className="text-[11px] text-[var(--mute)]">Add to .env and rebuild the container</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {activeTab === "notifications" ? (
          <section className="space-y-4">
            <SectionHeader>Notification Preferences</SectionHeader>
            <p className="text-[13.5px]" style={{ color: "var(--mute)" }}>
              Choose which pipeline events trigger toast notifications. Tool call events are never notified.
            </p>
            <div
              className="divide-y overflow-hidden rounded-[14px] border"
              style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
            >
              {NOTIF_EVENTS.map(({ key, label, note }) => (
                <label
                  key={key}
                  className="group flex cursor-pointer items-center justify-between gap-4 px-[18px] py-3.5"
                  style={{ borderColor: "var(--line)" }}
                >
                  <div>
                    <div className="text-[13px] font-medium" style={{ color: "var(--ink)" }}>{label}</div>
                    <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--mute)" }}>{note}</div>
                  </div>
                  <div
                    className="relative h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200"
                    style={{
                      background: notifPrefs[key]
                        ? "color-mix(in oklch, var(--signal) 55%, transparent)"
                        : "var(--mute-3)",
                      border: `1px solid ${notifPrefs[key]
                        ? "color-mix(in oklch, var(--signal) 40%, transparent)"
                        : "var(--line)"}`,
                    }}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={!!notifPrefs[key]}
                      onChange={(event) => setNotifPrefs({ ...notifPrefs, [key]: event.target.checked })}
                    />
                    <span
                      className="absolute top-0.5 h-4 w-4 rounded-full shadow transition-all duration-200"
                      style={{
                        background: notifPrefs[key] ? "var(--signal)" : "var(--mute-2)",
                        left: notifPrefs[key] ? "calc(100% - 18px)" : "2px",
                      }}
                    />
                  </div>
                </label>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {config ? (
        <section className="space-y-3">
          <SectionHeader>Active Config</SectionHeader>
          <JsonViewer label="Config" value={config} />
        </section>
      ) : null}
    </div>
  );
}
