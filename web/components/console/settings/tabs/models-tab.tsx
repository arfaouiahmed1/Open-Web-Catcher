"use client";

import * as React from "react";
import { Cpu, Search, RefreshCw, Loader2, CheckCircle2, AlertTriangle, Key } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export interface AgentSlotSelection {
  provider: string;
  model: string;
}

export interface ProviderOption {
  id: string;
  name: string;
  keyEnv: string;
  color: string;
  category: string;
  features: string[];
}

export interface ModelsTabProps {
  provider: string;
  providers: ProviderOption[];
  agentModelConfig: Record<string, AgentSlotSelection>;
  fallbackTemperature: string;
  providerCacheEnabled: boolean;
  geminiExplicitCacheEnabled: boolean;
  geminiExplicitCacheTtl: string;
  geminiExplicitCacheRefreshLead: string;
  toolCacheEnabled: boolean;
  toolCacheStable: string;
  thinkingEnabled: boolean;
  thinkingBudgetTokens: string;
  maxParallelHostingPages: string;
  catalogModels: any[];
  catalogQuery: string;
  selectedCatalogModelId: string;
  catalogAssignmentTarget: string;
  catalogLoading: string;
  pricingSyncLoading: string;
  activeCatalog: any;
  activePricingStatus: any;
  apiKeys: Record<string, unknown>;
  dirtyCount: number;
  dirty?: boolean;
  saving?: boolean;
  warnings: any[];
  modelSelectionDetails?: Record<string, any>;
  savedGlobal?: string;
  savedOrchestrator?: string;
  onProviderChange: (v: string) => void;
  onApplyToAllAgents: () => void;
  onUpdateAgentModel: (agentId: string, modelId: string) => void;
  onUpdateAgentProvider: (agentId: string, provider: string) => void;
  onInheritToggle: (agentId: string, inherit: boolean) => void;
  onFallbackTemperature: (v: string) => void;
  onProviderCache: (v: boolean) => void;
  onGeminiExplicitCache: (v: boolean) => void;
  onGeminiExplicitCacheTtl: (v: string) => void;
  onGeminiExplicitCacheRefreshLead: (v: string) => void;
  onToolCache: (v: boolean) => void;
  onToolCacheStable: (v: string) => void;
  onThinking: (v: boolean) => void;
  onThinkingBudget: (v: string) => void;
  onMaxParallel: (v: string) => void;
  onCatalogQuery: (v: string) => void;
  onSelectCatalogModel: (id: string) => void;
  onCatalogTarget: (v: string) => void;
  onApplyCatalogToTarget: () => void;
  onRefreshCatalog: () => void;
  onSyncPricing: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

const AGENT_SLOTS = [
  { id: "orchestrator", label: "Orchestrator", subtitle: "Pipeline default · fanout strategy and routing" },
  { id: "classification", label: "Classification", subtitle: "Target URL analysis · page type decision" },
  { id: "landing", label: "Landing", subtitle: "Link discovery on listing and schedule pages" },
  { id: "hosting", label: "Hosting", subtitle: "Direct stream extraction from host pages" },
  { id: "embedded", label: "Embedded", subtitle: "Sandboxed player and iframe recovery" },
];

function capabilityBadges(model: any): string[] {
  const caps = model?.capabilities ?? {};
  const out: string[] = [];
  const push = (cond: unknown, label: string) => {
    if (cond === true || cond === "supported") out.push(label);
  };
  push(caps.supports_vision ?? model?.supports_vision, "Vision");
  push(caps.supports_thinking_controls ?? model?.supports_thinking, "Thinking");
  push(caps.supports_explicit_cache ?? model?.supports_explicit_cache, "Prompt Cache");
  return out.length ? out : ["Tools"];
}

function formatTokens(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-border/60 bg-card px-3.5 py-3 transition-colors hover:bg-muted/20">
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-foreground">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">{description}</span>
        ) : null}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} className="mt-0.5 shrink-0" />
    </label>
  );
}

export function ModelsTab(props: ModelsTabProps): React.JSX.Element {
  const {
    provider,
    providers,
    agentModelConfig,
    catalogModels,
    catalogQuery,
    selectedCatalogModelId,
    catalogAssignmentTarget,
    catalogLoading,
    pricingSyncLoading,
    activeCatalog,
    activePricingStatus,
    apiKeys,
    dirtyCount,
    dirty,
    saving,
    warnings,
    modelSelectionDetails,
    savedGlobal,
    savedOrchestrator,
  } = props;

  const [catalogOpen, setCatalogOpen] = React.useState(false);
  const providerOptions = providers.map((p) => ({
    value: p.id,
    label: p.name,
    description: p.category,
    meta: p.keyEnv,
  }));
  const globalSlot = agentModelConfig.classification ?? { provider, model: "" };
  const globalModelOptions = React.useMemo(() => {
    const base = (catalogModels || []).map((m: any) => {
      const ctx = m.context_window ? ` (${formatTokens(m.context_window)} ctx)` : "";
      return {
        value: String(m.id),
        label: `${String(m.label || m.id)}${ctx}`,
        description: m.description ? String(m.description) : undefined,
      };
    });
    if (globalSlot.model && !base.some((o) => o.value === globalSlot.model)) {
      base.push({ value: globalSlot.model, label: `${globalSlot.model} (manual)`, description: "Custom configured model ID" });
    }
    return base;
  }, [catalogModels, globalSlot.model]);

  const q = catalogQuery.trim().toLowerCase();
  const visibleCatalog = q
    ? (catalogModels || []).filter((m: any) =>
        [m.id, m.label, m.description].filter(Boolean).join(" ").toLowerCase().includes(q),
      )
    : catalogModels || [];
  const selectedModel = (catalogModels || []).find((m: any) => String(m.id) === String(selectedCatalogModelId)) ?? null;

  const temp = Number(props.fallbackTemperature);
  const tempError = !Number.isFinite(temp) || temp < 0 || temp > 2 ? "Must be between 0.0 and 2.0." : undefined;
  const thinkBudget = Number(props.thinkingBudgetTokens);
  const thinkError =
    props.thinkingEnabled && (!Number.isInteger(thinkBudget) || thinkBudget < 1000 || thinkBudget > 32000)
      ? "Must be an integer from 1000 to 32000."
      : undefined;
  const ttl = Number(props.geminiExplicitCacheTtl);
  const ttlError =
    props.geminiExplicitCacheEnabled && (!Number.isFinite(ttl) || ttl < 60 || ttl > 7200)
      ? "Must be between 60 and 7200 seconds."
      : undefined;
  const lead = Number(props.geminiExplicitCacheRefreshLead);
  const leadError =
    props.geminiExplicitCacheEnabled && (!Number.isFinite(lead) || lead < 5 || lead > 600)
      ? "Must be between 5 and 600 seconds."
      : undefined;
  const stable = Number(props.toolCacheStable);
  const stableError =
    props.toolCacheEnabled && (!Number.isInteger(stable) || stable < 2 || stable > 10)
      ? "Must be an integer from 2 to 10."
      : undefined;
  const maxParallel = Number(props.maxParallelHostingPages);
  const maxParallelError =
    !Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 16 ? "Must be an integer from 1 to 16." : undefined;
  const hasError = Boolean(tempError || thinkError || ttlError || leadError || stableError || maxParallelError);

  return (
    <div className="space-y-4 animate-fade-up">
      {warnings.length ? (
        <div className="space-y-2">
          {warnings.map((w: any, i: number) => (
            <div
              key={String(w?.id ?? w?.message ?? i)}
              className="flex items-start gap-2 rounded-xl border border-amber-300/50 bg-amber-100/50 px-4 py-3 text-[13px] text-amber-900"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span className="leading-relaxed">{String(w?.message ?? w)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <section className="space-y-3 rounded-2xl border border-border/70 bg-card/95 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-[14px] font-semibold text-foreground">Global default model</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Every agent inherits this unless it has a custom override. Saved global:{" "}
              <span className="font-mono text-[11px]">{savedGlobal || "not set"}</span>
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={props.onApplyToAllAgents}>
            Apply to all agents
          </Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Provider"
            value={provider}
            onChange={(v) => props.onProviderChange(v)}
            options={providerOptions}
            searchable
            searchPlaceholder="Search providers…"
          />
          <Select
            label="Model"
            value={globalSlot.model || ""}
            onChange={(v) => props.onUpdateAgentModel("classification", v)}
            options={globalModelOptions}
            searchable
            searchPlaceholder="Search models…"
            placeholder={globalModelOptions.length ? "Select model" : "Add a provider key to load the catalog"}
          />
        </div>
        {!apiKeys[provider] ? (
          <div className="flex items-start gap-2 rounded-lg border border-primary/35 bg-primary/10 px-3 py-2.5 text-sm text-primary">
            <Key className="mt-0.5 size-4 shrink-0" />
            <span>No key set for this provider. The catalog falls back to the saved snapshot until a key is added.</span>
          </div>
        ) : null}
      </section>

      <section className="space-y-3 rounded-2xl border border-border/70 bg-card/95 p-4">
        <div>
          <h3 className="text-[14px] font-semibold text-foreground">Agent model routing</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Inherit the global default or pin a custom provider and model per agent.
          </p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {AGENT_SLOTS.map((slot) => {
            const sel = agentModelConfig[slot.id] ?? { provider, model: "" };
            const isGlobal = slot.id === "classification";
            const inherit =
              !isGlobal && sel.provider === globalSlot.provider && (sel.model || "") === (globalSlot.model || "");
            const detail = modelSelectionDetails?.[slot.id];
            const slotCatalogNote = detail?.catalog_source ? String(detail.catalog_source) : activeCatalog?.source;
            return (
              <div key={slot.id} className="space-y-3 rounded-xl border border-border/60 bg-background/50 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info" className="gap-1">
                    <Cpu className="h-3 w-3" /> {slot.label}
                  </Badge>
                  {isGlobal ? <Badge tone="success">global default</Badge> : null}
                  {!isGlobal ? (
                    <button
                      type="button"
                      onClick={() => props.onInheritToggle(slot.id, !inherit)}
                      className={cn(
                        "ml-auto inline-flex h-6 items-center rounded-full border px-2.5 text-[11px] font-medium transition-colors",
                        inherit
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                          : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {inherit ? "Inheriting global" : "Custom override"}
                    </button>
                  ) : null}
                </div>
                <p className="text-[12px] text-muted-foreground">{slot.subtitle}</p>
                {isGlobal || !inherit ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select
                      label="Provider"
                      value={sel.provider || provider}
                      onChange={(v) => props.onUpdateAgentProvider(slot.id, v)}
                      options={providerOptions}
                      searchable
                    />
                    <div className="space-y-2">
                      <label className="block text-sm font-semibold leading-none text-foreground">Model ID</label>
                      <input
                        value={sel.model || ""}
                        onChange={(e) => props.onUpdateAgentModel(slot.id, e.target.value)}
                        placeholder="e.g. gemini-2.5-flash"
                        className="flex h-10 w-full rounded-lg border border-border bg-background px-3.5 py-2.5 font-mono text-[12px] outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </div>
                  </div>
                ) : (
                  <p className="rounded-lg bg-muted/30 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                    {globalSlot.model || "global model not set"} · {globalSlot.provider}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                  <span>
                    Effective: <span className="font-mono">{String(detail?.model || sel.model || "—")}</span>
                  </span>
                  {detail?.context_window ? (
                    <Badge tone="default" className="font-mono text-[9px]">
                      {formatTokens(detail.context_window)} ctx
                    </Badge>
                  ) : null}
                  {slotCatalogNote ? <Badge tone="muted">{String(slotCatalogNote)}</Badge> : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-border/70 bg-card/95 p-4">
        <div>
          <h3 className="text-[14px] font-semibold text-foreground">Runtime & caching controls</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">Sampling, reasoning, caching, and parallelism budgets.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 rounded-xl border border-border/60 p-3.5">
            <Slider
              label="Temperature"
              value={Number.isFinite(temp) ? temp : 0}
              onChange={(v) => props.onFallbackTemperature(String(v))}
              min={0}
              max={2}
              step={0.05}
              description="Fallback sampling temperature before provider defaults apply."
            />
            {tempError ? <p className="text-xs font-medium text-destructive">{tempError}</p> : null}
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: "Deterministic 0.0", value: "0" },
                { label: "Balanced 0.7", value: "0.7" },
                { label: "Creative 1.0", value: "1" },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => props.onFallbackTemperature(p.value)}
                  className="inline-flex h-6 items-center rounded-full border border-border bg-muted/30 px-2.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2 rounded-xl border border-border/60 p-3.5">
            <Slider
              label="Thinking budget (tokens)"
              value={Number.isFinite(thinkBudget) ? thinkBudget : 8000}
              onChange={(v) => props.onThinkingBudget(String(Math.round(v)))}
              min={1000}
              max={32000}
              step={1000}
              unit="tok"
              description="Reasoning token budget. Ignored by models without thinking support."
            />
            {thinkError ? <p className="text-xs font-medium text-destructive">{thinkError}</p> : null}
            <ToggleRow
              label="Extended thinking"
              description="Allow deeper reasoning where the model supports it."
              checked={props.thinkingEnabled}
              onChange={props.onThinking}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <ToggleRow
            label="Provider prompt caching"
            description="Reuse provider-native cache hits for repeated shared context."
            checked={props.providerCacheEnabled}
            onChange={props.onProviderCache}
          />
          <ToggleRow
            label="Deterministic tool result cache"
            description="Cache repeated browser-tool responses within the same run."
            checked={props.toolCacheEnabled}
            onChange={props.onToolCache}
          />
        </div>
        {props.toolCacheEnabled ? (
          <div className="max-w-sm">
            <Slider
              label="Min identical observations"
              value={Number.isFinite(stable) ? stable : 2}
              onChange={(v) => props.onToolCacheStable(String(Math.round(v)))}
              min={2}
              max={10}
              step={1}
              description="Identical consecutive tool results required before caching."
            />
            {stableError ? <p className="text-xs font-medium text-destructive">{stableError}</p> : null}
          </div>
        ) : null}
        <div className="space-y-3 rounded-xl border border-border/60 p-3.5">
          <ToggleRow
            label="LiteLLM prompt caching"
            description="Provider-agnostic prompt prefix caching via LiteLLM. Bypasses redundant tokens across repetitive agent turns for Gemini, Claude, and OpenAI."
            checked={props.geminiExplicitCacheEnabled}
            onChange={props.onGeminiExplicitCache}
          />
          {props.geminiExplicitCacheEnabled ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Slider
                  label="Cache TTL (seconds)"
                  value={Number.isFinite(ttl) ? ttl : 1800}
                  onChange={(v) => props.onGeminiExplicitCacheTtl(String(Math.round(v)))}
                  min={60}
                  max={7200}
                  step={60}
                  unit="s"
                />
                {ttlError ? <p className="mt-1 text-xs font-medium text-destructive">{ttlError}</p> : null}
              </div>
              <div>
                <Slider
                  label="Refresh lead (seconds)"
                  value={Number.isFinite(lead) ? lead : 120}
                  onChange={(v) => props.onGeminiExplicitCacheRefreshLead(String(Math.round(v)))}
                  min={5}
                  max={600}
                  step={5}
                  unit="s"
                />
                {leadError ? <p className="mt-1 text-xs font-medium text-destructive">{leadError}</p> : null}
              </div>
            </div>
          ) : null}
        </div>
        <div className="max-w-sm">
          <Input
            label="Max parallel hosting pages"
            type="number"
            min={1}
            max={16}
            step={1}
            value={props.maxParallelHostingPages}
            onChange={(e) => props.onMaxParallel(e.target.value)}
            error={maxParallelError}
            description="Caps simultaneous hosting-page and embedded-page executions (1–16)."
          />
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-card/95">
        <button
          type="button"
          onClick={() => setCatalogOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 p-4 text-left"
          aria-expanded={catalogOpen}
        >
          <span>
            <span className="block text-[14px] font-semibold text-foreground">Live catalog & pricing reference</span>
            <span className="mt-0.5 block text-[12px] text-muted-foreground">
              {catalogModels.length} models · {String(activePricingStatus?.model_count ?? 0)} priced · source:{" "}
              {String(activeCatalog?.source ?? "unavailable")}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                props.onRefreshCatalog();
              }}
              disabled={catalogLoading === provider}
            >
              {catalogLoading === provider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                props.onSyncPricing();
              }}
              disabled={pricingSyncLoading === provider}
            >
              {pricingSyncLoading === provider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Sync pricing
            </Button>
          </span>
        </button>
        {catalogOpen ? (
          <div className="space-y-3 border-t border-border/60 p-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={catalogQuery}
                onChange={(e) => props.onCatalogQuery(e.target.value)}
                placeholder="Search models"
                className="pl-9"
              />
            </div>
            {selectedModel ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/25 px-3 py-2.5 text-[12px]">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                <span className="font-mono">{String(selectedModel.id)}</span>
                <span className="ml-auto flex items-center gap-2">
                  <Select
                    value={catalogAssignmentTarget}
                    onChange={(v) => props.onCatalogTarget(v)}
                    options={[
                      { value: "global", label: "Global default" },
                      ...AGENT_SLOTS.map((s) => ({ value: s.id, label: s.label })),
                    ]}
                  />
                  <Button type="button" size="sm" onClick={props.onApplyCatalogToTarget}>
                    Apply assignment
                  </Button>
                </span>
              </div>
            ) : null}
            <div className="divide-y divide-border/60 rounded-xl border">
              {visibleCatalog.length ? (
                visibleCatalog.slice(0, 30).map((m: any) => (
                  <button
                    key={String(m.id)}
                    type="button"
                    onClick={() => props.onSelectCatalogModel(String(m.id))}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted/20",
                      String(m.id) === String(selectedCatalogModelId) ? "bg-primary/5" : undefined,
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-semibold">{String(m.label || m.id)}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{String(m.id)}</span>
                      <span className="mt-1 flex flex-wrap gap-1">
                        {capabilityBadges(m).map((c) => (
                          <Badge key={c} tone="muted" className="px-1.5 py-0 text-[9px]">
                            {c}
                          </Badge>
                        ))}
                      </span>
                    </span>
                    <span className="shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                      {formatTokens(m.context_window)} ctx
                      {m.pricing ? (
                        <span className="block">
                          ${String(m.pricing.input ?? "?")}/${String(m.pricing.output ?? "?")} /1M
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))
              ) : (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">No models match this search.</div>
              )}
            </div>
            {activeCatalog?.error ? (
              <p className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                {String(activeCatalog.error)}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-border/70 bg-background/95 px-4 py-3 shadow-lg backdrop-blur">
        <span className="text-[12px] text-muted-foreground">
          {dirty ? `${dirtyCount} unsaved change${dirtyCount === 1 ? "" : "s"}` : "All model settings saved"}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={props.onDiscard} disabled={!dirty || saving}>
            Discard changes
          </Button>
          <Button
            type="button"
            variant="accent"
            size="sm"
            onClick={props.onSave}
            disabled={Boolean(saving || !dirty || hasError)}
            className="min-w-[170px]"
          >
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : hasError ? (
              "Fix validation"
            ) : (
              "Save model settings"
            )}
          </Button>
        </span>
      </div>
      {savedOrchestrator ? <span className="hidden">{savedOrchestrator}</span> : null}
    </div>
  );
}
