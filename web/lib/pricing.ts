import { apiFetch } from "./api";
import {
  callContextWindow,
  callInputTokens,
  callModel,
  callOutputTokens,
} from "./context-window";

export interface PricingStoredRow {
  provider?: unknown;
  model_name?: unknown;
  input_per_million?: unknown;
  output_per_million?: unknown;
  cached_input_per_million?: unknown;
  cache_write_per_million?: unknown;
  context_window?: unknown;
  active?: unknown;
}

export interface PricingEntry {
  provider: string;
  model: string;
  input_per_million: number;
  output_per_million: number;
  cached_input_per_million: number;
  cache_write_per_million: number;
  context_window: number;
}

export type PricingMap = Map<string, PricingEntry>;

let pricingCache: PricingMap | null = null;
let pricingPromise: Promise<PricingMap> | null = null;

function normalizeProvider(value: unknown): string {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "google_genai" || v === "gemini") return "google";
  return v;
}

function normalizeModel(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function canonicalModel(value: unknown): string {
  return normalizeModel(value).replace(/[^a-z0-9/]+/g, "");
}

function pricingKey(provider: unknown, model: unknown): string {
  return `${normalizeProvider(provider)}|${normalizeModel(model)}`;
}

function buildPricingMap(rows: PricingStoredRow[] | null | undefined): PricingMap {
  const map: PricingMap = new Map();
  for (const row of rows ?? []) {
    if (!row?.active) continue;
    map.set(pricingKey(row.provider, row.model_name), {
      provider: normalizeProvider(row.provider),
      model: normalizeModel(row.model_name),
      input_per_million: Number((row.input_per_million as number) || 0),
      output_per_million: Number((row.output_per_million as number) || 0),
      cached_input_per_million: Number((row.cached_input_per_million as number) || 0),
      cache_write_per_million: Number((row.cache_write_per_million as number) || 0),
      context_window: Number((row.context_window as number) || 0),
    });
  }
  return map;
}

function pricingRowsFromEnvDefaults(
  defaults: Record<string, unknown> | null | undefined = {},
): PricingStoredRow[] {
  if (!defaults || typeof defaults !== "object") return [];
  const rows: PricingStoredRow[] = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const [keyProvider, ...modelParts] = String(key ?? "").split("::");
    const modelFromKey = modelParts.length ? modelParts.join("::") : keyProvider;
    rows.push({
      provider: v.provider ?? (modelParts.length ? keyProvider : ""),
      model_name: v.model_name ?? modelFromKey,
      input_per_million: v.input_per_million,
      output_per_million: v.output_per_million,
      cached_input_per_million: v.cached_input_per_million,
      cache_write_per_million: v.cache_write_per_million,
      context_window: v.context_window,
      active: true,
    });
  }
  return rows;
}

export interface LoadPricingOptions {
  force?: boolean;
}

export async function loadPricing({ force = false }: LoadPricingOptions = {}): Promise<PricingMap> {
  if (!force && pricingCache) return pricingCache;
  if (!force && pricingPromise) return pricingPromise;
  pricingPromise = apiFetch<{ env_defaults?: Record<string, unknown>; stored?: PricingStoredRow[] }>("/ui/pricing")
    .then((payload) => {
      pricingCache = buildPricingMap([
        ...pricingRowsFromEnvDefaults((payload?.env_defaults ?? {}) as Record<string, unknown>),
        ...((payload?.stored ?? []) as PricingStoredRow[]),
      ]);
      pricingPromise = null;
      return pricingCache;
    })
    .catch(() => {
      pricingCache = new Map();
      pricingPromise = null;
      return pricingCache;
    });
  return pricingPromise;
}

export function lookupPricing(
  map: PricingMap | null | undefined,
  provider: unknown,
  model: unknown,
): PricingEntry | null {
  if (!map) return null;
  const exact = map.get(pricingKey(provider, model));
  if (exact) return exact;
  const providerless = map.get(pricingKey("", model));
  if (providerless) return providerless;
  const m = normalizeModel(model);
  const canonical = canonicalModel(model);
  const p = normalizeProvider(provider);
  let best: PricingEntry | null = null;
  for (const [, value] of map) {
    if (value.provider && value.provider !== p) continue;
    const candidateCanonical = canonicalModel(value.model);
    if (
      m.startsWith(value.model) ||
      value.model.startsWith(m) ||
      (canonical &&
        candidateCanonical &&
        (canonical === candidateCanonical ||
          canonical.startsWith(candidateCanonical) ||
          candidateCanonical.startsWith(canonical)))
    ) {
      if (!best || value.model.length > best.model.length) best = value;
    }
  }
  return best;
}

export interface LlmCallCostInput {
  provider?: unknown;
  model_name?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  inputTokens?: unknown;
  output_tokens?: unknown;
  outputTokens?: unknown;
  context_window?: unknown;
  contextWindow?: unknown;
  usage_metadata_json?: Record<string, unknown> | null;
  cached_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  new_input_tokens?: unknown;
  estimated_input_cost_usd?: unknown;
  estimated_cached_input_cost_usd?: unknown;
  estimated_cache_write_cost_usd?: unknown;
  estimated_output_cost_usd?: unknown;
  estimated_total_cost_usd?: unknown;
  total_cost_usd?: unknown;
}

export interface CallCost {
  total: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  pricing: PricingEntry | null;
  source: "logged" | "computed" | "unpriced";
}

export function estimateCallCost(
  call: LlmCallCostInput | null | undefined,
  pricingMap: PricingMap | null | undefined,
): CallCost {
  const provider = (call?.provider as string | undefined) ?? "";
  const model = callModel(call as unknown as Parameters<typeof callModel>[0]);
  const pricing = lookupPricing(pricingMap, provider, model);
  const inputTokens = callInputTokens(call as unknown as Parameters<typeof callInputTokens>[0]);
  const outputTokens = callOutputTokens(call as unknown as Parameters<typeof callOutputTokens>[0]);
  const meta = (call?.usage_metadata_json ?? {}) as Record<string, unknown>;
  const cachedInput = Number(
    (call?.cached_input_tokens as number | undefined) ??
      (meta?.cached_input_tokens as number | undefined) ??
      0,
  );
  const cacheWriteInput = Number(
    (call?.cache_creation_input_tokens as number | undefined) ??
      (meta?.cache_creation_input_tokens as number | undefined) ??
      0,
  );
  const loggedInputCost = Number(
    (call?.estimated_input_cost_usd as number | undefined) ??
      (meta?.estimated_input_cost_usd as number | undefined) ??
      0,
  );
  const loggedCachedCost = Number(
    (call?.estimated_cached_input_cost_usd as number | undefined) ??
      (meta?.estimated_cached_input_cost_usd as number | undefined) ??
      0,
  );
  const loggedCacheWriteCost = Number(
    (call?.estimated_cache_write_cost_usd as number | undefined) ??
      (meta?.estimated_cache_write_cost_usd as number | undefined) ??
      0,
  );
  const loggedOutputCost = Number(
    (call?.estimated_output_cost_usd as number | undefined) ??
      (meta?.estimated_output_cost_usd as number | undefined) ??
      0,
  );
  const loggedTotalCost = Number(
    (call?.estimated_total_cost_usd as number | undefined) ??
      (call?.total_cost_usd as number | undefined) ??
      (meta?.estimated_total_cost_usd as number | undefined) ??
      0,
  );
  if (
    loggedTotalCost > 0 ||
    loggedInputCost > 0 ||
    loggedCachedCost > 0 ||
    loggedCacheWriteCost > 0 ||
    loggedOutputCost > 0
  ) {
    const total = loggedTotalCost || loggedInputCost + loggedCachedCost + loggedCacheWriteCost + loggedOutputCost;
    return {
      total,
      input: loggedInputCost,
      cached: loggedCachedCost,
      cacheWrite: loggedCacheWriteCost,
      output: loggedOutputCost,
      pricing: pricing ?? null,
      source: "logged",
    };
  }
  const newInput = Number(
    (call?.new_input_tokens as number | undefined) ??
      (meta?.new_input_tokens as number | undefined) ??
      Math.max(inputTokens - cachedInput - cacheWriteInput, 0),
  );

  if (!pricing) {
    const fallback = Number((call?.estimated_total_cost_usd as number | undefined) ?? (call?.total_cost_usd as number | undefined) ?? 0);
    return {
      total: fallback,
      input: 0,
      cached: 0,
      cacheWrite: 0,
      output: 0,
      pricing: null,
      source: "unpriced",
    };
  }

  const cachedRate =
    pricing.cached_input_per_million > 0 ? pricing.cached_input_per_million : pricing.input_per_million;
  const cacheWriteRate =
    pricing.cache_write_per_million > 0 ? pricing.cache_write_per_million : pricing.input_per_million;

  const inputCost = (newInput / 1_000_000) * pricing.input_per_million;
  const cachedCost = (cachedInput / 1_000_000) * cachedRate;
  const cacheWriteCost = (cacheWriteInput / 1_000_000) * cacheWriteRate;
  const outputCost = (outputTokens / 1_000_000) * pricing.output_per_million;
  return {
    total: inputCost + cachedCost + cacheWriteCost + outputCost,
    input: inputCost,
    cached: cachedCost,
    cacheWrite: cacheWriteCost,
    output: outputCost,
    pricing,
    source: "computed",
  };
}

export interface ModelUsageEntry {
  provider?: unknown;
  model_name?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  context_window?: unknown;
  cached_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  new_input_tokens?: unknown;
  estimated_input_cost_usd?: unknown;
  estimated_cached_input_cost_usd?: unknown;
  estimated_cache_write_cost_usd?: unknown;
  estimated_output_cost_usd?: unknown;
  estimated_total_cost_usd?: unknown;
}

export function synthCallsFromModelUsage(modelUsage: unknown[] = []): LlmCallCostInput[] {
  return ((modelUsage ?? []) as ModelUsageEntry[])
    .filter((entry) => entry && ((entry.input_tokens as number) || (entry.output_tokens as number)))
    .map((entry) => ({
      provider: (entry.provider as string | undefined) ?? "",
      model_name: (entry.model_name as string | undefined) ?? "",
      input_tokens: Number((entry.input_tokens as number) || 0),
      output_tokens: Number((entry.output_tokens as number) || 0),
      context_window: Number((entry.context_window as number) || 0),
      usage_metadata_json: {
        cached_input_tokens: Number((entry.cached_input_tokens as number) || 0),
        cache_creation_input_tokens: Number((entry.cache_creation_input_tokens as number) || 0),
        new_input_tokens: Number((entry.new_input_tokens as number) || 0),
      },
      estimated_input_cost_usd: Number((entry.estimated_input_cost_usd as number) || 0),
      estimated_cached_input_cost_usd: Number((entry.estimated_cached_input_cost_usd as number) || 0),
      estimated_cache_write_cost_usd: Number((entry.estimated_cache_write_cost_usd as number) || 0),
      estimated_output_cost_usd: Number((entry.estimated_output_cost_usd as number) || 0),
      estimated_total_cost_usd: Number((entry.estimated_total_cost_usd as number) || 0),
    }));
}

export interface RunCostTotals {
  total: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  calls: number;
  computed: number;
  unpriced: number;
}

export function estimateRunCost(
  llmCalls: Array<LlmCallCostInput | null | undefined> | null | undefined,
  pricingMap: PricingMap | null | undefined,
): RunCostTotals {
  const totals: RunCostTotals = {
    total: 0,
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    calls: 0,
    computed: 0,
    unpriced: 0,
  };
  for (const call of llmCalls ?? []) {
    const r = estimateCallCost(call, pricingMap);
    totals.total += r.total;
    totals.input += r.input;
    totals.cached += r.cached;
    totals.cacheWrite += r.cacheWrite;
    totals.output += r.output;
    totals.calls += 1;
    if (r.source === "computed" || r.source === "logged") totals.computed += 1;
    else totals.unpriced += 1;
  }
  return totals;
}

export function getContextWindow(
  provider: unknown,
  model: unknown,
  llmCalls: Array<LlmCallCostInput | null | undefined> = [],
  pricingMap: PricingMap | null = null,
): number {
  const m = normalizeModel(model);
  for (const call of llmCalls) {
    const modelName = callModel(call as unknown as Parameters<typeof callModel>[0]);
    const window = callContextWindow(call as unknown as Parameters<typeof callContextWindow>[0]);
    if (normalizeModel(modelName) === m && window > 0) {
      return window;
    }
  }
  for (const call of llmCalls) {
    const window = callContextWindow(call as unknown as Parameters<typeof callContextWindow>[0]);
    if (window > 0) return window;
  }
  if (pricingMap) {
    const pricing = lookupPricing(pricingMap, provider, model);
    if (pricing && pricing.context_window > 0) return pricing.context_window;
  }
  return 0;
}

export function peakContextUsage(
  llmCalls: Array<LlmCallCostInput | null | undefined> = [],
  pricingMap: PricingMap | null = null,
): { tokens: number; contextWindow: number; model: string; provider: string } {
  let peak = 0;
  let peakCw = 0;
  let peakModel = "";
  let peakProvider = "";
  for (const call of llmCalls) {
    const tokens = callInputTokens(call as unknown as Parameters<typeof callInputTokens>[0]);
    let cw = callContextWindow(call as unknown as Parameters<typeof callContextWindow>[0]);
    if (cw === 0 && pricingMap) {
      const pricing = lookupPricing(pricingMap, (call as Record<string, unknown>)?.provider, callModel(call as unknown as Parameters<typeof callModel>[0]));
      if (pricing && pricing.context_window > 0) cw = pricing.context_window;
    }
    if (cw > 0 && tokens > peak) {
      peak = tokens;
      peakCw = cw;
      peakModel = callModel(call as unknown as Parameters<typeof callModel>[0]);
      peakProvider = String((call as Record<string, unknown>)?.provider ?? "");
    }
  }
  return { tokens: peak, contextWindow: peakCw, model: peakModel, provider: peakProvider };
}
