"use client";

import { Database, ShieldCheck } from "lucide-react";

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
    <div
      className="rounded-[12px] border px-3 py-2.5"
      style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.02)" }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
        {label}
      </div>
      <div className="mt-1 text-[18px] font-semibold leading-none" style={{ color: accent }}>
        {formatNumber(value || 0)}
      </div>
    </div>
  );
}

export function DashboardPersistencePanel({ entries = [] }) {
  const byName = Object.fromEntries((entries || []).map((row) => [row.name, row.row_count || 0]));
  const visible = PRIORITY_TABLES.filter(([name]) => Object.prototype.hasOwnProperty.call(byName, name));

  return (
    <div
      className="overflow-hidden rounded-[14px] border"
      style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
    >
      <div className="flex items-center gap-3 border-b px-4 py-3.5" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.02)" }}>
        <div
          className="flex h-8 w-8 items-center justify-center rounded-[9px]"
          style={{ background: "color-mix(in oklch, var(--sky) 12%, transparent)", border: "1px solid color-mix(in oklch, var(--sky) 25%, transparent)" }}
        >
          <Database className="h-4 w-4" style={{ color: "var(--sky)" }} />
        </div>
        <div>
          <div className="text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>Persistence health</div>
          <div className="text-[11.5px]" style={{ color: "var(--mute)" }}>
            Normalized database records currently available to the dashboard.
          </div>
        </div>
        <div className="ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px]" style={{ borderColor: "color-mix(in oklch, var(--mint) 28%, transparent)", background: "color-mix(in oklch, var(--mint) 8%, transparent)", color: "var(--mint)" }}>
          <ShieldCheck className="h-3.5 w-3.5" />
          db-backed
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {visible.length ? visible.map(([name, label], index) => (
            <CountCard
              key={name}
              label={label}
              value={byName[name] || 0}
              accent={index % 4 === 0 ? "var(--sky)" : index % 4 === 1 ? "var(--signal)" : index % 4 === 2 ? "var(--mint)" : "var(--violet)"}
            />
          )) : (
            <div className="rounded-[10px] border border-dashed px-4 py-6 text-center text-[12px]" style={{ borderColor: "var(--line)", color: "var(--mute)" }}>
              Database table counts are not available yet.
            </div>
          )}
        </div>

        <div className="rounded-[12px] border px-3.5 py-3 text-[12px] leading-relaxed" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.015)", color: "var(--mute)" }}>
          The operator dashboard is sourced from persisted observability tables such as <span className="font-mono" style={{ color: "var(--ink-dim)" }}>pipeline_runs</span>, <span className="font-mono" style={{ color: "var(--ink-dim)" }}>agent_runs</span>, <span className="font-mono" style={{ color: "var(--ink-dim)" }}>runtime_events</span>, <span className="font-mono" style={{ color: "var(--ink-dim)" }}>llm_calls</span>, and <span className="font-mono" style={{ color: "var(--ink-dim)" }}>tool_calls</span>.
        </div>
      </div>
    </div>
  );
}
