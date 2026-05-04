"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatNumber } from "@/lib/utils";
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

function parseClassificationFromText(text) {
  if (!text) return null;
  const pageMatch =
    text.match(/CLASSIFICATION:\s*(\S+)/i) ||
    text.match(/page_type['":\s]+([a-z_]+)/i);
  const confMatch =
    text.match(/CONFIDENCE:\s*(\S+)/i) ||
    text.match(/confidence['":\s]+([a-z]+)/i);
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

function ClassificationBadge({ text }) {
  const parsed = parseClassificationFromText(text);
  if (!parsed) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {parsed.page_type ? (
        <span className="rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{
          background: `color-mix(in oklch, ${TYPE_COLOR[parsed.page_type] || "var(--mute-2)"} 14%, transparent)`,
          borderColor: `color-mix(in oklch, ${TYPE_COLOR[parsed.page_type] || "var(--mute-2)"} 28%, transparent)`,
          color: TYPE_COLOR[parsed.page_type] || "var(--mute-2)",
        }}>
          {parsed.page_type}
        </span>
      ) : null}
      {parsed.confidence ? (
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{
            background: `color-mix(in oklch, ${CONF_COLOR[parsed.confidence] || "var(--mute-2)"} 14%, transparent)`,
            border: `1px solid color-mix(in oklch, ${CONF_COLOR[parsed.confidence] || "var(--mute-2)"} 28%, transparent)`,
            color: CONF_COLOR[parsed.confidence] || "var(--mute-2)",
          }}
        >
          {parsed.confidence}
        </span>
      ) : null}
    </div>
  );
}

function LlmCallCard({ event, index }) {
  const [expanded, setExpanded] = useState(index === 0);
  const details = event.details || {};
  const text = extractText(
    details.content_full || details.content_preview || "",
  );
  const thinkingText = extractText(details.thinking_content || "");
  const thinkingTokens = Number(details.thinking_tokens || 0);
  const actor = String(event.actor || "llm");
  const provider = details.provider || "";
  const model = details.model_name || "";
  const inputTokens = Number(details.input_tokens || 0);
  const outputTokens = Number(details.output_tokens || 0);
  const contextWindow = details.context_window
    ? Number(details.context_window)
    : null;
  const ctxPct =
    contextWindow && inputTokens
      ? Math.min(100, (inputTokens / contextWindow) * 100)
      : null;
  const cost = Number(details.estimated_total_cost_usd || 0);
  const toolCalls = Number(details.tool_calls || 0);
  const isClassification = actor.toLowerCase().includes("classif");

  return (
    <div
      className="rounded-[14px] border overflow-hidden animate-slide-in-up"
      style={{ borderColor: "var(--line)", background: "var(--card)" }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span style={{ color: "var(--mute-3)" }}>
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="text-[11px] font-semibold"
              style={{ color: "var(--signal)" }}
            >
              #{event.seq || index + 1}
            </span>
            <span
              className="text-[11px] font-medium"
              style={{ color: "var(--ink-dim)" }}
            >
              {actor}
            </span>
            {model ? (
              <span
                className="font-mono text-[10px]"
                style={{ color: "var(--mute-2)" }}
              >
                {provider ? `${provider}/` : ""}
                {model}
              </span>
            ) : null}
            {toolCalls > 0 ? (
              <Badge tone="default" className="px-1.5 py-0.5 text-[9.5px] font-medium text-sky-400">
                {toolCalls} tool{toolCalls !== 1 ? "s" : ""}
              </Badge>
            ) : null}
          </div>
          {!expanded && text ? (
            <div
              className="mt-0.5 truncate font-mono text-[10.5px]"
              style={{ color: "var(--mute-2)" }}
            >
              {text.slice(0, 120)}
            </div>
          ) : null}
          {isClassification && !expanded ? (
            <ClassificationBadge text={text} />
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3 text-right">
          <div className="text-[10px]" style={{ color: "var(--mute-3)" }}>
            <span style={{ color: "var(--violet)" }}>
              {formatNumber(inputTokens)}
            </span>
            {" / "}
            <span style={{ color: "var(--signal)" }}>
              {formatNumber(outputTokens)}
            </span>
            {" tok"}
          </div>
          {ctxPct !== null ? (
            <div
              className="flex items-center gap-1.5"
              title={`${formatNumber(inputTokens)} / ${formatNumber(contextWindow)} tokens (${ctxPct.toFixed(1)}% context)`}
            >
              <div
                className="h-1 w-14 overflow-hidden rounded-full"
                style={{ background: "var(--line)" }}
              >
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${ctxPct}%`,
                    background:
                      ctxPct > 85
                        ? "var(--signal)"
                        : ctxPct > 60
                          ? "var(--jade, var(--mint))"
                          : "var(--violet)",
                  }}
                />
              </div>
              <span
                className="font-mono text-[9.5px]"
                style={{ color: "var(--mute-3)" }}
              >
                {ctxPct.toFixed(0)}%
              </span>
            </div>
          ) : null}
          {cost > 0 ? (
            <div
              className="font-mono text-[10px]"
              style={{ color: "var(--mint)" }}
            >
              {formatCurrency(cost)}
            </div>
          ) : null}
        </div>
      </button>

      {expanded ? (
        <div className="border-t" style={{ borderColor: "var(--line)" }}>
          <div
            className="flex flex-wrap gap-4 border-b px-4 py-2.5 text-[10.5px]"
            style={{ borderColor: "var(--line)", background: "var(--card)" }}
          >
            <span>
              <span style={{ color: "var(--mute-3)" }}>in </span>
              <span style={{ color: "var(--violet)" }}>
                {formatNumber(inputTokens)}
              </span>
            </span>
            <span>
              <span style={{ color: "var(--mute-3)" }}>out </span>
              <span style={{ color: "var(--signal)" }}>
                {formatNumber(outputTokens)}
              </span>
            </span>
            {thinkingTokens > 0 ? (
              <span>
                <span style={{ color: "var(--mute-3)" }}>think </span>
                <span style={{ color: "var(--sky)" }}>
                  {formatNumber(thinkingTokens)}
                </span>
              </span>
            ) : null}
            {cost > 0 ? (
              <span>
                <span style={{ color: "var(--mute-3)" }}>cost </span>
                <span style={{ color: "var(--mint)" }}>
                  {formatCurrency(cost)}
                </span>
              </span>
            ) : null}
            {details.cache_hit ? (
              <span style={{ color: "var(--sky)" }}>cache hit</span>
            ) : null}
            {ctxPct !== null ? (
              <span
                title={`${formatNumber(inputTokens)} / ${formatNumber(contextWindow)} context tokens`}
              >
                <span style={{ color: "var(--mute-3)" }}>ctx </span>
                <span
                  style={{
                    color:
                      ctxPct > 85
                        ? "var(--signal)"
                        : ctxPct > 60
                          ? "var(--jade, var(--mint))"
                          : "var(--violet)",
                  }}
                >
                  {ctxPct.toFixed(1)}%
                </span>
                <span style={{ color: "var(--mute-3)" }}>
                  {" "}
                  ({formatNumber(inputTokens)}/{formatNumber(contextWindow)})
                </span>
              </span>
            ) : null}
          </div>

          {isClassification ? <ClassificationBadge text={text} /> : null}

          {thinkingText ? (
            <details
              className="group border-b"
              style={{ borderColor: "var(--line)" }}
            >
              <summary
                className="flex cursor-pointer select-none items-center gap-2 px-4 py-2 text-[10.5px] font-medium"
                style={{ color: "var(--sky)", background: "rgba(0,0,0,0.08)" }}
              >
                <span>Thinking</span>
                {thinkingTokens > 0 ? (
                  <span
                    className="font-mono text-[9.5px]"
                    style={{ color: "var(--mute-3)" }}
                  >
                    ({formatNumber(thinkingTokens)} tok)
                  </span>
                ) : null}
              </summary>
              <pre
                className="max-h-[300px] overflow-auto px-4 py-3 text-[10.5px] leading-relaxed whitespace-pre-wrap font-mono"
                style={{ color: "var(--mute-2)", background: "var(--card)" }}
              >
                {thinkingText}
              </pre>
            </details>
          ) : null}

          {text ? (
            <pre
              className="max-h-[400px] overflow-auto px-4 py-3 text-[11.5px] leading-relaxed whitespace-pre-wrap font-mono"
              style={{ color: "var(--ink-dim)" }}
            >
              {text}
            </pre>
          ) : (
            <div
              className="px-4 py-4 text-[11.5px]"
              style={{ color: "var(--mute-3)" }}
            >
              No text output (tool-call only response)
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function LlmOutputPanel({ events = [], title = "LLM Output" }) {
  const llmEvents = useMemo(() => {
    const normalized = events.map(normalizeTraceEvent).filter(Boolean);
    return normalized.filter((e) => e.kind === "llm_response").reverse();
  }, [events]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between border-b px-4 py-3">
        <div>
          <CardTitle className="text-[13.5px] font-medium">{title}</CardTitle>
          <CardDescription className="mt-0.5 text-[12px]">
            Live LLM reasoning and classification output per call
          </CardDescription>
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          {formatNumber(llmEvents.length)} calls
        </span>
      </CardHeader>

      {!llmEvents.length ? (
        <CardContent className="px-4 py-10 text-center text-[12px] text-muted-foreground">No LLM calls recorded yet.</CardContent>
      ) : (
        <CardContent className="max-h-[640px] overflow-auto p-3">
          <div className="flex flex-col gap-2">
          {llmEvents.map((event, index) => (
            <LlmCallCard
              key={`${event.seq || index}-${event.actor || "llm"}`}
              event={event}
              index={index}
            />
          ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
