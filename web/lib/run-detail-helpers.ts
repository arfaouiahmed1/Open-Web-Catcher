import { estimateRunCost, synthCallsFromModelUsage, type LlmCallCostInput, type PricingMap } from "./pricing";
import { extractToolCalls, type ToolCallRow } from "./run-trace";

export type InspectorEvent = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveNumber(value: unknown): number {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : 0;
}

function eventDetails(event: InspectorEvent): Record<string, unknown> {
  const raw = event as { details?: unknown; details_json?: unknown };
  return asRecord(raw.details ?? raw.details_json);
}

function eventSeq(event: InspectorEvent): number {
  return Number((event as { seq?: unknown }).seq || 0);
}

// ---------------------------------------------------------------------------
// Tool-call counting
// ---------------------------------------------------------------------------

export interface ToolCountInput {
  run?: Record<string, unknown> | null;
  toolCalls?: unknown[] | null;
  runEvents?: InspectorEvent[] | null;
}

/**
 * Accurate tool-call count that never reports 0 while tool telemetry exists.
 * Takes the max of the persisted counter, the persisted tool_calls rows, the
 * paired start/finish rows derived from normalized run events, and the raw
 * `tool_call_started` observations (covers streams that only emit starts).
 */
export function resolveRunToolCallCount({
  run,
  toolCalls,
  runEvents,
}: ToolCountInput = {}): number {
  const logged = positiveNumber(asRecord(run).total_tool_calls);
  const rows = Array.isArray(toolCalls) ? toolCalls.length : 0;
  const events = Array.isArray(runEvents) ? (runEvents as InspectorEvent[]) : [];
  let paired = 0;
  try {
    paired = extractToolCalls(events).length;
  } catch {
    paired = 0;
  }
  let started = 0;
  for (const event of events) {
    if (String((event as { kind?: unknown }).kind || "") === "tool_call_started") started += 1;
  }
  return Math.max(0, logged, rows, paired, started);
}

// ---------------------------------------------------------------------------
// Estimated-cost fallback chain
// ---------------------------------------------------------------------------

export type RunCostSource = "logged" | "priced" | "unpriced" | "none";

export interface ResolvedRunCost {
  total: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  calls: number;
  unpriced: number;
  source: RunCostSource;
}

export interface ResolveRunCostInput {
  run?: Record<string, unknown> | null;
  modelUsage?: unknown[] | null;
  llmCalls?: Array<LlmCallCostInput | Record<string, unknown>> | null;
  pricingMap?: PricingMap | null;
  liveMetrics?: Record<string, unknown> | null;
}

const EMPTY_COST: ResolvedRunCost = {
  total: 0,
  input: 0,
  cached: 0,
  cacheWrite: 0,
  output: 0,
  calls: 0,
  unpriced: 0,
  source: "none",
};

/**
 * Cost fallback chain: persisted/logged run cost first, then priced LLM event
 * calls (or model_usage synthesis) via the pricing map. Explicit unpriced and
 * no-billable states replace the old `-- (Trace missing)` rendering.
 */
export function resolveRunCost({
  run,
  modelUsage,
  llmCalls,
  pricingMap,
  liveMetrics,
}: ResolveRunCostInput = {}): ResolvedRunCost {
  const record = asRecord(run);
  const metrics = asRecord(liveMetrics);
  const logged =
    positiveNumber(record.estimated_total_cost_usd) ||
    positiveNumber((record as Record<string, unknown>).total_cost_usd) ||
    positiveNumber(metrics.estimated_total_cost_usd) ||
    positiveNumber(metrics.total_cost_usd);
  const llmList = Array.isArray(llmCalls) ? llmCalls : [];
  const usageList = Array.isArray(modelUsage) ? modelUsage : [];

  if (logged > 0) {
    return {
      total: logged,
      input: Number(record.estimated_input_cost_usd ?? metrics.estimated_input_cost_usd ?? 0) || 0,
      cached: Number(record.estimated_cached_input_cost_usd ?? 0) || 0,
      cacheWrite: Number(record.estimated_cache_write_cost_usd ?? 0) || 0,
      output: Number(record.estimated_output_cost_usd ?? metrics.estimated_output_cost_usd ?? 0) || 0,
      calls: Number(record.total_llm_calls ?? llmList.length ?? 0) || 0,
      unpriced: 0,
      source: "logged",
    };
  }

  const callsForPricing =
    llmList.length > 0 ? llmList : synthCallsFromModelUsage(usageList);
  const totals = estimateRunCost(
    callsForPricing as Parameters<typeof estimateRunCost>[0],
    pricingMap ?? null,
  );
  if (totals.total > 0) return { ...totals, source: "priced" };
  if (totals.calls > 0 || usageList.length > 0 || llmList.length > 0) {
    return {
      ...EMPTY_COST,
      calls: totals.calls || llmList.length,
      unpriced: totals.unpriced,
      source: "unpriced",
    };
  }
  return { ...EMPTY_COST };
}

/** Human-readable qualifier for the cost ribbon (never "Trace missing"). */
export function runCostDetail(resolved: ResolvedRunCost, llmAttempts = 0): string {
  switch (resolved.source) {
    case "logged":
      return resolved.calls > 0
        ? `Logged spend · ${resolved.calls} call${resolved.calls === 1 ? "" : "s"}`
        : "Logged spend";
    case "priced":
      return `${resolved.calls} priced call${resolved.calls === 1 ? "" : "s"}`;
    case "unpriced":
      return llmAttempts > 0
        ? "Model calls observed but no pricing matched"
        : "Telemetry present but unpriced";
    case "none":
    default:
      return "No billable spend";
  }
}

/** Short source badge for the cost ribbon. */
export function runCostSourceLabel(source: RunCostSource): string {
  if (source === "logged") return "Logged";
  if (source === "priced") return "Priced";
  if (source === "unpriced") return "Unpriced";
  return "Free";
}

// ---------------------------------------------------------------------------
// Agent inspector sections
// ---------------------------------------------------------------------------

export function nodeEventsForActor(
  events: InspectorEvent[] | null | undefined,
  actor: unknown,
  isRoot = false,
): InspectorEvent[] {
  const list = Array.isArray(events) ? events : [];
  if (isRoot) return [...list].sort((a, b) => eventSeq(a) - eventSeq(b));
  const name = String(actor || "").trim();
  if (!name) return [];
  return list
    .filter((event) => String((event as { actor?: unknown }).actor || "") === name)
    .sort((a, b) => eventSeq(a) - eventSeq(b));
}

const REASONING_KINDS = new Set([
  "llm_response",
  "llm_turn_started",
  "llm_error",
  "llm_timeout",
  "llm_rate_limited",
  "orchestrator_decision",
  "agent_thought",
  "reasoning",
  "chain",
  "agent",
]);

const ARTIFACT_KINDS = new Set([
  "stream_extracted",
  "hosting_page_discovered",
  "server_activated",
  "screenshot",
  "screenshot_captured",
  "extraction_finished",
  "hosting_item_finished",
  "player_opened",
  "stream_validated",
  "playback_confirmed",
]);

const ARTIFACT_DETAIL_KEYS = [
  "stream_url",
  "stream_urls",
  "m3u8_url",
  "m3u8_urls",
  "mp4_url",
  "mp4_urls",
  "mpd_urls",
  "screenshot_url",
  "screenshot_urls",
  "player_iframe_url",
  "embedded_url",
  "servers",
  "streams",
  "extraction_results",
] as const;

const DIAGNOSTIC_PATTERN =
  /fail|error|timeout|block|popup|sandbox|iframe|network|rate_limit|inaccessible|dead|denied|forbidden/i;

export interface AgentInspectorSections {
  tools: ToolCallRow[];
  reasoning: InspectorEvent[];
  artifacts: InspectorEvent[];
  diagnostics: InspectorEvent[];
  timeline: InspectorEvent[];
}

function hasAnyKey(details: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => {
    const value = details[key];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value.trim().length > 0;
    return value !== undefined && value !== null;
  });
}

/**
 * Splits one agent's events into inspector segments: paired tool executions
 * (with args/results), reasoning traces, output artifacts, network/iframe/
 * popup diagnostics, and the full chronological timeline.
 */
export function buildAgentInspectorSections(
  nodeEvents: InspectorEvent[] | null | undefined,
): AgentInspectorSections {
  const list = Array.isArray(nodeEvents) ? nodeEvents : [];
  let tools: ToolCallRow[] = [];
  try {
    tools = extractToolCalls(list);
  } catch {
    tools = [];
  }
  const reasoning: InspectorEvent[] = [];
  const artifacts: InspectorEvent[] = [];
  const diagnostics: InspectorEvent[] = [];
  for (const event of list) {
    const kind = String((event as { kind?: unknown }).kind || "");
    const status = String((event as { status?: unknown }).status || "").toLowerCase();
    const details = eventDetails(event);
    const message = String((event as { message?: unknown }).message || "");
    if (
      REASONING_KINDS.has(kind) ||
      kind.includes("thought") ||
      kind.includes("reason") ||
      kind.includes("decision") ||
      kind.includes("plan_step")
    ) {
      reasoning.push(event);
    }
    if (
      ARTIFACT_KINDS.has(kind) ||
      kind.includes("stream") ||
      kind.includes("screenshot") ||
      kind.includes("extract") ||
      hasAnyKey(details, ARTIFACT_DETAIL_KEYS)
    ) {
      artifacts.push(event);
    }
    if (
      status === "error" ||
      status === "failed" ||
      DIAGNOSTIC_PATTERN.test(kind) ||
      DIAGNOSTIC_PATTERN.test(message.slice(0, 160)) ||
      hasAnyKey(details, ["network_diagnostics", "iframe_diagnostics", "popup", "popups", "blocked_url"] as const)
    ) {
      diagnostics.push(event);
    }
  }
  return {
    tools,
    reasoning,
    artifacts,
    diagnostics,
    timeline: [...list].sort((a, b) => eventSeq(a) - eventSeq(b)),
  };
}

/** Truncated JSON payload for expandable inspector rows. */
export function truncateEventJson(value: unknown, maxChars = 1600): string {
  let text = "";
  try {
    text = JSON.stringify(value ?? null, null, 2);
  } catch {
    text = String(value ?? "");
  }
  if (text.length > maxChars) return `${text.slice(0, maxChars)}…`;
  return text;
}

// ---------------------------------------------------------------------------
// Direct playable stream URLs (native HTML5 video, no hls.js)
// ---------------------------------------------------------------------------

const DIRECT_VIDEO_EXTENSIONS = new Set(["mp4", "webm", "ogg", "ogv", "mov", "m4v"]);

/** True for http(s) URLs with a directly playable container extension. */
export function isDirectVideoUrl(value: unknown): boolean {
  const raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  const path = raw.split(/[?#]/, 1)[0].toLowerCase();
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return DIRECT_VIDEO_EXTENSIONS.has(path.slice(dot + 1));
}
