/* eslint-disable */
﻿"use client";

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
  ShieldCheck,
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
import { apiFetch } from "@/lib/api";
import { BrowserTab } from "./tabs/browser-tab";
import { ModelsTab } from "./tabs/models-tab";
import { DisplayTab } from "./tabs/display-tab";
import { McpToolsTab } from "./tabs/mcp-tools-tab";
import { ApiKeysTab } from "./tabs/api-keys-tab";
import { NotificationsTab } from "./tabs/notifications-tab";
import { AccountTab } from "./tabs/account-tab";
import {
  BROWSER_RUNTIME_KEYS,
  buildServerConfigDraft,
  getDirtyTabs,
  snapshotServerConfig,
} from "@/lib/settings-page";

const CORE_PROVIDERS = [
  { id: "google", name: "Google Gemini", keyEnv: "GOOGLE_API_KEY", color: "#4285F4", features: ["caching", "thinking", "vision"], category: "Frontier" },
  { id: "openai", name: "OpenAI", keyEnv: "OPENAI_API_KEY", color: "#10a37f", features: ["reasoning", "vision", "tools"], category: "Frontier" },
  { id: "anthropic", name: "Anthropic", keyEnv: "ANTHROPIC_API_KEY", color: "#d4a574", features: ["thinking", "vision", "tools"], category: "Frontier" },
  { id: "xai", name: "xAI", keyEnv: "XAI_API_KEY", color: "#000000", features: ["grok", "reasoning"], category: "Frontier" },
  { id: "deepseek", name: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", color: "#4d6bfe", features: ["reasoning", "coder"], category: "Frontier" },
  { id: "upstage", name: "Upstage", keyEnv: "UPSTAGE_API_KEY", color: "#ff6b35", features: ["solar", "reasoning"], category: "Frontier" },
  { id: "groq", name: "Groq", keyEnv: "GROQ_API_KEY", color: "#f55036", features: ["LPU", "ultra-fast"], category: "Speed" },
  { id: "together", name: "Together AI", keyEnv: "TOGETHER_API_KEY", color: "#00b4d8", features: ["fast", "open"], category: "Speed" },
  { id: "fireworks", name: "Fireworks AI", keyEnv: "FIREWORKS_API_KEY", color: "#ff3b30", features: ["fast", "inference"], category: "Speed" },
  { id: "nvidia", name: "NVIDIA NIM", keyEnv: "NVIDIA_API_KEY", color: "#76b900", features: ["inference", "hosted"], category: "Speed" },
  { id: "mistral", name: "Mistral AI", keyEnv: "MISTRAL_API_KEY", color: "#ff7000", features: ["open", "european"], category: "Open" },
  { id: "cohere", name: "Cohere", keyEnv: "COHERE_API_KEY", color: "#39594e", features: ["command", "embed"], category: "Open" },
  { id: "perplexity", name: "Perplexity", keyEnv: "PERPLEXITY_API_KEY", color: "#1ea2a6", features: ["sonar", "search"], category: "Open" },
  { id: "openrouter", name: "OpenRouter", keyEnv: "OPENROUTER_API_KEY", color: "var(--signal)", features: ["aggregator", "routing"], category: "Gateway" },
  { id: "azure", name: "Azure OpenAI", keyEnv: "AZURE_API_KEY", color: "#0078d4", features: ["enterprise", "azure"], category: "Gateway" },
  { id: "bedrock", name: "AWS Bedrock", keyEnv: "BEDROCK_API_KEY", color: "#ff9900", features: ["aws", "hosted"], category: "Gateway" },
];

const DIRECTORY_PROVIDERS = [
  ["opencode", "OpenCode Zen", "OPENCODE_API_KEY", "Gateway", "curated models", "reasoning"],
  ["opencode-go", "OpenCode Go", "OPENCODE_API_KEY", "Gateway", "coding models", "subscription"],
  ["litellm", "LiteLLM Gateway", "LITELLM_API_KEY", "Gateway", "unified gateway", "routing"],
  ["litellm_proxy", "LiteLLM Proxy", "LITELLM_API_KEY", "Gateway", "OpenAI-compatible", "routing"],
  ["openai_like", "OpenAI-compatible", "OPENAI_API_KEY", "Gateway", "custom endpoint", "bring your URL"],
  ["custom-openai", "Custom OpenAI-compatible", "CUSTOM_OPENAI_API_KEY", "Gateway", "custom endpoint", "bring your URL"],
  ["chatgpt", "ChatGPT Subscription", "CHATGPT_API_KEY", "Frontier", "subscription", "OpenAI"],
  ["zai", "Z.AI", "ZAI_API_KEY", "Frontier", "GLM", "reasoning"],
  ["minimax", "MiniMax", "MINIMAX_API_KEY", "Frontier", "M-series", "reasoning"],
  ["moonshot", "Moonshot AI", "MOONSHOT_API_KEY", "Frontier", "Kimi", "reasoning"],
  ["amazon_nova", "Amazon Nova", "AMAZON_NOVA_API_KEY", "Cloud", "AWS", "multimodal"],
  ["ai21", "AI21 Labs", "AI21_API_KEY", "Cloud", "Jamba", "enterprise"],
  ["cerebras", "Cerebras", "CEREBRAS_API_KEY", "Speed", "wafer-scale", "ultra-fast"],
  ["sambanova", "SambaNova", "SAMBANOVA_API_KEY", "Speed", "DataScale", "inference"],
  ["nebius", "Nebius AI Studio", "NEBIUS_API_KEY", "Speed", "EU cloud", "inference"],
  ["hyperbolic", "Hyperbolic", "HYPERBOLIC_API_KEY", "Speed", "open models", "inference"],
  ["deepinfra", "DeepInfra", "DEEPINFRA_API_KEY", "Speed", "open models", "inference"],
  ["replicate", "Replicate", "REPLICATE_API_TOKEN", "Open", "open models", "community"],
  ["huggingface", "Hugging Face", "HF_TOKEN", "Open", "open models", "inference"],
  ["featherless_ai", "Featherless AI", "FEATHERLESS_AI_API_KEY", "Open", "open models", "serverless"],
  ["friendliai", "FriendliAI", "FRIENDLI_TOKEN", "Speed", "inference", "fast"],
  ["baseten", "Baseten", "BASETEN_API_KEY", "Speed", "deployments", "inference"],
  ["databricks", "Databricks", "DATABRICKS_API_KEY", "Enterprise", "foundation models", "workspace"],
  ["snowflake", "Snowflake Cortex", "SNOWFLAKE_API_KEY", "Enterprise", "Cortex", "warehouse"],
  ["watsonx", "IBM watsonx", "WATSONX_API_KEY", "Enterprise", "Granite", "enterprise"],
  ["azure_ai", "Azure AI Foundry", "AZURE_AI_API_KEY", "Enterprise", "Azure", "enterprise"],
  ["sagemaker", "AWS SageMaker", "SAGEMAKER_API_KEY", "Enterprise", "JumpStart", "AWS"],
  ["cloudflare", "Cloudflare AI", "CLOUDFLARE_API_TOKEN", "Gateway", "Workers AI", "edge"],
  ["vercel_ai_gateway", "Vercel AI Gateway", "VERCEL_AI_GATEWAY_API_KEY", "Gateway", "unified gateway", "routing"],
  ["portkey", "Portkey", "PORTKEY_API_KEY", "Gateway", "unified gateway", "routing"],
  ["helicone", "Helicone", "HELICONE_API_KEY", "Gateway", "observability", "routing"],
  ["ollama", "Ollama", "OLLAMA_API_KEY", "Local", "local models", "private"],
  ["lmstudio", "LM Studio", "LMSTUDIO_API_KEY", "Local", "local models", "desktop"],
  ["lm_studio", "LM Studio (legacy ID)", "LMSTUDIO_API_KEY", "Local", "local models", "desktop"],
  ["vllm", "vLLM", "VLLM_API_KEY", "Local", "self-hosted", "OpenAI API"],
  ["vllm-local", "vLLM (local)", "VLLM_API_KEY", "Local", "self-hosted", "private"],
  ["hosted_vllm", "Hosted vLLM", "VLLM_API_KEY", "Local", "self-hosted", "OpenAI API"],
  ["llamafile", "Llamafile", "LLAMAFILE_API_KEY", "Local", "local models", "single file"],
  ["oobabooga", "Text Generation WebUI", "OOBABOOGA_API_KEY", "Local", "local models", "self-hosted"],
  ["xinference", "Xinference", "XINFERENCE_API_KEY", "Local", "local models", "self-hosted"],
  ["docker_model_runner", "Docker Model Runner", "DOCKER_MODEL_RUNNER_API_KEY", "Local", "local models", "Docker"],
  ["nscale", "Nscale", "NSCALE_API_KEY", "Cloud", "EU sovereign", "inference"],
  ["ovhcloud", "OVHcloud AI Endpoints", "OVHCLOUD_API_KEY", "Cloud", "EU cloud", "sovereign"],
  ["scaleway", "Scaleway", "SCALEWAY_API_KEY", "Cloud", "EU cloud", "inference"],
  ["lambda_ai", "Lambda AI", "LAMBDA_API_KEY", "Cloud", "GPU cloud", "inference"],
  ["volcengine", "Volcano Engine", "VOLCENGINE_API_KEY", "Cloud", "Doubao", "inference"],
  ["dashscope", "Alibaba DashScope", "DASHSCOPE_API_KEY", "Cloud", "Qwen", "inference"],
  ["publicai", "PublicAI", "PUBLICAI_API_KEY", "Open", "open models", "inference"],
  ["together_ai", "Together AI (LiteLLM ID)", "TOGETHER_API_KEY", "Speed", "open models", "inference"],
  ["fireworks_ai", "Fireworks AI (LiteLLM ID)", "FIREWORKS_API_KEY", "Speed", "open models", "inference"],
  ["codestral", "Codestral", "CODESTRAL_API_KEY", "Open", "code models", "Mistral"],
  ["voyage", "Voyage AI", "VOYAGE_API_KEY", "Open", "embeddings", "retrieval"],
  ["jina_ai", "Jina AI", "JINA_API_KEY", "Open", "embeddings", "retrieval"],
  ["cohere_chat", "Cohere Chat", "COHERE_API_KEY", "Open", "Command", "chat"],
  ["meta_llama", "Meta Llama API", "META_API_KEY", "Open", "Llama", "open models"],
  ["morph", "Morph", "MORPH_API_KEY", "Open", "code models", "fast"],
  ["synthetic", "Synthetic", "SYNTHETIC_API_KEY", "Open", "open models", "inference"],
  ["poe", "Poe", "POE_API_KEY", "Gateway", "multi-model", "aggregation"],
  ["chutes", "Chutes", "CHUTES_API_KEY", "Open", "open models", "inference"],
  ["galadriel", "Galadriel", "GALADRIEL_API_KEY", "Open", "open models", "inference"],
  ["cometapi", "CometAPI", "COMETAPI_API_KEY", "Gateway", "multi-model", "aggregation"],
  ["aiml", "AI/ML API", "AIML_API_KEY", "Gateway", "multi-model", "aggregation"],
  ["oci", "Oracle OCI Generative AI", "OCI_API_KEY", "Enterprise", "OCI", "enterprise"],
  ["manus", "Manus", "MANUS_API_KEY", "Gateway", "agent API", "agents"],
  ["wandb", "W&B Inference", "WANDB_API_KEY", "Gateway", "inference", "observability"],
  ["lemonade", "Lemonade", "LEMONADE_API_KEY", "Local", "AMD local", "OpenAI API"],
  ["xiaomi_mimo", "Xiaomi MiMo", "XIAOMI_MIMO_API_KEY", "Open", "MiMo", "multimodal"],
  ["tensormesh", "TensorMesh", "TENSORMESH_API_KEY", "Open", "inference", "open models"],
  ["apertis", "Apertis", "APERTIS_API_KEY", "Open", "open models", "inference"],
  ["bytez", "Bytez", "BYTEZ_API_KEY", "Open", "open models", "inference"],
  ["compactifai", "CompactifAI", "COMPACTIFAI_API_KEY", "Open", "inference", "optimization"],
  ["custom", "Custom Provider", "CUSTOM_API_KEY", "Gateway", "custom endpoint", "bring your URL"],
  ["datarobot", "DataRobot", "DATAROBOT_API_KEY", "Enterprise", "deployment", "enterprise"],
  ["fal_ai", "fal.ai", "FAL_AI_API_KEY", "Open", "media models", "inference"],
  ["gigachat", "GigaChat", "GIGACHAT_API_KEY", "Cloud", "chat", "inference"],
  ["inception", "Inception", "INCEPTION_API_KEY", "Open", "reasoning", "inference"],
  ["infinity", "Infinity", "INFINITY_API_KEY", "Local", "embeddings", "self-hosted"],
  ["maritalk", "Maritaca AI", "MARITALK_API_KEY", "Open", "chat", "inference"],
  ["modelscope", "ModelScope", "MODELSCOPE_API_KEY", "Open", "open models", "inference"],
  ["nano-gpt", "NanoGPT", "NANO_GPT_API_KEY", "Gateway", "multi-model", "aggregation"],
  ["nlp_cloud", "NLP Cloud", "NLP_CLOUD_API_KEY", "Cloud", "NLP", "inference"],
  ["novita", "Novita AI", "NOVITA_API_KEY", "Cloud", "open models", "inference"],
  ["nvidia_nim", "NVIDIA NIM (LiteLLM ID)", "NVIDIA_API_KEY", "Enterprise", "NIM", "inference"],
  ["petals", "Petals", "PETALS_API_KEY", "Open", "distributed", "open models"],
  ["predibase", "Predibase", "PREDIBASE_API_KEY", "Enterprise", "fine-tuning", "inference"],
  ["recraft", "Recraft", "RECRAFT_API_KEY", "Open", "image models", "generation"],
  ["sagemaker_chat", "AWS SageMaker Chat", "SAGEMAKER_API_KEY", "Enterprise", "JumpStart", "AWS"],
  ["sagemaker_nova", "AWS SageMaker Nova", "SAGEMAKER_API_KEY", "Enterprise", "Nova", "AWS"],
  ["sap", "SAP AI Core", "SAP_API_KEY", "Enterprise", "enterprise", "inference"],
  ["stability", "Stability AI", "STABILITY_API_KEY", "Open", "image models", "generation"],
  ["tencent", "Tencent Hunyuan", "TENCENT_API_KEY", "Cloud", "Hunyuan", "inference"],
  ["topaz", "Topaz", "TOPAZ_API_KEY", "Open", "inference", "open models"],
  ["vertex_ai", "Vertex AI", "VERTEX_AI_API_KEY", "Cloud", "Gemini", "Google Cloud"],
  ["vertex_ai_beta", "Vertex AI (Beta)", "VERTEX_AI_API_KEY", "Cloud", "Gemini", "Google Cloud"],
].map(([id, name, keyEnv, category, featureA, featureB]) => ({
  id, name, keyEnv, category, features: [featureA, featureB], color: "var(--sky)",
}));

const PROVIDERS = [...CORE_PROVIDERS, ...DIRECTORY_PROVIDERS];
const EMPTY_PROVIDER_KEYS = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, null])) as Record<string, string | null>;

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



const BROWSER_OPTIONS = [
  {
    id: "playwright",
    name: "Playwright",
    note: "Default stack: stronger context isolation, iframe recovery, persistent contexts",
  },
];

const SETTINGS_TABS = [
  { id: "models", label: "Models" },
  { id: "api-keys", label: "Provider Keys" },
  { id: "browser", label: "Browser" },
  { id: "mcp-tools", label: "MCP Tools" },
  { id: "display", label: "Display" },
  { id: "notifications", label: "Notifications" },
  { id: "account", label: "Account" },
];

const SETTINGS_TAB_ICONS = {
  models: Cpu,
  browser: Globe,
  display: Monitor,
  "api-keys": Key,
  account: ShieldCheck,
  notifications: Bell,
  "mcp-tools": Layers,
};

const TAB_DETAILS = {
  models: {
    title: "Models",
    description:
      "Assign models per agent, inspect live provider defaults, and verify what the runtime actually applies. Keys are BYOK — set them in Provider Keys.",
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
    title: "Provider Keys",
    description:
      "BYOK — paste provider keys here. They are saved to runtime config (data/settings.runtime.yaml), masked in the UI, and never baked into images. Leave blank to keep existing, or clear to remove.",
    storage: "server",
    saveLabel: "Save provider keys",
  },
  account: {
    title: "Account",
    description:
      "Manage password, 2FA (TOTP), and passkeys. BYOK provider keys live in API Keys — this is console login.",
    storage: "server",
    saveLabel: "Save account settings",
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


const EMPTY_TUNING = {
  provider_defaults: {},
  model_overrides: {},
  agent_overrides: {},
};


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

function normalizeStringList(value: any, fallback = []) {
  let rows = [];
  if (Array.isArray(value))
    rows = value.map((item) => String(item || "").trim());
  else if (typeof value === "string")
    rows = value.split(",").map((item) => item.trim());
  else rows = fallback;

  const seen = new Set();
  const deduped: any[] = [];
  rows.forEach((item) => {
    if (!item) return;
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(item);
  });
  return deduped;
}

function normalizeTuning(tuning: any) {
  if (!tuning || typeof tuning !== "object") return { ...EMPTY_TUNING };

  const providerDefaults: Record<string, any> = {};
  Object.entries(tuning.provider_defaults || {}).forEach(
    ([provider, value]) => {
      if (value && typeof value === "object")
        providerDefaults[String(provider).toLowerCase()] = { ...value };
    },
  );

  const modelOverrides: Record<string, any> = {};
  Object.entries(tuning.model_overrides || {}).forEach(([key, value]) => {
    if (value && typeof value === "object")
      modelOverrides[String(key).toLowerCase()] = { ...value };
  });

  const agentOverrides: Record<string, any> = {};
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
  config: any,
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
  AGENT_SLOTS.forEach(({  id  }: any) => {
    const row = (config as any)[id];
    const normalizedProvider = String(
      // @ts-expect-error -- strict migration
      row?.provider || defaults[id].provider || fallbackProvider,
    ).toLowerCase();
    const allowedProviders = new Set(PROVIDERS.map((providerOption: any) => providerOption.id));
    const finalProvider = allowedProviders.has(normalizedProvider) ? normalizedProvider : fallbackProvider;
    // @ts-expect-error -- strict migration
    next[id] = {
      provider: finalProvider,
      // @ts-expect-error -- strict migration
      model: String(row?.model || defaults[id].model || ""),
    };
  });
  return next;
}

function normalizeBrowserRuntime(value: any) {
  const base = cloneBrowserRuntime();
  if (!value || typeof value !== "object") return base;

  BROWSER_OPTIONS.forEach(({  id  }: any) => {
    const current = value[id];
    if (!current || typeof current !== "object") return;
    const picked = {};
    BROWSER_RUNTIME_KEYS.forEach((key) => {
      // @ts-expect-error -- strict migration
      if (current[key] !== undefined) picked[key] = current[key];
    });
    // @ts-expect-error -- strict migration
    base[id] = {
      // @ts-expect-error -- strict migration
      ...base[id],
      ...picked,
      extra_launch_args: normalizeStringList(
        // @ts-expect-error -- strict migration
        picked.extra_launch_args,
        // @ts-expect-error -- strict migration
        base[id].extra_launch_args,
      ),
      adblock_allowlist_hosts: normalizeStringList(
        // @ts-expect-error -- strict migration
        picked.adblock_allowlist_hosts,
        // @ts-expect-error -- strict migration
        base[id].adblock_allowlist_hosts,
      ),
    };
  });

  return base;
}

function normalizeDisabledToolsByBrowserProfile(value: any, legacy = {}) {
  const next = Object.fromEntries(
    BROWSER_OPTIONS.map(({  id  }: any) => [
      id,
      Object.fromEntries(
        Object.keys(MCP_TOOLS_BY_PROFILE).map((profile) => [
          profile,
          // @ts-expect-error -- strict migration
          normalizeStringList(legacy[profile] || []),
        ]),
      ),
    ]),
  );

  if (!value || typeof value !== "object") return next;

  Object.keys(MCP_TOOLS_BY_PROFILE).forEach((profile) => {
    if (Array.isArray(value[profile])) {
      BROWSER_OPTIONS.forEach(({  id  }: any) => {
        next[id][profile] = normalizeStringList(value[profile]);
      });
    }
  });

  BROWSER_OPTIONS.forEach(({  id  }: any) => {
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





function getModelCapabilities(modelMeta: any) {
  return modelMeta?.capabilities || {};
}










function buildCompatibilityWarnings({ 
  thinkingEnabled,
  explicitCacheEnabled,
  selections,
  catalogModels,
 }: any) {
  const catalogMap = new Map(
    (catalogModels || []).map((model: any) => [String(model.id || "").toLowerCase(), model]),
  );
  const warnings: any[] = [];
  (selections || []).forEach((selection: any) => {
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




function StatusPill({  tone = "neutral", children  }: any) {
  const mappedTone = tone === "success" ? "success" : tone === "warning" ? "warning" : tone === "info" ? "signal" : "default";
  return (
    <Badge tone={mappedTone} className="px-2.5 py-1 text-[11px] font-medium">
      {children}
    </Badge>
  );
}

function ErrorNotice({  message  }: any) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span className="leading-relaxed">{message}</span>
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
 }: any) {
  // @ts-expect-error -- strict migration
  const meta = TAB_DETAILS[tabId] || TAB_DETAILS.models;
  const isServerTab = meta.storage === "server";
  const isBrowserTab = meta.storage === "browser";
  // @ts-expect-error -- strict migration
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

function SettingsTabBar({ active, onChange, dirtyTabs = {}, mobile = false, filterIds = null }: any) {
  const visibleTabs = filterIds ? SETTINGS_TABS.filter((tab: any) => (filterIds as string[]).includes(tab.id)) : SETTINGS_TABS;
  return (
    <nav className={cn("gap-1", mobile ? "flex overflow-x-auto pb-1" : "flex flex-col")}>
      {mobile || filterIds ? null : (
        <div className="mb-2 border-b border-border/60 px-2 pb-3 text-[11px] font-[600] uppercase tracking-[0.08em] text-muted-foreground/70">
          Configuration
        </div>
      )}
      {visibleTabs.map((tab) => {
        const isActive = active === tab.id;
        const isDirty = dirtyTabs[tab.id];
        // @ts-expect-error -- strict migration
        const Icon = SETTINGS_TAB_ICONS[tab.id];
        // @ts-expect-error -- strict migration
        const meta = TAB_DETAILS[tab.id];
        return (
          <Button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            variant="ghost"
            className={cn(
              "h-auto w-full justify-between rounded-[6px] border text-left transition-colors",
              mobile ? "shrink-0 px-3 py-2.5" : "px-2.5 py-2",
              isActive
                ? "border-border bg-muted/60 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground/80",
            )}
          >
            <span className={cn("flex gap-2.5", mobile ? "items-center" : "items-start")}>
              {Icon ? <Icon className="mt-0.5 size-[14px] shrink-0" /> : null}
              <span className="min-w-0">
                <span className="block text-[13px] font-[510] tracking-[-0.12px] leading-none">{tab.label}</span>
                {mobile ? null : (
                  <span className="mt-1 block text-[11px] font-[400] leading-snug tracking-[-0.12px] text-muted-foreground/70">
                    {meta?.storage === "server"
                      ? "Runtime config"
                      : meta?.storage === "browser"
                        ? "Browser only"
                        : "Status"}
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
















export function SettingsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { prefs: notifPrefs, setPrefs: setNotifPrefs } = useNotifPrefs();

  const requestedTab = searchParams.get("tab") || "models";
  const activeTab = SETTINGS_TABS.some((tab) => tab.id === requestedTab)
    ? requestedTab
    : "models";

  useEffect(() => {
    if (requestedTab === activeTab) return;
    const params = new URLSearchParams(searchParams.toString());
    if (activeTab === "models") params.delete("tab");
    else params.set("tab", activeTab);
    const query = params.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
  }, [activeTab, pathname, requestedTab, router, searchParams]);

  function setActiveTab(nextTab: any) {
    if (nextTab === activeTab) return;

    const params = new URLSearchParams(searchParams.toString());
    if (nextTab === "models") params.delete("tab");
    else params.set("tab", nextTab);

    const query = params.toString();
    router.push(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
  }

  const [config, setConfig] = useState<any>(null);
  const [savedConfigSnapshot, setSavedConfigSnapshot] = useState<any>(null);
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
  const [keyEdits, setKeyEdits] = useState<Record<string, string | null>>(() => ({ ...EMPTY_PROVIDER_KEYS }));
  const [baseUrlEdits, setBaseUrlEdits] = useState<Record<string, string | null>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [keyTestState, setKeyTestState] = useState<Record<string, string>>({});
  const [providerKeyQuery, setProviderKeyQuery] = useState("");
  const [providerKeyCategory, setProviderKeyCategory] = useState<string>("All");
  const [providerKeyStatus, setProviderKeyStatus] = useState<string>("All");
  const [savedTab, setSavedTab] = useState("");
  const [configErr, setConfigErr] = useState("");
  const [saveMismatchWarning, setSaveMismatchWarning] = useState("");
  const [modelConfigWarnings, setModelConfigWarnings] = useState([]);

  const apiKeys = config?.api_keys || {};
  const activeProvider =
    PROVIDERS.find((item) => item.id === provider) || PROVIDERS[0];
  // @ts-expect-error -- strict migration
  const activeCatalog = providerCatalogs[provider] || null;
  // @ts-expect-error -- strict migration
  const activePricingStatus = pricingStatus[provider] || null;
  const activeBrowserRuntime =
    // @ts-expect-error -- strict migration
    browserRuntime[browserSettingsTab] ||
    // @ts-expect-error -- strict migration
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
  const enabledToolCount =
    // @ts-expect-error -- strict migration
    (MCP_TOOLS_BY_PROFILE[activeProfileTab] || []).length -
    activeMcpDisabledTools.length;
  const modelSelectionDetails = useMemo(
    () => config?.model_selection_details || {},
    [config?.model_selection_details],
  );

  const modelOverrideTargets = useMemo(() => {
    const byModel = new Map();
    AGENT_SLOTS.forEach(({  id, label  }: any) => {
      // @ts-expect-error -- strict migration
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
        (field: any) => !field.model_patterns?.length,
      ),
    [activeCatalog],
  );

  const catalogModels = useMemo(() => activeCatalog?.models || [], [activeCatalog]);
  const filteredCatalogModels = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase();
    if (!query) return catalogModels;
    return catalogModels.filter((model: any) => {
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
    if (catalogModels.some((item: any) => item.id === selectedCatalogModelId)) return;
    const preferredModelId = modelOverrideTargets[0]?.id;
    const fallbackSelection =
      catalogModels.find((item: any) => item.id === preferredModelId)?.id ||
      catalogModels[0]?.id ||
      "";
    setSelectedCatalogModelId(fallbackSelection);
  }, [catalogModels, modelOverrideTargets, selectedCatalogModelId]);

  const selectedCatalogModel =
    catalogModels.find((item: any) => item.id === selectedCatalogModelId) || null;


  const assignmentRows = useMemo(
    () =>
      AGENT_SLOTS.map((slot) => {
        // @ts-expect-error -- strict migration
        const selection = agentModelConfig[slot.id] || { provider, model: "" };
        const detail = modelSelectionDetails[slot.id] || {};
        const modelMeta =
          catalogModels.find(
            (item: any) =>
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
    // @ts-expect-error -- strict migration
    const rows = [];
    const seen = new Set();
    const pushUnique = (item: any) => {
      const message = String(item?.message || "").trim();
      if (!message || seen.has(message)) return;
      seen.add(message);
      rows.push(item);
    };
    draftCompatibilityWarnings.forEach(pushUnique);
    (modelConfigWarnings || []).forEach((item, index) =>
      pushUnique({
        // @ts-expect-error -- strict migration
        id: `${item.type || "warning"}-${item.agent_id || index}`,
        tone:
          // @ts-expect-error -- strict migration
          item.type?.includes("unavailable") || item.type?.includes("disabled")
            ? "warning"
            : "default",
        // @ts-expect-error -- strict migration
        message: item.message || String(item),
      }),
    );
    // @ts-expect-error -- strict migration
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

  const _baseDirtyTabs = useMemo(
    () => getDirtyTabs(savedConfigSnapshot, serverDraft),
    [savedConfigSnapshot, serverDraft],
  );
  const apiKeysDirty = useMemo(
    () => Object.values(keyEdits).some((value) => value !== null)
      || Object.values(baseUrlEdits).some((value) => value !== null),
    [baseUrlEdits, keyEdits],
  );
  const dirtyTabs = useMemo(() => ({ ..._baseDirtyTabs, "api-keys": apiKeysDirty }), [_baseDirtyTabs, apiKeysDirty]);
  const currentTabDirty = Boolean((dirtyTabs as any)[activeTab]);
  const otherDirtyCount = useMemo(
    () =>
      Object.entries(dirtyTabs).filter(
        ([tabId, dirty]) => tabId !== activeTab && dirty,
      ).length,
    [activeTab, dirtyTabs],
  );

  useEffect(() => {
    if (savedTab && (dirtyTabs as any)[savedTab]) setSavedTab("");
  }, [dirtyTabs, savedTab]);

  async function loadProviderCatalog(providerId: any, { force = false } = {}) {
    if (!providerId) return null;
    // @ts-expect-error -- strict migration
    if (!force && providerCatalogs[providerId])
      // @ts-expect-error -- strict migration
      return providerCatalogs[providerId];

    setCatalogLoading(providerId);
    try {
      const payload = await apiFetch(
        `/ui/providers/models?provider=${encodeURIComponent(providerId)}`,
      );
      setProviderCatalogs((current) => ({ ...current, [providerId]: payload }));
      return payload;
    } catch (error: any) {
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
      // @ts-expect-error -- strict migration
      setPricingStatus(payload?.provider_statuses || {});
      return payload;
    } catch (error: any) {
      return null;
    }
  }

  async function syncPricing(providerId = provider) {
    const targetProvider = String(providerId || "").trim().toLowerCase();
    if (!targetProvider) return;
    setPricingSyncLoading(targetProvider);
    setConfigErr("");
    try {
      await apiFetch("/ui/pricing/sync", {
        method: "POST",
        body: JSON.stringify({ provider: targetProvider }),
      });
      await loadPricingStatus();
    } catch (error: any) {
      setConfigErr(error.message || "Could not sync provider pricing.");
    } finally {
      setPricingSyncLoading("");
    }
  }

  async function hydrateConfig(payload: any, { refreshCatalogs = true } = {}) {
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
      normalizeDisabledToolsByBrowserProfile({}, {}),
    );
    setModelConfigWarnings(payload.model_config_warnings || []);
    setActiveMcpBrowserTab(payload.browser_engine || "playwright");
    setKeyEdits({ ...EMPTY_PROVIDER_KEYS });
    setBaseUrlEdits({});
    setSavedTab("");

    if (refreshCatalogs) {
      const providersToLoad = [...new Set([
        fallbackProvider,
        ...Object.keys(payload.api_keys || {}).filter((providerId) => payload.api_keys[providerId]),
      ])];
      await Promise.all(
        providersToLoad.map((providerId) =>
          loadProviderCatalog(providerId, { force: true }).catch(() => null),
        ),
      );
    }
    await loadPricingStatus();
  }

  async function loadConfig() {
    try {
      const payload = await apiFetch("/ui/config");
      await hydrateConfig(payload);
    } catch (error: any) {
      setConfigErr(error.message || "Could not load settings.");
    }
  }

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateAgentModel(agentId: any, modelId: any) {
    setAgentModelConfig((current) => ({
      ...current,
      [agentId]: {
        // @ts-expect-error -- strict migration
        ...(current[agentId] || { provider, model: "" }),
        model: modelId,
      },
    }));
  }

  function updateAgentProvider(agentId: any, nextProvider: any) {
    const normalized = String(nextProvider || "google").toLowerCase();
    setAgentModelConfig((current) => ({
      ...current,
      [agentId]: {
        // @ts-expect-error -- strict migration
        ...(current[agentId] || { provider: normalized, model: "" }),
        provider: normalized,
      },
    }));
    // preload catalog for the new provider if not already loaded
    void loadProviderCatalog(normalized).catch(() => null);
  }

  function updateBrowserRuntime(browserId: any, key: any, value: any) {
    setBrowserRuntime((current) => ({
      ...current,
      [browserId]: {
        // @ts-expect-error -- strict migration
        ...current[browserId],
        [key]: value,
      },
    }));
  }

  function updateBrowserRuntimeList(browserId: any, key: any, value: any) {
    updateBrowserRuntime(browserId, key, normalizeStringList(value));
  }

  function activeBrowserTools() {
    return (
      disabledToolsByBrowserProfile[activeMcpBrowserTab]?.[activeProfileTab] ||
      []
    );
  }

  function setDisabledToolsForCurrentBrowserProfile(nextTools: any) {
    setDisabledToolsByBrowserProfile((current: any) => ({
      ...current,
      [activeMcpBrowserTab]: {
        ...current[activeMcpBrowserTab],
        [activeProfileTab]: normalizeStringList(nextTools),
      },
    }));
  }

  function buildSavePayloadForTab(tabId: any) {
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
          max_parallel_hosting_pages: serverDraft.max_parallel_hosting_pages,
        };
      case "mcp-tools":
        return {};
      case "api-keys": {
        const payload: Record<string, any> = {};
        if (keyEdits.google !== null) payload.google_api_key = keyEdits.google;
        if (keyEdits.openai !== null) payload.openai_api_key = keyEdits.openai;
        if (keyEdits.anthropic !== null) payload.anthropic_api_key = keyEdits.anthropic;
        if (keyEdits.openrouter !== null) payload.openrouter_api_key = keyEdits.openrouter;
        if (keyEdits.nvidia !== null) payload.nvidia_api_key = keyEdits.nvidia;
        if ((keyEdits as any).mistral !== null) payload.mistral_api_key = (keyEdits as any).mistral;
        if ((keyEdits as any).cohere !== null) payload.cohere_api_key = (keyEdits as any).cohere;
        if ((keyEdits as any).groq !== null) payload.groq_api_key = (keyEdits as any).groq;
        if ((keyEdits as any).together !== null) payload.together_api_key = (keyEdits as any).together;
        if ((keyEdits as any).fireworks !== null) payload.fireworks_api_key = (keyEdits as any).fireworks;
        if ((keyEdits as any).perplexity !== null) payload.perplexity_api_key = (keyEdits as any).perplexity;
        if ((keyEdits as any).deepseek !== null) payload.deepseek_api_key = (keyEdits as any).deepseek;
        if ((keyEdits as any).xai !== null) payload.xai_api_key = (keyEdits as any).xai;
        if ((keyEdits as any).upstage !== null) payload.upstage_api_key = (keyEdits as any).upstage;
        if ((keyEdits as any).azure !== null) payload.azure_api_key = (keyEdits as any).azure;
        if ((keyEdits as any).bedrock !== null) payload.bedrock_api_key = (keyEdits as any).bedrock;
        const providerApiKeys = Object.fromEntries(
          Object.entries(keyEdits).filter(([, value]) => value !== null),
        );
        const providerBaseUrls = Object.fromEntries(
          Object.entries(baseUrlEdits).filter(([, value]) => value !== null),
        );
        if (Object.keys(providerApiKeys).length) payload.provider_api_keys = providerApiKeys;
        if (Object.keys(providerBaseUrls).length) payload.provider_base_urls = providerBaseUrls;
        return Object.keys(payload).length ? payload : null;
      }
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
      const payload = await apiFetch<Record<string, any>>("/ui/config", {
        method: "PUT",
        body: JSON.stringify(payloadToSave),
      });
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
      await hydrateConfig(payload, { refreshCatalogs: false });
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
    } catch (error: any) {
      setConfigErr(error.message || "Could not save config.");
    } finally {
      setSaving(false);
    }
  }

  async function testProvider(providerId: string) {
    setKeyTestState((state) => ({ ...state, [providerId]: "testing" }));
    try {
      if ((keyEdits as any)[providerId] !== null || (baseUrlEdits as any)[providerId] !== null) {
        await saveConfig("api-keys");
      }
      const result = await loadProviderCatalog(providerId, { force: true });
      if (!result?.available && !result?.models?.length) throw new Error(result?.error || "No models returned");
      setKeyTestState((state) => ({ ...state, [providerId]: "ok" }));
      setTimeout(() => setKeyTestState((state) => {
        const next = { ...state };
        delete next[providerId];
        return next;
      }), 2500);
    } catch {
      setKeyTestState((state) => ({ ...state, [providerId]: "error" }));
      setTimeout(() => setKeyTestState((state) => {
        const next = { ...state };
        delete next[providerId];
        return next;
      }), 2500);
    }
  }

  const currentTabSaved = savedTab === activeTab && !currentTabDirty;
  const showConfigError =
    Boolean(configErr) &&
    // @ts-expect-error -- strict migration
    (!config || TAB_DETAILS[activeTab]?.storage === "server");

  const hasDirty = Object.values(dirtyTabs).some(Boolean);
  // @ts-expect-error -- strict migration
  const activeGlobalModel = agentModelConfig?.classification?.model || "";
  // @ts-expect-error -- strict migration
  const activeOrchestratorModel = agentModelConfig?.orchestrator?.model || "";

  function applySelectedCatalogModelAsGlobalDefault() {
    const modelId = String(selectedCatalogModelId || "").trim();
    if (!modelId) return;
    setConfigErr("");
    setSaveMismatchWarning("");
    setAgentModelConfig((current) => {
      const next = { ...current };
      // @ts-expect-error -- strict migration
      next.classification = { ...(next.classification || { provider, model: "" }), provider, model: modelId };
      // @ts-expect-error -- strict migration
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

  function applyGlobalDefaultToAllAgents() {
    setConfigErr("");
    setSaveMismatchWarning("");
    setAgentModelConfig((current: any) => {
      const global = current?.classification || { provider, model: "" };
      const next: any = { ...current };
      AGENT_SLOTS.forEach(({ id }: any) => {
        next[id] = { ...(next[id] || { provider, model: "" }), provider: global.provider, model: global.model };
      });
      return next;
    });
  }

  function handleGlobalProviderChange(nextProvider: string) {
    const normalized = String(nextProvider || "google").toLowerCase();
    setProvider(normalized);
    updateAgentProvider("classification", normalized);
  }

  function handleAgentInheritToggle(agentId: string, inherit: boolean) {
    if (!inherit) return;
    setAgentModelConfig((current: any) => ({
      ...current,
      [agentId]: { ...(current?.classification || { provider, model: "" }) },
    }));
  }

  function discardModelChanges() {
    if (!config) return;
    void hydrateConfig(config, { refreshCatalogs: false });
  }

  function handleAgentSlotProvider(agentId: string, nextProvider: string) {
    updateAgentProvider(agentId, nextProvider);
  }

  return (
    <div className="settings-page space-y-6" style={{ fontFeatureSettings: '"cv01","ss03"' }}>
      <div className="flex flex-col gap-4 border-b border-border/60 pb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div className="space-y-1.5">
            <h1 className="text-[20px] font-[590] tracking-[-0.24px] text-foreground">Settings</h1>
            <p className="max-w-[560px] text-[13px] leading-[1.6] tracking-[-0.12px] text-muted-foreground">Provider keys are BYOK in <span className="font-[500] text-foreground/80">Provider Keys</span> — no <span className="font-mono text-[12px] text-foreground/80">.env</span> for models. Browser, tools, and display stay separate.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={["inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-[500] tracking-[-0.12px]", hasDirty ? "border-[rgba(245,158,11,0.2)] bg-[rgba(245,158,11,0.12)] text-[var(--signal-text)]" : "border-border bg-muted/30 text-muted-foreground"].join(" ")}>
              <span className={["size-1.5 rounded-full", hasDirty ? "bg-[#f59e0b]" : "bg-[#10b981]"].join(" ")} />
              {hasDirty ? `${Object.values(dirtyTabs).filter(Boolean).length} unsaved` : "All saved"}
            </span>
            <span className={["inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-[500] tracking-[-0.12px]", activeCatalog?.available ? "border-[rgba(16,185,129,0.2)] bg-[rgba(16,185,129,0.10)] text-[var(--mint-text)]" : "border-border bg-muted/30 text-muted-foreground"].join(" ")}>
              <span className={["size-1.5 rounded-full", activeCatalog?.available ? "bg-[#10b981]" : "bg-[#62666d]"].join(" ")} />
              {activeCatalog?.available ? "Catalog live" : activeCatalog ? "Catalog offline" : "Loading catalog"}
            </span>
          </div>
        </div>
        <div className="lg:hidden">
          <SettingsTabBar active={activeTab} onChange={setActiveTab} dirtyTabs={dirtyTabs} mobile />
        </div>
      </div>
      <div className="flex items-start gap-6">
      {/* ── LEFT NAV — grouped, minimal ─────────────────────────── */}
      <div className="sticky top-6 hidden w-[220px] shrink-0 self-start lg:block">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <div className="px-2 text-[11px] font-[600] uppercase tracking-[0.08em] text-muted-foreground/70">AI Configuration</div>
            <SettingsTabBar active={activeTab} onChange={setActiveTab} dirtyTabs={dirtyTabs} filterIds={["models","api-keys"]} />
          </div>
          <div className="space-y-1.5">
            <div className="px-2 text-[11px] font-[600] uppercase tracking-[0.08em] text-muted-foreground/70">Runtime</div>
            <SettingsTabBar active={activeTab} onChange={setActiveTab} dirtyTabs={dirtyTabs} filterIds={["browser","mcp-tools"]} />
          </div>
          <div className="space-y-1.5">
            <div className="px-2 text-[11px] font-[600] uppercase tracking-[0.08em] text-muted-foreground/70">Preferences</div>
            <SettingsTabBar active={activeTab} onChange={setActiveTab} dirtyTabs={dirtyTabs} filterIds={["display","notifications"]} />
          </div>
          <div className="space-y-1.5">
            <div className="px-2 text-[11px] font-[600] uppercase tracking-[0.08em] text-muted-foreground/70">Security</div>
            <SettingsTabBar active={activeTab} onChange={setActiveTab} dirtyTabs={dirtyTabs} filterIds={["account"]} />
          </div>
          <div className="rounded-[8px] border border-border bg-muted/20 px-3 py-3">
            <div className="text-[11px] font-[600] uppercase tracking-[0.06em] text-muted-foreground">Status</div>
            <div className="mt-3 space-y-2.5">
              <div className="flex items-center justify-between text-[12px]"><span className="tracking-[-0.12px] text-muted-foreground">Catalog</span><span className={["inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-[500]", activeCatalog?.available ? "bg-[rgba(16,185,129,0.12)] text-[var(--mint-text)]" : "bg-muted/60 text-muted-foreground/70"].join(" ")}><span className={["size-1 rounded-full", activeCatalog?.available ? "bg-[#10b981]" : "bg-[#62666d]"].join(" ")} />{activeCatalog?.available ? "Live" : "Offline"}</span></div>
              <div className="flex items-center justify-between text-[12px]"><span className="tracking-[-0.12px] text-muted-foreground">Keys</span><span className="font-[500] tracking-[-0.12px] text-foreground">{Object.values(apiKeys).filter(Boolean).length || 0} / {PROVIDERS.length}</span></div>
              <div className="h-px bg-muted/60" />
              <div className="flex items-center justify-between text-[12px]"><span className="tracking-[-0.12px] text-muted-foreground">Unsaved</span><span className={["text-[12px] font-[500] tracking-[-0.12px]", hasDirty ? "text-[var(--signal-text)]" : "text-muted-foreground/70"].join(" ")}>{hasDirty ? String(Object.values(dirtyTabs).filter(Boolean).length) : "—"}</span></div>
            </div>
          </div>
        </div>
      </div>

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
            <ModelsTab
              provider={provider}
              providers={PROVIDERS}
              agentModelConfig={agentModelConfig}
              fallbackTemperature={fallbackTemperature}
              providerCacheEnabled={providerCacheEnabled}
              geminiExplicitCacheEnabled={geminiExplicitCacheEnabled}
              geminiExplicitCacheTtl={geminiExplicitCacheTtl}
              geminiExplicitCacheRefreshLead={geminiExplicitCacheRefreshLead}
              toolCacheEnabled={toolCacheEnabled}
              toolCacheStable={toolCacheStable}
              thinkingEnabled={thinkingEnabled}
              thinkingBudgetTokens={thinkingBudgetTokens}
              maxParallelHostingPages={maxParallelHostingPages}
              catalogModels={catalogModels}
              catalogQuery={catalogQuery}
              selectedCatalogModelId={selectedCatalogModelId}
              catalogAssignmentTarget={catalogAssignmentTarget}
              catalogLoading={catalogLoading}
              pricingSyncLoading={pricingSyncLoading}
              activeCatalog={activeCatalog}
              activePricingStatus={activePricingStatus}
              apiKeys={apiKeys}
              dirtyCount={Object.values(dirtyTabs).filter(Boolean).length}
              dirty={currentTabDirty}
              saving={saving}
              warnings={mergedModelWarnings}
              modelSelectionDetails={modelSelectionDetails}
              savedGlobal={config?.agent_model}
              savedOrchestrator={config?.orchestrator_model}
              onProviderChange={handleGlobalProviderChange}
              onApplyToAllAgents={applyGlobalDefaultToAllAgents}
              onUpdateAgentModel={updateAgentModel}
              onUpdateAgentProvider={handleAgentSlotProvider}
              onInheritToggle={handleAgentInheritToggle}
              onFallbackTemperature={setFallbackTemperature}
              onProviderCache={setProviderCacheEnabled}
              onGeminiExplicitCache={setGeminiExplicitCacheEnabled}
              onGeminiExplicitCacheTtl={setGeminiExplicitCacheTtl}
              onGeminiExplicitCacheRefreshLead={setGeminiExplicitCacheRefreshLead}
              onToolCache={setToolCacheEnabled}
              onToolCacheStable={setToolCacheStable}
              onThinking={setThinkingEnabled}
              onThinkingBudget={setThinkingBudgetTokens}
              onMaxParallel={setMaxParallelHostingPages}
              onCatalogQuery={setCatalogQuery}
              onSelectCatalogModel={setSelectedCatalogModelId}
              onCatalogTarget={setCatalogAssignmentTarget}
              onApplyCatalogToTarget={applySelectedCatalogModelToTarget}
              onRefreshCatalog={() => loadProviderCatalog(provider, { force: true })}
              onSyncPricing={() => syncPricing(provider)}
              onDiscard={discardModelChanges}
              onSave={() => saveConfig("models")}
            />
          ) : null}

          {activeTab === "browser" ? (
            <BrowserTab
              runtime={activeBrowserRuntime}
              maxParallelHostingPages={maxParallelHostingPages}
              source={String(config?.source_layer ?? config?.source ?? "default")}
              dirty={Boolean((dirtyTabs as any)?.browser)}
              saving={saving}
              syncStatus={browserRuntimeSyncStatus}
              onRuntimeChange={(key, value) => updateBrowserRuntime(browserSettingsTab, key, value)}
              onRuntimeListChange={(key, value) => updateBrowserRuntimeList(browserSettingsTab, key, value)}
              onMaxParallelChange={setMaxParallelHostingPages}
              onSave={() => saveConfig("browser")}
            />
          ) : null}

          {activeTab === "mcp-tools" ? (
            <McpToolsTab manifestTools={Array.isArray((config as any)?.browser_manifest) ? (config as any).browser_manifest : undefined} />
          ) : null}

          {activeTab === "api-keys" ? (
            <ApiKeysTab
              providers={PROVIDERS}
              apiKeys={apiKeys}
              keyEdits={keyEdits}
              baseUrlEdits={baseUrlEdits}
              showKey={showKey}
              keyTestState={keyTestState}
              providerKeyQuery={providerKeyQuery}
              providerKeyCategory={providerKeyCategory}
              providerKeyStatus={providerKeyStatus}
              configuredBaseUrls={(config as any)?.provider_base_urls || {}}
              registryBaseUrls={Object.fromEntries(((config as any)?.provider_registry || []).map((row: any) => [row.id, row.base_url || ""]))}
              onQuery={setProviderKeyQuery}
              onCategory={setProviderKeyCategory}
              onStatus={setProviderKeyStatus}
              onKeyEdit={(id, v) => setKeyEdits((s: any) => ({ ...s, [id]: v }))}
              onKeyClear={(id) => setKeyEdits((s: any) => ({ ...s, [id]: "" }))}
              onKeyUndo={(id) => setKeyEdits((s: any) => ({ ...s, [id]: null }))}
              onToggleShow={(id) => setShowKey((s: any) => ({ ...s, [id]: !(s as any)[id] }))}
              onBaseUrlEdit={(id, v) => setBaseUrlEdits((s: any) => ({ ...s, [id]: v }))}
              onTest={testProvider}
              onClearFilters={() => { setProviderKeyQuery(""); setProviderKeyCategory("All"); setProviderKeyStatus("All"); }}
            />
          ) : null}

{activeTab === "display" ? <DisplayTab /> : null}

          {activeTab === "account" ? (
            <section className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">Account</h2>
                <p className="mt-1 text-sm text-muted-foreground">Passwords, 2FA, and passkeys for the console login.</p>
              </div>
              <AccountTab />
            </section>
          ) : null}

          {activeTab === "notifications" ? (
            <NotificationsTab prefs={notifPrefs} onChange={setNotifPrefs} />
          ) : null}
        </div>
      </div>
    </div>
    </div>
  );
}

/* ── Display settings section ─────────────────────────────────────────────── */