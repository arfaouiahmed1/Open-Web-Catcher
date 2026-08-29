"use client";

import { Activity, Coins, Cpu, Layers3, Radio, Server, Waypoints } from "lucide-react";
import { memo, useMemo } from "react";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { statusLabel, statusTone } from "@/lib/run-status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StructuredDataCard } from "@/components/structured-data-card";
import { MetricCard } from "@/components/library/MetricCard";
import { StateFrame } from "@/components/library/StateFrame";

interface StageRollup {
  agent_type: string;
  actors?: string[];
  status?: string;
  invocations?: number;
  active_parallel_agents?: number;
  max_parallel_agents?: number;
  total_tokens?: number;
  cost_usd?: number;
  output_summary?: string;
  started_at?: string;
}

interface AgentRollup {
  agent_run_id?: string | number;
  invocation_index?: number;
  agent_type: string;
  actor?: string;
  status?: string;
  llm_calls?: number;
  tool_calls?: number;
  total_tokens?: number;
  cost_usd?: number;
  stream_count?: number;
  output_summary?: string;
  raw_output?: Record<string, unknown>;
}

interface MetricProps {
  label: string;
  value: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }> | null;
}

const Metric = memo(function Metric({ label, value, icon: Icon = null }: MetricProps): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card/70 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
        {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
        <span>{label}</span>
      </div>
      <div className="mt-1 font-mono text-[12px] text-foreground/80">{value}</div>
    </div>
  );
});

function stringList(values: unknown, limit = 6): string[] {
  return (Array.isArray(values) ? (values as unknown[]) : [])
    .map((value) => {
      if (typeof value === "string") return value;
      if (value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        return (v.url as string) ?? (v.primary_stream as string) ?? (v.label as string) ?? "";
      }
      return "";
    })
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function agentEvidence(row: AgentRollup): { title: string; rows: string[] } {
  const payload = (row?.raw_output && typeof row.raw_output === "object" ? (row.raw_output as Record<string, unknown>) : {}) as Record<string, unknown>;
  const agentType = String(row?.agent_type ?? "").toLowerCase();
  if (agentType.includes("landing")) {
    return { title: "Hosting URLs found", rows: stringList((payload.hosting_pages as unknown) ?? (payload.landing_match_urls as unknown) ?? [], 8) };
  }
  if (agentType.includes("hosting") || agentType.includes("embedded")) {
    const servers = Array.isArray(payload.servers) ? (payload.servers as Array<Record<string, unknown>>) : [];
    const serverRows = servers.slice(0, 8).map((server, index) => {
      const label = (server?.label as string) ?? (server?.name as string) ?? `server ${index + 1}`;
      const state = (server?.status as string) ?? (server?.player_state as string) ?? ((server?.server_up as boolean) ? "up" : "unknown");
      const streamCount = [...((Array.isArray(server?.stream_urls) ? server.stream_urls : []) as unknown[]), ...((Array.isArray(server?.m3u8_urls) ? server.m3u8_urls : []) as unknown[]), ...((Array.isArray(server?.mpd_urls) ? server.mpd_urls : []) as unknown[]), ...((Array.isArray(server?.mp4_urls) ? server.mp4_urls : []) as unknown[])].filter(Boolean).length;
      return `${label} | ${state}${streamCount ? ` | streams ${streamCount}` : ""}`;
    });
    const streams = stringList([...((Array.isArray(payload.all_stream_urls) ? payload.all_stream_urls : []) as unknown[]), ...((Array.isArray(payload.streaming_urls) ? payload.streaming_urls : []) as unknown[])], 4);
    return { title: agentType.includes("embedded") ? "Embedded player results" : "Server states", rows: [...serverRows, ...streams] };
  }
  return { title: "Evidence", rows: [] };
}

const EvidencePreview = memo(function EvidencePreview({ row }: { row: AgentRollup }): React.JSX.Element | null {
  const evidence = agentEvidence(row);
  const continuationCount = Number(((row?.raw_output as Record<string, unknown>)?.agent_run as Record<string, unknown> | undefined)?.continuation_count ?? 0);
  if (!evidence.rows.length && !continuationCount) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">{evidence.title}</div>
        {continuationCount ? <Badge tone="warning" className="font-mono text-[10px]">{continuationCount} continuation{continuationCount === 1 ? "" : "s"}</Badge> : null}
      </div>
      {evidence.rows.length ? <div className="mt-2 grid gap-1.5">{evidence.rows.map((item, index) => <div key={`${item}-${index}`} className="truncate rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[11px] text-foreground/85" title={item}>{item}</div>)}</div> : null}
    </div>
  );
});

function outputTotals(stageRollups: StageRollup[] = [], agentRollups: AgentRollup[] = []): { stages: number; agents: number; tokens: number; cost: number; streams: number; evidence: number } {
  const stages = Array.isArray(stageRollups) ? stageRollups : [];
  const agents = Array.isArray(agentRollups) ? agentRollups : [];
  return {
    stages: stages.length,
    agents: agents.length,
    tokens: agents.reduce((sum, row) => sum + Number(row?.total_tokens ?? 0), 0),
    cost: agents.reduce((sum, row) => sum + Number(row?.cost_usd ?? 0), 0),
    streams: agents.reduce((sum, row) => {
      const payload = (row?.raw_output && typeof row.raw_output === "object" ? (row.raw_output as Record<string, unknown>) : {}) as Record<string, unknown>;
      return sum + Number(row?.stream_count ?? (payload.stream_count as number) ?? 0);
    }, 0),
    evidence: agents.reduce((sum, row) => sum + agentEvidence(row).rows.length, 0),
  };
}

const StageCard = memo(function StageCard({ row }: { row: StageRollup }): React.JSX.Element {
  return (
    <Card className="overflow-hidden shadow-card">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">{row.agent_type}</div>
            <div className="mt-1 text-[13px] font-medium text-foreground">{row.actors?.length ? row.actors.join(" / ") : row.agent_type}</div>
          </div>
          <Badge tone={statusTone(row.status) as never}>{statusLabel(row.status)}</Badge>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Invocations" value={formatNumber(row.invocations ?? 0)} icon={Waypoints} />
          <Metric label="Parallel" value={`${formatNumber(row.active_parallel_agents ?? 0)} live / ${formatNumber(row.max_parallel_agents ?? 0)} peak`} icon={Activity} />
          <Metric label="Tokens" value={formatNumber(row.total_tokens ?? 0)} icon={Cpu} />
          <Metric label="Cost" value={formatCurrency(row.cost_usd ?? 0)} icon={Coins} />
        </div>

        {row.output_summary ? <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[12px] leading-relaxed text-foreground/80">{row.output_summary}</div> : null}
      </CardContent>
    </Card>
  );
});

const AgentCard = memo(function AgentCard({ row }: { row: AgentRollup }): React.JSX.Element {
  const evidence = agentEvidence(row);
  return (
    <Card className="overflow-hidden shadow-card">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-mono text-[11px] text-muted-foreground/60">#{row.invocation_index ?? 0}</div>
              <Badge tone="default" className="font-mono text-[10px]">{row.agent_type}</Badge>
            </div>
            <div className="mt-1 truncate text-[13px] font-medium text-foreground">{row.actor ?? row.agent_type}</div>
          </div>
          <Badge tone={statusTone(row.status) as never}>{statusLabel(row.status)}</Badge>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="LLM" value={formatNumber(row.llm_calls ?? 0)} icon={Cpu} />
          <Metric label="Tools" value={formatNumber(row.tool_calls ?? 0)} icon={Waypoints} />
          <Metric label="Tokens" value={formatNumber(row.total_tokens ?? 0)} icon={Radio} />
          <Metric label="Cost" value={formatCurrency(row.cost_usd ?? 0)} icon={Coins} />
        </div>

        {row.output_summary ? (
          <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">Output summary</div>
            <div className="mt-1 text-[12px] leading-relaxed text-foreground/80">{row.output_summary}</div>
          </div>
        ) : null}

        {evidence.rows.length ? (
          <div className="rounded-lg border border-border bg-muted/20 px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Server className="h-3.5 w-3.5 text-primary" />
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">{evidence.title}</div>
            </div>
            <div className="mt-2 grid gap-1.5">{evidence.rows.map((item, index) => <div key={`${item}-${index}`} className="truncate rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[11px] text-foreground/85" title={item}>{item}</div>)}</div>
          </div>
        ) : (
          <EvidencePreview row={row} />
        )}

        {row.raw_output && Object.keys(row.raw_output).length > 0 ? (
          <div>
            <StructuredDataCard title={`${row.actor ?? row.agent_type} output summary`} description="Structured output fields captured for this agent run." data={row.raw_output} limit={6} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
});

export interface AgentOutputPanelProps {
  stageRollups?: StageRollup[];
  agentRollups?: AgentRollup[];
  parallelism?: unknown;
  title?: string;
}

export const AgentOutputPanel = memo(function AgentOutputPanel({ stageRollups = [], agentRollups = [], parallelism = null, title = "Agent outputs" }: AgentOutputPanelProps): React.JSX.Element {
  const totals = useMemo(() => outputTotals(stageRollups, agentRollups), [stageRollups, agentRollups]);

  if (!stageRollups.length && !agentRollups.length) {
    return (
      <Card>
        <CardContent className="px-5 py-10 text-center text-sm text-muted-foreground">No agent output recorded yet.</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden shadow-card">
        <CardHeader className="border-b border-border px-4 py-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0">
              <CardTitle className="text-sm font-medium">{title}</CardTitle>
              <CardDescription className="mt-0.5 text-sm">Evidence-first agent results, stage rollups, tokens, cost, and raw payloads.</CardDescription>
            </div>
            <Badge tone="signal" className="ml-auto font-mono text-[10px]">
              {formatNumber(totals.agents)} agent runs
            </Badge>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
            <Metric label="Stages" value={formatNumber(totals.stages)} icon={Layers3} />
            <Metric label="Agent runs" value={formatNumber(totals.agents)} icon={Waypoints} />
            <Metric label="Evidence" value={formatNumber(totals.evidence)} icon={Server} />
            <Metric label="Streams" value={formatNumber(totals.streams)} icon={Radio} />
            <Metric label="Tokens" value={formatNumber(totals.tokens)} icon={Cpu} />
            <Metric label="Cost" value={formatCurrency(totals.cost)} icon={Coins} />
          </div>
        </CardHeader>
      </Card>

      {stageRollups.length ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[12px] font-medium text-foreground"><Layers3 className="h-4 w-4 text-primary" />Stage rollups</div>
          <div className="grid gap-3 xl:grid-cols-2">{stageRollups.map((row) => <StageCard key={`${row.agent_type}-${row.started_at ?? row.invocations}`} row={row} />)}</div>
        </div>
      ) : null}

      {agentRollups.length ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[12px] font-medium text-foreground"><Waypoints className="h-4 w-4 text-sky-400" />Agent runs</div>
          <div className="space-y-3">{agentRollups.map((row) => <AgentCard key={`${row.agent_run_id}-${row.invocation_index}`} row={row} />)}</div>
        </div>
      ) : null}
    </div>
  );
});
