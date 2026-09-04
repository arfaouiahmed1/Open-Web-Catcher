import { actorToStage, STAGE_LABELS, STAGE_ORDER, type Stage } from "./run-trace";

export interface AgentRunGraphEvent {
  seq?: number | string;
  timestamp?: string;
  created_at?: string;
  actor?: string;
  kind?: string;
  status?: string;
  message?: string;
  details?: Record<string, unknown>;
  details_json?: Record<string, unknown>;
  agent_run_id?: number | string | null;
  agent_type?: string;
  invocation_index?: number | string | null;
  [key: string]: unknown;
}

export interface AgentRunGraphRollup {
  agent_run_id?: number | string | null;
  actor?: string;
  agent_type?: string;
  status?: string;
  invocation_index?: number | string | null;
  llm_calls?: number | string;
  llm_calls_made?: number | string;
  tool_calls?: number | string;
  tool_calls_made?: number | string;
  total_tokens?: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
  cost_usd?: number | string;
  duration_seconds?: number | string;
  context_window?: number | string;
  context_tokens?: number | string;
  context_usage_pct?: number | string;
  started_at?: string;
  finished_at?: string;
  [key: string]: unknown;
}

export type AgentGraphStatus = "queued" | "running" | "success" | "partial" | "failed" | "skipped" | "unknown";

export interface AgentRunGraphNode {
  id: string;
  kind: "root" | "agent";
  actor: string;
  stage: string;
  stageLabel: string;
  stageIndex: number;
  status: AgentGraphStatus;
  eventCount: number;
  llmCalls: number;
  toolCalls: number;
  totalTokens: number;
  costUsd: number;
  durationSeconds: number;
  contextWindow: number;
  contextTokens: number;
  contextUsagePct: number;
  latestActivity: string;
  safeLatestActivity: string;
  latestKind: string;
  latestTimestamp: string;
  recentEvents: AgentRunGraphEvent[];
}

export interface AgentRunGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "root" | "handoff" | "continuation";
  animated: boolean;
}

export interface AgentRunGraphSummary {
  agentCount: number;
  activeAgentCount: number;
  completedAgentCount: number;
  eventCount: number;
  toolCallCount: number;
  llmCallCount: number;
  totalTokens: number;
  contextWindow: number;
  contextTokens: number;
  contextUsagePct: number;
  contextWindowCount: number;
}

export interface AgentRunGraphResult {
  nodes: AgentRunGraphNode[];
  agentNodes: AgentRunGraphNode[];
  edges: AgentRunGraphEdge[];
  summary: AgentRunGraphSummary;
}

interface AgentItem {
  id: string;
  actor: string;
  invocationIndex: number;
  rollup: AgentRunGraphRollup | null;
  events: AgentRunGraphEvent[];
}

const FAILURE_KINDS = new Set(["agent_failed", "agent_timeout", "llm_error", "llm_timeout", "llm_rate_limited", "pipeline_failed"]);
const ACTIVE_KINDS = new Set(["agent_started", "agent_loop_started", "tool_call_started", "llm_turn_started", "tool_session_connecting"]);
const SUCCESS_KINDS = new Set(["agent_finished", "agent_loop_finished"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function eventDetails(event: AgentRunGraphEvent): Record<string, unknown> {
  return asRecord(event.details || event.details_json);
}

function numberValue(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function numericValues(...values: unknown[]): number[] {
  return values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
}

function maxValue(...values: unknown[]): number {
  return Math.max(0, ...numericValues(...values));
}

function normalized(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function eventSequence(event: AgentRunGraphEvent): number {
  return numberValue(event.seq);
}

function sortEvents(events: AgentRunGraphEvent[]): AgentRunGraphEvent[] {
  return [...events].sort((left, right) => {
    const leftSeq = eventSequence(left);
    const rightSeq = eventSequence(right);
    if (leftSeq && rightSeq && leftSeq !== rightSeq) return leftSeq - rightSeq;
    if (leftSeq) return -1;
    if (rightSeq) return 1;
    return String(left.timestamp || left.created_at || "").localeCompare(String(right.timestamp || right.created_at || ""));
  });
}

function rootActorMatches(actor: string, rootActor: string): boolean {
  const value = normalized(actor);
  const root = normalized(rootActor);
  return !value || value === root || value === "control-room" || value === "control_room";
}

function eventActor(event: AgentRunGraphEvent): string {
  const details = eventDetails(event);
  return String(event.actor || event.agent_type || details.agent_type || details.actor || "").trim();
}

function eventAgentRunId(event: AgentRunGraphEvent): number {
  return numberValue(event.agent_run_id, eventDetails(event).agent_run_id);
}

function eventInvocationIndex(event: AgentRunGraphEvent): number {
  return numberValue(event.invocation_index, eventDetails(event).invocation_index);
}

function rollupActor(rollup: AgentRunGraphRollup): string {
  return String(rollup.actor || rollup.agent_type || "agent").trim() || "agent";
}

function rollupAgentRunId(rollup: AgentRunGraphRollup): number {
  return numberValue(rollup.agent_run_id);
}

function rollupInvocationIndex(rollup: AgentRunGraphRollup): number {
  return numberValue(rollup.invocation_index);
}

function sameItem(item: AgentItem, actor: string, agentRunId: number, invocationIndex: number): boolean {
  if (agentRunId && item.id === `run:${agentRunId}`) return true;
  if (agentRunId && item.id.startsWith("run:") && item.id !== `run:${agentRunId}`) return false;
  if (normalized(item.actor) !== normalized(actor)) return false;
  return item.invocationIndex === invocationIndex || item.invocationIndex === 0 || invocationIndex === 0;
}

function findOrCreateItem(items: AgentItem[], actor: string, agentRunId: number, invocationIndex: number): AgentItem {
  const existing = items.find((item) => sameItem(item, actor, agentRunId, invocationIndex));
  if (existing) {
    if (agentRunId && !existing.id.startsWith("run:")) existing.id = `run:${agentRunId}`;
    if (!existing.invocationIndex && invocationIndex) existing.invocationIndex = invocationIndex;
    return existing;
  }
  const id = agentRunId ? `run:${agentRunId}` : `agent:${normalized(actor)}:${invocationIndex}`;
  const item = { id, actor, invocationIndex, rollup: null, events: [] };
  items.push(item);
  return item;
}

function statusFrom(rollup: AgentRunGraphRollup | null, events: AgentRunGraphEvent[]): AgentGraphStatus {
  const rollupStatus = normalized(rollup?.status);
  if (["queued", "running", "success", "partial", "failed", "skipped"].includes(rollupStatus)) {
    return rollupStatus as AgentGraphStatus;
  }
  const latest = events[events.length - 1];
  const latestStatus = normalized(latest?.status);
  if (latestStatus === "failed" || latestStatus === "error") return "failed";
  if (latestStatus === "skipped") return "skipped";
  if (latestStatus === "success" || latestStatus === "succeeded" || latestStatus === "ok") {
    return SUCCESS_KINDS.has(String(latest?.kind || "")) ? "success" : "unknown";
  }
  if (FAILURE_KINDS.has(String(latest?.kind || ""))) return "failed";
  if (SUCCESS_KINDS.has(String(latest?.kind || ""))) return "success";
  if (ACTIVE_KINDS.has(String(latest?.kind || "")) || latestStatus === "started" || latestStatus === "running") return "running";
  return "unknown";
}

function stageFor(actor: string, rollup: AgentRunGraphRollup | null): string {
  return actorToStage(actor) || actorToStage(rollup?.agent_type) || normalized(rollup?.agent_type) || normalized(actor) || "agent";
}

function stageIndexFor(stage: string): number {
  const index = STAGE_ORDER.indexOf(stage as Stage);
  return index >= 0 ? index : STAGE_ORDER.length;
}

function stageLabelFor(stage: string, actor: string): string {
  if ((STAGE_ORDER as readonly string[]).includes(stage)) return STAGE_LABELS[stage as Stage];
  return actor || "Agent";
}

function safeActivity(text: string): string {
  return text.replace(/https?:\/\/[^\s)]+/gi, "[target]").replace(/\s+/g, " ").trim();
}

function activityFor(event: AgentRunGraphEvent | undefined): string {
  if (!event) return "Waiting for telemetry";
  const details = eventDetails(event);
  const toolName = String(details.tool_name || details.name || details.profile || "").trim();
  const message = String(event.message || "").trim();
  return message || (toolName ? `${event.kind || "Event"}: ${toolName}` : String(event.kind || "Runtime event"));
}

function timestampMs(value: unknown): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationFrom(item: AgentItem, latest: AgentRunGraphEvent | undefined): number {
  const rollupDuration = numberValue(item.rollup?.duration_seconds);
  if (rollupDuration) return rollupDuration;
  const first = item.events[0];
  const start = timestampMs(first?.timestamp || first?.created_at || item.rollup?.started_at);
  const end = timestampMs(latest?.timestamp || latest?.created_at || item.rollup?.finished_at);
  return start && end && end >= start ? (end - start) / 1000 : 0;
}

function makeAgentNode(item: AgentItem): AgentRunGraphNode {
  const events = sortEvents(item.events);
  const latest = events[events.length - 1];
  const llmEvents = events.filter((event) => String(event.kind || "").startsWith("llm_") && ["llm_response", "llm_error", "llm_timeout", "llm_rate_limited", "llm_turn_started"].includes(String(event.kind)));
  const toolEvents = events.filter((event) => String(event.kind || "").startsWith("tool_call_") || String(event.kind || "").startsWith("tool_session_"));
  const inputTokens = events.reduce((total, event) => total + numberValue(eventDetails(event).input_tokens), 0);
  const outputTokens = events.reduce((total, event) => total + numberValue(eventDetails(event).output_tokens), 0);
  const contextWindow = maxValue(
    item.rollup?.context_window,
    ...events.map((event) => eventDetails(event).context_window),
  );
  const contextTokens = maxValue(
    item.rollup?.context_tokens,
    ...events.map((event) => eventDetails(event).context_tokens),
    ...events.map((event) => numberValue(eventDetails(event).input_tokens) + numberValue(eventDetails(event).output_tokens)),
  );
  const contextUsagePct = Math.max(
    0,
    maxValue(item.rollup?.context_usage_pct, ...events.map((event) => eventDetails(event).context_usage_pct)) ||
      (contextWindow ? contextTokens / contextWindow : 0),
  );
  const stage = stageFor(item.actor, item.rollup);
  const latestActivity = activityFor(latest);

  return {
    id: item.id,
    kind: "agent",
    actor: item.actor,
    stage,
    stageLabel: stageLabelFor(stage, item.actor),
    stageIndex: stageIndexFor(stage),
    status: statusFrom(item.rollup, events),
    eventCount: events.length,
    llmCalls: Math.round(maxValue(item.rollup?.llm_calls, item.rollup?.llm_calls_made, llmEvents.length)),
    toolCalls: Math.round(maxValue(item.rollup?.tool_calls, item.rollup?.tool_calls_made, toolEvents.length)),
    totalTokens: Math.round(maxValue(item.rollup?.total_tokens, numberValue(item.rollup?.input_tokens) + numberValue(item.rollup?.output_tokens), inputTokens + outputTokens)),
    costUsd: maxValue(item.rollup?.cost_usd, ...events.map((event) => eventDetails(event).estimated_total_cost_usd)),
    durationSeconds: durationFrom(item, latest),
    contextWindow: Math.round(contextWindow),
    contextTokens: Math.round(contextTokens),
    contextUsagePct,
    latestActivity,
    safeLatestActivity: safeActivity(latestActivity),
    latestKind: String(latest?.kind || ""),
    latestTimestamp: String(latest?.timestamp || latest?.created_at || item.rollup?.finished_at || item.rollup?.started_at || ""),
    recentEvents: events.slice(-5).reverse(),
  };
}

function makeRootNode(rootActor: string, events: AgentRunGraphEvent[], summary: AgentRunGraphSummary): AgentRunGraphNode {
  const latest = sortEvents(events)[events.length - 1];
  return {
    id: "root",
    kind: "root",
    actor: rootActor || "run",
    stage: "root",
    stageLabel: "Run",
    stageIndex: -1,
    status: summary.activeAgentCount > 0 ? "running" : summary.completedAgentCount > 0 ? "success" : "unknown",
    eventCount: events.length,
    llmCalls: summary.llmCallCount,
    toolCalls: summary.toolCallCount,
    totalTokens: summary.totalTokens,
    costUsd: 0,
    durationSeconds: 0,
    contextWindow: summary.contextWindow,
    contextTokens: summary.contextTokens,
    contextUsagePct: summary.contextUsagePct,
    latestActivity: activityFor(latest),
    safeLatestActivity: safeActivity(activityFor(latest)),
    latestKind: String(latest?.kind || ""),
    latestTimestamp: String(latest?.timestamp || latest?.created_at || ""),
    recentEvents: sortEvents(events).slice(-5).reverse(),
  };
}

export function buildAgentRunGraph({
  events = [],
  agentRollups = [],
  rootActor = "orchestrator",
}: {
  events?: AgentRunGraphEvent[];
  agentRollups?: AgentRunGraphRollup[];
  rootActor?: string;
} = {}): AgentRunGraphResult {
  const safeEvents = Array.isArray(events) ? events.filter(Boolean) : [];
  const safeRollups = Array.isArray(agentRollups) ? agentRollups.filter(Boolean) : [];
  const items: AgentItem[] = [];

  for (const rollup of safeRollups) {
    const actor = rollupActor(rollup);
    if (rootActorMatches(actor, rootActor)) continue;
    const item = findOrCreateItem(items, actor, rollupAgentRunId(rollup), rollupInvocationIndex(rollup));
    item.rollup = rollup;
  }

  for (const event of safeEvents) {
    const actor = eventActor(event);
    if (rootActorMatches(actor, rootActor)) continue;
    const item = findOrCreateItem(items, actor, eventAgentRunId(event), eventInvocationIndex(event));
    item.events.push(event);
  }

  const agentNodes = items
    .map(makeAgentNode)
    .sort((left, right) => left.stageIndex - right.stageIndex || left.actor.localeCompare(right.actor) || left.id.localeCompare(right.id));
  const activeAgentCount = agentNodes.filter((node) => ["queued", "running"].includes(node.status)).length;
  const completedAgentCount = agentNodes.filter((node) => ["success", "partial", "failed", "skipped"].includes(node.status)).length;
  const summary: AgentRunGraphSummary = {
    agentCount: agentNodes.length,
    activeAgentCount,
    completedAgentCount,
    eventCount: safeEvents.length,
    toolCallCount: agentNodes.reduce((total, node) => total + node.toolCalls, 0),
    llmCallCount: agentNodes.reduce((total, node) => total + node.llmCalls, 0),
    totalTokens: agentNodes.reduce((total, node) => total + node.totalTokens, 0),
    contextWindow: Math.max(0, ...agentNodes.map((node) => node.contextWindow)),
    contextTokens: Math.max(0, ...agentNodes.map((node) => node.contextTokens)),
    contextUsagePct: Math.max(0, ...agentNodes.map((node) => node.contextUsagePct)),
    contextWindowCount: agentNodes.filter((node) => node.contextWindow > 0).length,
  };
  const rootNode = makeRootNode(rootActor, safeEvents, summary);
  const edges: AgentRunGraphEdge[] = [];

  for (const node of agentNodes) {
    edges.push({
      id: `root-${node.id}`,
      source: rootNode.id,
      target: node.id,
      kind: "root",
      animated: node.status === "running" || node.status === "queued",
    });
  }

  const stageGroups = new Map<number, AgentRunGraphNode[]>();
  for (const node of agentNodes) {
    const group = stageGroups.get(node.stageIndex) || [];
    group.push(node);
    stageGroups.set(node.stageIndex, group);
  }
  const stageIndexes = Array.from(stageGroups.keys()).sort((left, right) => left - right);
  for (let index = 0; index < stageIndexes.length; index += 1) {
    const current = stageGroups.get(stageIndexes[index]) || [];
    for (let itemIndex = 1; itemIndex < current.length; itemIndex += 1) {
      const previous = current[itemIndex - 1];
      const next = current[itemIndex];
      edges.push({
        id: `continuation-${previous.id}-${next.id}`,
        source: previous.id,
        target: next.id,
        kind: "continuation",
        animated: next.status === "running" || next.status === "queued",
      });
    }
    const previousStage = stageGroups.get(stageIndexes[index - 1]);
    if (previousStage?.length && current.length) {
      const previousNode = previousStage[previousStage.length - 1];
      const currentNode = current[0];
      edges.push({
        id: `handoff-${previousNode.id}-${currentNode.id}`,
        source: previousNode.id,
        target: currentNode.id,
        kind: "handoff",
        animated: currentNode.status === "running" || currentNode.status === "queued",
      });
    }
  }

  return { nodes: [rootNode, ...agentNodes], agentNodes, edges, summary };
}
