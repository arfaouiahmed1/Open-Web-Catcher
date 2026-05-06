import { apiFetch } from "@/lib/api";

let pricingCache = null;
let pricingPromise = null;

function normalizeProvider(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "google_genai" || v === "gemini") return "google";
  return v;
}

function normalizeModel(value) {
  return String(value || "").trim().toLowerCase();
}

function pricingKey(provider, model) {
  return `${normalizeProvider(provider)}|${normalizeModel(model)}`;
}

function buildPricingMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row?.active) continue;
    map.set(pricingKey(row.provider, row.model_name), {
      provider: normalizeProvider(row.provider),
      model: normalizeModel(row.model_name),
      input_per_million: Number(row.input_per_million || 0),
      output_per_million: Number(row.output_per_million || 0),
      cached_input_per_million: Number(row.cached_input_per_million || 0),
      cache_write_per_million: Number(row.cache_write_per_million || 0),
      context_window: Number(row.context_window || 0),
    });
  }
  return map;
}

function pricingRowsFromEnvDefaults(defaults = {}) {
  if (!defaults || typeof defaults !== "object") return [];
  const rows = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (!value || typeof value !== "object") continue;
    const [keyProvider, ...modelParts] = String(key || "").split("::");
    const modelFromKey = modelParts.length ? modelParts.join("::") : keyProvider;
    rows.push({
      provider: value.provider || (modelParts.length ? keyProvider : ""),
      model_name: value.model_name || modelFromKey,
      input_per_million: value.input_per_million,
      output_per_million: value.output_per_million,
      cached_input_per_million: value.cached_input_per_million,
      cache_write_per_million: value.cache_write_per_million,
      context_window: value.context_window,
      active: true,
    });
  }
  return rows;
}

export async function loadPricing({ force = false } = {}) {
  if (!force && pricingCache) return pricingCache;
  if (!force && pricingPromise) return pricingPromise;
  pricingPromise = apiFetch("/ui/pricing")
    .then((payload) => {
      pricingCache = buildPricingMap([
        ...pricingRowsFromEnvDefaults(payload?.env_defaults || {}),
        ...(payload?.stored || []),
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

export function lookupPricing(map, provider, model) {
  if (!map) return null;
  const exact = map.get(pricingKey(provider, model));
  if (exact) return exact;
  const providerless = map.get(pricingKey("", model));
  if (providerless) return providerless;
  const m = normalizeModel(model);
  const p = normalizeProvider(provider);
  let best = null;
  for (const [, value] of map) {
    if (value.provider && value.provider !== p) continue;
    if (m.startsWith(value.model) || value.model.startsWith(m)) {
      if (!best || value.model.length > best.model.length) best = value;
    }
  }
  return best;
}

export function estimateCallCost(call, pricingMap) {
  const provider = call?.provider || "";
  const model = call?.model_name || "";
  const pricing = lookupPricing(pricingMap, provider, model);
  const inputTokens = Number(call?.input_tokens || 0);
  const outputTokens = Number(call?.output_tokens || 0);
  const meta = call?.usage_metadata_json || {};
  const cachedInput = Number(call?.cached_input_tokens ?? meta?.cached_input_tokens ?? 0);
  const cacheWriteInput = Number(call?.cache_creation_input_tokens ?? meta?.cache_creation_input_tokens ?? 0);
  const loggedInputCost = Number(call?.estimated_input_cost_usd ?? meta?.estimated_input_cost_usd ?? 0);
  const loggedCachedCost = Number(call?.estimated_cached_input_cost_usd ?? meta?.estimated_cached_input_cost_usd ?? 0);
  const loggedCacheWriteCost = Number(call?.estimated_cache_write_cost_usd ?? meta?.estimated_cache_write_cost_usd ?? 0);
  const loggedOutputCost = Number(call?.estimated_output_cost_usd ?? meta?.estimated_output_cost_usd ?? 0);
  const loggedTotalCost = Number(call?.estimated_total_cost_usd ?? call?.total_cost_usd ?? meta?.estimated_total_cost_usd ?? 0);
  if (loggedTotalCost > 0 || loggedInputCost > 0 || loggedCachedCost > 0 || loggedCacheWriteCost > 0 || loggedOutputCost > 0) {
    const total = loggedTotalCost || (loggedInputCost + loggedCachedCost + loggedCacheWriteCost + loggedOutputCost);
    return {
      total,
      input: loggedInputCost,
      cached: loggedCachedCost,
      cacheWrite: loggedCacheWriteCost,
      output: loggedOutputCost,
      pricing,
      source: "logged",
    };
  }
  const newInput = Number(call?.new_input_tokens ?? meta?.new_input_tokens ?? Math.max(inputTokens - cachedInput - cacheWriteInput, 0));

  if (!pricing) {
    const fallback = Number(call?.estimated_total_cost_usd || call?.total_cost_usd || 0);
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
    pricing.cached_input_per_million > 0
      ? pricing.cached_input_per_million
      : pricing.input_per_million;
  const cacheWriteRate =
    pricing.cache_write_per_million > 0
      ? pricing.cache_write_per_million
      : pricing.input_per_million;

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

export function synthCallsFromModelUsage(modelUsage = []) {
  return (modelUsage || [])
    .filter((entry) => entry && (entry.input_tokens || entry.output_tokens))
    .map((entry) => ({
      provider: entry.provider || "",
      model_name: entry.model_name || "",
      input_tokens: Number(entry.input_tokens || 0),
      output_tokens: Number(entry.output_tokens || 0),
      context_window: Number(entry.context_window || 0),
      usage_metadata_json: {
        cached_input_tokens: Number(entry.cached_input_tokens || 0),
        cache_creation_input_tokens: Number(entry.cache_creation_input_tokens || 0),
        new_input_tokens: Number(entry.new_input_tokens || 0),
      },
      estimated_input_cost_usd: Number(entry.estimated_input_cost_usd || 0),
      estimated_cached_input_cost_usd: Number(entry.estimated_cached_input_cost_usd || 0),
      estimated_cache_write_cost_usd: Number(entry.estimated_cache_write_cost_usd || 0),
      estimated_output_cost_usd: Number(entry.estimated_output_cost_usd || 0),
      estimated_total_cost_usd: Number(entry.estimated_total_cost_usd || 0),
    }));
}

export function estimateRunCost(llmCalls, pricingMap) {
  const totals = {
    total: 0,
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    calls: 0,
    computed: 0,
  };
  for (const call of llmCalls || []) {
    const r = estimateCallCost(call, pricingMap);
    totals.total += r.total;
    totals.input += r.input;
    totals.cached += r.cached;
    totals.cacheWrite += r.cacheWrite;
    totals.output += r.output;
    totals.calls += 1;
    if (r.source === "computed" || r.source === "logged") totals.computed += 1;
  }
  return totals;
}

export function getContextWindow(provider, model, llmCalls = [], pricingMap = null) {
  const m = normalizeModel(model);
  for (const call of llmCalls) {
    if (
      normalizeModel(call?.model_name) === m &&
      Number(call?.context_window || 0) > 0
    ) {
      return Number(call.context_window);
    }
  }
  for (const call of llmCalls) {
    if (Number(call?.context_window || 0) > 0) return Number(call.context_window);
  }
  if (pricingMap) {
    const pricing = lookupPricing(pricingMap, provider, model);
    if (pricing && pricing.context_window > 0) return pricing.context_window;
  }
  return 0;
}

export function peakContextUsage(llmCalls = [], pricingMap = null) {
  let peak = 0;
  let peakCw = 0;
  let peakModel = "";
  let peakProvider = "";
  for (const call of llmCalls) {
    const tokens = Number(call?.input_tokens || 0);
    let cw = Number(call?.context_window || 0);
    if (cw === 0 && pricingMap) {
      const pricing = lookupPricing(pricingMap, call?.provider, call?.model_name);
      if (pricing && pricing.context_window > 0) cw = pricing.context_window;
    }
    if (cw > 0 && tokens > peak) {
      peak = tokens;
      peakCw = cw;
      peakModel = call?.model_name || "";
      peakProvider = call?.provider || "";
    }
  }
  return { tokens: peak, contextWindow: peakCw, model: peakModel, provider: peakProvider };
}
