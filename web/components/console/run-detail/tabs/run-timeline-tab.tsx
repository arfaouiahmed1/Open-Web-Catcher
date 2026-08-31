"use client";

import React, { useMemo } from "react";
import { ListOrdered, Radio } from "lucide-react";
import { StepTimeline } from "@/components/library/StepTimeline";
import { SectionPanel } from "@/components/console/common/section-panel";
import { Badge } from "@/components/ui/badge";
import type { PlanStep } from "@/components/library/types";

export interface RunTimelineTabProps {
  plan?: { steps?: PlanStep[] } | null;
  steps?: PlanStep[] | null;
  events?: Array<{ kind?: string; details?: Record<string, unknown>; seq?: number; message?: string }>;
  title?: string;
  isLive?: boolean;
  streamStatus?: string;
  connected?: boolean;
}

function deriveStepsFromPlan(plan: RunTimelineTabProps["plan"]): PlanStep[] {
  if (!plan || !Array.isArray(plan.steps)) return [];
  return (plan.steps as PlanStep[]).filter((s) => s && typeof s.id === "string");
}

function deriveStepsFromEvents(events: RunTimelineTabProps["events"]): PlanStep[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  // Fallback: synthesize steps from plan_step_update events when plan payload absent
  const latestById = new Map<string, PlanStep>();
  for (const ev of events) {
    if (ev?.kind !== "plan_step_update") continue;
    const d = ev.details as Record<string, unknown> | undefined;
    const id = String(d?.step_id || d?.id || ev?.message || "").trim();
    if (!id) continue;
    const status = String(d?.status || d?.state || "pending").trim() as PlanStep["status"];
    const title = String(d?.title || d?.step_title || id);
    const criteria = String(d?.criteria || "");
    const budget = (d?.budget as PlanStep["budget"]) ?? null;
    latestById.set(id, {
      id,
      title,
      criteria,
      budget,
      status: (["pending","in_progress","done","failed","skipped"].includes(status) ? status : "pending") as PlanStep["status"],
    });
  }
  return Array.from(latestById.values());
}

export function RunTimelineTab({ plan, steps: stepsProp, events, title = "Run plan", isLive = false, streamStatus, connected }: RunTimelineTabProps) {
  const effectiveIsLive = typeof connected === "boolean" ? connected : isLive;
  const steps = useMemo(() => {
    if (Array.isArray(stepsProp) && stepsProp.length > 0) return stepsProp;
    const fromPlan = deriveStepsFromPlan(plan);
    if (fromPlan.length) return fromPlan;
    return deriveStepsFromEvents(events);
  }, [stepsProp, plan, events]);

  const hasSteps = steps.length > 0;
  const liveLabel = effectiveIsLive ? "live" : "persisted";

  return (
    <SectionPanel
      title={title}
      description={`Live plan driven by SSE — zero polling. Steps update as plan_step_update events arrive.${streamStatus ? ` · ${streamStatus}` : ""}`}
      icon={<ListOrdered className="h-3.5 w-3.5" />}
      actions={
        <div className="flex items-center gap-2">
          <Badge
            tone={effectiveIsLive ? "live" : "muted"}
            className="text-[10px] gap-1"
            data-role="timeline-live-badge"
            data-live={effectiveIsLive ? "true" : "false"}
          >
            {effectiveIsLive ? <Radio className="h-3 w-3 animate-pulse" /> : null}
            {liveLabel}
          </Badge>
          <span className="text-[11px] text-muted-foreground" data-role="timeline-count">
            {hasSteps ? `${steps.length} steps` : "no steps yet"}
          </span>
        </div>
      }
      className="animate-fade-up"
    >
      <StepTimeline steps={steps} title={title} emptyLabel={effectiveIsLive ? "Waiting for plan…" : "No plan recorded for this run."} />
    </SectionPanel>
  );
}
