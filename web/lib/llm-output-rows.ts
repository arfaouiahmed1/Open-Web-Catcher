import { normalizeTraceEvent } from "@/lib/run-trace";

type TraceEventLike = Parameters<typeof normalizeTraceEvent>[0];

function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<unknown>)
      .map((block) =>
        typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text"
          ? String((block as Record<string, unknown>).text ?? "")
          : typeof block === "string"
            ? block
            : "",
      )
      .join("\n");
  }
  return String(content);
}

function toPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function llmTone(kind: string): string {
  if (kind === "llm_response") return "success";
  if (kind === "llm_rate_limited") return "warning";
  if (kind === "llm_timeout" || kind === "llm_error") return "danger";
  return "default";
}

function llmKindLabel(kind: string): string {
  if (kind === "llm_response") return "response";
  if (kind === "llm_timeout") return "timeout";
  if (kind === "llm_rate_limited") return "rate limited";
  if (kind === "llm_error") return "error";
  return kind || "llm";
}

function buildUsageMetadata(
  details: Record<string, unknown>,
  providerCacheActive: unknown,
  costSource: unknown,
): Record<string, unknown> {
  const raw = toPlainObject(details.usage_metadata_json);
  const fallback = toPlainObject(details.usage_metadata);
  return {
    ...raw,
    ...fallback,
    cached_input_tokens: Number(
      (raw.cached_input_tokens as number | undefined) ??
        (fallback.cached_input_tokens as number | undefined) ??
        (details.cached_input_tokens as number | undefined) ??
        0,
    ),
    cache_creation_input_tokens: Number(
      (raw.cache_creation_input_tokens as number | undefined) ??
        (fallback.cache_creation_input_tokens as number | undefined) ??
        (details.cache_creation_input_tokens as number | undefined) ??
        0,
    ),
    new_input_tokens: Number(
      (raw.new_input_tokens as number | undefined) ??
        (fallback.new_input_tokens as number | undefined) ??
        (details.new_input_tokens as number | undefined) ??
        0,
    ),
    cache_hit: Boolean(
      (raw.cache_hit as boolean | undefined) ?? (fallback.cache_hit as boolean | undefined) ?? details.cache_hit,
    ),
    provider_cache_active: Boolean(providerCacheActive),
    cost_source: String(costSource ?? raw.cost_source ?? fallback.cost_source ?? ""),
  };
}

function buildResponseMetadata(details: Record<string, unknown>): Record<string, unknown> {
  const raw = toPlainObject(details.response_metadata_json);
  const fallback = toPlainObject(details.response_metadata);
  return { ...raw, ...fallback };
}

function buildAdditionalKwargs(details: Record<string, unknown>): Record<string, unknown> {
  const raw = toPlainObject(details.additional_kwargs_json);
  const fallback = toPlainObject(details.additional_kwargs);
  return { ...raw, ...fallback };
}

const LLM_EVENT_KINDS = new Set<string>([
  "llm_response",
  "llm_error",
  "llm_timeout",
  "llm_rate_limited",
]);

export interface LlmRow {
  seq: number;
  timestamp: string;
  actor: string;
  provider: string;
  model: string;
  kind: string;
  kindLabel: string;
  kindTone: string;
  inputTokens: number;
  outputTokens: number;
  contextWindow: number | null;
  cost: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  newInputTokens: number;
  cacheHit: boolean;
  providerCacheActive: boolean;
  costSource: string;
  responseClass: string;
  usageMetadataJson: Record<string, unknown>;
  responseMetadataJson: Record<string, unknown>;
  additionalKwargsJson: Record<string, unknown>;
  contentPreview: string;
  contentFull: string;
  thinkingContent: string;
  thinkingTokens: number;
  errorPreview: string;
  summary: string;
  toolCalls: number;
  searchText: string;
  event: NonNullable<ReturnType<typeof normalizeTraceEvent>>;
}

export function buildLlmRows(events: unknown[] | null | undefined = []): LlmRow[] {
  const list: LlmRow[] = [];
  for (const raw of Array.isArray(events) ? events : []) {
    const event = normalizeTraceEvent(raw as TraceEventLike);
    if (!event || !LLM_EVENT_KINDS.has(event.kind ?? "")) continue;
    const details = toPlainObject(event.details);
    const kind = String(event.kind ?? "llm_response");
    const responseMetadataJson = buildResponseMetadata(details);
    const additionalKwargsJson = buildAdditionalKwargs(details);
    const providerCacheActive =
      (details.provider_cache_active as boolean | undefined) ??
      (responseMetadataJson.provider_cache_active as boolean | undefined) ??
      (additionalKwargsJson.provider_cache_active as boolean | undefined) ??
      false;
    const costSource =
      (details.cost_source as string | undefined) ??
      (toPlainObject(details.usage_metadata).cost_source as string | undefined) ??
      (responseMetadataJson.cost_source as string | undefined) ??
      (additionalKwargsJson.cost_source as string | undefined) ??
      "";
    const responseClass =
      (details.response_class as string | undefined) ??
      (responseMetadataJson.response_class as string | undefined) ??
      (additionalKwargsJson.response_class as string | undefined) ??
      "";
    const usageMetadataJson = buildUsageMetadata(details, providerCacheActive, costSource);
    const contentPreview = extractText(details.content_preview ?? "");
    const contentFull = extractText(details.content_full ?? contentPreview ?? "");
    const thinkingContent = extractText(details.thinking_content ?? "");
    const errorPreview = extractText(
      details.error_preview ?? details.error ?? event.message ?? "",
    );
    const summary =
      kind === "llm_response"
        ? contentPreview || contentFull || String(event.message ?? "") || "Response received"
        : errorPreview || String(event.message ?? "") || llmKindLabel(kind);
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
      seq: Number(event.seq ?? 0),
      timestamp: event.timestamp ?? "",
      actor: String(event.actor ?? "llm"),
      provider: String(details.provider ?? ""),
      model: String(details.model_name ?? ""),
      kind,
      kindLabel: llmKindLabel(kind),
      kindTone: llmTone(kind),
      inputTokens: Number(details.input_tokens ?? 0),
      outputTokens: Number(details.output_tokens ?? 0),
      contextWindow: details.context_window ? Number(details.context_window) : null,
      cost: Number(details.estimated_total_cost_usd ?? 0),
      cachedInputTokens: Number(usageMetadataJson.cached_input_tokens ?? 0),
      cacheCreationInputTokens: Number(usageMetadataJson.cache_creation_input_tokens ?? 0),
      newInputTokens: Number(usageMetadataJson.new_input_tokens ?? 0),
      cacheHit: Boolean(usageMetadataJson.cache_hit),
      providerCacheActive: Boolean(providerCacheActive),
      costSource: String(costSource ?? ""),
      responseClass: String(responseClass ?? ""),
      usageMetadataJson,
      responseMetadataJson,
      additionalKwargsJson,
      contentPreview,
      contentFull,
      thinkingContent,
      thinkingTokens: Number(details.thinking_tokens ?? 0),
      errorPreview,
      summary,
      toolCalls: Number(details.tool_calls ?? 0),
      searchText,
      event,
    });
  }
  return list;
}

export function buildTelemetryData(row: LlmRow): Record<string, unknown> {
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
    context_window: row.contextWindow ?? 0,
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

export function buildFailureData(row: LlmRow): Record<string, unknown> {
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
