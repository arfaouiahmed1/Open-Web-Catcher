"use client";

import React, { useMemo } from "react";
import { CheckCircle2, Circle, Clock, ListTodo, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface PlanItem {
  id: number;
  text: string;
  status: "pending" | "done" | "in_progress";
}

export interface AgentPlan {
  agentName: string;
  role: string;
  items: PlanItem[];
  completedCount: number;
  totalCount: number;
  progressPct: number;
}

interface AgentPlanBoardProps {
  events?: Array<Record<string, unknown>>;
  className?: string;
}

/**
 * Extract live agent plan items from SSE / trace events.
 */
function extractAgentPlans(events: Array<Record<string, unknown>> = []): AgentPlan[] {
  const plansByActor = new Map<string, Map<number, PlanItem>>();

  for (const ev of events) {
    const actor = String(ev.actor || ev.stage || "agent").trim().toLowerCase();
    const details = (ev.details || ev.details_json || {}) as Record<string, unknown>;

    // Look for tool_call_started or tool_call_finished for tool_name === "plan"
    const toolName = String(details.tool_name || ev.message || "");
    if (toolName.includes("plan") || ev.kind === "plan_updated") {
      const args = (details.tool_args || {}) as Record<string, unknown>;
      const op = String(args.op || "");
      const items = Array.isArray(args.items) ? (args.items as string[]) : [];
      const itemId = typeof args.item_id === "number" ? args.item_id : null;

      if (!plansByActor.has(actor)) {
        plansByActor.set(actor, new Map());
      }
      const actorMap = plansByActor.get(actor)!;

      if (op === "write" && items.length > 0) {
        actorMap.clear();
        items.forEach((text, i) => {
          actorMap.set(i, { id: i, text: String(text), status: "pending" });
        });
      } else if (op === "append") {
        const startId = actorMap.size;
        items.forEach((text, i) => {
          const id = startId + i;
          actorMap.set(id, { id, text: String(text), status: "pending" });
        });
      } else if (op === "complete" && itemId !== null) {
        const existing = actorMap.get(itemId);
        if (existing) {
          existing.status = "done";
        }
      } else if (op === "clear") {
        actorMap.clear();
      }

      // Also parse from result_full if plan tool returned plan_items list
      const resultFull = String(details.result_full || details.result_preview || "");
      if (resultFull.includes("plan_items")) {
        try {
          const parsed = JSON.parse(resultFull);
          if (Array.isArray(parsed.plan_items)) {
            parsed.plan_items.forEach((item: { id: number; text: string; status: "pending" | "done" }) => {
              actorMap.set(item.id, { id: item.id, text: item.text, status: item.status });
            });
          }
        } catch {}
      }
    }
  }

  const result: AgentPlan[] = [];
  for (const [actor, itemsMap] of plansByActor.entries()) {
    const items = Array.from(itemsMap.values()).sort((a, b) => a.id - b.id);
    if (items.length === 0) continue;

    const completedCount = items.filter((i) => i.status === "done").length;
    const totalCount = items.length;
    const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    result.push({
      agentName: actor.replace(/_/g, " "),
      role: actor,
      items,
      completedCount,
      totalCount,
      progressPct,
    });
  }

  return result;
}

export function AgentPlanBoard({ events = [], className }: AgentPlanBoardProps) {
  const plans = useMemo(() => extractAgentPlans(events), [events]);

  if (plans.length === 0) {
    return null;
  }

  return (
    <Card className={className}>
      <CardHeader className="border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-semibold">Agent Action Plans (Live Todos)</CardTitle>
          </div>
          <Badge tone="default" className="text-[11px]">
            {plans.length} active {plans.length === 1 ? "agent" : "agents"}
          </Badge>
        </div>
        <CardDescription className="text-[12px]">
          Structured task lists formulated by autonomous agents and checked off as execution progresses.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.role}
              className="flex flex-col rounded-[14px] border border-border/60 bg-muted/20 p-3.5 space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[13px] capitalize text-foreground">
                  {plan.agentName}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {plan.completedCount}/{plan.totalCount} ({plan.progressPct}%)
                </span>
              </div>

              {/* Progress Bar */}
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                <div
                  className="h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none"
                  style={{
                    width: `${plan.progressPct}%`,
                    backgroundColor: plan.progressPct === 100 ? "var(--color-emerald-500, #10b981)" : "var(--color-primary, #3b82f6)",
                  }}
                />
              </div>

              {/* Todo Items */}
              <div className="space-y-1.5 text-[12px]">
                {plan.items.map((item) => {
                  const isDone = item.status === "done";
                  return (
                    <div
                      key={item.id}
                      className="flex items-start gap-2 rounded-md p-1 transition-colors hover:bg-muted/40"
                    >
                      {isDone ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500 mt-0.5" />
                      ) : (
                        <Circle className="h-4 w-4 shrink-0 text-muted-foreground/60 mt-0.5" />
                      )}
                      <span
                        className={
                          isDone
                            ? "text-muted-foreground line-through transition-colors motion-reduce:transition-none"
                            : "text-foreground font-medium"
                        }
                      >
                        {item.text}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
