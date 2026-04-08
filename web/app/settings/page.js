"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, CheckCircle2, Key, Loader2, RefreshCw, Save, Settings2 } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { JsonViewer } from "@/components/json-viewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/* ─── provider catalog ───────────────────────────────────────────────────── */

const PROVIDERS = [
  {
    id: "google",
    name: "Google Gemini",
    keyEnv: "GOOGLE_API_KEY",
    models: [
      { id: "gemini-2.5-pro",        label: "Gemini 2.5 Pro",         note: "Most capable" },
      { id: "gemini-2.5-flash",      label: "Gemini 2.5 Flash",       note: "Recommended" },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite",  note: "Fast / cheap" },
      { id: "gemini-2.0-flash",      label: "Gemini 2.0 Flash",       note: "" },
      { id: "gemini-1.5-pro",        label: "Gemini 1.5 Pro",         note: "" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    models: [
      { id: "gpt-4o",           label: "GPT-4o",           note: "Most capable" },
      { id: "gpt-4o-mini",      label: "GPT-4o Mini",      note: "Recommended" },
      { id: "gpt-4-turbo",      label: "GPT-4 Turbo",      note: "" },
      { id: "gpt-3.5-turbo",    label: "GPT-3.5 Turbo",    note: "Fast / cheap" },
      { id: "o1-mini",          label: "o1 Mini",           note: "Reasoning" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-opus-4-6",      label: "Claude Opus 4.6",      note: "Most capable" },
      { id: "claude-sonnet-4-6",    label: "Claude Sonnet 4.6",    note: "Recommended" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", note: "Fast / cheap" },
      { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet", note: "" },
      { id: "claude-3-5-haiku-20241022",  label: "Claude 3.5 Haiku",  note: "Fast" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    models: [
      { id: "openai/gpt-4o",                    label: "OpenAI GPT-4o",        note: "" },
      { id: "openai/gpt-4o-mini",               label: "OpenAI GPT-4o Mini",   note: "" },
      { id: "anthropic/claude-sonnet-4-6",      label: "Anthropic Sonnet 4.6", note: "" },
      { id: "google/gemini-2.5-flash",          label: "Google Gemini 2.5 Flash", note: "" },
      { id: "meta-llama/llama-3.3-70b-instruct",label: "Llama 3.3 70B",        note: "Open source" },
      { id: "deepseek/deepseek-chat",           label: "DeepSeek Chat",        note: "Budget" },
    ],
  },
];

/* ─── components ─────────────────────────────────────────────────────────── */

function KeyStatus({ set }) {
  return set ? (
    <span className="flex items-center gap-1 text-xs text-surge">
      <CheckCircle2 className="h-3 w-3" />set
    </span>
  ) : (
    <span className="flex items-center gap-1 text-xs text-slate-600">
      <AlertCircle className="h-3 w-3" />not set
    </span>
  );
}

function ProviderCard({ provider, active, apiKeySet, agentModel, orchModel, onSelect }) {
  const isActive = active === provider.id;
  return (
    <button
      onClick={() => onSelect(provider)}
      className={`w-full rounded-xl border p-4 text-left transition-colors ${
        isActive
          ? "border-signal/50 bg-signal/10"
          : "border-white/8 bg-white/[0.03] hover:border-white/20"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-white">{provider.name}</span>
        <div className="flex items-center gap-2">
          <KeyStatus set={apiKeySet} />
          {isActive && <Badge tone="signal">Active</Badge>}
        </div>
      </div>
      <div className="mt-1 text-xs text-slate-600">{provider.keyEnv}</div>
      {isActive && (
        <div className="mt-3 space-y-1 text-xs text-slate-400">
          <div>Agent: <span className="font-mono text-slate-200">{agentModel}</span></div>
          <div>Orchestrator: <span className="font-mono text-slate-200">{orchModel}</span></div>
        </div>
      )}
    </button>
  );
}

/* ─── main ───────────────────────────────────────────────────────────────── */

export default function SettingsPage() {
  /* LLM config state */
  const [config, setConfig]       = useState(null);
  const [provider, setProvider]   = useState("google");
  const [agentModel, setAgent]    = useState("");
  const [orchModel, setOrch]      = useState("");
  const [temp, setTemp]           = useState("1.0");
  const [providerCacheEnabled, setProviderCacheEnabled] = useState(true);
  const [toolCacheEnabled, setToolCacheEnabled] = useState(true);
  const [toolCacheStable, setToolCacheStable] = useState("2");
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [configErr, setConfigErr] = useState("");

  /* Pricing state */
  const [pricing, setPricing]     = useState({ stored: [], env_defaults: [] });
  const [pProvider, setPProvider] = useState("google");
  const [pModel, setPModel]       = useState("gemini-2.5-flash");
  const [pInput, setPInput]       = useState("0");
  const [pOutput, setPOutput]     = useState("0");
  const [pNotes, setPNotes]       = useState("");
  const [priceSaved, setPriceSaved] = useState(false);
  const [priceSyncing, setPriceSyncing] = useState(false);
  const [priceSyncMsg, setPriceSyncMsg] = useState("");
  const [priceSyncErr, setPriceSyncErr] = useState("");

  /* load config */
  async function loadConfig() {
    try {
      const c = await apiFetch("/ui/config");
      setConfig(c);
      setProvider(c.llm_provider || "google");
      setPProvider(c.llm_provider || "google");
      setAgent(c.agent_model || "");
      setOrch(c.orchestrator_model || "");
      setTemp(String(c.gemini_temperature ?? "1.0"));
      setProviderCacheEnabled(Boolean(c.provider_cache_enabled ?? true));
      setToolCacheEnabled(Boolean(c.tool_result_cache_enabled ?? true));
      setToolCacheStable(String(c.tool_result_cache_min_identical_observations ?? 2));
    } catch (e) {
      setConfigErr(e.message);
    }
  }

  async function loadPricing() {
    const p = await apiFetch("/ui/pricing");
    setPricing(p);
  }

  useEffect(() => {
    loadConfig();
    loadPricing();
  }, []);

  function selectProvider(p) {
    setProvider(p.id);
    const first = p.models[0];
    if (first) {
      setAgent(first.id);
      setOrch(first.id);
    }
  }

  async function saveConfig() {
    setSaving(true);
    setConfigErr("");
    try {
      const res = await fetch(apiUrl("/ui/config"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llm_provider: provider,
          agent_model: agentModel,
          orchestrator_model: orchModel,
          gemini_temperature: parseFloat(temp) || 1.0,
          provider_cache_enabled: providerCacheEnabled,
          tool_result_cache_enabled: toolCacheEnabled,
          tool_result_cache_min_identical_observations: Number(toolCacheStable || 2),
        }),
      });
      const updated = await res.json();
      if (!res.ok) throw new Error(updated.detail || `Status ${res.status}`);
      setConfig(updated);
      if (updated.config_persisted === false) {
        setConfigErr(updated.config_persist_error || "Config updated in memory, but could not be persisted to disk.");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setConfigErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function savePricing() {
    await fetch(apiUrl("/ui/pricing"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: pProvider,
        model_name: pModel,
        input_per_million: Number(pInput || 0),
        output_per_million: Number(pOutput || 0),
        active: true,
        notes: pNotes,
      }),
    });
    setPriceSaved(true);
    setTimeout(() => setPriceSaved(false), 2500);
    await loadPricing();
  }

  async function syncPricingFromProvider() {
    setPriceSyncing(true);
    setPriceSyncErr("");
    setPriceSyncMsg("");
    try {
      const res = await fetch(apiUrl("/ui/pricing/sync"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: pProvider }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.detail || `Status ${res.status}`);
      setPriceSyncMsg(`Synced ${payload.stored || 0} model pricing row(s) from ${payload.provider}.`);
      await loadPricing();
    } catch (e) {
      setPriceSyncErr(e.message || "Provider pricing sync failed.");
    } finally {
      setPriceSyncing(false);
    }
  }

  const activeProvider = PROVIDERS.find((p) => p.id === provider) || PROVIDERS[0];
  const apiKeys = config?.api_keys || {};

  return (
    <div className="space-y-8">

      {/* header */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-spark">Settings</p>
        <h1 className="mt-1 text-2xl font-semibold text-white">Provider & model configuration</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Switch LLM provider and model at runtime. API keys are set in <code className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-xs text-slate-300">.env</code> and never exposed here.
        </p>
      </div>

      {/* ── LLM provider ───────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-600">LLM Provider</h2>

        {/* provider cards */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {PROVIDERS.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              active={provider}
              apiKeySet={apiKeys[p.id]}
              agentModel={agentModel}
              orchModel={orchModel}
              onSelect={selectProvider}
            />
          ))}
        </div>

        {/* model selectors */}
        <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-signal" />
            <span className="text-sm font-semibold text-white">Model selection — {activeProvider.name}</span>
          </div>

          {!apiKeys[provider] && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-400">
              <Key className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                <strong>{activeProvider.keyEnv}</strong> is not set. Add it to your <code className="font-mono">.env</code> file and rebuild the container.
              </span>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">
                Agent model
              </label>
              <select
                value={agentModel}
                onChange={(e) => setAgent(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-200 focus:border-signal/50 focus:outline-none"
              >
                {activeProvider.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}{m.note ? ` — ${m.note}` : ""}
                  </option>
                ))}
                {/* allow custom entry */}
                {agentModel && !activeProvider.models.find((m) => m.id === agentModel) && (
                  <option value={agentModel}>{agentModel} (custom)</option>
                )}
              </select>
              <p className="text-xs text-slate-600">Used by classification, landing, hosting, embedded agents</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">
                Orchestrator model
              </label>
              <select
                value={orchModel}
                onChange={(e) => setOrch(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-200 focus:border-signal/50 focus:outline-none"
              >
                {activeProvider.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}{m.note ? ` — ${m.note}` : ""}
                  </option>
                ))}
                {orchModel && !activeProvider.models.find((m) => m.id === orchModel) && (
                  <option value={orchModel}>{orchModel} (custom)</option>
                )}
              </select>
              <p className="text-xs text-slate-600">Lighter model used for pipeline routing decisions</p>
            </div>
          </div>

          {/* custom model input */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">
                Custom agent model ID
              </label>
              <input
                value={agentModel}
                onChange={(e) => setAgent(e.target.value)}
                placeholder="e.g. gemini-2.5-flash"
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 font-mono text-sm text-white placeholder:text-slate-700 focus:border-signal/50 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">
                Custom orchestrator model ID
              </label>
              <input
                value={orchModel}
                onChange={(e) => setOrch(e.target.value)}
                placeholder="e.g. gemini-2.5-flash-lite"
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 font-mono text-sm text-white placeholder:text-slate-700 focus:border-signal/50 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">
                Temperature
              </label>
              <input
                value={temp}
                onChange={(e) => setTemp(e.target.value)}
                type="number"
                min="0"
                max="2"
                step="0.1"
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white focus:border-signal/50 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">
                Tool cache stabilization threshold
              </label>
              <input
                value={toolCacheStable}
                onChange={(e) => setToolCacheStable(e.target.value)}
                type="number"
                min="1"
                step="1"
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white focus:border-signal/50 focus:outline-none"
              />
              <p className="text-xs text-slate-600">Cache serves only after this many identical outputs for same tool+args</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={providerCacheEnabled}
                onChange={(e) => setProviderCacheEnabled(e.target.checked)}
                className="h-4 w-4"
              />
              Enable provider prompt caching
            </label>
            <label className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={toolCacheEnabled}
                onChange={(e) => setToolCacheEnabled(e.target.checked)}
                className="h-4 w-4"
              />
              Enable deterministic tool result cache
            </label>
          </div>

          {configErr && (
            <div className="flex items-start gap-2 rounded-lg border border-ember/30 bg-ember/10 px-3 py-2.5 text-sm text-ember">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              {configErr}
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <Button variant="accent" onClick={saveConfig} disabled={saving}>
              {saving
                ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Saving</>
                : saved
                  ? <><Check className="mr-1.5 h-3.5 w-3.5" />Saved</>
                  : <><Save className="mr-1.5 h-3.5 w-3.5" />Apply config</>}
            </Button>
            <p className="text-xs text-slate-600">
              Changes apply immediately in memory and persist to <code className="font-mono">configs/settings.yaml</code> (or <code className="font-mono">data/settings.runtime.yaml</code> when configs are read-only).
            </p>
          </div>
        </div>
      </section>

      {/* ── API key status ─────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-600">API Key Status</h2>
        <div className="rounded-xl border border-white/8 bg-white/[0.03] divide-y divide-white/4">
          {PROVIDERS.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="text-sm font-medium text-white">{p.name}</div>
                <div className="mt-0.5 font-mono text-xs text-slate-600">{p.keyEnv}</div>
              </div>
              <div className="flex items-center gap-3">
                <KeyStatus set={apiKeys[p.id]} />
                {!apiKeys[p.id] && (
                  <span className="text-xs text-slate-700">Add to .env → rebuild container</span>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-600">
          API keys are read from <code className="font-mono">.env</code> at startup and never exposed through this interface.
          To rotate a key, update <code className="font-mono">.env</code> and restart the <code className="font-mono">owc</code> container.
        </p>
      </section>

      {/* ── Pricing config ──────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-600">Cost Accounting</h2>

        <div className="grid gap-5 xl:grid-cols-2">
          {/* entry */}
          <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4 space-y-3">
            <span className="text-sm font-semibold text-white">Add / update pricing row</span>
            <p className="text-xs text-slate-500">
              Set input/output prices per million tokens so the console can compute accurate cost estimates.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Provider" value={pProvider} onChange={(e) => setPProvider(e.target.value)} placeholder="google" />
              <Input label="Model name" value={pModel} onChange={(e) => setPModel(e.target.value)} placeholder="gemini-2.5-flash" />
              <Input label="Input / 1M tokens ($)" type="number" value={pInput} onChange={(e) => setPInput(e.target.value)} placeholder="0.00" />
              <Input label="Output / 1M tokens ($)" type="number" value={pOutput} onChange={(e) => setPOutput(e.target.value)} placeholder="0.00" />
            </div>
            <Textarea label="Notes (optional)" value={pNotes} onChange={(e) => setPNotes(e.target.value)} className="min-h-[60px]" />
            {priceSyncErr && (
              <div className="rounded-lg border border-ember/30 bg-ember/10 px-3 py-2 text-xs text-ember">
                {priceSyncErr}
              </div>
            )}
            {priceSyncMsg && (
              <div className="rounded-lg border border-surge/30 bg-surge/10 px-3 py-2 text-xs text-surge">
                {priceSyncMsg}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="accent" onClick={savePricing}>
                {priceSaved ? <><Check className="mr-1.5 h-3.5 w-3.5" />Saved</> : <><Save className="mr-1.5 h-3.5 w-3.5" />Save pricing row</>}
              </Button>
              <Button variant="secondary" onClick={syncPricingFromProvider} disabled={priceSyncing}>
                {priceSyncing
                  ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Syncing</>
                  : <><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Sync from provider</>}
              </Button>
            </div>
            <p className="text-xs text-slate-600">
              Direct pricing API sync is currently supported for openrouter.
            </p>
          </div>

          {/* stored rows */}
          <div className="rounded-xl border border-white/8 bg-white/[0.03] overflow-hidden">
            <div className="border-b border-white/6 px-4 py-3 text-xs font-semibold text-white">
              Stored pricing rows
            </div>
            <div className="divide-y divide-white/4">
              {(pricing.stored || []).length ? (
                pricing.stored.map((item) => (
                  <div key={`${item.provider}-${item.model_name}`} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="font-mono text-sm text-white">{item.model_name}</div>
                        <div className="text-xs text-slate-600">{item.provider}</div>
                      </div>
                      <Badge tone="signal">active</Badge>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-6 text-xs text-slate-400">
                      <span>In: {formatCurrency(item.input_per_million)} / 1M</span>
                      <span>Out: {formatCurrency(item.output_per_million)} / 1M</span>
                    </div>
                    {item.notes && <div className="mt-1 text-xs text-slate-600">{item.notes}</div>}
                  </div>
                ))
              ) : (
                <div className="px-4 py-8 text-center text-sm text-slate-600">
                  No pricing rows yet
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── raw config debug ────────────────────────────────────────────────── */}
      {config && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-600">Active config (debug)</h2>
          <JsonViewer label="Config" value={config} />
        </section>
      )}

    </div>
  );
}
