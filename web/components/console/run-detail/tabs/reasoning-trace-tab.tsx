"use client";

import React, { useMemo } from "react";
import { Brain, Sparkles } from "lucide-react";
import { ReasoningTrace } from "@/components/library/ReasoningTrace";
import { SectionPanel } from "@/components/console/common/section-panel";
import { Badge } from "@/components/ui/badge";
import type { ReasoningEntry } from "@/components/library/types";

export interface ReasoningTraceTabProps {
  events?: Array<Record<string, unknown>>;
  entries?: ReasoningEntry[];
  title?: string;
}

function entriesFromEvents(events: Array<Record<string, unknown>>): ReasoningEntry[] {
  const out: ReasoningEntry[] = [];
  for (const raw of events) {
    const kind = String((raw as { kind?: string })?.kind || "");
    const isReasoningKind =
      kind === "llm_response" ||
      kind === "llm_turn_started" ||
      kind === "orchestrator_decision" ||
      kind === "chain" ||
      kind === "agent";
    if (!isReasoningKind) continue;
    const seq = (raw as { seq?: number })?.seq;
    const ts = String((raw as { timestamp?: string })?.timestamp || (raw as { created_at?: string })?.created_at || "");
    const details = ((raw as { details?: Record<string, unknown> })?.details || (raw as { details_json?: Record<string, unknown> })?.details_json || {}) as Record<string, unknown>;
    const actor = String((raw as { actor?: string })?.actor || details.actor || kind);
    const thought =
      String(details.thinking_content || details.content_preview || details.reasoning || (raw as { message?: string })?.message || "").trim();
    const title = actor ? `${actor} — ${kind}` : kind;
    out.push({
      id: String(seq != null ? `r-${seq}` : `r-${out.length}`),
      title: title.slice(0, 80),
      thought: thought ? thought.slice(0, 2000) : undefined,
      timestamp: ts || undefined,
    });
  }
  // Deterministic order: seq ascending -> already in arrival order; keep stable
  return out;
}

export function ReasoningTraceTab({ events, entries: explicitEntries, title = "Reasoning trace" }: ReasoningTraceTabProps) {
  const entries = useMemo(() => {
    if (Array.isArray(explicitEntries) && explicitEntries.length) return explicitEntries;
    if (!Array.isArray(events)) return [];
    return entriesFromEvents(events);
  }, [events, explicitEntries]);

  const hasEntries = entries.length > 0;
  return (
    <SectionPanel
      title={title}
      description="Derived live from SSE events — LLM reasoning + orchestrator decisions. Zero polling."
      icon={<Brain className="h-3.5 w-3.5" />}
      actions={
        <Badge tone={hasEntries ? "success" : "muted"} className="text-[10px]">
          <Sparkles className="mr-1 h-3 w-3" />
          <span data-role="reasoning-count">{hasEntries ? `${entries.length} entries` : "no reasoning yet"}</span>
        </Badge>
      }
      className="animate-fade-up"
    >
      <ReasoningTrace entries={entries} title={title} emptyLabel="No reasoning recorded yet — waiting for model turns." />
    </SectionPanel>
  );
}
