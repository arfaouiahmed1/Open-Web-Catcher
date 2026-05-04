"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function summarizeArgs(details) {
  if (!details) return null;
  try {
    const args = details.arguments ?? details.args ?? details.input ?? details;
    if (typeof args === "string") return args.slice(0, 80);
    const entries = Object.entries(args)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 30)}`);
    return entries.join(", ");
  } catch {
    return null;
  }
}

function buildAgentTodos(events) {
  // keyed by actor → { actor, items: Map<toolCallKey, item> }
  const agentMap = new Map();

  for (const event of events) {
    const actor = event.actor || "unknown";
    if (!agentMap.has(actor)) {
      agentMap.set(actor, { actor, items: new Map() });
    }
    const agent = agentMap.get(actor);

    const kind = event.kind || "";
    if (kind === "tool_call_started") {
      const toolName = event.details?.tool_name ?? event.details?.name ?? "tool";
      const key = event.details?.call_id ?? `${actor}-${event.seq ?? event.timestamp}-${toolName}`;
      agent.items.set(key, {
        key,
        toolName,
        argSummary: summarizeArgs(event.details),
        status: event.status === "error" ? "failed" : "running",
        seq: event.seq ?? 0,
      });
    } else if (kind === "tool_call_finished") {
      const key = event.details?.call_id;
      if (key && agent.items.has(key)) {
        const item = agent.items.get(key);
        item.status = event.status === "error" || event.status === "failed" ? "failed" : "done";
      } else {
        // Match by tool name + actor if no call_id
        const toolName = event.details?.tool_name ?? event.details?.name;
        if (toolName) {
          for (const [k, item] of agent.items) {
            if (item.toolName === toolName && item.status === "running") {
              item.status = event.status === "error" ? "failed" : "done";
              break;
            }
          }
        }
      }
    }
  }

  return Array.from(agentMap.values())
    .filter((a) => a.items.size > 0)
    .map((a) => ({
      ...a,
      items: Array.from(a.items.values()).sort((x, y) => x.seq - y.seq),
    }))
    .sort((a, b) => a.actor.localeCompare(b.actor));
}

function TodoItem({ item }) {
  const isDone = item.status === "done";
  const isFailed = item.status === "failed";
  const isRunning = item.status === "running";

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-md px-2 py-1.5 text-[12px] transition-colors",
        isDone && "opacity-70",
      )}
    >
      <span className="mt-0.5 shrink-0">
        {isDone ? (
          <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "var(--mint)" }} />
        ) : isFailed ? (
          <XCircle className="h-3.5 w-3.5" style={{ color: "var(--rose)" }} />
        ) : isRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--signal)" }} />
        ) : (
          <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "font-mono font-medium",
            isDone && "line-through decoration-muted-foreground/50",
            isFailed && "text-rose-500",
          )}
        >
          {item.toolName}
        </span>
        {item.argSummary && (
          <span className="ml-1.5 truncate text-[10.5px] text-muted-foreground">
            ({item.argSummary})
          </span>
        )}
      </div>
    </div>
  );
}

function AgentTaskCard({ agent, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const done = agent.items.filter((i) => i.status === "done").length;
  const failed = agent.items.filter((i) => i.status === "failed").length;
  const total = agent.items.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-card">
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 text-[12.5px] font-semibold text-foreground">{agent.actor}</span>
        <div className="flex items-center gap-2">
          {failed > 0 && (
            <Badge tone="rose" className="text-[10px] px-1.5 py-0">{failed} failed</Badge>
          )}
          <span className="font-mono text-[11px] text-muted-foreground">{done}/{total}</span>
        </div>
      </button>

      {/* Progress bar */}
      <div className="h-0.5 w-full bg-muted">
        <div
          className="h-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            background: failed > 0 ? "var(--rose)" : done === total ? "var(--mint)" : "var(--signal)",
          }}
        />
      </div>

      {open && (
        <div className="divide-y divide-border/40 px-1 py-1">
          {agent.items.map((item) => (
            <TodoItem key={item.key} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentTodoPanel({ events = [], isStreaming = false }) {
  const agents = useMemo(() => buildAgentTodos(events), [events]);

  if (!agents.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <span
          className="flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: "color-mix(in oklch, var(--violet) 12%, transparent)" }}
        >
          {isStreaming ? (
            <Loader2 className="h-5 w-5 animate-spin" style={{ color: "var(--violet)" }} />
          ) : (
            <CheckCircle2 className="h-5 w-5" style={{ color: "var(--violet)" }} />
          )}
        </span>
        <p className="text-sm text-muted-foreground">
          {isStreaming ? "Waiting for agent tool calls…" : "No tool calls recorded"}
        </p>
      </div>
    );
  }

  const totalItems = agents.reduce((s, a) => s + a.items.length, 0);
  const totalDone = agents.reduce((s, a) => s + a.items.filter((i) => i.status === "done").length, 0);

  return (
    <div className="space-y-3 p-1">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {agents.length} agent{agents.length !== 1 ? "s" : ""} · {totalDone}/{totalItems} tasks
        </span>
        {isStreaming && (
          <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            live
          </span>
        )}
      </div>
      {agents.map((agent) => (
        <AgentTaskCard key={agent.actor} agent={agent} defaultOpen={agents.length <= 3} />
      ))}
    </div>
  );
}
