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
      { id: "gemini-2.5-pro",        label: "Gemini 2.5 Pro",        note: "Most capable" },
      { id: "gemini-2.5-flash",      label: "Gemini 2.5 Flash",      note: "Recommended" },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", note: "Fast / cheap" },
      { id: "gemini-2.0-flash",      label: "Gemini 2.0 Flash",      note: "" },
      { id: "gemini-1.5-pro",        label: "Gemini 1.5 Pro",        note: "" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    models: [
      { id: "gpt-4o",        label: "GPT-4o",        note: "Most capable" },
      { id: "gpt-4o-mini",   label: "GPT-4o Mini",   note: "Recommended" },
      { id: "gpt-4-turbo",   label: "GPT-4 Turbo",   note: "" },
      { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo", note: "Fast / cheap" },
      { id: "o1-mini",       label: "o1 Mini",        note: "Reasoning" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-opus-4-6",           label: "Claude Opus 4.6",   note: "Most capable" },
      { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6", note: "Recommended" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5",  note: "Fast / cheap" },
      { id: "claude-3-5-sonnet-20241022",label: "Claude 3.5 Sonnet", note: "" },
      { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku",  note: "Fast" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    models: [
      { id: "openai/gpt-4o",                     label: "OpenAI GPT-4o",           note: "" },
      { id: "openai/gpt-4o-mini",                label: "OpenAI GPT-4o Mini",      note: "" },
      { id: "anthropic/claude-sonnet-4-6",       label: "Anthropic Sonnet 4.6",    note: "" },
      { id: "google/gemini-2.5-flash",           label: "Google Gemini 2.5 Flash", note: "" },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B",           note: "Open source" },
      { id: "deepseek/deepseek-chat",            label: "DeepSeek Chat",           note: "Budget" },
    ],
  },
];

/* ─── components ─────────────────────────────────────────────────────────── */

function KeyStatus({ set }) {
  return set ? (
    <span className="flex items-center gap-1 text-[12px]" style={{ color: "var(--mint)" }}>
      <CheckCircle2 className="h-3 w-3" />set
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[12px] text-[var(--mute)]">
      <AlertCircle className="h-3 w-3" />not set
    </span>
  );
}

function ProviderCard({ provider, active, apiKeySet, agentModel, orchModel, onSelect }) {
  const isActive = active === provider.id;
  return (
    <button
      onClick={() => onSelect(provider)}
      className="w-full rounded-[14px] border p-4 text-left transition-colors"
      style={isActive
        ? { borderColor: "color-mix(in oklch, var(--signal) 55%, transparent)", background: "color-mix(in oklch, var(--signal) 9%, transparent)" }
        : { borderColor: "var(--line)", background: "var(--card)" }
      }
      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.borderColor = "var(--line-hi)"; }}
      onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.borderColor = "var(--line)"; }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13.5px] font-medium text-[var(--ink)]">{provider.name}</span>
        <div className="flex items-center gap-2">
          <KeyStatus set={apiKeySet} />
          {isActive && <Badge tone="signal">Active</Badge>}
        </div>
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-[var(--mute)]">{provider.keyEnv}</div>
      {isActive && (
        <div className="mt-3 space-y-1 text-[12px] text-[var(--ink-dim)]">
          <div>Agent: <span className="font-mono text-[var(--ink)]">{agentModel}</span></div>
          <div>Orchestrator: <span className="font-mono text-[var(--ink)]">{orchModel}</span></div>
        </div>
      )}
    </button>
  );
}

function SectionHeader({ children }) {
  return (
    <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">{children}</h2>
  );
}

/* ─── main ───────────────────────────────────────────────────────────────── */

export default function SettingsPage() {
  const [config, setConfig]       = useState(null);
  const [provider, setProvider]   = useState("google");
  const [agentModel, setAgent]    = useState("");
  const [orchModel, setOrch]      = useState("");
  const [temp, setTemp]           = useState("1.0");
  const [providerCacheEnabled, setProviderCacheEnabled] = useState(true);
  const [toolCacheEnabled, setToolCacheEnabled]         = useState(true);
  const [toolCacheStable, setToolCacheStable]           = useState("2");
  const [browserEngine, setBrowserEngine]               = useState("puppeteer");
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [configErr, setConfigErr] = useState("");

  const [pricing, setPricing]         = useState({ stored: [], env_defaults: [] });
  const [pProvider, setPProvider]     = useState("google");
  const [pModel, setPModel]           = useState("gemini-2.5-flash");
  const [pInput, setPInput]           = useState("0");
  const [pOutput, setPOutput]         = useState("0");
  const [pNotes, setPNotes]           = useState("");
  const [priceSaved, setPriceSaved]   = useState(false);
  const [priceSyncing, setPriceSyncing] = useState(false);
  const [priceSyncMsg, setPriceSyncMsg] = useState("");
  const [priceSyncErr, setPriceSyncErr] = useState("");

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
      setBrowserEngine(c.browser_engine || "puppeteer");
    } catch (e) {
      setConfigErr(e.message);
    }
  }

  async function loadPricing() {
    const p = await apiFetch("/ui/pricing");
    setPricing(p);
  }

  useEffect(() => { loadConfig(); loadPricing(); }, []);

  function selectProvider(p) {
    setProvider(p.id);
    const first = p.models[0];
    if (first) { setAgent(first.id); setOrch(first.id); }
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
          browser_engine: browserEngine,
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

  const inputCls = "w-full rounded-lg border px-3 py-2 text-[13px] focus:outline-none";
  const inputStyle = { borderColor: "var(--line)", background: "rgba(0,0,0,0.2)", color: "var(--ink-dim)" };

  return (
    <div className="space-y-8">

      {/* page header */}
      <div>
        <span className="owc-eyebrow">settings · runtime config</span>
        <h1 className="mt-2 font-['Inter_Tight',sans-serif] text-3xl font-medium tracking-tight text-[var(--ink)]">
          Provider &amp; model configuration
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--mute)]">
          Switch LLM provider and model at runtime. API keys are set in{" "}
          <code className="rounded px-1 py-0.5 font-mono text-[12px]" style={{ background: "rgba(255,255,255,0.06)", color: "var(--ink-dim)" }}>.env</code>{" "}
          and never exposed here.
        </p>
      </div>

      {/* ── LLM Provider ── */}
      <section className="space-y-4">
        <SectionHeader>LLM Provider</SectionHeader>

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
        <div
          className="rounded-[14px] border p-4 space-y-4"
          style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
        >
          <div className="flex items-center gap-2">
            <Settings2 className="h-3.5 w-3.5" style={{ color: "var(--signal)" }} />
            <span className="text-[13.5px] font-medium text-[var(--ink)]">Model selection — {activeProvider.name}</span>
          </div>

          {!apiKeys[provider] && (
            <div
              className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[12.5px]"
              style={{ borderColor: "color-mix(in oklch, var(--signal) 35%, transparent)", background: "color-mix(in oklch, var(--signal) 10%, transparent)", color: "var(--signal)" }}
            >
              <Key className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                <strong>{activeProvider.keyEnv}</strong> is not set. Add it to your{" "}
                <code className="font-mono">.env</code> file and rebuild the container.
              </span>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">Agent model</label>
              <select value={agentModel} onChange={(e) => setAgent(e.target.value)} className={inputCls} style={inputStyle}>
                {activeProvider.models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}{m.note ? ` — ${m.note}` : ""}</option>
                ))}
                {agentModel && !activeProvider.models.find((m) => m.id === agentModel) && (
                  <option value={agentModel}>{agentModel} (custom)</option>
                )}
              </select>
              <p className="text-[12px] text-[var(--mute)]">Used by classification, landing, hosting, embedded agents</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">Orchestrator model</label>
              <select value={orchModel} onChange={(e) => setOrch(e.target.value)} className={inputCls} style={inputStyle}>
                {activeProvider.models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}{m.note ? ` — ${m.note}` : ""}</option>
                ))}
                {orchModel && !activeProvider.models.find((m) => m.id === orchModel) && (
                  <option value={orchModel}>{orchModel} (custom)</option>
                )}
              </select>
              <p className="text-[12px] text-[var(--mute)]">Lighter model used for pipeline routing decisions</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">Custom agent model ID</label>
              <input value={agentModel} onChange={(e) => setAgent(e.target.value)} placeholder="e.g. gemini-2.5-flash" className={`${inputCls} font-mono`} style={inputStyle} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">Custom orchestrator model ID</label>
              <input value={orchModel} onChange={(e) => setOrch(e.target.value)} placeholder="e.g. gemini-2.5-flash-lite" className={`${inputCls} font-mono`} style={inputStyle} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">Temperature</label>
              <input value={temp} onChange={(e) => setTemp(e.target.value)} type="number" min="0" max="2" step="0.1" className={inputCls} style={inputStyle} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">Tool cache stabilization threshold</label>
              <input value={toolCacheStable} onChange={(e) => setToolCacheStable(e.target.value)} type="number" min="1" step="1" className={inputCls} style={inputStyle} />
              <p className="text-[12px] text-[var(--mute)]">Cache serves only after this many identical outputs for same tool+args</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { label: "Enable provider prompt caching", checked: providerCacheEnabled, onChange: setProviderCacheEnabled },
              { label: "Enable deterministic tool result cache", checked: toolCacheEnabled, onChange: setToolCacheEnabled },
            ].map(({ label, checked, onChange }) => (
              <label
                key={label}
                className="flex items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-[13px] cursor-pointer"
                style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.02)", color: "var(--ink-dim)" }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => onChange(e.target.checked)}
                  className="h-4 w-4 accent-[var(--signal)]"
                />
                {label}
              </label>
            ))}
          </div>

          {configErr && (
            <div
              className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]"
              style={{ borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)", background: "color-mix(in oklch, var(--rose) 10%, transparent)", color: "var(--rose)" }}
            >
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
            <p className="text-[12px] text-[var(--mute)]">
              Changes apply immediately in memory and persist to{" "}
              <code className="font-mono">configs/settings.yaml</code>.
            </p>
          </div>
        </div>
      </section>

      {/* ── Browser Engine ── */}
      <section className="space-y-4">
        <SectionHeader>Browser Engine</SectionHeader>
        <p className="text-[13.5px] text-[var(--mute)]">Switch the browser automation backend. Changes apply on next agent run.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { id: "puppeteer",  name: "Puppeteer",  note: "Port 3000 — mature, CDP-based" },
            { id: "playwright", name: "Playwright", note: "Port 3001 — context isolation, modern" },
          ].map((eng) => (
            <button
              key={eng.id}
              onClick={() => setBrowserEngine(eng.id)}
              className="w-full rounded-[14px] border p-4 text-left transition-colors"
              style={browserEngine === eng.id
                ? { borderColor: "color-mix(in oklch, var(--signal) 55%, transparent)", background: "color-mix(in oklch, var(--signal) 9%, transparent)" }
                : { borderColor: "var(--line)", background: "var(--card)" }
              }
              onMouseEnter={(e) => { if (browserEngine !== eng.id) e.currentTarget.style.borderColor = "var(--line-hi)"; }}
              onMouseLeave={(e) => { if (browserEngine !== eng.id) e.currentTarget.style.borderColor = "var(--line)"; }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13.5px] font-medium text-[var(--ink)]">{eng.name}</span>
                {browserEngine === eng.id && <Badge tone="signal">Active</Badge>}
              </div>
              <p className="mt-0.5 text-[12px] text-[var(--mute)]">{eng.note}</p>
            </button>
          ))}
        </div>
      </section>

      {/* ── API key status ── */}
      <section className="space-y-3">
        <SectionHeader>API Key Status</SectionHeader>
        <div
          className="rounded-[14px] border overflow-hidden divide-y"
          style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
        >
          {PROVIDERS.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-[18px] py-3" style={{ borderColor: "var(--line)" }}>
              <div>
                <div className="text-[13px] font-medium text-[var(--ink)]">{p.name}</div>
                <div className="mt-0.5 font-mono text-[11px] text-[var(--mute)]">{p.keyEnv}</div>
              </div>
              <div className="flex items-center gap-3">
                <KeyStatus set={apiKeys[p.id]} />
                {!apiKeys[p.id] && (
                  <span className="text-[11px] text-[var(--mute)]">Add to .env → rebuild container</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Cost Accounting ── */}
      <section className="space-y-4">
        <SectionHeader>Cost Accounting</SectionHeader>

        <div className="grid gap-5 xl:grid-cols-2">
          <div
            className="rounded-[14px] border p-4 space-y-3"
            style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
          >
            <span className="text-[13.5px] font-medium text-[var(--ink)]">Add / update pricing row</span>
            <p className="text-[12.5px] text-[var(--mute)]">
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
              <div
                className="rounded-lg border px-3 py-2 text-[12.5px]"
                style={{ borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)", background: "color-mix(in oklch, var(--rose) 10%, transparent)", color: "var(--rose)" }}
              >
                {priceSyncErr}
              </div>
            )}
            {priceSyncMsg && (
              <div
                className="rounded-lg border px-3 py-2 text-[12.5px]"
                style={{ borderColor: "color-mix(in oklch, var(--mint) 30%, transparent)", background: "color-mix(in oklch, var(--mint) 10%, transparent)", color: "var(--mint)" }}
              >
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
          </div>

          <div
            className="rounded-[14px] border overflow-hidden"
            style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
          >
            <div className="border-b px-[18px] py-3.5" style={{ borderColor: "var(--line)" }}>
              <span className="text-[13.5px] font-medium text-[var(--ink)]">Stored pricing rows</span>
            </div>
            <div className="divide-y" style={{ borderColor: "var(--line)" }}>
              {(pricing.stored || []).length ? (
                pricing.stored.map((item) => (
                  <div key={`${item.provider}-${item.model_name}`} className="px-[18px] py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="font-mono text-[13px] text-[var(--ink)]">{item.model_name}</div>
                        <div className="text-[11px] text-[var(--mute)]">{item.provider}</div>
                      </div>
                      <Badge tone="signal">active</Badge>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-6 text-[12px] text-[var(--ink-dim)]">
                      <span>In: {formatCurrency(item.input_per_million)} / 1M</span>
                      <span>Out: {formatCurrency(item.output_per_million)} / 1M</span>
                    </div>
                    {item.notes && <div className="mt-1 text-[11px] text-[var(--mute)]">{item.notes}</div>}
                  </div>
                ))
              ) : (
                <div className="px-4 py-8 text-center text-[13px] text-[var(--mute)]">No pricing rows yet</div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── raw config debug ── */}
      {config && (
        <section className="space-y-3">
          <SectionHeader>Active config (debug)</SectionHeader>
          <JsonViewer label="Config" value={config} />
        </section>
      )}
    </div>
  );
}
