"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  Cpu,
  Globe,
  Key,
  Layers,
  Loader2,
  Monitor,
  Search,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useNotifPrefs } from "@/components/notification-provider";
import {
  RunViewSettingsPanel,
  useRunViewSettings,
} from "@/components/run-view-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { HelpIcon } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, apiUrl } from "@/lib/api";
import { BrowserTab } from "./tabs/browser-tab";
import {
  BROWSER_RUNTIME_KEYS,
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

const MCP_TOOL_META = {
  navigate: { label: "navigate", desc: "Load a URL in the browser tab", category: "Navigation" },
  inspect: { label: "inspect", desc: "Read the current page DOM structure", category: "Inspection" },
  inspect_landing: { label: "inspect_landing", desc: "Read DOM for landing-page analysis", category: "Inspection" },
  inspect_hosting: { label: "inspect_hosting", desc: "Read DOM for hosting-page extraction", category: "Inspection" },
  inspect_embedded: { label: "inspect_embedded", desc: "Read DOM for embedded-player detection", category: "Inspection" },
  interact: { label: "interact", desc: "Generic page interaction dispatcher", category: "Interaction" },
  screenshot: { label: "screenshot", desc: "Capture a browser screenshot", category: "Inspection" },
  memory_lookup: { label: "memory_lookup", desc: "Retrieve data from agent memory store", category: "Memory" },
  memory_update: { label: "memory_update", desc: "Write data to agent memory store", category: "Memory" },
  open_url: { label: "open_url", desc: "Open a URL in a new or existing tab", category: "Navigation" },
  get_page_context: { label: "get_page_context", desc: "Return page title, URL, and meta tags", category: "Inspection" },
  get_frame_tree: { label: "get_frame_tree", desc: "List all frames and iframes on the page", category: "Inspection" },
  query_elements: { label: "query_elements", desc: "CSS/XPath element query with counts", category: "Inspection" },
  get_element_detail: { label: "get_element_detail", desc: "Deep detail on a single DOM element", category: "Inspection" },
  scroll_page: { label: "scroll_page", desc: "Scroll the page by amount or to element", category: "Navigation" },
  scroll_to_element: { label: "scroll_to_element", desc: "Scroll until an element is in view", category: "Navigation" },
  go_back: { label: "go_back", desc: "Navigate to previous page in history", category: "Navigation" },
  wait_for_page_state: { label: "wait_for_page_state", desc: "Wait for load/networkidle/selector", category: "Navigation" },
  click_element: { label: "click_element", desc: "Click a DOM element by selector", category: "Interaction" },
  click_css: { label: "click_css", desc: "Click by CSS selector", category: "Interaction" },
  click_text: { label: "click_text", desc: "Click element matching visible text", category: "Interaction" },
  click_xpath: { label: "click_xpath", desc: "Click element matching XPath expression", category: "Interaction" },
  click_checkbox: { label: "click_checkbox", desc: "Toggle a checkbox element", category: "Interaction" },
  click_radio: { label: "click_radio", desc: "Select a radio button", category: "Interaction" },
  click_coordinates: { label: "click_coordinates", desc: "Click at (x, y) pixel coordinates", category: "Interaction" },
  type_into: { label: "type_into", desc: "Type text into an input or textarea", category: "Interaction" },
  select_option: { label: "select_option", desc: "Choose an option from a <select>", category: "Interaction" },
  play_media: { label: "play_media", desc: "Start playback of a media element", category: "Media" },
  swipe_region: { label: "swipe_region", desc: "Swipe gesture over a screen region", category: "Interaction" },
  harvest: { label: "harvest", desc: "Extract structured media data from page", category: "Media" },
  get_media_state: { label: "get_media_state", desc: "Read playback state of a media element", category: "Media" },
  capture_streams: { label: "capture_streams", desc: "Intercept and record network media streams", category: "Media" },
};

const BROWSER_OPTIONS = [
  {
    id: "playwright",
    name: "Playwright",
    note: "Default stack: stronger context isolation, iframe recovery, persistent contexts",
  },
];

const SETTINGS_TABS = [
  { id: "models", label: "Google Models" },
  { id: "browser", label: "Browser" },
  { id: "display", label: "Display" },
  { id: "api-keys", label: "API Keys" },
  { id: "notifications", label: "Notifications" },
  { id: "mcp-tools", label: "MCP Tools" },
];

const SETTINGS_TAB_ICONS = {
  models: Cpu,
  browser: Globe,
  display: Monitor,
  "api-keys": Key,
  notifications: Bell,
  "mcp-tools": Layers,
};

const TAB_DETAILS = {
  models: {
    title: "Google Models",
    description:
      "Assign live Google models, inspect direct-from-Google defaults, and verify what the runtime actually applies.",
    storage: "server",
    saveLabel: "Save model settings",
  },
  browser: {
    title: "Browser Runtime",
    description:
      "Choose the default engine and tune browsing behavior: blocker handling, popup control, iframe recovery, and reliable media capture.",
    storage: "server",
    saveLabel: "Save browser settings",
  },
  display: {
    title: "Run Display",
    description:
      "Control what appears on run detail pages and how aggressively the UI refreshes in this browser.",
    storage: "browser",
  },
  "api-keys": {
    title: "Gemini API Key",
    description:
      "See whether the Gemini API key is configured and ready for live model calls.",
    storage: "readonly",
  },
  notifications: {
    title: "Notifications",
    description:
      "Choose which pipeline milestones trigger toast notifications in this browser.",
    storage: "browser",
  },
  "mcp-tools": {
    title: "MCP Tool Availability",
    description:
      "Enable or disable browser tools independently for each agent profile and browser backend.",
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

const MODEL_WORKSPACE_VIEWS = [
  { id: "assignments", label: "Assignments" },
  { id: "runtime", label: "Runtime Controls" },
  { id: "catalog", label: "Catalog & Costs" },
];

const BROWSER_RUNTIME_DEFAULTS = {
  launch_timeout_ms: 45000,
  extra_launch_args: [],
  adblock_allowlist_hosts: [],
  streaming_safe_mode: "adaptive",
  asset_diagnostics_enabled: true,
  popup_blocking_enabled: true,
  ubol_enabled: true,
  iframe_sandbox_patch_enabled: true,
  iframe_auto_recovery_enabled: true,
  iframe_recovery_timeout_ms: 20000,
  media_capture_timeout_ms: 45000,
  media_cors_patch_enabled: false,
  media_playback_verification_enabled: true,
};

const DEFAULT_BROWSER_RUNTIME = {
  playwright: {
    ...BROWSER_RUNTIME_DEFAULTS,
    stream_cors_patch_enabled: false,
    stream_cors_include_credentials: false,
  },
};

function cloneBrowserRuntime() {
  return {
    playwright: {
      ...DEFAULT_BROWSER_RUNTIME.playwright,
      extra_launch_args: [
        ...DEFAULT_BROWSER_RUNTIME.playwright.extra_launch_args,
      ],
      adblock_allowlist_hosts: [
        ...DEFAULT_BROWSER_RUNTIME.playwright.adblock_allowlist_hosts,
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
    const normalizedProvider = String(
      row?.provider || defaults[id].provider || fallbackProvider,
    ).toLowerCase();
    next[id] = {
      provider: normalizedProvider === "google" ? "google" : fallbackProvider,
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
    const picked = {};
    BROWSER_RUNTIME_KEYS.forEach((key) => {
      if (current[key] !== undefined) picked[key] = current[key];
    });
    base[id] = {
      ...base[id],
      ...picked,
      extra_launch_args: normalizeStringList(
        picked.extra_launch_args,
        base[id].extra_launch_args,
      ),
      adblock_allowlist_hosts: normalizeStringList(
        picked.adblock_allowlist_hosts,
        base[id].adblock_allowlist_hosts,
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

function getModelDefaultValue(modelMeta, fieldKey) {
  return modelMeta?.default_parameters?.[fieldKey];
}

function getModelCapabilities(modelMeta) {
  return modelMeta?.capabilities || {};
}

function formatParameterValue(value) {
  if (value === "" || value == null) return "Not set";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value.toLocaleString();
    return Number(value).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  return String(value);
}

function formatTokenCount(value) {
  if (!Number.isFinite(Number(value))) return "Unknown";
  return Number(value).toLocaleString();
}

function releaseChannelTone(channel) {
  if (channel === "stable") return "success";
  if (channel === "preview") return "warning";
  return "default";
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
  if (source === "saved_catalog") return "ok";
  if (source === "fallback_catalog") return "warn";
  if (source === "unavailable") return "error";
  return "warn";
}

function sourceLabel(source) {
  if (source === "provider_api") return "Live provider catalog";
  if (source === "saved_catalog") return "Saved Google snapshot";
  if (source === "fallback_catalog") return "Fallback catalog";
  if (source === "unverified_manual") return "Manual model ID";
  if (source === "unavailable") return "Catalog unavailable";
  return "Stored catalog";
}

function provenanceLabel(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "Unknown";
  return normalized;
}

function capabilityTone(status) {
  if (status === "supported") return "success";
  if (status === "unsupported") return "warning";
  if (status === "unverified") return "default";
  return "default";
}

function capabilityStatusLabel(value, fallback = "Unavailable") {
  if (value === true || value === "supported") return "Supported";
  if (value === false || value === "unsupported") return fallback;
  if (value === "unverified") return "Unverified";
  return fallback;
}

function buildCompatibilityWarnings({
  thinkingEnabled,
  explicitCacheEnabled,
  selections,
  catalogModels,
}) {
  const catalogMap = new Map(
    (catalogModels || []).map((model) => [String(model.id || "").toLowerCase(), model]),
  );
  const warnings = [];
  (selections || []).forEach((selection) => {
    const modelId = String(selection?.selection?.model || "").trim();
    if (!modelId) return;
    const modelMeta = catalogMap.get(modelId.toLowerCase()) || null;
    const capabilities = getModelCapabilities(modelMeta);
    const label = selection?.label || selection?.id || "Agent";
    const status = modelMeta ? "verified" : "unverified";
    if (thinkingEnabled && modelMeta && capabilities.supports_thinking_controls === false) {
      warnings.push({
        id: `${selection.id}-thinking`,
        tone: "warning",
        message: `${label} uses ${modelId}; thinking controls will be ignored for this model.`,
      });
    } else if (thinkingEnabled && !modelMeta) {
      warnings.push({
        id: `${selection.id}-thinking-unverified`,
        tone: "default",
        message: `${label} uses ${modelId}; thinking support is unverified until Google returns metadata for it.`,
      });
    }
    if (explicitCacheEnabled && modelMeta && capabilities.supports_explicit_cache === false) {
      warnings.push({
        id: `${selection.id}-cache`,
        tone: "warning",
        message: `${label} uses ${modelId}; explicit cache is unavailable for this model.`,
      });
    } else if (explicitCacheEnabled && !modelMeta && status === "unverified") {
      warnings.push({
        id: `${selection.id}-cache-unverified`,
        tone: "default",
        message: `${label} uses ${modelId}; explicit cache support is unverified until Google returns metadata for it.`,
      });
    }
  });
  return warnings;
}

function pricingStatusTone(status) {
  if (!status) return "default";
  if (status.model_count > 0) return "success";
  if (status.api_key_set) return "warning";
  return "default";
}

function KeyStatus({ set }) {
  return (
    <Badge tone={set ? "success" : "default"} className="gap-1 text-[11px]">
      {set ? <CheckCircle2 className="size-3" /> : <AlertCircle className="size-3" />}
      {set ? "set" : "not set"}
    </Badge>
  );
}

function SectionHeader({ children }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="shrink-0 text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground/80">
        {children}
      </h2>
      <Separator className="flex-1 opacity-70" />
    </div>
  );
}

function StatusPill({ tone = "neutral", children }) {
  const mappedTone = tone === "success" ? "success" : tone === "warning" ? "warning" : tone === "info" ? "signal" : "default";
  return (
    <Badge tone={mappedTone} className="px-2.5 py-1 text-[11px] font-medium">
      {children}
    </Badge>
  );
}

function ErrorNotice({ message }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span className="leading-relaxed">{message}</span>
    </div>
  );
}

function WarningNotice({ items = [] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={item.id || item.message}
          className={cn(
            "flex items-start gap-2 rounded-xl border px-4 py-3 text-[13px]",
            item.tone === "warning"
              ? "border-amber-300/50 bg-amber-100/50 text-amber-900"
              : "border-border/70 bg-muted/30 text-foreground",
          )}
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="leading-relaxed">{item.message}</span>
        </div>
      ))}
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
  const Icon = SETTINGS_TAB_ICONS[tabId] || SlidersHorizontal;

  return (
    <div className="rounded-[22px] border border-border/70 bg-gradient-to-br from-background via-background to-muted/20 p-5 shadow-[0_18px_48px_-30px_rgba(0,0,0,0.5)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-2xl border border-border/80 bg-background/80 text-foreground shadow-sm">
              <Icon className="size-4" />
            </span>
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
                Settings workspace
              </div>
              <h1 className="text-[23px] font-semibold tracking-tight text-foreground">{meta.title}</h1>
            </div>
          {dirty ? (
            <Badge tone="warning" className="px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">Unsaved</Badge>
          ) : isServerTab && saved ? (
            <Badge tone="success" className="gap-1 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">
              <Check className="size-3" />
              Saved
            </Badge>
          ) : null}
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{meta.description}</p>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <StatusPill tone={isServerTab ? "info" : "neutral"}>
              {isServerTab ? "Server-backed" : isBrowserTab ? "Saved in browser" : "Read only"}
            </StatusPill>
            {isBrowserTab ? (
              <StatusPill tone="neutral">Auto-saved locally</StatusPill>
            ) : null}
            {isServerTab && dirty && otherDirtyCount > 0 ? (
              <StatusPill tone="warning">
                {otherDirtyCount} other dirty tab{otherDirtyCount === 1 ? "" : "s"}
              </StatusPill>
            ) : null}
          </div>
        </div>

        {isServerTab ? (
          <Button variant="accent" onClick={onSave} disabled={saving || !dirty} className="min-w-[164px]">
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
    </div>
  );
}

function SettingsTabBar({ active, onChange, dirtyTabs = {}, mobile = false }) {
  return (
    <nav className={cn("gap-1.5", mobile ? "flex overflow-x-auto pb-1" : "flex flex-col")}>
      {mobile ? null : (
        <div className="mb-2 border-b px-2 pb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground/80">
          Configuration
        </div>
      )}
      {SETTINGS_TABS.map((tab) => {
        const isActive = active === tab.id;
        const isDirty = dirtyTabs[tab.id];
        const Icon = SETTINGS_TAB_ICONS[tab.id];
        const meta = TAB_DETAILS[tab.id];
        return (
          <Button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            variant={isActive ? "secondary" : "ghost"}
            className={cn(
              mobile
                ? "h-auto shrink-0 rounded-[14px] border px-3.5 py-2.5 text-left"
                : "h-auto w-full justify-between rounded-[14px] px-3 py-3 text-left",
              isActive
                ? "border-border bg-background text-foreground shadow-sm"
                : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-muted/30",
            )}
          >
            <span className={cn("flex gap-2.5", mobile ? "items-center" : "items-start")}>
              {Icon ? <Icon className="mt-0.5 size-[14px] shrink-0" /> : null}
              <span className="min-w-0">
                <span className="block text-[13px] font-medium leading-none">{tab.label}</span>
                {mobile ? null : (
                  <span className="mt-1 block text-[11px] font-normal leading-snug text-muted-foreground/80">
                    {meta?.storage === "server"
                      ? "Saved to runtime config"
                      : meta?.storage === "browser"
                        ? "Local browser preference"
                        : "Status only"}
                  </span>
                )}
              </span>
            </span>
            {isDirty ? (
              <span className="ml-2 size-2 shrink-0 rounded-full bg-primary" aria-label={`${tab.label} has unsaved changes`} />
            ) : null}
          </Button>
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
            className="h-11 border-[var(--line)] bg-muted/50 text-[13px] text-[var(--ink-dim)]"
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
    <Card className="rounded-[12px] border">
      <CardContent className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold text-foreground">{title}</div>
          {description ? <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p> : null}
        </div>
        {onClear ? (
          <Button
            type="button"
            onClick={onClear}
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-[11px]"
          >
            {clearLabel || "Clear"}
          </Button>
        ) : null}
      </div>
      <TuningFieldGrid fields={fields} values={values} onChange={onChange} />
      </CardContent>
    </Card>
  );
}

function ModelFact({ label, value, tone = "default" }) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-1 text-sm font-medium", tone === "primary" ? "text-primary" : "text-foreground")}>
        {value}
      </div>
    </div>
  );
}

function ParameterSummaryCard({ title, icon: Icon, tone = "default", rows = [] }) {
  return (
    <Card className="rounded-[14px] border">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-xl border",
              tone === "primary" ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-muted/40 text-foreground",
            )}
          >
            <Icon className="size-4" />
          </span>
          <div className="text-[13px] font-semibold text-foreground">{title}</div>
        </div>
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/70 px-3 py-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-foreground">{row.label}</div>
                {row.note ? (
                  <div className="text-[10px] text-muted-foreground">{row.note}</div>
                ) : null}
              </div>
              <div className="shrink-0 font-mono text-[11.5px] text-foreground">{row.value}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function MiniSegment({ options, active, onChange }) {
  return (
    <div className="flex w-full flex-wrap gap-1.5 rounded-[16px] border border-border/70 bg-muted/25 p-1.5">
      {options.map((option) => {
        const isActive = option.id === active;
        return (
          <Button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            variant={isActive ? "secondary" : "ghost"}
            size="sm"
            className={cn(
              "h-auto flex-1 rounded-[12px] px-3 py-2 text-[12.5px] font-medium sm:flex-none",
              isActive
                ? "border border-border bg-background text-foreground shadow-sm"
                : "text-muted-foreground",
            )}
          >
            {option.label}
            {option.badge ? (
              <Badge tone="danger" className="px-1.5 py-0.5 text-[9px] font-bold">{option.badge}</Badge>
            ) : null}
          </Button>
        );
      })}
    </div>
  );
}

function FieldNote({ children }) {
  if (!children) return null;
  return <p className="text-[11px] text-muted-foreground">{children}</p>;
}

function ToggleRow({ label, checked, onChange, description = "" }) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-card px-4 py-3 transition-colors",
        checked ? "border-primary/30 bg-primary/5" : ""
      )}
    >
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        className="mt-0.5 data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium leading-snug text-foreground">{label}</p>
        {description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

function CostEstimator({ provider, model }) {
  const [inputTokens, setInputTokens] = useState(1000);
  const [outputTokens, setOutputTokens] = useState(1000);
  const [cachedTokens, setCachedTokens] = useState(0);
  const [cacheWriteTokens, setCacheWriteTokens] = useState(0);
  const [costs, setCosts] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchCosts = useCallback(async () => {
    if (!provider || !model) return;
    setLoading(true);
    try {
      const response = await apiFetch(
        `/ui/settings/estimate-costs?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}&input_tokens=${inputTokens}&output_tokens=${outputTokens}&cached_input_tokens=${cachedTokens}&cache_write_input_tokens=${cacheWriteTokens}`,
      );
      setCosts(response);
    } catch (error) {
      console.error("Cost estimation error:", error);
    } finally {
      setLoading(false);
    }
  }, [provider, model, inputTokens, outputTokens, cachedTokens, cacheWriteTokens]);

  useEffect(() => {
    const timer = setTimeout(fetchCosts, 500);
    return () => clearTimeout(timer);
  }, [fetchCosts]);

  if (!provider || !model) {
    return null;
  }

  return (
    <Card className="rounded-[14px] border">
      <CardContent className="flex flex-col gap-4 p-4">
      <div className="text-[13px] font-medium text-foreground">Estimated Cost</div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Input
          label="Input tokens"
          type="number"
          min="0"
          step="100"
          value={inputTokens}
          onChange={(e) => setInputTokens(parseInt(e.target.value, 10) || 0)}
          className="h-9 border-[var(--line)] bg-muted/50 text-[12px] text-[var(--ink-dim)]"
        />

        <Input
          label="Output tokens"
          type="number"
          min="0"
          step="100"
          value={outputTokens}
          onChange={(e) => setOutputTokens(parseInt(e.target.value, 10) || 0)}
          className="h-9 border-[var(--line)] bg-muted/50 text-[12px] text-[var(--ink-dim)]"
        />

        <Input
          label="Cached tokens"
          type="number"
          min="0"
          step="100"
          value={cachedTokens}
          onChange={(e) => setCachedTokens(parseInt(e.target.value, 10) || 0)}
          className="h-9 border-[var(--line)] bg-muted/50 text-[12px] text-[var(--ink-dim)]"
        />

        <Input
          label="Cache write tokens"
          type="number"
          min="0"
          step="100"
          value={cacheWriteTokens}
          onChange={(e) => setCacheWriteTokens(parseInt(e.target.value, 10) || 0)}
          className="h-9 border-[var(--line)] bg-muted/50 text-[12px] text-[var(--ink-dim)]"
        />
      </div>

      {costs ? (
        <div className="grid gap-2 rounded-[10px] border bg-muted/20 p-3">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-muted-foreground">Input cost</span>
            <span className="font-mono text-foreground">
              ${costs.input_cost_usd.toFixed(6)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-muted-foreground">Cached read cost</span>
            <span className="font-mono text-foreground">
              ${(costs.cached_input_cost_usd || 0).toFixed(6)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-muted-foreground">Cache write cost</span>
            <span className="font-mono text-foreground">
              ${(costs.cache_write_cost_usd || 0).toFixed(6)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-muted-foreground">Output cost</span>
            <span className="font-mono text-foreground">
              ${costs.output_cost_usd.toFixed(6)}
            </span>
          </div>
          <Separator />
          <div className="flex items-center justify-between text-[12px] font-medium">
            <span className="text-foreground">Total</span>
            <span className="font-mono text-sm text-primary">
              ${costs.total_cost_usd.toFixed(6)}
            </span>
          </div>
          {costs.pricing_source &&
            costs.pricing_source !== "no_pricing_available" && (
              <p className="mt-2 text-[10px] text-muted-foreground">
                Pricing: {costs.pricing_source}
              </p>
            )}
          {provider === "google" ? (
            <p className="text-[10px] text-muted-foreground">
              Gemini cache storage retention charges are separate from token charges and are not included in this estimate.
            </p>
          ) : null}
          {costs.pricing_source === "no_pricing_available" && (
            <p className="mt-2 text-[10px] text-destructive">
              No pricing available for this model
            </p>
          )}
        </div>
      ) : null}
      </CardContent>
    </Card>
  );
}

function FieldGroup({ title, description, children, accent = null }) {
  return (
    <Card className="overflow-hidden rounded-[18px] border border-border/70 bg-card/95 shadow-[0_18px_48px_-36px_rgba(0,0,0,0.55)]">
      <div
        className="border-b px-5 py-4"
        style={{
          borderColor: "var(--line)",
          background: accent
            ? `linear-gradient(135deg, color-mix(in oklch, ${accent} 8%, transparent), rgba(255,255,255,0.015))`
            : "rgba(255,255,255,0.018)",
          boxShadow: accent ? `inset 3px 0 0 ${accent}` : "none",
        }}
      >
        <div className="text-[14px] font-semibold text-foreground">{title}</div>
        {description ? <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      <CardContent className="flex flex-col gap-4 p-5">{children}</CardContent>
    </Card>
  );
}

function CompactStat({ label, value, tone = "default" }) {
  return (
    <div
      className={cn(
        "rounded-[14px] border px-3.5 py-3",
        tone === "primary" ? "border-primary/20 bg-primary/5" : "border-border/70 bg-background/70",
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
        {label}
      </div>
      <div className={cn("mt-1 text-[14px] font-semibold", tone === "primary" ? "text-primary" : "text-foreground")}>
        {value}
      </div>
    </div>
  );
}

function SettingsWorkspaceCard({
  eyebrow = "",
  title,
  description = "",
  actions = null,
  className = "",
  children,
}) {
  return (
    <Card className={cn("overflow-hidden rounded-[20px] border border-border/70 bg-card/95 shadow-[0_18px_48px_-36px_rgba(0,0,0,0.55)]", className)}>
      {(eyebrow || title || description || actions) ? (
        <div className="border-b border-border/70 px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              {eyebrow ? (
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/75">
                  {eyebrow}
                </div>
              ) : null}
              {title ? <div className="text-[15px] font-semibold text-foreground">{title}</div> : null}
              {description ? <p className="max-w-2xl text-[12px] leading-relaxed text-muted-foreground">{description}</p> : null}
            </div>
            {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
        </div>
      ) : null}
      <CardContent className="p-5">{children}</CardContent>
    </Card>
  );
}

function AgentAssignmentGrid({ assignments = [], selectedModelId = "", onSelectModel = null }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {assignments.map((assignment) => {
        const modelId = assignment.selection?.model || "";
        const isSelected = selectedModelId && modelId === selectedModelId;
        return (
          <button
            key={assignment.id}
            type="button"
            onClick={() => {
              if (modelId && onSelectModel) onSelectModel(modelId);
            }}
            className={cn(
              "rounded-[16px] border px-3.5 py-3 text-left transition-colors",
              isSelected
                ? "border-primary/35 bg-primary/8"
                : "border-border/70 bg-background/55 hover:bg-muted/35",
              !modelId && "cursor-default hover:bg-background/55",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-foreground">{assignment.label}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{assignment.note}</div>
              </div>
              {isSelected ? <Badge tone="signal">selected</Badge> : null}
            </div>
            <div className="mt-3 space-y-2">
              <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Backend model</div>
                <div className="mt-1 truncate font-mono text-[11.5px] text-foreground">
                  {modelId || "Not set"}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <Badge tone="default" className="px-1.5 py-0.5 text-[9px]">
                  {assignment.selection?.provider || "google"}
                </Badge>
                {assignment.modelMeta?.context_window ? (
                  <span className="font-mono">{assignment.modelMeta.context_window.toLocaleString()} ctx</span>
                ) : null}
              </div>
            </div>
          </button>
        );
      })}
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
      className="h-9 border-[var(--line-hi)] bg-muted/30 text-[12.5px] text-[var(--ink)]"
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
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { prefs: notifPrefs, setPrefs: setNotifPrefs } = useNotifPrefs();

  const requestedTab = searchParams.get("tab") || "models";
  const activeTab = SETTINGS_TABS.some((tab) => tab.id === requestedTab)
    ? requestedTab
    : "models";

  function setActiveTab(nextTab) {
    if (nextTab === activeTab) return;

    const params = new URLSearchParams(searchParams.toString());
    if (nextTab === "models") params.delete("tab");
    else params.set("tab", nextTab);

    const query = params.toString();
    router.push(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
  }

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
  const [browserEngine, setBrowserEngine] = useState("playwright");
  const [browserSettingsTab, setBrowserSettingsTab] = useState("playwright");
  const [browserRuntime, setBrowserRuntime] = useState(cloneBrowserRuntime());
  const [disabledToolsByBrowserProfile, setDisabledToolsByBrowserProfile] =
    useState(normalizeDisabledToolsByBrowserProfile({}));
  const [activeMcpBrowserTab, setActiveMcpBrowserTab] = useState("playwright");
  const [activeProfileTab, setActiveProfileTab] = useState("classification");
  const [activeModelWorkspaceView, setActiveModelWorkspaceView] =
    useState("assignments");
  const [mcpToolQuery, setMcpToolQuery] = useState("");
  const [providerCatalogs, setProviderCatalogs] = useState({});
  const [catalogQuery, setCatalogQuery] = useState("");
  const [selectedCatalogModelId, setSelectedCatalogModelId] = useState("");
  const [catalogAssignmentTarget, setCatalogAssignmentTarget] = useState("global");
  const [catalogLoading, setCatalogLoading] = useState("");
  const [pricingStatus, setPricingStatus] = useState({});
  const [pricingSyncLoading, setPricingSyncLoading] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedTab, setSavedTab] = useState("");
  const [configErr, setConfigErr] = useState("");
  const [saveMismatchWarning, setSaveMismatchWarning] = useState("");
  const [modelConfigWarnings, setModelConfigWarnings] = useState([]);

  const apiKeys = config?.api_keys || {};
  const activeProvider =
    PROVIDERS.find((item) => item.id === provider) || PROVIDERS[0];
  const activeCatalog = providerCatalogs[provider] || null;
  const activePricingStatus = pricingStatus[provider] || null;
  const activeBrowserRuntime =
    browserRuntime[browserSettingsTab] ||
    DEFAULT_BROWSER_RUNTIME[browserSettingsTab];
  const activeMcpDisabledTools =
    disabledToolsByBrowserProfile[activeMcpBrowserTab]?.[activeProfileTab] ||
    [];
  const browserRuntimeSyncStatus = config?.browser_runtime_sync_status || null;
  const safeStreamingDifferences = useMemo(() => {
    const diffs = [];
    if (activeBrowserRuntime.ubol_enabled)
      diffs.push("uBOL active on standard pages");
    if (activeBrowserRuntime.stream_cors_patch_enabled)
      diffs.push("stream CORS patch enabled");
    if (activeBrowserRuntime.media_cors_patch_enabled)
      diffs.push("media CORS diagnostics patch enabled");
    return diffs;
  }, [activeBrowserRuntime, browserSettingsTab]);
  const filteredMcpTools = useMemo(() => {
    const query = mcpToolQuery.trim().toLowerCase();
    const tools = MCP_TOOLS_BY_PROFILE[activeProfileTab] || [];
    if (!query) return tools;
    return tools.filter((toolName) => {
      const meta = MCP_TOOL_META[toolName] || {};
      return [
        toolName,
        meta.label,
        meta.desc,
        meta.category,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [activeProfileTab, mcpToolQuery]);
  const enabledToolCount =
    (MCP_TOOLS_BY_PROFILE[activeProfileTab] || []).length -
    activeMcpDisabledTools.length;
  const modelSelectionDetails = useMemo(
    () => config?.model_selection_details || {},
    [config?.model_selection_details],
  );

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

  const catalogModels = useMemo(() => activeCatalog?.models || [], [activeCatalog]);
  const filteredCatalogModels = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase();
    if (!query) return catalogModels;
    return catalogModels.filter((model) => {
      const haystack = [
        model.id,
        model.label,
        model.description,
        model.release_channel,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [catalogModels, catalogQuery]);

  useEffect(() => {
    if (!catalogModels.length) {
      setSelectedCatalogModelId("");
      return;
    }
    if (catalogModels.some((item) => item.id === selectedCatalogModelId)) return;
    const preferredModelId = modelOverrideTargets[0]?.id;
    const fallbackSelection =
      catalogModels.find((item) => item.id === preferredModelId)?.id ||
      catalogModels[0]?.id ||
      "";
    setSelectedCatalogModelId(fallbackSelection);
  }, [catalogModels, modelOverrideTargets, selectedCatalogModelId]);

  const selectedCatalogModel =
    catalogModels.find((item) => item.id === selectedCatalogModelId) || null;
  const selectedModelFields = useMemo(
    () =>
      (activeCatalog?.hyperparameters || []).filter((field) =>
        fieldMatchesModel(field, selectedCatalogModel?.id),
      ),
    [activeCatalog, selectedCatalogModel],
  );
  const selectedModelOverrideValues = useMemo(
    () =>
      llmTuning.model_overrides[
        modelOverrideKey(provider, selectedCatalogModel?.id || "")
      ] || {},
    [llmTuning.model_overrides, provider, selectedCatalogModel],
  );
  const selectedModelEffectiveRows = useMemo(
    () =>
      selectedModelFields.map((field) => {
        const liveDefault = getModelDefaultValue(selectedCatalogModel, field.key);
        const providerDefault = llmTuning.provider_defaults[provider]?.[field.key];
        const overrideValue = selectedModelOverrideValues[field.key];
        const effectiveValue =
          overrideValue !== undefined && overrideValue !== ""
            ? overrideValue
            : providerDefault !== undefined && providerDefault !== ""
              ? providerDefault
              : liveDefault;
        let source = "Google live default";
        if (overrideValue !== undefined && overrideValue !== "") source = "Model override";
        else if (providerDefault !== undefined && providerDefault !== "") source = "Provider default";
        return {
          label: field.label,
          value: formatParameterValue(effectiveValue),
          note: source,
        };
      }),
    [
      llmTuning.provider_defaults,
      provider,
      selectedCatalogModel,
      selectedModelFields,
      selectedModelOverrideValues,
    ],
  );
  const selectedModelDefaultRows = useMemo(
    () =>
      selectedModelFields.map((field) => ({
        label: field.label,
        value: formatParameterValue(getModelDefaultValue(selectedCatalogModel, field.key)),
        note: provenanceLabel(
          selectedCatalogModel?.default_parameter_provenance?.[field.key] ||
            "Pulled from Google catalog",
        ),
      })),
    [selectedCatalogModel, selectedModelFields],
  );
  const assignmentRows = useMemo(
    () =>
      AGENT_SLOTS.map((slot) => {
        const selection = agentModelConfig[slot.id] || { provider, model: "" };
        const detail = modelSelectionDetails[slot.id] || {};
        const modelMeta =
          catalogModels.find(
            (item) =>
              String(item.id || "").toLowerCase() ===
              String(selection.model || "").toLowerCase(),
          ) || null;
        return {
          ...slot,
          selection,
          detail,
          modelMeta,
        };
      }),
    [agentModelConfig, catalogModels, modelSelectionDetails, provider],
  );
  const draftCompatibilityWarnings = useMemo(
    () =>
      buildCompatibilityWarnings({
        thinkingEnabled,
        explicitCacheEnabled: geminiExplicitCacheEnabled,
        selections: assignmentRows,
        catalogModels,
      }),
    [assignmentRows, catalogModels, geminiExplicitCacheEnabled, thinkingEnabled],
  );
  const mergedModelWarnings = useMemo(() => {
    const rows = [];
    const seen = new Set();
    const pushUnique = (item) => {
      const message = String(item?.message || "").trim();
      if (!message || seen.has(message)) return;
      seen.add(message);
      rows.push(item);
    };
    draftCompatibilityWarnings.forEach(pushUnique);
    (modelConfigWarnings || []).forEach((item, index) =>
      pushUnique({
        id: `${item.type || "warning"}-${item.agent_id || index}`,
        tone:
          item.type?.includes("unavailable") || item.type?.includes("disabled")
            ? "warning"
            : "default",
        message: item.message || String(item),
      }),
    );
    return rows;
  }, [draftCompatibilityWarnings, modelConfigWarnings]);

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
      }),
    [
      agentModelConfig,
      browserEngine,
      browserRuntime,
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
        provider: providerId,
        available: false,
        source: "unavailable",
        models: [],
        hyperparameters: [],
        error: fallback,
      };
      setProviderCatalogs((current) => ({ ...current, [providerId]: payload }));
      return payload;
    } finally {
      setCatalogLoading("");
    }
  }

  async function loadPricingStatus() {
    try {
      const payload = await apiFetch("/ui/pricing");
      setPricingStatus(payload?.provider_statuses || {});
      return payload;
    } catch (error) {
      return null;
    }
  }

  async function syncPricing(providerId = provider) {
    const targetProvider = String(providerId || "").trim().toLowerCase();
    if (!targetProvider) return;
    setPricingSyncLoading(targetProvider);
    setConfigErr("");
    try {
      await fetch(apiUrl("/ui/pricing/sync"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: targetProvider }),
      }).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.detail || payload.error || `Status ${response.status}`);
        }
        return payload;
      });
      await loadPricingStatus();
    } catch (error) {
      setConfigErr(error.message || "Could not sync provider pricing.");
    } finally {
      setPricingSyncLoading("");
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
    setBrowserEngine(payload.browser_engine || "playwright");
    setBrowserSettingsTab(payload.browser_engine || "playwright");
    setBrowserRuntime(normalizeBrowserRuntime(payload.browser_runtime));
    setDisabledToolsByBrowserProfile(
      normalizeDisabledToolsByBrowserProfile(
        payload.disabled_tools_by_browser_profile,
        payload.disabled_tools_by_profile || {},
      ),
    );
    setModelConfigWarnings(payload.model_config_warnings || []);
    setActiveMcpBrowserTab(payload.browser_engine || "playwright");
    setSavedTab("");

    const providersToLoad = ["google"];
    await Promise.all(
      providersToLoad.map((providerId) =>
        loadProviderCatalog(providerId, { force: true }).catch(() => null),
      ),
    );
    await loadPricingStatus();
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

  function applyLiveDefaultsToModelOverride(modelMeta) {
    if (!modelMeta?.id) return;
    const key = modelOverrideKey(provider, modelMeta.id);
    const liveDefaults = modelMeta.default_parameters || {};
    setLlmTuning((current) => {
      const next = normalizeTuning(current);
      return {
        ...next,
        model_overrides: {
          ...next.model_overrides,
          [key]: { ...liveDefaults },
        },
      };
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
    setSaveMismatchWarning("");
    try {
      const response = await fetch(apiUrl("/ui/config"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadToSave),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.detail || `Status ${response.status}`);
      if (tabId === "models") {
        const requestedSnapshot = snapshotServerConfig({
          ...serverDraft,
          ...payloadToSave,
        });
        const returnedSnapshot = snapshotServerConfig(payload);
        const requestedModel = requestedSnapshot.agent_model;
        const returnedModel = returnedSnapshot.agent_model;
        const requestedOrchestrator = requestedSnapshot.orchestrator_model;
        const returnedOrchestrator = returnedSnapshot.orchestrator_model;
        if (
          requestedModel !== returnedModel ||
          requestedOrchestrator !== returnedOrchestrator
        ) {
          setSaveMismatchWarning(
            `Server applied different model values (agent=${returnedModel || "n/a"}, orchestrator=${returnedOrchestrator || "n/a"}).`,
          );
        }
        setModelConfigWarnings(
          payload.apply_adjustments ||
            payload.model_config_warnings ||
            [],
        );
      }
      await hydrateConfig(payload);
      await loadPricingStatus();
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

  const currentTabSaved = savedTab === activeTab && !currentTabDirty;
  const showConfigError =
    Boolean(configErr) &&
    (!config || TAB_DETAILS[activeTab]?.storage === "server");

  const hasDirty = Object.values(dirtyTabs).some(Boolean);
  const activeGlobalModel = agentModelConfig?.classification?.model || "";
  const activeOrchestratorModel = agentModelConfig?.orchestrator?.model || "";

  function applySelectedCatalogModelAsGlobalDefault() {
    const modelId = String(selectedCatalogModelId || "").trim();
    if (!modelId) return;
    setConfigErr("");
    setSaveMismatchWarning("");
    setAgentModelConfig((current) => {
      const next = { ...current };
      next.classification = { ...(next.classification || { provider, model: "" }), provider, model: modelId };
      next.orchestrator = { ...(next.orchestrator || { provider, model: "" }), provider, model: modelId };
      return next;
    });
  }

  function applySelectedCatalogModelToTarget() {
    const modelId = String(selectedCatalogModelId || "").trim();
    if (!modelId) return;
    setConfigErr("");
    setSaveMismatchWarning("");
    if (catalogAssignmentTarget === "global") {
      applySelectedCatalogModelAsGlobalDefault();
      return;
    }
    updateAgentModel(catalogAssignmentTarget, modelId);
  }

  return (
    <div className="space-y-6">
      <div className="rounded-[24px] border border-border/70 bg-gradient-to-br from-background via-background to-muted/15 p-5 shadow-[0_20px_60px_-36px_rgba(0,0,0,0.5)]">
        <div className="flex flex-col gap-4">
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
              Operator console
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Settings
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Configure Gemini, browser runtime, local display behavior, and tool availability without losing tab-scoped save behavior.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <CompactStat label="Unsaved tabs" value={hasDirty ? `${Object.values(dirtyTabs).filter(Boolean).length}` : "0"} tone={hasDirty ? "primary" : "default"} />
            <CompactStat label="Active engine" value="Playwright" />
            <CompactStat label="Catalog" value={activeCatalog?.available ? "Live" : activeCatalog ? "Offline fallback" : "Loading"} />
            <CompactStat label="MCP tools" value={`${enabledToolCount}/${(MCP_TOOLS_BY_PROFILE[activeProfileTab] || []).length} enabled`} />
          </div>
          <div className="lg:hidden">
            <SettingsTabBar
              active={activeTab}
              onChange={setActiveTab}
              dirtyTabs={dirtyTabs}
              mobile
            />
          </div>
        </div>
      </div>
      <div className="flex items-start gap-6">
      {/* ── LEFT SIDEBAR NAV ───────────────────────────────────── */}
      <Card className="sticky top-6 hidden w-64 shrink-0 self-start overflow-hidden rounded-[22px] border-border/70 bg-card/95 shadow-[0_24px_60px_-42px_rgba(0,0,0,0.6)] lg:block">
        <CardContent className="px-3 pb-2 pt-3">
          <SettingsTabBar
            active={activeTab}
            onChange={setActiveTab}
            dirtyTabs={dirtyTabs}
          />
        </CardContent>
        <div className="flex flex-col gap-2 border-t border-border/70 px-3 py-3">
          <Badge tone={activeCatalog?.available ? "success" : activeCatalog ? "warning" : "default"} className="justify-center rounded-lg px-2.5 py-1.5 text-xs">
            {activeCatalog?.available ? "Catalog ready" : activeCatalog ? "Catalog unavailable" : "Loading..."}
          </Badge>
          <Badge tone={pricingStatusTone(activePricingStatus)} className="justify-center rounded-lg px-2.5 py-1.5 text-xs">
            {activePricingStatus?.model_count > 0
              ? `${activePricingStatus.model_count} priced models`
              : activePricingStatus?.api_key_set
                ? "Pricing not synced"
                : "Pricing unavailable"}
          </Badge>
          <Badge tone={hasDirty ? "warning" : "success"} className="justify-center rounded-lg px-2.5 py-1.5 text-xs">
            {hasDirty ? "Unsaved changes" : "All synced"}
          </Badge>
        </div>
      </Card>

      {/* ── RIGHT CONTENT ─────────────────────────────────────── */}
      <div className="flex-1 min-w-0 space-y-6">
        <SettingsTabHero
          tabId={activeTab}
          dirty={currentTabDirty}
          saving={saving}
          saved={currentTabSaved}
          onSave={() => saveConfig(activeTab)}
          otherDirtyCount={otherDirtyCount}
        />
        <ErrorNotice message={showConfigError ? configErr : ""} />
        {activeTab === "models" && saveMismatchWarning ? (
          <div className="rounded-xl border border-amber-300/50 bg-amber-100/50 px-4 py-3 text-[13px] text-amber-900">
            {saveMismatchWarning}
          </div>
        ) : null}

        <div key={activeTab} className="animate-fade-up space-y-8">
          {activeTab === "models" ? (
            <section className="space-y-4">
              <SettingsWorkspaceCard
                eyebrow="Live Google control plane"
                title="Model assignments that stay current"
                description="Assignments is the operator view. Runtime Controls holds cache and reasoning knobs. Catalog & Costs pulls the live Google catalog so new models appear as soon as Google exposes them."
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={currentTabDirty ? "warning" : "success"}>
                      {currentTabDirty ? "Unsaved model changes" : "Saved to runtime config"}
                    </Badge>
                    <Badge
                      tone={
                        sourceTone(activeCatalog?.source || "unavailable") === "ok"
                          ? "success"
                          : sourceTone(activeCatalog?.source || "unavailable") === "error"
                            ? "destructive"
                            : "warning"
                      }
                    >
                      {sourceLabel(activeCatalog?.source || "unavailable")}
                    </Badge>
                  </div>
                }
              >
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <CompactStat label="Selected global" value={activeGlobalModel || "Not set"} tone="primary" />
                    <CompactStat label="Saved global" value={config?.agent_model || "Not set"} />
                    <CompactStat label="Effective orchestrator" value={modelSelectionDetails?.orchestrator?.model || activeOrchestratorModel || "Not set"} />
                    <CompactStat label="Live models" value={String(catalogModels.length || 0)} />
                  </div>
                  <MiniSegment
                    options={MODEL_WORKSPACE_VIEWS}
                    active={activeModelWorkspaceView}
                    onChange={setActiveModelWorkspaceView}
                  />
                </div>
              </SettingsWorkspaceCard>

              {saveMismatchWarning ? (
                <WarningNotice items={[{ id: "save-mismatch", tone: "warning", message: saveMismatchWarning }]} />
              ) : null}
              <WarningNotice items={mergedModelWarnings} />

              {activeModelWorkspaceView === "assignments" ? (
                <div className="space-y-4">
                  <SettingsWorkspaceCard
                    eyebrow="Apply state"
                    title="Selected, saved, and effective runtime state"
                    description="The form state can differ from saved config until you save. Effective runtime state comes back from the backend after re-hydration."
                  >
                    <div className="grid gap-4 lg:grid-cols-3">
                      <ParameterSummaryCard
                        title="Selected in form"
                        icon={Cpu}
                        tone="primary"
                        rows={[
                          { label: "Global default", value: activeGlobalModel || "Not set", note: "Current unsaved form state" },
                          { label: "Orchestrator", value: activeOrchestratorModel || "Not set", note: "Current unsaved form state" },
                        ]}
                      />
                      <ParameterSummaryCard
                        title="Saved to config"
                        icon={Save}
                        rows={[
                          { label: "Global default", value: config?.agent_model || "Not set", note: "Last backend config payload" },
                          { label: "Orchestrator", value: config?.orchestrator_model || "Not set", note: "Last backend config payload" },
                        ]}
                      />
                      <ParameterSummaryCard
                        title="Effective runtime"
                        icon={CheckCircle2}
                        rows={[
                          { label: "Classification", value: modelSelectionDetails?.classification?.model || "Not set", note: sourceLabel(modelSelectionDetails?.classification?.catalog_source) },
                          { label: "Orchestrator", value: modelSelectionDetails?.orchestrator?.model || "Not set", note: sourceLabel(modelSelectionDetails?.orchestrator?.catalog_source) },
                        ]}
                      />
                    </div>
                  </SettingsWorkspaceCard>

                  <div className="grid gap-4 lg:grid-cols-2">
                    {assignmentRows.map((slot) => {
                      const selection = slot.selection || { provider, model: "" };
                      const slotCatalog = providerCatalogs[selection.provider] || null;
                      const slotOptions = ensureSelectedOption(
                        (slotCatalog?.models || []).map((model) => ({
                          value: model.id,
                          label: model.label || model.id,
                        })),
                        selection.model,
                      );
                      const selectedModelMeta = slot.modelMeta;
                      const slotFields = (slotCatalog?.hyperparameters || []).filter((field) =>
                        fieldMatchesModel(field, selection.model),
                      );
                      const slotOverrides = llmTuning.agent_overrides[slot.id] || {};
                      const slotDetail = slot.detail || {};
                      const slotCapabilities = getModelCapabilities(selectedModelMeta);
                      const isManual = slotDetail.catalog_status === "unverified_manual" || (!selectedModelMeta && selection.model);

                      return (
                        <SettingsWorkspaceCard
                          key={slot.id}
                          eyebrow={slot.note}
                          title={slot.label}
                          description="Per-agent model routing with direct Google catalog metadata when available."
                          actions={
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge tone="default">{selection.provider || "google"}</Badge>
                              <Badge tone={isManual ? "default" : "success"}>
                                {isManual ? "Manual ID" : sourceLabel(slotDetail.catalog_source || slotCatalog?.source)}
                              </Badge>
                            </div>
                          }
                        >
                          <div className="space-y-4">
                            <div className="grid gap-3 sm:grid-cols-2">
                              <Select
                                label="Live Google model"
                                value={selection.model}
                                onChange={(next) => updateAgentModel(slot.id, next)}
                                options={slotOptions}
                                searchable
                                placeholder="Select model"
                                emptyMessage="No Google models available"
                              />
                              <Input
                                label="Manual model ID"
                                value={selection.model}
                                onChange={(event) => updateAgentModel(slot.id, event.target.value)}
                                placeholder="Use a newly released or manual Google model ID"
                                className="h-10 font-mono text-[12px]"
                              />
                            </div>

                            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                              <ModelFact label="Selected model" value={selection.model || "Not set"} tone="primary" />
                              <ModelFact label="Catalog status" value={isManual ? "Unverified manual ID" : "Verified"} />
                              <ModelFact label="Thinking" value={capabilityStatusLabel(slotCapabilities.supports_thinking_controls, "Ignored")} />
                              <ModelFact label="Explicit cache" value={capabilityStatusLabel(slotCapabilities.supports_explicit_cache)} />
                            </div>

                            {selectedModelMeta ? (
                              <div className="rounded-xl border border-border/70 bg-muted/15 p-4">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge tone={releaseChannelTone(selectedModelMeta.release_channel)}>
                                    {selectedModelMeta.release_channel || "stable"}
                                  </Badge>
                                  <Badge tone={capabilityTone(selectedModelMeta.compatibility?.thinking_controls)}>
                                    thinking {capabilityStatusLabel(selectedModelMeta.compatibility?.thinking_controls, "ignored").toLowerCase()}
                                  </Badge>
                                  <Badge tone={capabilityTone(selectedModelMeta.compatibility?.explicit_cache)}>
                                    cache {capabilityStatusLabel(selectedModelMeta.compatibility?.explicit_cache).toLowerCase()}
                                  </Badge>
                                </div>
                                <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                                  {selectedModelMeta.description || "No Google description returned for this model."}
                                </p>
                                <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                                  <span className="font-mono">{formatTokenCount(selectedModelMeta.context_window)} ctx</span>
                                  <span className="font-mono">{formatTokenCount(selectedModelMeta.output_limit)} out</span>
                                  <span>Defaults: {sourceLabel(selectedModelMeta.defaults_source)}</span>
                                </div>
                              </div>
                            ) : selection.model ? (
                              <div className="rounded-xl border border-border/70 bg-muted/15 p-4 text-[12px] text-muted-foreground">
                                This model is not in the current Google catalog response yet. It can still be saved, but capabilities remain unverified until Google returns metadata for it.
                              </div>
                            ) : null}

                            <TuningCard
                              title={`${slot.label} override`}
                              description="Applied after provider defaults and model defaults."
                              values={slotOverrides}
                              fields={slotFields}
                              onChange={(field, value) => updateAgentOverride(slot.id, field, value)}
                              onClear={() => clearAgentOverride(slot.id)}
                              clearLabel="Clear override"
                            />
                          </div>
                        </SettingsWorkspaceCard>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {activeModelWorkspaceView === "runtime" ? (
                <div className="space-y-4">
                  <FieldGroup
                    title="Runtime Defaults"
                    description="Global settings applied before per-model and per-agent overrides."
                    accent="var(--signal)"
                  >
                    <div className="grid gap-6 sm:grid-cols-2">
                      <div>
                        <div className="mb-3 flex items-center gap-2">
                          <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                            Fallback Temperature
                          </span>
                          <HelpIcon tip="Used only when Google does not return a model-specific default and no override is set." />
                        </div>
                        <Slider
                          value={Number(fallbackTemperature) || 0}
                          onChange={(next) => setFallbackTemperature(next)}
                          min={0}
                          max={2}
                          step={0.1}
                          description="Direct Google defaults still take precedence when present."
                        />
                      </div>
                      <div>
                        <div className="mb-3 flex items-center gap-2">
                          <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                            Tool Cache Stabilization
                          </span>
                          <HelpIcon tip="How many identical consecutive tool results must be seen before the response is cached." />
                        </div>
                        <Slider
                          value={Number(toolCacheStable) || 1}
                          onChange={(next) => setToolCacheStable(next)}
                          min={1}
                          max={10}
                          step={1}
                          description="Higher values are more conservative."
                        />
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <ToggleRow
                        label="Provider prompt caching"
                        checked={providerCacheEnabled}
                        onChange={setProviderCacheEnabled}
                        description="Use Google-native cache hits for repeated shared prompt context."
                      />
                      <ToggleRow
                        label="Deterministic tool result cache"
                        checked={toolCacheEnabled}
                        onChange={setToolCacheEnabled}
                        description="Cache repeated browser-tool responses within the same run session."
                      />
                    </div>
                  </FieldGroup>

                  <div className="grid gap-4 xl:grid-cols-2">
                    <FieldGroup
                      title="Explicit Cache"
                      description="Server-side cached context for repeated Google model runs."
                      accent="var(--violet)"
                    >
                      <ToggleRow
                        label="Enabled"
                        checked={geminiExplicitCacheEnabled}
                        onChange={setGeminiExplicitCacheEnabled}
                        description="Auto-adjusted at runtime when a selected model does not support explicit cache."
                      />
                      <div className="grid gap-4 sm:grid-cols-2">
                        <BrowserRuntimeInput
                          label="Cache TTL (seconds)"
                          value={geminiExplicitCacheTtl}
                          onChange={setGeminiExplicitCacheTtl}
                          type="number"
                          min="60"
                          step="60"
                          description="How long the server keeps the cached context alive."
                        />
                        <BrowserRuntimeInput
                          label="Refresh lead (seconds)"
                          value={geminiExplicitCacheRefreshLead}
                          onChange={setGeminiExplicitCacheRefreshLead}
                          type="number"
                          min="5"
                          step="5"
                          description="How early the runtime pre-warms a replacement cache."
                        />
                      </div>
                    </FieldGroup>

                    <FieldGroup
                      title="Thinking"
                      description="Global reasoning control. Unsupported models keep the selection but ignore the thinking budget."
                      accent="var(--sky)"
                    >
                      <ToggleRow
                        label="Enable thinking"
                        checked={thinkingEnabled}
                        onChange={setThinkingEnabled}
                        description="Only applied where the selected Google model supports it."
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
                            description="Higher values allow deeper reasoning with higher cost."
                          />
                        </div>
                      ) : null}
                    </FieldGroup>
                  </div>

                  <FieldGroup
                    title="Overrides and Parallelism"
                    description="Use overrides sparingly. Google live defaults remain the base layer."
                    accent="var(--mint)"
                  >
                    <div className="grid gap-4 xl:grid-cols-2">
                      <TuningCard
                        title={`${activeProvider.name} provider defaults`}
                        description="Applied before model-specific and agent-specific overrides."
                        values={llmTuning.provider_defaults[provider] || {}}
                        fields={providerDefaultFields}
                        onChange={updateAgentProviderDefault}
                      />
                      <div className="space-y-4">
                        <BrowserRuntimeInput
                          label="Max parallel hosting pages"
                          value={maxParallelHostingPages}
                          onChange={setMaxParallelHostingPages}
                          type="number"
                          min="1"
                          max="20"
                          step="1"
                          description="Caps simultaneous hosting-page and embedded-page executions."
                        />
                        {modelOverrideTargets.map((target) => {
                          const fields = (activeCatalog?.hyperparameters || []).filter((field) =>
                            fieldMatchesModel(field, target.id),
                          );
                          const values =
                            llmTuning.model_overrides[modelOverrideKey(provider, target.id)] || {};
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
                      </div>
                    </div>
                  </FieldGroup>
                </div>
              ) : null}

              {activeModelWorkspaceView === "catalog" ? (
                <div className="space-y-4">
                  <SettingsWorkspaceCard
                    eyebrow="Direct from Google"
                    title="Live catalog and defaults"
                    description="This view is fed by the Google models API first, then saved snapshot, then fallback catalog. If Google adds a model later today, it should show up here on load or refresh."
                    actions={
                      <div className="flex items-center gap-2">
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
                              Refresh live catalog
                            </>
                          )}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => syncPricing(provider)}
                          disabled={pricingSyncLoading === provider}
                        >
                          {pricingSyncLoading === provider ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Syncing pricing
                            </>
                          ) : (
                            <>
                              <RefreshCw className="h-3.5 w-3.5" />
                              Sync pricing
                            </>
                          )}
                        </Button>
                      </div>
                    }
                  >
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <ModelFact label="Catalog source" value={sourceLabel(activeCatalog?.source || "unavailable")} tone="primary" />
                      <ModelFact label="Defaults source" value={sourceLabel(activeCatalog?.defaults_source || "unavailable")} />
                      <ModelFact label="Priced models" value={String(activePricingStatus?.model_count || 0)} />
                      <ModelFact label="Last pricing sync" value={activePricingStatus?.last_sync_at || "Not recorded"} />
                    </div>

                    {!apiKeys[provider] ? (
                      <div className="flex items-start gap-2 rounded-lg border border-primary/35 bg-primary/10 px-3 py-2.5 text-sm text-primary">
                        <Key className="mt-0.5 size-4 shrink-0" />
                        <span>
                          <strong>{activeProvider.keyEnv}</strong> not set. {activeCatalog?.source === "saved_catalog"
                            ? "Using the last saved Google snapshot."
                            : "Live Google defaults are unavailable; fallback rows are shown."}
                        </span>
                      </div>
                    ) : null}

                    {activeCatalog?.error ? (
                      <div className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                        {activeCatalog.error}
                      </div>
                    ) : null}

                    <div className="grid gap-4 lg:grid-cols-[minmax(0,0.92fr)_minmax(360px,1.08fr)]">
                      <div className="space-y-3">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={catalogQuery}
                            onChange={(event) => setCatalogQuery(event.target.value)}
                            placeholder="Search Google models"
                            className="h-10 pl-9"
                          />
                        </div>
                        <div className="space-y-2 rounded-2xl border border-border/70 bg-muted/15 p-2">
                          {filteredCatalogModels.length ? (
                            filteredCatalogModels.map((model) => {
                              const isSelected = model.id === selectedCatalogModelId;
                              const capabilities = getModelCapabilities(model);
                              const isAssigned = modelOverrideTargets.some((target) => target.id === model.id);
                              return (
                                <button
                                  key={model.id}
                                  type="button"
                                  onClick={() => setSelectedCatalogModelId(model.id)}
                                  className={cn(
                                    "w-full rounded-xl border px-3 py-3 text-left transition-colors",
                                    isSelected
                                      ? "border-primary/40 bg-primary/8"
                                      : "border-border/60 bg-background hover:bg-muted/35",
                                  )}
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <div className="text-sm font-semibold text-foreground">{model.label || model.id}</div>
                                        <Badge tone={releaseChannelTone(model.release_channel)} className="px-1.5 py-0.5 text-[9px] uppercase tracking-wide">
                                          {model.release_channel || "stable"}
                                        </Badge>
                                        {isAssigned ? <Badge tone="signal" className="px-1.5 py-0.5 text-[9px]">in use</Badge> : null}
                                      </div>
                                      <div className="mt-1 font-mono text-[11px] text-muted-foreground">{model.id}</div>
                                    </div>
                                    {isSelected ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
                                  </div>
                                  <div className="mt-2 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
                                    {model.description || "No Google description returned."}
                                  </div>
                                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                                    <Badge tone="default" className="px-1.5 py-0.5 text-[9px]">{formatTokenCount(model.context_window)} ctx</Badge>
                                    <Badge tone="default" className="px-1.5 py-0.5 text-[9px]">{formatTokenCount(model.output_limit)} out</Badge>
                                    <Badge tone={capabilityTone(model.compatibility?.thinking_controls)} className="px-1.5 py-0.5 text-[9px]">
                                      thinking {capabilityStatusLabel(capabilities.supports_thinking_controls, "off").toLowerCase()}
                                    </Badge>
                                  </div>
                                </button>
                              );
                            })
                          ) : (
                            <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                              No Google models match this search.
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="space-y-4">
                        {selectedCatalogModel ? (
                          <>
                            <SettingsWorkspaceCard
                              eyebrow="Selected model"
                              title={selectedCatalogModel.label || selectedCatalogModel.id}
                              description={selectedCatalogModel.description || "No Google description returned for this model."}
                              actions={
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge tone={releaseChannelTone(selectedCatalogModel.release_channel)}>
                                    {selectedCatalogModel.release_channel || "stable"}
                                  </Badge>
                                  <Badge tone="default">{sourceLabel(selectedCatalogModel.catalog_source)}</Badge>
                                </div>
                              }
                            >
                              <div className="space-y-4">
                                <div className="font-mono text-[11px] text-muted-foreground">
                                  {selectedCatalogModel.id}
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                  <ModelFact label="Context window" value={formatTokenCount(selectedCatalogModel.context_window)} />
                                  <ModelFact label="Output limit" value={formatTokenCount(selectedCatalogModel.output_limit)} />
                                  <ModelFact label="Cache API" value={capabilityStatusLabel(getModelCapabilities(selectedCatalogModel).supports_explicit_cache)} />
                                  <ModelFact label="Thinking controls" value={capabilityStatusLabel(getModelCapabilities(selectedCatalogModel).supports_thinking_controls, "Ignored")} />
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2">
                                  <Select
                                    label="Assign selected model to"
                                    value={catalogAssignmentTarget}
                                    onChange={setCatalogAssignmentTarget}
                                    options={[
                                      { value: "global", label: "Global default" },
                                      ...AGENT_SLOTS.map((slot) => ({
                                        value: slot.id,
                                        label: slot.label,
                                      })),
                                    ]}
                                  />
                                  <div className="flex items-end gap-2">
                                    <Button
                                      type="button"
                                      size="sm"
                                      onClick={applySelectedCatalogModelToTarget}
                                      disabled={!selectedCatalogModelId}
                                    >
                                      Apply assignment
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => applyLiveDefaultsToModelOverride(selectedCatalogModel)}
                                      disabled={!selectedModelFields.length}
                                    >
                                      <Sparkles className="h-3.5 w-3.5" />
                                      Copy Google defaults
                                    </Button>
                                  </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  {(selectedCatalogModel.supported_generation_methods || []).map((method) => (
                                    <Badge key={method} tone="default" className="px-1.5 py-0.5 text-[9px]">
                                      {method}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            </SettingsWorkspaceCard>

                            <div className="grid gap-4 xl:grid-cols-2">
                              <ParameterSummaryCard
                                title="Google defaults"
                                icon={Sparkles}
                                tone="primary"
                                rows={selectedModelDefaultRows}
                              />
                              <ParameterSummaryCard
                                title="Effective request values"
                                icon={SlidersHorizontal}
                                rows={selectedModelEffectiveRows}
                              />
                            </div>

                            <CostEstimator provider={provider} model={selectedCatalogModel.id} />
                          </>
                        ) : (
                          <Card className="rounded-[16px] border border-dashed">
                            <CardContent className="px-5 py-10 text-center text-sm text-muted-foreground">
                              Select a Google model to inspect live defaults, capability provenance, and estimated costs.
                            </CardContent>
                          </Card>
                        )}
                      </div>
                    </div>
                  </SettingsWorkspaceCard>
                </div>
              ) : null}
            </section>
          ) : null}

          {activeTab === "browser" ? (
            <section className="space-y-4">
              <BrowserTab config={config} dirty={Boolean(getDirtyTabs(savedConfigSnapshot, serverDraft)?.browser)} onSave={() => saveConfig("browser")} saving={loading} />
              <SectionHeader>Engine Selection — Removed (Playwright-only per D15)</SectionHeader>
              <div className="rounded-lg border border-amber-300/50 bg-amber-50 px-3 py-2 text-xs text-amber-900">Engine selector removed — the console is now Playwright-only (persona spec D15). Server retains internal overrides; UI has no runtime knob.</div>
              <div className="grid gap-3 sm:grid-cols-2" style={{ display: "none" }}>
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
                        className="mt-1 text-[12px] leading-relaxed"
                        style={{ color: "var(--mute)" }}
                      >
                        {engine.note}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {engine.id === "playwright" ? (
                          <>
                            <Badge tone="signal">iframe recovery</Badge>
                            <Badge tone="default">context isolation</Badge>
                          </>
                        ) : (
                          <>
                            <Badge tone="signal">default path</Badge>
                            <Badge tone="default">legacy CDP</Badge>
                          </>
                        )}
                      </div>
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

              <div className="grid gap-3 sm:grid-cols-2">
                <CompactStat label="Editing runtime" value="Playwright" tone="primary" />
                <CompactStat label="Streaming-safe mode" value={String(activeBrowserRuntime.streaming_safe_mode || "adaptive")} />
              </div>

              <FieldGroup
                title="Runtime Status"
                description="Bridge sync state for the active backend."
                accent="var(--sky)"
              >
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
                title="Adaptive Streaming"
                description="Prefer direct, browser-like playback on player pages and only escalate when evidence says it is needed."
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
                title="Cleanup & Launch"
                description="Keep the browser looking normal, load the real uBOL extension for standard pages, and leave stream-like targets untouched."
                accent="var(--rose)"
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
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <ToggleRow
                    label="uBOL extension"
                    checked={!!activeBrowserRuntime.ubol_enabled}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "ubol_enabled",
                        value,
                      )
                    }
                    description="Load uBlock Origin Lite for standard pages. Landing, hosting, embedded, and streaming-safe cases still stand down automatically."
                  />
                  <BrowserRuntimeInput
                    label="uBOL no-filter hosts"
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
                    description="Pass these hostnames to Chrome managed policy so uBOL leaves them alone even on standard pages."
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <ToggleRow
                    label="Block popups"
                    checked={!!activeBrowserRuntime.popup_blocking_enabled}
                    onChange={(value) =>
                      updateBrowserRuntime(
                        browserSettingsTab,
                        "popup_blocking_enabled",
                        value,
                      )
                    }
                    description="Block new tabs, alert-style interruptions, and window.open popups so agents stay on task."
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
                  <ToggleRow
                    label="Stream CORS patch"
                    checked={
                      !!browserRuntime.playwright?.stream_cors_patch_enabled
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        "playwright",
                        "stream_cors_patch_enabled",
                        value,
                      )
                    }
                    description="Last-resort compatibility patch. Keep off unless diagnostics show a real stream-header issue."
                  />
                  <ToggleRow
                    label="Include stream credentials"
                    checked={
                      !!browserRuntime.playwright?.stream_cors_include_credentials
                    }
                    onChange={(value) =>
                      updateBrowserRuntime(
                        "playwright",
                        "stream_cors_include_credentials",
                        value,
                      )
                    }
                    description="Include credentials when the stream CORS patch is active."
                  />
                </div>
              </FieldGroup>

              <FieldGroup
                title="Recovery & Media"
                description="Give players enough time to load, retry transient failures, and recover cross-frame playback without over-correcting."
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
                </div>
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

          {activeTab === "mcp-tools" ? (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <SectionHeader>MCP Tools</SectionHeader>
                <span className="text-[11px]" style={{ color: "var(--mute)" }}>
                  Clean per-profile toggles with faster scanning and fewer accidental disables
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

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <CompactStat label="Enabled" value={`${enabledToolCount}/${(MCP_TOOLS_BY_PROFILE[activeProfileTab] || []).length}`} tone="primary" />
                <CompactStat label="Disabled" value={`${activeMcpDisabledTools.length}`} />
                <CompactStat label="Backend" value="Playwright" />
                <CompactStat label="Profile" value={PROFILE_LABELS[activeProfileTab]} />
              </div>

              <div
                className="rounded-[18px] border border-border/70 bg-card/95 p-4 shadow-[0_18px_48px_-36px_rgba(0,0,0,0.55)]"
              >
                <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-[13px] font-semibold text-foreground">
                        {BROWSER_OPTIONS.find((item) => item.id === activeMcpBrowserTab)?.name}
                        {" · "}
                        {PROFILE_LABELS[activeProfileTab]}
                      </span>
                      <Badge tone="default" className="font-mono text-[10px]">
                        {enabledToolCount}
                        {" / "}
                        {(MCP_TOOLS_BY_PROFILE[activeProfileTab] || []).length} enabled
                      </Badge>
                    </div>
                    <p className="max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
                      Required shared tools should normally stay enabled. Use this screen to trim redundant or risky tools per engine/profile, not to hide core navigation and inspection by default.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-[11px] text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/10"
                      onClick={() => setDisabledToolsForCurrentBrowserProfile([])}
                    >
                      Enable all
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-[11px]"
                      onClick={() => setDisabledToolsForCurrentBrowserProfile(MCP_TOOLS_BY_PROFILE[activeProfileTab])}
                    >
                      Disable all
                    </Button>
                  </div>
                </div>

                <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
                    <input
                      value={mcpToolQuery}
                      onChange={(event) => setMcpToolQuery(event.target.value)}
                      placeholder="Filter tools by name, category, or description"
                      className="h-11 w-full rounded-[14px] border border-border/70 bg-background/75 pl-10 pr-3 text-[13px] text-foreground outline-none transition focus:border-primary/40 focus:ring-2 focus:ring-primary/10"
                    />
                  </div>
                  <div className="rounded-[14px] border border-border/70 bg-background/70 px-3.5 py-3 text-[12px] text-muted-foreground">
                    Showing <span className="font-semibold text-foreground">{filteredMcpTools.length}</span> of{" "}
                    <span className="font-semibold text-foreground">{(MCP_TOOLS_BY_PROFILE[activeProfileTab] || []).length}</span> tools
                  </div>
                </div>

                {(() => {
                  const categories = [...new Set(filteredMcpTools.map((t) => MCP_TOOL_META[t]?.category || "Other"))];
                  return categories.map((cat) => {
                    const catTools = filteredMcpTools.filter((t) => (MCP_TOOL_META[t]?.category || "Other") === cat);
                    return (
                      <div key={cat} className="mb-4">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                            {cat}
                          </div>
                          <Badge tone="default" className="text-[9px] font-mono">
                            {catTools.filter((toolName) => !activeBrowserTools().includes(toolName)).length}/{catTools.length} enabled
                          </Badge>
                        </div>
                        <div className="divide-y divide-border/40 rounded-[14px] border border-border/60 bg-background/65">
                          {catTools.map((toolName) => {
                            const isDisabled = activeBrowserTools().includes(toolName);
                            const meta = MCP_TOOL_META[toolName];
                            return (
                              <div
                                key={toolName}
                                className="flex items-start gap-3 px-3 py-3 transition-colors hover:bg-muted/25"
                              >
                                <Switch
                                  checked={!isDisabled}
                                  onCheckedChange={(checked) => {
                                    const currentDisabled = activeBrowserTools();
                                    const nextDisabled = checked
                                      ? currentDisabled.filter((item) => item !== toolName)
                                      : [...currentDisabled, toolName];
                                    setDisabledToolsForCurrentBrowserProfile(nextDisabled);
                                  }}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className={cn(
                                      "font-mono text-[12px] font-medium",
                                      isDisabled ? "text-muted-foreground/50 line-through" : "text-foreground"
                                    )}>
                                      {toolName}
                                    </span>
                                    <Badge tone="default" className="text-[9px]">
                                      {meta?.category || "Other"}
                                    </Badge>
                                  </div>
                                  {meta?.desc ? (
                                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/75">
                                      {meta.desc}
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  });
                })()}
                {!filteredMcpTools.length ? (
                  <div className="rounded-[14px] border border-dashed border-border/70 px-4 py-6 text-center text-[12px] text-muted-foreground">
                    No tools match this filter.
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeTab === "api-keys" ? (
            <section className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">Gemini API Key Status</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  The key is loaded from environment variables at server start. Add it to your{" "}
                  <code className="rounded border bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                    .env
                  </code>{" "}
                  file and rebuild to activate Gemini.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {PROVIDERS.map((item) => {
                  const hasKey = !!apiKeys[item.id];
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "flex items-start gap-3 rounded-lg border bg-card p-4 transition-colors",
                        hasKey ? "border-mint/30" : ""
                      )}
                    >
                      <span
                        className="mt-1 h-2 w-2 shrink-0 rounded-full"
                        style={{
                          background: hasKey ? (item.color || "var(--mint)") : "var(--mute-3)",
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-medium text-foreground">{item.name}</div>
                          <KeyStatus set={hasKey} />
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/60">
                          {item.keyEnv}
                        </div>
                        {item.features && item.features.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {item.features.map((feat) => (
                              <span
                                key={feat}
                                className="rounded border bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
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
              <div>
                <h2 className="text-base font-semibold text-foreground">Notification Preferences</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Choose which pipeline events trigger toast notifications. Tool call events are
                  never notified.
                </p>
              </div>
              <div className="space-y-2">
                {NOTIF_EVENTS.map(({ key, label, note }) => (
                  <ToggleRow
                    key={key}
                    label={label}
                    checked={!!notifPrefs[key]}
                    onChange={(checked) => setNotifPrefs({ ...notifPrefs, [key]: checked })}
                    description={note}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
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
          className="mt-1 text-sm leading-relaxed"
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
