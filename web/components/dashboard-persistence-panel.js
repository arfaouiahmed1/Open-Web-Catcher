"use client";

import { Database, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils";

const PRIORITY_TABLES = [
  ["pipeline_runs", "Runs"],
  ["agent_runs", "Agent runs"],
  ["runtime_events", "Runtime events"],
  ["llm_calls", "LLM calls"],
  ["tool_calls", "Tool calls"],
  ["agent_outputs", "Agent outputs"],
  ["prompt_compilations", "Prompt cache"],
  ["memory_entries", "Memory"],
];

function CountCard({ label, value, accent = "var(--sky)" }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold leading-none" style={{ color: accent }}>
        {formatNumber(value || 0)}
      </div>
    </div>
  );
}

export function DashboardPersistencePanel({ entries = [] }) {
  const byName = Object.fromEntries((entries || []).map((row) => [row.name, row.row_count || 0]));
  const visible = PRIORITY_TABLES.filter(([name]) => Object.prototype.hasOwnProperty.call(byName, name));

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center gap-3 border-b bg-muted/20 px-4 py-3.5">
        <div className="flex size-8 items-center justify-center rounded-md border bg-primary/10 text-primary">
          <Database />
        </div>
        <div className="min-w-0 flex-1">
          <CardTitle className="text-[13.5px]">Persistence health</CardTitle>
          <CardDescription className="text-[11.5px]">
            Normalized database records currently available to the dashboard.
          </CardDescription>
        </div>
        <Badge tone="success" className="gap-1.5 px-2.5 py-1 text-[10.5px]">
          <ShieldCheck />
          db-backed
        </Badge>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {visible.length ? visible.map(([name, label], index) => (
            <CountCard
              key={name}
              label={label}
              value={byName[name] || 0}
              accent={index % 4 === 0 ? "var(--sky)" : index % 4 === 1 ? "var(--signal)" : index % 4 === 2 ? "var(--mint)" : "var(--violet)"}
            />
          )) : (
            <div className="rounded-[10px] border border-dashed px-4 py-6 text-center text-[12px] text-muted-foreground">
              Database table counts are not available yet.
            </div>
          )}
        </div>

        <div className="rounded-[12px] border bg-muted/20 px-3.5 py-3 text-[12px] leading-relaxed text-muted-foreground">
          The operator dashboard is sourced from persisted observability tables such as <span className="font-mono text-foreground">pipeline_runs</span>, <span className="font-mono text-foreground">agent_runs</span>, <span className="font-mono text-foreground">runtime_events</span>, <span className="font-mono text-foreground">llm_calls</span>, and <span className="font-mono text-foreground">tool_calls</span>.
        </div>
      </CardContent>
    </Card>
  );
}
