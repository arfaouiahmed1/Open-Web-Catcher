/* eslint-disable */
"use client";

import { useMemo, useState } from "react";

import { formatTime } from "@/lib/datetime";
import { formatCurrency, formatNumber } from "@/lib/utils";
import type { AgentRunGraphNode } from "@/lib/agent-run-graph";
import {
  buildAgentInspectorSections,
  nodeEventsForActor,
  truncateEventJson,
  type InspectorEvent,
} from "@/lib/run-detail-helpers";

export interface AgentInspectorPanelProps {
  node: AgentRunGraphNode;
  events?: InspectorEvent[];
  totalCostUsd?: number;
  /** Hide tool input arguments/results when display settings disable them. */
  showToolArgs?: boolean;
}

type SectionKey = "tools" | "reasoning" | "artifacts" | "diagnostics" | "timeline";

const SECTION_LABELS: Record<SectionKey, string> = {
  tools: "Tools executed",
  reasoning: "Reasoning",
  artifacts: "Artifacts",
  diagnostics: "Diagnostics",
  timeline: "Timeline",
};

function compactDuration(value: number): string {
  if (!value) return "--";
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${(value % 60).toFixed(0)}s`;
}

function eventText(event: InspectorEvent): string {
  const raw = event as { message?: unknown; kind?: unknown };
  const details = (event.details || event.details_json || {}) as Record<string, unknown>;
  const text = String(
    raw.message ||
      details.error_preview ||
      details.error ||
      details.reason ||
      details.content_preview ||
      details.url ||
      details.stream_url ||
      raw.kind ||
      "event",
  );
  return text.replace(/https?:\/\/[^\s)]+/gi, "[target]").replace(/\s+/g, " ").trim();
}

function SectionTabs({
  active,
  counts,
  onSelect,
}: {
  active: SectionKey;
  counts: Record<SectionKey, number>;
  onSelect: (key: SectionKey) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Agent inspector sections">
      {(Object.keys(SECTION_LABELS) as SectionKey[]).map((key) => {
        const selected = key === active;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(key)}
            className="rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors"
            style={{
              borderColor: selected ? "var(--signal)" : "var(--line)",
              color: selected ? "var(--signal)" : "var(--mute-2)",
              background: selected
                ? "color-mix(in oklch, var(--signal) 10%, transparent)"
                : "transparent",
            }}
          >
            {SECTION_LABELS[key]} · {formatNumber(counts[key] || 0)}
          </button>
        );
      })}
    </div>
  );
}

function PayloadDetails({ value, label = "payload" }: { value: unknown; label?: string }) {
  return (
    <details className="mt-1.5">
      <summary
        className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.1em]"
        style={{ color: "var(--mute-3)" }}
      >
        {label}
      </summary>
      <pre
        className="mt-1 max-h-48 overflow-auto rounded-[8px] border p-2 font-mono text-[10px] leading-relaxed"
        style={{
          borderColor: "var(--line)",
          background: "color-mix(in oklch, var(--bg) 82%, transparent)",
          color: "var(--mute)",
        }}
      >
        {truncateEventJson(value)}
      </pre>
    </details>
  );
}

export function AgentInspectorPanel({ node, events = [], totalCostUsd = 0, showToolArgs = true }: AgentInspectorPanelProps) {
  const [section, setSection] = useState<SectionKey>("tools");
  const nodeEvents = useMemo(
    () => nodeEventsForActor(events, node.actor, node.kind === "root"),
    [events, node.actor, node.kind],
  );
  const sections = useMemo(() => buildAgentInspectorSections(nodeEvents), [nodeEvents]);
  const counts = useMemo(
    () => ({
      tools: sections.tools.length,
      reasoning: sections.reasoning.length,
      artifacts: sections.artifacts.length,
      diagnostics: sections.diagnostics.length,
      timeline: sections.timeline.length,
    }),
    [sections],
  );
  const costShare = totalCostUsd > 0 && node.costUsd > 0 ? node.costUsd / totalCostUsd : 0;
  const contextPct = node.contextWindow > 0 ? Math.max(0, Math.min(1, node.contextUsagePct)) : 0;

  return (
    <div
      className="rounded-[16px] border px-4 py-3"
      style={{
        borderColor: "var(--line)",
        background: "color-mix(in oklch, var(--card) 94%, transparent)",
      }}
      aria-live="polite"
      data-component="AgentInspectorPanel"
      data-actor={node.actor}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="text-[10px] font-semibold uppercase tracking-[0.12em]"
              style={{ color: "var(--signal)" }}
            >
              {node.stageLabel}
            </span>
            <span className="text-[14px] font-semibold" style={{ color: "var(--ink)" }}>
              {node.actor}
            </span>
            <span
              className="rounded-full border px-2 py-0.5 text-[10px]"
              style={{ borderColor: "var(--line)", color: "var(--mute-2)" }}
            >
              {node.status}
            </span>
          </div>
          <div className="mt-1 text-[12px]" style={{ color: "var(--mute)" }}>
            {node.safeLatestActivity || "No activity observed yet."}
          </div>
        </div>
        {node.latestTimestamp ? (
          <div className="text-[10px]" style={{ color: "var(--mute-3)" }}>
            {formatTime(node.latestTimestamp)}
          </div>
        ) : null}
      </div>

      <div className="mt-3 grid gap-2 grid-cols-2 sm:grid-cols-3">
        {[
          { label: "Events", value: formatNumber(node.eventCount), detail: node.latestKind || "--" },
          { label: "Tool calls", value: formatNumber(node.toolCalls), detail: `${formatNumber(sections.tools.length)} paired` },
          { label: "LLM calls", value: formatNumber(node.llmCalls), detail: "Model turns" },
          {
            label: "Tokens",
            value: node.totalTokens >= 1000 ? `${(node.totalTokens / 1000).toFixed(1)}k` : formatNumber(node.totalTokens),
            detail: "Input + output",
          },
          { label: "Duration", value: compactDuration(node.durationSeconds), detail: "Observed span" },
          {
            label: "Cost share",
            value: node.costUsd > 0 ? formatCurrency(node.costUsd) : "--",
            detail: costShare > 0 ? `${(costShare * 100).toFixed(0)}% of run` : "Not attributed",
          },
        ].map((metric) => (
          <div
            key={metric.label}
            className="min-w-0 rounded-[12px] border px-3 py-2.5"
            style={{
              borderColor: "var(--line)",
              background: "color-mix(in oklch, var(--bg) 82%, transparent)",
            }}
          >
            <div
              className="truncate text-[10px] font-semibold uppercase tracking-[0.12em]"
              style={{ color: "var(--mute-3)" }}
            >
              {metric.label}
            </div>
            <div className="mt-1 font-mono text-[14px] font-semibold whitespace-nowrap tabular-nums" style={{ color: "var(--ink)" }} title={metric.value}>
              {metric.value}
            </div>
            <div className="mt-0.5 truncate text-[10px]" style={{ color: "var(--mute)" }}>
              {metric.detail}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
        <span className="uppercase tracking-[0.1em]" style={{ color: "var(--mute-3)" }}>
          Context window
        </span>
        <span className="font-mono" style={{ color: "var(--mute-2)" }}>
          {node.contextWindow
            ? `${(contextPct * 100).toFixed(1)}%`
            : "not reported"}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${contextPct * 100}%`,
            background: node.contextWindow ? "var(--signal)" : "var(--mute-3)",
          }}
        />
      </div>

      <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--line)" }}>
        <SectionTabs active={section} counts={counts} onSelect={setSection} />

        {section === "tools" ? (
          <div className="mt-2 grid gap-1.5" role="tabpanel" aria-label="Tools executed">
            {sections.tools.length ? (
              sections.tools.map((tool) => (
                <div
                  key={tool.key}
                  className="rounded-[10px] border px-2.5 py-2"
                  style={{
                    borderColor: "var(--line)",
                    background: "color-mix(in oklch, var(--bg) 78%, transparent)",
                  }}
                  data-role="inspector-tool"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] font-semibold" style={{ color: "var(--ink)" }}>
                      {tool.toolName}
                    </span>
                    <span
                      className="rounded-full border px-1.5 py-0.5 font-mono text-[9px]"
                      style={{ borderColor: "var(--line)", color: "var(--mute-2)" }}
                    >
                      {tool.status || "unknown"}
                    </span>
                    {tool.durationSeconds > 0 ? (
                      <span className="font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
                        {tool.durationSeconds.toFixed(2)}s
                      </span>
                    ) : null}
                  </div>
                  {tool.target ? (
                    <div
                      className="mt-1 truncate font-mono text-[10px]"
                      style={{ color: "var(--mute-3)" }}
                      title={tool.target}
                    >
                      {tool.target}
                    </div>
                  ) : null}
                  {showToolArgs && tool.args && Object.keys(tool.args).length ? (
                    <PayloadDetails value={tool.args} label="input arguments" />
                  ) : null}
                  {showToolArgs && tool.result !== null && tool.result !== undefined ? (
                    <PayloadDetails
                      value={typeof tool.result === "string" ? tool.result.slice(0, 1600) : tool.result}
                      label="result"
                    />
                  ) : null}
                </div>
              ))
            ) : (
              <div className="text-[11px]" style={{ color: "var(--mute)" }}>
                No tool executions attributed to this agent yet.
              </div>
            )}
          </div>
        ) : null}

        {section === "reasoning" ? (
          <div className="mt-2 grid gap-1.5" role="tabpanel" aria-label="Reasoning">
            {sections.reasoning.length ? (
              sections.reasoning.map((event, index) => (
                <div
                  key={`${String(event.seq || index)}`}
                  className="rounded-[10px] border px-2.5 py-2"
                  style={{
                    borderColor: "var(--line)",
                    background: "color-mix(in oklch, var(--bg) 78%, transparent)",
                  }}
                  data-role="inspector-reasoning"
                >
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
                    <span>{String(event.kind || "reasoning")}</span>
                    {event.timestamp ? <span>· {formatTime(String(event.timestamp))}</span> : null}
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed" style={{ color: "var(--ink)" }}>
                    {eventText(event)}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-[11px]" style={{ color: "var(--mute)" }}>
                No model thoughts or decisions recorded for this agent yet.
              </div>
            )}
          </div>
        ) : null}

        {section === "artifacts" ? (
          <div className="mt-2 grid gap-1.5" role="tabpanel" aria-label="Artifacts">
            {sections.artifacts.length ? (
              sections.artifacts.map((event, index) => {
                const details = (event.details || event.details_json || {}) as Record<string, unknown>;
                const urls = [
                  details.stream_url,
                  details.player_iframe_url,
                  details.embedded_url,
                  details.screenshot_url,
                ]
                  .filter((value) => typeof value === "string" && String(value).trim())
                  .map((value) => String(value));
                return (
                  <div
                    key={`${String(event.seq || index)}`}
                    className="rounded-[10px] border px-2.5 py-2"
                    style={{
                      borderColor: "var(--line)",
                      background: "color-mix(in oklch, var(--bg) 78%, transparent)",
                    }}
                    data-role="inspector-artifact"
                  >
                    <div className="font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
                      {String(event.kind || "artifact")}
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: "var(--ink)" }}>
                      {eventText(event)}
                    </div>
                    {urls.map((url) => (
                      <div key={url} className="mt-1 break-all font-mono text-[10px]" style={{ color: "var(--sky)" }}>
                        {url}
                      </div>
                    ))}
                  </div>
                );
              })
            ) : (
              <div className="text-[11px]" style={{ color: "var(--mute)" }}>
                No extracted outputs or evidence for this agent yet.
              </div>
            )}
          </div>
        ) : null}

        {section === "diagnostics" ? (
          <div className="mt-2 grid gap-1.5" role="tabpanel" aria-label="Diagnostics">
            {sections.diagnostics.length ? (
              sections.diagnostics.map((event, index) => {
                const details = (event.details || event.details_json || {}) as Record<string, unknown>;
                const badges: string[] = [];
                if (details.network_diagnostics) badges.push("network");
                if (details.iframe_diagnostics) badges.push("iframe");
                if (details.popup || details.popups) badges.push("popup");
                if (String(event.kind || "").includes("sandbox")) badges.push("sandbox");
                return (
                  <div
                    key={`${String(event.seq || index)}`}
                    className="rounded-[10px] border px-2.5 py-2"
                    style={{
                      borderColor: "color-mix(in oklch, var(--rose) 26%, var(--line))",
                      background: "color-mix(in oklch, var(--rose) 5%, transparent)",
                    }}
                    data-role="inspector-diagnostic"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10px] font-semibold" style={{ color: "var(--rose)" }}>
                        {String(event.kind || "diagnostic")}
                      </span>
                      {badges.map((badge) => (
                        <span
                          key={badge}
                          className="rounded-full border px-1.5 py-0.5 font-mono text-[9px]"
                          style={{ borderColor: "var(--line)", color: "var(--mute-2)" }}
                        >
                          {badge}
                        </span>
                      ))}
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: "var(--ink)" }}>
                      {eventText(event)}
                    </div>
                    <PayloadDetails value={details} label="diagnostic payload" />
                  </div>
                );
              })
            ) : (
              <div className="text-[11px]" style={{ color: "var(--mute)" }}>
                No network, iframe, popup, or failure diagnostics for this agent.
              </div>
            )}
          </div>
        ) : null}

        {section === "timeline" ? (
          <div className="mt-2 grid gap-1.5" role="tabpanel" aria-label="Timeline">
            {sections.timeline.length ? (
              sections.timeline.map((event, index) => (
                <div
                  key={`${String(event.seq || event.timestamp || index)}`}
                  className="rounded-[10px] border px-2.5 py-2"
                  style={{
                    borderColor: "var(--line)",
                    background: "color-mix(in oklch, var(--bg) 78%, transparent)",
                  }}
                  data-role="inspector-timeline-event"
                >
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
                    <span>{String(event.kind || "event")}</span>
                    {event.seq !== undefined ? <span>· seq {String(event.seq)}</span> : null}
                    {event.timestamp ? <span>· {formatTime(String(event.timestamp))}</span> : null}
                  </div>
                  <div className="mt-0.5 truncate text-[11px]" style={{ color: "var(--ink)" }}>
                    {eventText(event)}
                  </div>
                  <PayloadDetails value={event.details || event.details_json || {}} label="event payload" />
                </div>
              ))
            ) : (
              <div className="text-[11px]" style={{ color: "var(--mute)" }}>
                No agent-specific events have arrived yet.
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
