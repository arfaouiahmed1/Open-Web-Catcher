import { normalizeTraceEvent } from "@/lib/run-trace";

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" && block?.type === "text"
          ? block.text
          : typeof block === "string"
            ? block
            : "",
      )
      .join("\n");
  }
  return String(content);
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function llmTone(kind) {
  if (kind === "llm_response") return "success";
  if (kind === "llm_rate_limited") return "warning";
  if (kind === "llm_timeout" || kind === "llm_error") return "danger";
  return "default";
}

function llmKindLabel(kind) {
  if (kind === "llm_response") return "response";
  if (kind === "llm_timeout") return "timeout";
  if (kind === "llm_rate_limited") return "rate limited";
  if (kind === "llm_error") return "error";
  return kind || "llm";
}

function buildUsageMetadata(details, providerCacheActive, costSource) {
  const raw = toPlainObject(details.usage_metadata_json);
  const fallback = toPlainObject(details.usage_metadata);
  return {
    ...raw,
    ...fallback,
    cached_input_tokens: Number(
      raw.cached_input_tokens ??
        fallback.cached_input_tokens ??
        details.cached_input_tokens ??
        0,
    ),
    cache_creation_input_tokens: Number(
      raw.cache_creation_input_tokens ??
        fallback.cache_creation_input_tokens ??
        details.cache_creation_input_tokens ??
        0,
    ),
    new_input_tokens: Number(
      raw.new_input_tokens ?? fallback.new_input_tokens ?? details.new_input_tokens ?? 0,
    ),
    cache_hit: Boolean(raw.cache_hit ?? fallback.cache_hit ?? details.cache_hit),
    provider_cache_active: Boolean(providerCacheActive),
    cost_source: String(costSource || raw.cost_source || fallback.cost_source || ""),
  };
}

function buildResponseMetadata(details) {
  const raw = toPlainObject(details.response_metadata_json);
  const fallback = toPlainObject(details.response_metadata);
  return { ...raw, ...fallback };
}

function buildAdditionalKwargs(details) {
  const raw = toPlainObject(details.additional_kwargs_json);
  const fallback = toPlainObject(details.additional_kwargs);
  return { ...raw, ...fallback };
}

const LLM_EVENT_KINDS = new Set([
  "llm_response",
  "llm_error",
  "llm_timeout",
  "llm_rate_limited",
]);

export function buildLlmRows(events = []) {
  const list = [];
  for (const raw of Array.isArray(events) ? events : []) {
    const event = normalizeTraceEvent(raw);
    if (!event || !LLM_EVENT_KINDS.has(event.kind)) continue;
    const details = toPlainObject(event.details);
    const kind = String(event.kind || "llm_response");
    const responseMetadataJson = buildResponseMetadata(details);
    const additionalKwargsJson = buildAdditionalKwargs(details);
    const providerCacheActive =
      details.provider_cache_active ??
      responseMetadataJson.provider_cache_active ??
      additionalKwargsJson.provider_cache_active ??
      false;
    const costSource =
      details.cost_source ||
      details.usage_metadata?.cost_source ||
      responseMetadataJson.cost_source ||
      additionalKwargsJson.cost_source ||
      "";
    const responseClass =
      details.response_class ||
      responseMetadataJson.response_class ||
      additionalKwargsJson.response_class ||
      "";
    const usageMetadataJson = buildUsageMetadata(details, providerCacheActive, costSource);
    const contentPreview = extractText(details.content_preview || "");
    const contentFull = extractText(details.content_full || contentPreview || "");
    const thinkingContent = extractText(details.thinking_content || "");
    const errorPreview = extractText(
      details.error_preview || details.error || event.message || "",
    );
    const summary =
      kind === "llm_response"
        ? contentPreview || contentFull || String(event.message || "") || "Response received"
        : errorPreview || String(event.message || "") || llmKindLabel(kind);
    const searchText = [
      event.actor,
      details.provider,
      details.model_name,
      kind,
      llmKindLabel(kind),
      summary,
      errorPreview,
      costSource,
      responseClass,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    list.push({
      seq: Number(event.seq || 0),
      timestamp: event.timestamp || "",
      actor: String(event.actor || "llm"),
      provider: String(details.provider || ""),
      model: String(details.model_name || ""),
      kind,
      kindLabel: llmKindLabel(kind),
      kindTone: llmTone(kind),
      inputTokens: Number(details.input_tokens || 0),
      outputTokens: Number(details.output_tokens || 0),
      contextWindow: details.context_window ? Number(details.context_window) : null,
      cost: Number(details.estimated_total_cost_usd || 0),
      cachedInputTokens: Number(usageMetadataJson.cached_input_tokens || 0),
      cacheCreationInputTokens: Number(usageMetadataJson.cache_creation_input_tokens || 0),
      newInputTokens: Number(usageMetadataJson.new_input_tokens || 0),
      cacheHit: Boolean(usageMetadataJson.cache_hit),
      providerCacheActive: Boolean(providerCacheActive),
      costSource: String(costSource || ""),
      responseClass: String(responseClass || ""),
      usageMetadataJson,
      responseMetadataJson,
      additionalKwargsJson,
      contentPreview,
      contentFull,
      thinkingContent,
      thinkingTokens: Number(details.thinking_tokens || 0),
      errorPreview,
      summary,
      toolCalls: Number(details.tool_calls || 0),
      searchText,
      event,
    });
  }
  return list;
}

export function buildTelemetryData(row) {
  return {
    kind: row.kind,
    kind_label: row.kindLabel,
    actor: row.actor,
    provider: row.provider,
    model: row.model,
    provider_cache_active: row.providerCacheActive,
    cache_hit: row.cacheHit,
    cost_source: row.costSource,
    response_class: row.responseClass,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    context_window: row.contextWindow || 0,
    estimated_total_cost_usd: row.cost,
    cached_input_tokens: row.cachedInputTokens,
    cache_creation_input_tokens: row.cacheCreationInputTokens,
    new_input_tokens: row.newInputTokens,
    tool_calls: row.toolCalls,
    usage_metadata_json: row.usageMetadataJson,
    response_metadata_json: row.responseMetadataJson,
    additional_kwargs_json: row.additionalKwargsJson,
  };
}

export function buildFailureData(row) {
  return {
    kind: row.kind,
    kind_label: row.kindLabel,
    actor: row.actor,
    provider: row.provider,
    model: row.model,
    cost_source: row.costSource,
    response_class: row.responseClass,
    error_preview: row.errorPreview,
    message: row.summary,
  };
}
