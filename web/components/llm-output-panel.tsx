/* eslint-disable */
"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Clock, Coins, Cpu, DollarSign } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { StructuredDataCard } from "@/components/structured-data-card";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { normalizeTraceEvent } from "@/lib/run-trace";

function extractText(content: any) {
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

function parseClassificationFromText(text: any) {
  if (!text) return null;
  const pageMatch =
    text.match(/CLASSIFICATION:\s*(\S+)/i) || text.match(/page_type['":\s]+([a-z_]+)/i);
  const confMatch =
    text.match(/CONFIDENCE:\s*(\S+)/i) || text.match(/confidence['":\s]+([a-z]+)/i);
  if (!pageMatch && !confMatch) return null;
  return {
    page_type: pageMatch?.[1]?.toLowerCase().replace(/['"]/g, "") || null,
    confidence: confMatch?.[1]?.toLowerCase().replace(/['"]/g, "") || null,
  };
}

const CONF_COLOR = {
  high: "var(--mint)",
  medium: "var(--signal)",
  low: "var(--rose)",
};
const TYPE_COLOR = {
  landing_page: "var(--sky)",
  host_page: "var(--violet)",
  hosting_page: "var(--violet)",
  embed_video_page: "var(--signal)",
  embedded_page: "var(--signal)",
  other: "var(--mute-2)",
  unknown: "var(--mute-3)",
};

const LLM_EVENT_KINDS = new Set([
  "llm_response",
  "llm_error",
  "llm_timeout",
  "llm_rate_limited",
]);

function llmTone(kind: any) {
  if (kind === "llm_response") return "success";
  if (kind === "llm_rate_limited") return "warning";
  if (kind === "llm_timeout" || kind === "llm_error") return "danger";
  return "default";
}

function llmKindLabel(kind: any) {
  if (kind === "llm_response") return "response";
  if (kind === "llm_timeout") return "timeout";
  if (kind === "llm_rate_limited") return "rate limited";
  if (kind === "llm_error") return "error";
  return kind || "llm";
}

function ClassificationBadge({  text  }: any) {
  const parsed = parseClassificationFromText(text);
  if (!parsed) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {parsed.page_type ? (
        <span
          className="rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{
            // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
            background: `color-mix(in oklch, ${TYPE_COLOR[parsed.page_type] || "var(--mute-2)"} 14%, transparent)`,
            // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
            borderColor: `color-mix(in oklch, ${TYPE_COLOR[parsed.page_type] || "var(--mute-2)"} 28%, transparent)`,
            // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
            color: TYPE_COLOR[parsed.page_type] || "var(--mute-2)",
          }}
        >
          {parsed.page_type}
        </span>
      ) : null}
      {parsed.confidence ? (
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{
            // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
            background: `color-mix(in oklch, ${CONF_COLOR[parsed.confidence] || "var(--mute-2)"} 14%, transparent)`,
            // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
            border: `1px solid color-mix(in oklch, ${CONF_COLOR[parsed.confidence] || "var(--mute-2)"} 28%, transparent)`,
            // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
            color: CONF_COLOR[parsed.confidence] || "var(--mute-2)",
          }}
        >
          {parsed.confidence}
        </span>
      ) : null}
    </div>
  );
}

function toPlainObject(value: any) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function buildUsageMetadata(details: any, providerCacheActive: any, costSource: any) {
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

function buildResponseMetadata(details: any) {
  const raw = toPlainObject(details.response_metadata_json);
  const fallback = toPlainObject(details.response_metadata);
  return { ...raw, ...fallback };
}

function buildAdditionalKwargs(details: any) {
  const raw = toPlainObject(details.additional_kwargs_json);
  const fallback = toPlainObject(details.additional_kwargs);
  return { ...raw, ...fallback };
}

function buildLlmRows(events = []) {
  const list = [];
  for (const raw of Array.isArray(events) ? events : []) {
    const event = normalizeTraceEvent(raw);
    // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
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
    const contentPreview = extractText(
      details.content_preview ||
        responseMetadataJson.content_preview ||
        additionalKwargsJson.content_preview ||
        "",
    );
    const contentFull = extractText(
      details.content_full ||
        responseMetadataJson.content_full ||
        additionalKwargsJson.content_full ||
        contentPreview ||
        "",
    );
    const thinkingContent = extractText(
      details.thinking_content ||
        responseMetadataJson.thinking_content ||
        additionalKwargsJson.thinking_content ||
        "",
    );
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
      thinkingTokens: Number(
        details.thinking_tokens ||
          responseMetadataJson.thinking_tokens ||
          additionalKwargsJson.thinking_tokens ||
          0,
      ),
      errorPreview,
      summary,
      toolCalls: Number(details.tool_calls || 0),
      searchText,
      event,
    });
  }
  return list;
}

function buildTelemetryData(row: any) {
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

function buildFailureData(row: any) {
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

function LlmCallCard({  row, defaultExpanded = false  }: any) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const event = row.event;
  const isResponse = row.kind === "llm_response";
  const isFailure = !isResponse;
  const contentText = row.contentFull || row.contentPreview || "";
  const thinkingText = row.thinkingContent || "";
  const thinkingTokens = Number(row.thinkingTokens || 0);
  const actor = row.actor;
  const provider = row.provider;
  const model = row.model;
  const inputTokens = row.inputTokens;
  const outputTokens = row.outputTokens;
  const contextWindow = row.contextWindow;
  const ctxPct = contextWindow && inputTokens ? Math.min(100, (inputTokens / contextWindow) * 100) : null;
  const cost = row.cost;
  const toolCalls = Number(row.toolCalls || 0);
  const isClassification = isResponse && actor.toLowerCase().includes("classif");
  const telemetryData = buildTelemetryData(row);
  const failureData = buildFailureData(row);

  return (
    <div className="overflow-hidden rounded-[14px] border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v: any) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
      >
        <span className="text-muted-foreground">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] font-semibold text-[var(--signal)]">
              #{row.seq || "-"}
            </span>
            <Badge tone="default" className="font-mono">
              {actor}
            </Badge>
            <Badge tone={row.kindTone} className="font-mono">
              {row.kindLabel}
            </Badge>
            {model ? (
              <span className="font-mono text-[10px] text-muted-foreground">
                {provider ? `${provider}/` : ""}
                {model}
              </span>
            ) : null}
            {row.responseClass ? (
              <Badge tone="default" className="px-1.5 py-0.5 text-[9.5px]">
                {row.responseClass}
              </Badge>
            ) : null}
            {row.costSource ? (
              <Badge tone="signal" className="px-1.5 py-0.5 text-[9.5px]">
                {row.costSource}
              </Badge>
            ) : null}
            {row.providerCacheActive ? (
              <Badge tone="success" className="px-1.5 py-0.5 text-[9.5px]">
                provider cache
              </Badge>
            ) : null}
            {row.cacheHit ? (
              <Badge tone="success" className="px-1.5 py-0.5 text-[9.5px]">
                cache hit
              </Badge>
            ) : null}
            {toolCalls > 0 ? (
              <Badge tone="signal" className="px-1.5 py-0.5 text-[9.5px]">
                {toolCalls} tool{toolCalls !== 1 ? "s" : ""}
              </Badge>
            ) : null}
            {row.timestamp ? (
              <span className="ml-auto font-mono text-[9.5px] text-muted-foreground/70">
                {new Date(row.timestamp).toLocaleTimeString()}
              </span>
            ) : null}
          </div>
          {!expanded && row.summary ? (
            <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
              {row.summary.slice(0, 140)}
            </div>
          ) : null}
          {isClassification && !expanded ? <ClassificationBadge text={contentText} /> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3 text-right">
          {isResponse ? (
            <div className="text-[10px] text-muted-foreground">
              <span className="text-[var(--violet)]">{formatNumber(inputTokens)}</span>
              {" / "}
              <span className="text-[var(--signal)]">{formatNumber(outputTokens)}</span> tok
            </div>
          ) : (
            <Badge tone={row.kindTone} className="px-1.5 py-0.5 text-[9.5px]">
              provider issue
            </Badge>
          )}
          {ctxPct !== null ? (
            <div
              className="flex items-center gap-1.5"
              title={`${formatNumber(inputTokens)} / ${formatNumber(contextWindow)} tokens (${ctxPct.toFixed(1)}% context)`}
            >
              <div className="h-1 w-14 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${ctxPct}%`,
                    background:
                      ctxPct > 85 ? "var(--signal)" : ctxPct > 60 ? "var(--mint)" : "var(--violet)",
                  }}
                />
              </div>
              <span className="font-mono text-[9.5px] text-muted-foreground">{ctxPct.toFixed(0)}%</span>
            </div>
          ) : null}
          {cost > 0 ? (
            <div className="font-mono text-[10px] text-[var(--mint)]">{formatCurrency(cost)}</div>
          ) : null}
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-border">
          <div className="flex flex-wrap gap-4 border-b border-border bg-muted/20 px-4 py-2.5 text-[10.5px]">
            <span>
              <span className="text-muted-foreground">in </span>
              <span className="text-[var(--violet)]">{formatNumber(inputTokens)}</span>
            </span>
            <span>
              <span className="text-muted-foreground">out </span>
              <span className="text-[var(--signal)]">{formatNumber(outputTokens)}</span>
            </span>
            {thinkingTokens > 0 ? (
              <span>
                <span className="text-muted-foreground">think </span>
                <span className="text-[var(--sky)]">{formatNumber(thinkingTokens)}</span>
              </span>
            ) : null}
            {cost > 0 ? (
              <span>
                <span className="text-muted-foreground">cost </span>
                <span className="text-[var(--mint)]">{formatCurrency(cost)}</span>
              </span>
            ) : null}
            {row.providerCacheActive ? <span className="text-[var(--mint)]">provider cache</span> : null}
            {row.cacheHit ? <span className="text-[var(--sky)]">cache hit</span> : null}
            {ctxPct !== null ? (
              <span title={`${formatNumber(inputTokens)} / ${formatNumber(contextWindow)} context tokens`}>
                <span className="text-muted-foreground">ctx </span>
                <span
                  style={{
                    color:
                      ctxPct > 85 ? "var(--signal)" : ctxPct > 60 ? "var(--mint)" : "var(--violet)",
                  }}
                >
                  {ctxPct.toFixed(1)}%
                </span>
                <span className="text-muted-foreground">
                  {" "}({formatNumber(inputTokens)}/{formatNumber(contextWindow)})
                </span>
              </span>
            ) : null}
          </div>

          <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
            <div className="space-y-3">
              {isFailure ? (
                <div
                  className="rounded-lg border px-3 py-2 text-[11.5px]"
                  style={{
                    borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)",
                    background: "color-mix(in oklch, var(--rose) 10%, transparent)",
                    color: "var(--rose)",
                  }}
                >
                  <div className="font-medium">Provider request failed</div>
                  <div className="mt-0.5 whitespace-pre-wrap font-mono text-[10.5px] opacity-90">
                    {row.errorPreview || row.summary || "No error text recorded."}
                  </div>
                </div>
              ) : null}

              {isClassification ? <ClassificationBadge text={contentText} /> : null}

              {thinkingText ? (
                <details className="group rounded-lg border border-border">
                  <summary className="flex cursor-pointer select-none items-center gap-2 bg-muted/30 px-4 py-2 text-[10.5px] font-medium text-[var(--sky)]">
                    <span>Thinking</span>
                    {thinkingTokens > 0 ? (
                      <span className="font-mono text-[9.5px] text-muted-foreground">
                        ({formatNumber(thinkingTokens)} tok)
                      </span>
                    ) : null}
                  </summary>
                  <pre className="max-h-[300px] overflow-auto px-4 py-3 text-[10.5px] leading-relaxed whitespace-pre-wrap font-mono text-muted-foreground">
                    {thinkingText}
                  </pre>
                </details>
              ) : null}

              {isResponse && contentText ? (
                <pre className="max-h-[400px] overflow-auto rounded-lg border border-border bg-background px-4 py-3 text-[11.5px] leading-relaxed whitespace-pre-wrap font-mono text-foreground/90">
                  {contentText}
                </pre>
              ) : null}

              {isResponse && !contentText ? (
                <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-4 text-[11.5px] text-muted-foreground">
                  No text output (tool-call only response)
                </div>
              ) : null}

              {!isResponse && row.errorPreview ? (
                <pre className="max-h-[400px] overflow-auto rounded-lg border border-border bg-background px-4 py-3 text-[11.5px] leading-relaxed whitespace-pre-wrap font-mono text-foreground/90">
                  {row.errorPreview}
                </pre>
              ) : null}

              {!isResponse && !row.errorPreview ? (
                <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-4 text-[11.5px] text-muted-foreground">
                  No provider error text was captured for this event.
                </div>
              ) : null}
            </div>

            <div className="space-y-3">
              <StructuredDataCard
                title="Provider telemetry"
                description="Request and response metadata for this provider call."
                data={telemetryData}
                limit={6}
                emptyLabel="No provider telemetry recorded."
              />
              {isFailure ? (
                <StructuredDataCard
                  title="Failure details"
                  description="Captured context for the provider-side failure."
                  data={failureData}
                  limit={6}
                  emptyLabel="No failure metadata recorded."
                />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatTile({  icon: Icon, label, value, sub, accent = "default"  }: any) {
  const colorMap = {
    default: "var(--ink)",
    violet: "var(--violet)",
    signal: "var(--signal)",
    mint: "var(--mint)",
    sky: "var(--sky)",
  };
  // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
  const color = colorMap[accent] || colorMap.default;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-3">
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{
          background: `color-mix(in oklch, ${color} 14%, transparent)`,
          color,
        }}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </div>
        <div className="mt-0.5 truncate font-mono text-[14px] font-semibold text-foreground">{value}</div>
        {sub ? (
          <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{sub}</div>
        ) : null}
      </div>
    </div>
  );
}

const SORT_OPTIONS = [
  { value: "seq_asc", label: "Sequence asc" },
  { value: "seq_desc", label: "Sequence desc" },
  { value: "tokens_desc", label: "Tokens desc" },
  { value: "tokens_asc", label: "Tokens asc" },
  { value: "cost_desc", label: "Cost desc" },
  { value: "cost_asc", label: "Cost asc" },
  { value: "time_desc", label: "Newest" },
  { value: "time_asc", label: "Oldest" },
];

function compareCalls(a: any, b: any, sort: any) {
  const tokensA = a.inputTokens + a.outputTokens;
  const tokensB = b.inputTokens + b.outputTokens;
  switch (sort) {
    case "seq_asc":
      return (a.seq || 0) - (b.seq || 0);
    case "seq_desc":
      return (b.seq || 0) - (a.seq || 0);
    case "tokens_desc":
      return tokensB - tokensA;
    case "tokens_asc":
      return tokensA - tokensB;
    case "cost_desc":
      return b.cost - a.cost;
    case "cost_asc":
      return a.cost - b.cost;
    case "time_asc":
      return String(a.timestamp || "").localeCompare(String(b.timestamp || ""));
    case "time_desc":
    default:
      return String(b.timestamp || "").localeCompare(String(a.timestamp || ""));
  }
}

export function LlmOutputPanel({ 
  events = [],
  title = "LLM Output",
  emptyMessage = "No LLM calls recorded yet. Calls stream here as the model responds.",
 }: any) {
  const [sort, setSort] = useState("seq_desc");
  const [actorFilter, setActorFilter] = useState("");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => buildLlmRows(events), [events]);

  const actors = useMemo(() => {
    const set = new Set();
    for (const row of rows) if (row.actor) set.add(row.actor);
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (actorFilter && row.actor !== actorFilter) return false;
      if (!term) return true;
      return row.searchText.includes(term);
    });
  }, [actorFilter, rows, search]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => compareCalls(a, b, sort)), [filtered, sort]);

  const stats = useMemo(() => {
    const total = filtered.length;
    const responses = filtered.filter((row) => row.kind === "llm_response").length;
    const failures = total - responses;
    const errors = filtered.filter((row) => row.kind === "llm_error").length;
    const timeouts = filtered.filter((row) => row.kind === "llm_timeout").length;
    const rateLimited = filtered.filter((row) => row.kind === "llm_rate_limited").length;
    let inTok = 0;
    let outTok = 0;
    let cached = 0;
    let cost = 0;
    for (const row of filtered) {
      if (row.kind !== "llm_response") continue;
      inTok += row.inputTokens;
      outTok += row.outputTokens;
      cached += row.cachedInputTokens;
      cost += row.cost;
    }
    return {
      total,
      responses,
      failures,
      errors,
      timeouts,
      rateLimited,
      inputTokens: inTok,
      outputTokens: outTok,
      tokens: inTok + outTok,
      cached,
      cost,
      avgCost: responses ? cost / responses : 0,
    };
  }, [filtered]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="space-y-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-[13.5px] font-medium">{title}</CardTitle>
            <CardDescription className="mt-0.5 text-[12px]">
              Provider responses, failures, and per-call telemetry.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              tone={stats.failures ? "danger" : stats.responses ? "success" : "default"}
              className="font-mono"
            >
              Provider health: {formatNumber(stats.responses)} ok / {formatNumber(stats.failures)} issues
            </Badge>
            {stats.rateLimited > 0 ? (
              <Badge tone="warning" className="font-mono">
                {formatNumber(stats.rateLimited)} rate limited
              </Badge>
            ) : null}
            {stats.errors > 0 ? (
              <Badge tone="danger" className="font-mono">
                {formatNumber(stats.errors)} error{stats.errors !== 1 ? "s" : ""}
              </Badge>
            ) : null}
            {stats.timeouts > 0 ? (
              <Badge tone="signal" className="font-mono">
                {formatNumber(stats.timeouts)} timeout{stats.timeouts !== 1 ? "s" : ""}
              </Badge>
            ) : null}
            <Badge tone="default" className="font-mono">
              {formatNumber(stats.total)} call{stats.total !== 1 ? "s" : ""}
            </Badge>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            icon={Cpu}
            label="Calls"
            value={formatNumber(stats.total)}
            sub={
              stats.total
                ? `${formatNumber(stats.responses)} responses / ${formatNumber(stats.failures)} issues`
                : ""
            }
            accent="violet"
          />
          <StatTile
            icon={Coins}
            label="Tokens"
            value={formatNumber(stats.tokens)}
            sub={`${formatNumber(stats.inputTokens)} in / ${formatNumber(stats.outputTokens)} out`}
            accent="signal"
          />
          <StatTile
            icon={DollarSign}
            label="Est. cost"
            value={formatCurrency(stats.cost)}
            sub={stats.responses ? `${formatCurrency(stats.avgCost)} / response avg` : ""}
            accent="mint"
          />
          <StatTile
            icon={Clock}
            label="Cached"
            value={formatNumber(stats.cached)}
            sub={
              stats.inputTokens > 0
                ? `${((stats.cached / stats.inputTokens) * 100).toFixed(1)}% of input`
                : "-"
            }
            accent="sky"
          />
        </div>

        <Separator />

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by actor, provider, model, kind, error..."
            className="h-8 min-w-[200px] flex-1 text-xs"
          />
          {actors.length > 1 ? (
            <select
              value={actorFilter}
              onChange={(e) => setActorFilter(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              title="Filter by actor"
            >
              <option value="">All actors</option>
              {actors.map((a) => (
                <option key={String(a)} value={String(a)}>
                  {String(a)}
                </option>
              ))}
            </select>
          ) : null}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            title="Sort"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {search || actorFilter || sort !== "seq_desc" ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs text-muted-foreground"
              onClick={() => {
                setSearch("");
                setActorFilter("");
                setSort("seq_desc");
              }}
            >
              Reset
            </Button>
          ) : null}
        </div>
      </CardHeader>

      {!sorted.length ? (
        <CardContent className="px-4 py-10 text-center text-[12px] text-muted-foreground">
          {rows.length
            ? "No LLM calls match the current filters."
            : emptyMessage}
        </CardContent>
      ) : (
        <ScrollArea className="max-h-[640px]">
          <div className="flex flex-col gap-2 p-3">
            {sorted.map((row, index) => (
              <LlmCallCard
                key={`${row.seq || "noseq"}-${row.timestamp}-${index}`}
                row={row}
                defaultExpanded={index === 0 && sort.startsWith("seq")}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </Card>
  );
}