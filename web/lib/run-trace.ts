export const STAGE_ORDER = ["classification", "landing", "hosting", "embedded"] as const;

export type Stage = (typeof STAGE_ORDER)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  classification: "Classification",
  landing: "Landing",
  hosting: "Hosting",
  embedded: "Embedded",
};

const LLM_TERMINAL_KINDS = new Set<string>([
  "llm_response",
  "llm_error",
  "llm_timeout",
  "llm_rate_limited",
]);

const RUN_FAILURE_KINDS = new Set<string>([
  "pipeline_failed",
  "agent_failed",
  "llm_error",
  "llm_timeout",
  "llm_rate_limited",
]);

const RUN_TERMINAL_KINDS = new Set<string>([
  "pipeline_finished",
  "pipeline_failed",
  "agent_finished",
  "agent_failed",
  "run_cancelled",
  "cancel_requested",
]);

export interface TraceEvent {
  seq?: number;
  timestamp?: string;
  created_at?: string;
  actor?: string;
  kind?: string;
  status?: string;
  message?: string;
  details?: Record<string, unknown>;
  details_json?: Record<string, unknown>;
  agent_run_id?: number | string | null;
  [key: string]: unknown;
}

export interface NormalizedTraceEvent extends TraceEvent {
  timestamp: string;
  details: Record<string, unknown>;
}

export interface RunTerminalState {
  isTerminal: boolean;
  status: "running" | "cancelled" | "failed" | "completed";
  terminal: NormalizedTraceEvent | null;
}

function seqNumber(event: TraceEvent | NormalizedTraceEvent | null | undefined): number {
  return Number((event as TraceEvent)?.seq || 0);
}

function normalizeStageName(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (STAGE_ORDER as readonly string[]).find((stage) => normalized.includes(stage)) || normalized;
}

function latestEvent<T>(events: T[], predicate: (event: T) => boolean): T | null {
  return [...events].reverse().find((event) => predicate(event)) ?? null;
}

function eventErrorMessage(event: NormalizedTraceEvent | TraceEvent | null | undefined): string {
  const details = (event as TraceEvent)?.details ?? {};
  const d = details as Record<string, unknown>;
  return String(
    (d.error_preview as string | undefined) ??
      (d.error as string | undefined) ??
      (d.cancel_reason as string | undefined) ??
      (event as TraceEvent)?.message ??
      "",
  );
}

export function normalizeTraceEvent(event: unknown): NormalizedTraceEvent | null {
  if (!event || typeof event !== "object") return null;
  const e = event as TraceEvent;
  return {
    ...e,
    timestamp: String(e.timestamp ?? e.created_at ?? ""),
    details: (e.details ?? e.details_json ?? {}) as Record<string, unknown>,
  } as NormalizedTraceEvent;
}

export function normalizeTraceEvents(events: unknown[] | null | undefined = []): NormalizedTraceEvent[] {
  return (Array.isArray(events) ? events : [])
    .map((event) => normalizeTraceEvent(event))
    .filter((e): e is NormalizedTraceEvent => e !== null);
}

export function getRunTerminalState(events: unknown[] | null | undefined = []): RunTerminalState {
  const normalized = normalizeTraceEvents(events as unknown[]);
  const terminal = latestEvent(normalized, (event) => RUN_TERMINAL_KINDS.has(event?.kind ?? "")) ?? null;
  if (!terminal) {
    return {
      isTerminal: false,
      status: "running",
      terminal: null,
    };
  }

  if (terminal.kind === "run_cancelled" || terminal.kind === "cancel_requested") {
    return {
      isTerminal: true,
      status: "cancelled",
      terminal,
    };
  }

  if (terminal.kind === "pipeline_failed" || terminal.kind === "agent_failed") {
    return {
      isTerminal: true,
      status: "failed",
      terminal,
    };
  }

  return {
    isTerminal: true,
    status: "completed",
    terminal,
  };
}

function eventFallbackKey(event: unknown): string {
  const normalized = normalizeTraceEvent(event) ?? ({} as NormalizedTraceEvent);
  return [
    String(normalized?.timestamp ?? ""),
    String(normalized?.actor ?? ""),
    String(normalized?.kind ?? ""),
    String(normalized?.status ?? ""),
    String(normalized?.message ?? ""),
  ].join("|");
}

export function mergeTraceEvents(
  currentEvents: unknown[] | null | undefined,
  incomingEvents: unknown[] | null | undefined,
): NormalizedTraceEvent[] {
  if (!Array.isArray(incomingEvents) || incomingEvents.length === 0) {
    return Array.isArray(currentEvents)
      ? currentEvents.map((event) => normalizeTraceEvent(event)).filter((e): e is NormalizedTraceEvent => e !== null)
      : [];
  }

  const merged = Array.isArray(currentEvents)
    ? currentEvents.map((event) => normalizeTraceEvent(event)).filter((e): e is NormalizedTraceEvent => e !== null)
    : [];
  const seqToIndex = new Map<number, number>();
  const fallbackKeys = new Set<string>();

  merged.forEach((event, index) => {
    const seq = Number((event as TraceEvent)?.seq);
    if (Number.isFinite(seq) && seq > 0) {
      seqToIndex.set(seq, index);
      return;
    }
    fallbackKeys.add(eventFallbackKey(event));
  });

  for (const rawEvent of incomingEvents) {
    const event = normalizeTraceEvent(rawEvent);
    if (!event) continue;

    const seq = Number((event as TraceEvent).seq);
    if (Number.isFinite(seq) && seq > 0) {
      const existingIndex = seqToIndex.get(seq);
      if (existingIndex !== undefined) {
        merged[existingIndex] = { ...merged[existingIndex], ...event } as NormalizedTraceEvent;
      } else {
        seqToIndex.set(seq, merged.length);
        merged.push(event);
      }
      continue;
    }

    const fallback = eventFallbackKey(event);
    if (!fallbackKeys.has(fallback)) {
      fallbackKeys.add(fallback);
      merged.push(event);
    }
  }

  merged.sort((a, b) => {
    const aSeq = Number((a as TraceEvent)?.seq);
    const bSeq = Number((b as TraceEvent)?.seq);
    const aOk = Number.isFinite(aSeq) && aSeq > 0;
    const bOk = Number.isFinite(bSeq) && bSeq > 0;

    if (aOk && bOk) return aSeq - bSeq;
    if (aOk) return -1;
    if (bOk) return 1;
    return String((a as TraceEvent)?.timestamp ?? "").localeCompare(String((b as TraceEvent)?.timestamp ?? ""));
  });

  return merged;
}

export function actorToStage(actor: unknown): string {
  const normalized = String(actor ?? "").trim().toLowerCase();
  if (!normalized) return "";
  return (STAGE_ORDER as readonly string[]).find((stage) => normalized.includes(stage)) || "";
}

export interface LlmResponseCall {
  key: string;
  seq: number;
  actor: string;
  stage: string;
  kind: string;
  provider: string;
  model_name: string;
  input_tokens: number;
  output_tokens: number;
  context_window: number;
  cost_source: string;
  provider_cache_active: boolean;
  response_class: string;
  estimated_total_cost_usd: number;
  estimated_input_cost_usd: number;
  estimated_cached_input_cost_usd: number;
  estimated_cache_write_cost_usd: number;
  estimated_output_cost_usd: number;
  usage_metadata_json: Record<string, unknown>;
  response_metadata_json: Record<string, unknown>;
  additional_kwargs_json: Record<string, unknown>;
  content_preview: string;
  content_full: string;
  thinking_content: string;
  thinking_tokens: number;
  timestamp: string;
  event: NormalizedTraceEvent;
}

export function extractLlmResponses(events: unknown[] | null | undefined = []): LlmResponseCall[] {
  return (Array.isArray(events) ? events : [])
    .map((rawEvent) => normalizeTraceEvent(rawEvent))
    .filter((event): event is NormalizedTraceEvent => event?.kind === "llm_response")
    .map((event) => {
      const details = (event.details ?? {}) as Record<string, unknown>;
      const usageMetadata = (details.usage_metadata ?? details.usage_metadata_json ?? {}) as Record<string, unknown>;
      const responseMetadata = (details.response_metadata ?? details.response_metadata_json ?? {}) as Record<string, unknown>;
      const additionalKwargs = (details.additional_kwargs ?? {}) as Record<string, unknown>;
      const providerCacheActive =
        (details.provider_cache_active as boolean | undefined) ??
        (responseMetadata.provider_cache_active as boolean | undefined) ??
        (additionalKwargs.provider_cache_active as boolean | undefined) ??
        false;
      const costSource =
        (details.cost_source as string | undefined) ??
        (usageMetadata.cost_source as string | undefined) ??
        (responseMetadata.cost_source as string | undefined) ??
        (additionalKwargs.cost_source as string | undefined) ??
        "";
      const responseClass =
        (details.response_class as string | undefined) ??
        (responseMetadata.response_class as string | undefined) ??
        (additionalKwargs.response_class as string | undefined) ??
        "";
      return {
        key: `llm-${event.seq ?? event.timestamp ?? Math.random()}`,
        seq: seqNumber(event),
        actor: String(event.actor ?? ""),
        stage: actorToStage(event.actor),
        kind: String(event.kind ?? "llm_response"),
        provider: String(details.provider ?? ""),
        model_name: String(details.model_name ?? ""),
        input_tokens: Number(details.input_tokens ?? 0),
        output_tokens: Number(details.output_tokens ?? 0),
        context_window: Number(details.context_window ?? 0),
        cost_source: String(costSource ?? ""),
        provider_cache_active: Boolean(providerCacheActive),
        response_class: String(responseClass ?? ""),
        estimated_total_cost_usd: Number(details.estimated_total_cost_usd ?? 0),
        estimated_input_cost_usd: Number(details.estimated_input_cost_usd ?? 0),
        estimated_cached_input_cost_usd: Number(details.estimated_cached_input_cost_usd ?? 0),
        estimated_cache_write_cost_usd: Number(details.estimated_cache_write_cost_usd ?? 0),
        estimated_output_cost_usd: Number(details.estimated_output_cost_usd ?? 0),
        usage_metadata_json: {
          cached_input_tokens: Number(details.cached_input_tokens ?? 0),
          cache_creation_input_tokens: Number(details.cache_creation_input_tokens ?? 0),
          new_input_tokens: Number(details.new_input_tokens ?? 0),
          estimated_input_cost_usd: Number(details.estimated_input_cost_usd ?? 0),
          estimated_cached_input_cost_usd: Number(details.estimated_cached_input_cost_usd ?? 0),
          estimated_cache_write_cost_usd: Number(details.estimated_cache_write_cost_usd ?? 0),
          estimated_output_cost_usd: Number(details.estimated_output_cost_usd ?? 0),
          cache_hit: Boolean(details.cache_hit),
          provider_cache_active: Boolean(providerCacheActive),
          cost_source: String(costSource ?? ""),
        },
        response_metadata_json: responseMetadata,
        additional_kwargs_json: additionalKwargs,
        content_preview: String(details.content_preview ?? ""),
        content_full: String(details.content_full ?? ""),
        thinking_content: String(details.thinking_content ?? ""),
        thinking_tokens: Number(details.thinking_tokens ?? 0),
        timestamp: event.timestamp ?? "",
        event,
      };
    });
}

function resolveLiveContextStatus(events: NormalizedTraceEvent[]): string {
  const normalized = Array.isArray(events) ? events : [];
  const lastEvent = [...normalized].reverse().find(Boolean) ?? null;
  if (!lastEvent) return "tracked";

  if (
    RUN_FAILURE_KINDS.has(lastEvent.kind ?? "") ||
    normalized.some((event) => RUN_FAILURE_KINDS.has(event.kind ?? "")) ||
    ["error", "failed", "fail"].includes(String(lastEvent?.status ?? "").toLowerCase()) ||
    normalized.some((event) =>
      ["error", "failed", "fail"].includes(String(event?.status ?? "").toLowerCase()),
    )
  ) {
    return "failed";
  }

  if (["run_cancelled", "cancel_requested"].includes(lastEvent.kind ?? "")) {
    return "cancelled";
  }

  if (
    ["agent_finished", "pipeline_finished"].includes(lastEvent.kind ?? "") ||
    ["success", "done", "completed"].includes(String(lastEvent?.status ?? "").toLowerCase())
  ) {
    return "done";
  }

  if (normalized.some((event) => ["agent_started", "pipeline_started"].includes(event.kind ?? ""))) {
    return "running";
  }

  if (lastEvent.kind === "llm_response" || lastEvent.kind === "llm_turn_started") {
    return "running";
  }

  return String(lastEvent.status ?? "tracked");
}

export interface LiveAgentContextGroup {
  key: string;
  order: number;
  label: string;
  stage: string;
  agentType: string;
  actor: string;
  status: string;
  invocationIndex: number;
  llmCalls: Array<LlmResponseCall & { stage: string; actor: string; invocationIndex: number }>;
  startedAt: string;
  finishedAt: string;
}

function buildLiveAgentContexts(
  events: unknown[] | null | undefined = [],
  rootActor = "",
): LiveAgentContextGroup[] {
  const normalized = normalizeTraceEvents(events as unknown[]);
  const contexts: Array<{
    actor: string;
    agentType: string;
    events: NormalizedTraceEvent[];
    startedAt: string;
    finishedAt: string | null;
    invocationIndex: number;
  }> = [];
  const openRuns = new Map<string, (typeof contexts)[number]>();
  const invocationCounts = new Map<string, number>();

  for (const event of normalized) {
    const actor = String(event.actor ?? rootActor ?? "unknown") || "unknown";
    if (actor === "control-room") continue;

    const kind = String(event.kind ?? "");
    const isStart = kind === "agent_started" || kind === "pipeline_started";
    const isFinish =
      kind === "agent_finished" ||
      kind === "pipeline_finished" ||
      kind === "pipeline_failed" ||
      kind === "run_cancelled";
    let current = openRuns.get(actor);

    if (isStart) {
      const nextInvocation = Number(invocationCounts.get(actor) ?? 0) + 1;
      invocationCounts.set(actor, nextInvocation);
      current = {
        actor,
        agentType: normalizeStageName(actor) || actorToStage(actor) || actor,
        events: [event],
        startedAt: event.timestamp ?? "",
        finishedAt: null,
        invocationIndex: nextInvocation,
      };
      openRuns.set(actor, current);
      continue;
    }

    if (current == null) {
      const nextInvocation = Number(invocationCounts.get(actor) ?? 0) + 1;
      invocationCounts.set(actor, nextInvocation);
      current = {
        actor,
        agentType: normalizeStageName(actor) || actorToStage(actor) || actor,
        events: [],
        startedAt: event.timestamp ?? "",
        finishedAt: null,
        invocationIndex: nextInvocation,
      };
      openRuns.set(actor, current);
    }

    current.events.push(event);

    if (isFinish) {
      current.finishedAt = event.timestamp ?? current.startedAt ?? "";
      contexts.push(current);
      openRuns.delete(actor);
    }
  }

  for (const current of openRuns.values()) {
    current.finishedAt =
      current.events[current.events.length - 1]?.timestamp ?? current.startedAt ?? "";
    contexts.push(current);
  }

  contexts.sort((a, b) => {
    const byStart = String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? ""));
    if (byStart !== 0) return byStart;
    const byInvocation = Number(a.invocationIndex ?? 0) - Number(b.invocationIndex ?? 0);
    if (byInvocation !== 0) return byInvocation;
    return String(a.actor ?? "").localeCompare(String(b.actor ?? ""));
  });

  return contexts.map((ctx) => {
    const stage =
      actorToStage(ctx.actor) || normalizeStageName(ctx.agentType ?? ctx.actor) || "unknown";
    const invocationIndex = Number(ctx.invocationIndex ?? 0);
    const llmCalls = extractLlmResponses(ctx.events).map((call) => ({
      ...call,
      stage,
      actor: ctx.actor,
      invocationIndex,
    }));
    const stageIndex = (STAGE_ORDER as readonly string[]).indexOf(stage);
    const order = (stageIndex >= 0 ? stageIndex : STAGE_ORDER.length) * 1000 + invocationIndex;
    return {
      key: `agent-${ctx.actor ?? "unknown"}-${invocationIndex ?? 0}`,
      order,
      label: `${(STAGE_LABELS as Record<string, string>)[stage] ?? ctx.actor ?? "Agent"}${invocationIndex > 0 ? ` ${invocationIndex}` : ""}`,
      stage,
      agentType: stage,
      actor: ctx.actor,
      status: resolveLiveContextStatus(ctx.events),
      invocationIndex,
      llmCalls,
      startedAt: ctx.startedAt,
      finishedAt: ctx.finishedAt ?? "",
    };
  });
}

function isScreenshotValue(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return false;
  if (text.startsWith("data:image/")) return true;
  if (!/^https?:\/\//i.test(text)) return false;

  try {
    const parsed = new URL(text);
    const path = String(parsed.pathname ?? "").toLowerCase();
    const query = String(parsed.search ?? "").toLowerCase();
    if (/\.(png|jpe?g|webp|gif|bmp)$/.test(path)) return true;
    if (path.includes("/image/") || path.includes("/images/") || path.includes("image/upload")) {
      return true;
    }
    if (
      query.includes("format=png") ||
      query.includes("format=jpg") ||
      query.includes("format=jpeg") ||
      query.includes("format=webp") ||
      query.includes("fm=png") ||
      query.includes("fm=jpg") ||
      query.includes("fm=jpeg") ||
      query.includes("fm=webp")
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

const SCREENSHOT_SINGLE_KEYS = ["screenshot_url", "screenshot"] as const;
const SCREENSHOT_MULTI_KEYS = ["screenshot_urls", "screenshots", "all_screenshots"] as const;
const SCREENSHOT_WRAPPER_KEYS = [
  "result_full",
  "result_preview",
  "result",
  "output",
  "payload",
  "data",
  "details",
  "details_json",
  "response",
  "record",
  "content",
  "text",
  "message",
] as const;

function addScreenshotCandidate(value: unknown, out: Set<string>): boolean {
  if (!isScreenshotValue(value)) return false;
  out.add(String(value).trim());
  return true;
}

function parseJsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];

  try {
    candidates.push(JSON.parse(text) as unknown);
  } catch {
    // keep trying
  }

  try {
    const unescaped = text.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (unescaped !== text) candidates.push(JSON.parse(unescaped) as unknown);
  } catch {
    // keep trying
  }

  return candidates;
}

function extractEmbeddedScreenshotStrings(text: string, out: Set<string>): void {
  const pattern =
    /(?:\\?"(?:screenshot_url|screenshot)\\?"\s*:\s*\\?")(https?:\/\/[^"\\]+|data:image\/[^"\\]+)(?:\\?")/g;
  for (const match of text.matchAll(pattern)) {
    addScreenshotCandidate(match[1], out);
  }
}

function collectScreenshotFromObject(value: Record<string, unknown>, out: Set<string>): void {
  if (!value || typeof value !== "object") return;

  const itemType = String((value as Record<string, unknown>).type ?? "").toLowerCase();
  if (itemType === "image" && typeof value.data === "string" && (value.data as string).trim()) {
    const mime =
      String((value.mimeType as string | undefined) ?? (value.mime_type as string | undefined) ?? "image/png").trim() || "image/png";
    addScreenshotCandidate(`data:${mime};base64,${(value.data as string).trim()}`, out);
  }

  for (const key of SCREENSHOT_SINGLE_KEYS) {
    addScreenshotCandidate((value as Record<string, unknown>)[key], out);
  }

  for (const key of SCREENSHOT_MULTI_KEYS) {
    const urls = (value as Record<string, unknown>)[key];
    if (Array.isArray(urls)) {
      for (const url of urls) addScreenshotCandidate(url, out);
    }
  }

  for (const key of SCREENSHOT_WRAPPER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      collectScreenshotUrls((value as Record<string, unknown>)[key], out);
    }
  }
}

export function collectScreenshotUrls(value: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (value == null) return out;

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return out;
    if (addScreenshotCandidate(text, out)) return out;

    for (const candidate of parseJsonCandidates(text)) {
      collectScreenshotUrls(candidate, out);
    }
    extractEmbeddedScreenshotStrings(text, out);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectScreenshotUrls(item, out);
    return out;
  }

  if (typeof value === "object") {
    collectScreenshotFromObject(value as Record<string, unknown>, out);
  }

  return out;
}

function toolTarget(details: Record<string, unknown>): string {
  const args = (details?.tool_args ?? details?.args ?? {}) as Record<string, unknown>;
  return String(
    (args.url as string | undefined) ??
      (args.mainUrl as string | undefined) ??
      (args.target_url as string | undefined) ??
      (args.player_iframe_url as string | undefined) ??
      (args.iframe_url as string | undefined) ??
      (args.base_url as string | undefined) ??
      (args.href as string | undefined) ??
      (args.selector as string | undefined) ??
      (args.css_selector as string | undefined) ??
      (args.xpath as string | undefined) ??
      (args.text as string | undefined) ??
      (args.value as string | undefined) ??
      "",
  );
}

export interface ToolCallRow {
  key: string;
  actor: string;
  stage: string;
  agentRunId: number;
  agentType: string;
  invocationIndex: number;
  toolName: string;
  target: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  startSeq: number | null;
  finishSeq: number | null;
  args: Record<string, unknown>;
  result: unknown;
  screenshots: string[];
  startedEvent: NormalizedTraceEvent | null;
  finishedEvent: NormalizedTraceEvent | null;
}

export function extractToolCalls(events: unknown[] | null | undefined = []): ToolCallRow[] {
  const rows: ToolCallRow[] = [];
  const pendingById = new Map<string, ToolCallRow>();
  const pendingByActor = new Map<string, ToolCallRow[]>();

  const ensureActorStack = (actor: string): ToolCallRow[] => {
    const key = actor || "__unknown__";
    if (!pendingByActor.has(key)) pendingByActor.set(key, []);
    return pendingByActor.get(key) as ToolCallRow[];
  };

  for (const rawEvent of Array.isArray(events) ? events : []) {
    const event = normalizeTraceEvent(rawEvent);
    if (!event) continue;
    if (event.kind !== "tool_call_started" && event.kind !== "tool_call_finished") continue;

    const actor = String(event.actor ?? "");
    const stage = actorToStage(actor);
    const details = (event.details ?? {}) as Record<string, unknown>;
    const toolName = String(details.tool_name ?? "tool");
    const toolCallId = String(details.tool_call_id ?? "");
    const seq = Number(event.seq ?? 0);
    const stack = ensureActorStack(actor);

    if (event.kind === "tool_call_started") {
      const row: ToolCallRow = {
        key: toolCallId || `${actor || "unknown"}-${seq || rows.length + 1}`,
        actor,
        stage,
        agentRunId: Number(event.agent_run_id ?? details.agent_run_id ?? 0),
        agentType: String(details.agent_type ?? ""),
        invocationIndex: Number(details.invocation_index ?? 0),
        toolName,
        target: toolTarget(details),
        status: "running",
        startedAt: event.timestamp ?? "",
        finishedAt: "",
        durationSeconds: 0,
        startSeq: seq,
        finishSeq: null,
        args: (details.tool_args ?? details.args ?? {}) as Record<string, unknown>,
        result: null,
        screenshots: [],
        startedEvent: event,
        finishedEvent: null,
      };
      rows.push(row);
      stack.push(row);
      if (toolCallId) pendingById.set(toolCallId, row);
      continue;
    }

    let row: ToolCallRow | null = toolCallId ? (pendingById.get(toolCallId) ?? null) : null;
    if (!row) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]?.toolName === toolName) {
          row = stack[index] ?? null;
          stack.splice(index, 1);
          break;
        }
      }
    } else {
      pendingById.delete(toolCallId);
      const stackIndex = stack.findIndex((item) => item?.key === row?.key);
      if (stackIndex >= 0) stack.splice(stackIndex, 1);
    }

    if (!row) {
      row = {
        key: toolCallId || `${actor || "unknown"}-${seq || rows.length + 1}`,
        actor,
        stage,
        agentRunId: Number(event.agent_run_id ?? details.agent_run_id ?? 0),
        agentType: String(details.agent_type ?? ""),
        invocationIndex: Number(details.invocation_index ?? 0),
        toolName,
        target: toolTarget(details),
        status: "queued",
        startedAt: "",
        finishedAt: "",
        durationSeconds: 0,
        startSeq: null,
        finishSeq: null,
        args: {},
        result: null,
        screenshots: [],
        startedEvent: null,
        finishedEvent: null,
      };
      rows.push(row);
    }

    const result = (details.result_full ?? details.result_preview ?? null) as unknown;
    const screenshotSet = collectScreenshotUrls(details, new Set<string>());
    collectScreenshotUrls(result, screenshotSet);
    const screenshots = Array.from(screenshotSet);
    row.status = String(details.status ?? event.status ?? "success");
    row.agentRunId = Number(event.agent_run_id ?? details.agent_run_id ?? row.agentRunId ?? 0);
    row.agentType = String(details.agent_type ?? row.agentType ?? "");
    row.invocationIndex = Number(details.invocation_index ?? row.invocationIndex ?? 0);
    row.finishedAt = event.timestamp ?? "";
    row.durationSeconds = Number(details.duration_seconds ?? row.durationSeconds ?? 0);
    row.finishSeq = seq || row.finishSeq;
    row.result = result;
    row.screenshots = screenshots;
    row.finishedEvent = event;
  }

  return rows.sort((a, b) => {
    const aSeq = Number(a.startSeq ?? a.finishSeq ?? 0);
    const bSeq = Number(b.startSeq ?? b.finishSeq ?? 0);
    return aSeq - bSeq;
  });
}

function stageStatus(
  events: NormalizedTraceEvent[] | null | undefined,
  runTerminalState: RunTerminalState | null = null,
): string {
  const relevant = (events ?? []).filter((event) => event && typeof event === "object");
  if (!relevant.length) return "idle";

  if (runTerminalState?.status === "cancelled") return "cancelled";
  if (runTerminalState?.status === "failed") {
    const stageFailure = [...relevant].reverse().find((event) => event.kind === "agent_failed");
    if (stageFailure) return "failed";
  }

  const lastTerminal = [...relevant].reverse().find((event) =>
    ["agent_finished", "agent_failed", "run_cancelled", "cancel_requested"].includes(event.kind ?? ""),
  );
  const lastStart = [...relevant].reverse().find((event) => event.kind === "agent_started");

  if (lastTerminal?.kind === "agent_failed") return "failed";
  if (lastTerminal?.kind === "run_cancelled" || lastTerminal?.kind === "cancel_requested") return "cancelled";
  if (lastStart && (!lastTerminal || Number(lastStart.seq ?? 0) > Number(lastTerminal.seq ?? 0))) return "running";
  if (lastTerminal?.kind === "agent_finished") return "done";
  return "active";
}

export interface StageViewEntry {
  stage: Stage;
  label: string;
  actor: string;
  status: string;
  events: NormalizedTraceEvent[];
  toolCalls: ToolCallRow[];
  llmCalls: number;
  frames: Array<{
    url: string;
    seq: number;
    actor: string;
    stage: string;
    agentRunId: number;
    agentType: string;
    invocationIndex: number;
    toolName: string;
    target: string;
    timestamp: string;
  }>;
  latestFrame: {
    url: string;
    seq: number;
    actor: string;
    stage: string;
    agentRunId: number;
    agentType: string;
    invocationIndex: number;
    toolName: string;
    target: string;
    timestamp: string;
  } | null;
  latestEventSeq: number;
  pendingToolCount: number;
  pendingLlmCount: number;
  livePhase: string;
  liveLabel: string;
  latestFailure: NormalizedTraceEvent | null;
  latestLlm: LlmResponseCall | null;
  latestTool: ToolCallRow | null;
}

export interface StageView {
  stages: StageViewEntry[];
  toolCalls: ToolCallRow[];
  autoStage: string;
}

export function buildStageView(events: unknown[] | null | undefined = []): StageView {
  const runTerminalState = getRunTerminalState(events as unknown[]);
  const toolCalls = extractToolCalls(events as unknown[]);
  const llmCalls = extractLlmResponses(events as unknown[]);
  const stageMap: Record<string, StageViewEntry> = Object.fromEntries(
    STAGE_ORDER.map((stage) => [
      stage,
      {
        stage,
        label: STAGE_LABELS[stage],
        actor: stage,
        status: "idle",
        events: [] as NormalizedTraceEvent[],
        toolCalls: [] as ToolCallRow[],
        llmCalls: 0,
        frames: [] as StageViewEntry["frames"],
        latestFrame: null as StageViewEntry["latestFrame"],
        latestEventSeq: 0,
        pendingToolCount: 0,
        pendingLlmCount: 0,
        livePhase: "idle",
        liveLabel: "waiting",
        latestFailure: null as NormalizedTraceEvent | null,
        latestLlm: null as LlmResponseCall | null,
        latestTool: null as ToolCallRow | null,
      },
    ]),
  );

  for (const rawEvent of Array.isArray(events) ? events : []) {
    const event = normalizeTraceEvent(rawEvent);
    if (!event) continue;
    const stage = actorToStage(event?.actor);
    if (!stage || !stageMap[stage]) continue;
    stageMap[stage].events.push(event);
    stageMap[stage].latestEventSeq = Math.max(stageMap[stage].latestEventSeq, Number(event?.seq ?? 0));
    if (event?.kind === "llm_response") stageMap[stage].llmCalls += 1;
  }

  for (const call of toolCalls) {
    if (!call?.stage || !stageMap[call.stage]) continue;
    stageMap[call.stage].toolCalls.push(call);
    if (call.status === "running") stageMap[call.stage].pendingToolCount += 1;
    stageMap[call.stage].latestTool = call;
    for (const screenshot of call.screenshots ?? []) {
      const frame = {
        url: screenshot,
        seq: Number(call.finishSeq ?? call.startSeq ?? 0),
        actor: call.actor,
        stage: call.stage,
        agentRunId: Number(call.agentRunId ?? 0),
        agentType: String(call.agentType ?? ""),
        invocationIndex: Number(call.invocationIndex ?? 0),
        toolName: call.toolName,
        target: call.target,
        timestamp: call.finishedAt ?? call.startedAt ?? "",
      };
      stageMap[call.stage].frames.push(frame);
      stageMap[call.stage].latestFrame = frame;
    }
  }

  for (const call of llmCalls) {
    if (!call?.stage || !stageMap[call.stage]) continue;
    stageMap[call.stage].latestLlm = call;
  }

  const stages = STAGE_ORDER.map((stage) => {
    const entry = stageMap[stage];
    const stageEvents = entry.events;
    const lastFailure =
      latestEvent(stageEvents, (event) =>
        RUN_FAILURE_KINDS.has(event?.kind ?? "") ||
        ((event?.kind === "tool_call_finished" || event?.kind === "tool_call_started") &&
          ["error", "failed", "fail"].includes(String(event?.status ?? event?.details?.status ?? "").toLowerCase())),
      ) ?? null;
    const lastLlmStart = latestEvent(
      stageEvents,
      (event) => event?.kind === "llm_turn_started",
    );
    const lastLlmTerminal = latestEvent(stageEvents, (event) =>
      LLM_TERMINAL_KINDS.has(event?.kind ?? ""),
    );
    const pendingLlmCount =
      lastLlmStart && (!lastLlmTerminal || seqNumber(lastLlmStart) > seqNumber(lastLlmTerminal)) ? 1 : 0;
    const status = stageStatus(stageEvents, runTerminalState);
    let livePhase = "idle";
    let liveLabel = "waiting";
    if (lastFailure) {
      livePhase = "failed";
      liveLabel = "failed";
    } else if (runTerminalState.status === "cancelled" && stageEvents.length) {
      livePhase = "cancelled";
      liveLabel = "cancelled";
    } else if (pendingLlmCount > 0) {
      livePhase = "llm";
      liveLabel = "model running";
    } else if (entry.pendingToolCount > 0) {
      livePhase = "tool";
      liveLabel = entry.pendingToolCount > 1 ? "tools running" : "tool running";
    } else if (status === "done") {
      livePhase = "done";
      liveLabel = "done";
    } else if (status === "cancelled") {
      livePhase = "cancelled";
      liveLabel = "cancelled";
    } else if (status === "running" || status === "active") {
      livePhase = "running";
      liveLabel = "working";
    }
    return {
      ...entry,
      status,
      pendingLlmCount,
      livePhase,
      liveLabel,
      latestFailure: lastFailure,
      frames: entry.frames.sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0)),
    };
  });

  const lastActiveEvent = [...(Array.isArray(events) ? events : [])]
    .reverse()
    .find((event) => actorToStage((event as TraceEvent)?.actor));
  const autoStage =
    actorToStage((lastActiveEvent as TraceEvent)?.actor) ||
    stages.find((stage) => stage.status === "running")?.stage ||
    "classification";

  return { stages, toolCalls, autoStage };
}

export interface ContextWindowGroup {
  key: string;
  order: number;
  label: string;
  stage: string;
  agentType: string;
  actor: string;
  status: string;
  invocationIndex: number;
  llmCalls?: unknown[];
  agentRunId?: number;
}

export function buildContextWindowGroups({
  events = [],
  llmCalls = [],
  agentRuns = [],
  active = false,
}: {
  events?: unknown[];
  llmCalls?: Array<Record<string, unknown>>;
  agentRuns?: Array<Record<string, unknown>>;
  active?: boolean;
} = {}): ContextWindowGroup[] | LiveAgentContextGroup[] {
  if (active) {
    return buildLiveAgentContexts(events);
  }

  const agentMap = new Map<
    number,
    { actor: string; stage: string; invocationIndex: number; status: string; agentType: string }
  >(
    (agentRuns ?? []).map((row) => [
      Number((row as Record<string, unknown>)?.id ?? 0),
      {
        actor: String((row as Record<string, unknown>)?.actor ?? ""),
        stage: normalizeStageName((row as Record<string, unknown>)?.agent_type ?? (row as Record<string, unknown>)?.actor ?? ""),
        invocationIndex: Number((row as Record<string, unknown>)?.invocation_index ?? 0),
        status: String((row as Record<string, unknown>)?.status ?? ""),
        agentType: String((row as Record<string, unknown>)?.agent_type ?? (row as Record<string, unknown>)?.actor ?? ""),
      },
    ]),
  );

  const groups = new Map<string, ContextWindowGroup & { llmCalls: unknown[] }>();
  for (const row of llmCalls ?? []) {
    const agentRunId = Number((row as Record<string, unknown>)?.agent_run_id ?? 0);
    const agent = agentMap.get(agentRunId);
    const stage = agent?.stage ?? actorToStage((row as Record<string, unknown>)?.actor) ?? "unknown";
    const key = agentRunId > 0 ? `agent-${agentRunId}` : `${stage}-${(row as Record<string, unknown>)?.model_name ?? "model"}`;
    if (!groups.has(key)) {
      const labelBase = (STAGE_LABELS as Record<string, string>)[stage] ?? stage ?? "Agent";
      const label =
        (agent?.invocationIndex ?? 0) > 0 ? `${labelBase} ${agent?.invocationIndex}` : labelBase;
      const stageIndex = (STAGE_ORDER as readonly string[]).indexOf(stage);
      groups.set(key, {
        key,
        order: (stageIndex >= 0 ? stageIndex : STAGE_ORDER.length) * 1000 + Number(agent?.invocationIndex ?? 0),
        label,
        stage,
        agentType: agent?.agentType ?? stage,
        actor: agent?.actor ?? String((row as Record<string, unknown>)?.actor ?? ""),
        status: agent?.status ?? "",
        invocationIndex: Number(agent?.invocationIndex ?? 0),
        agentRunId: agentRunId > 0 ? agentRunId : 0,
        llmCalls: [],
      });
    }
    (groups.get(key) as { llmCalls: unknown[] }).llmCalls.push(row);
  }

  return [...groups.values()].sort((a, b) => {
    const stageDelta = Number(a.order ?? 999) - Number(b.order ?? 999);
    if (stageDelta !== 0) return stageDelta;
    const invocationDelta = Number(a.invocationIndex ?? 0) - Number(b.invocationIndex ?? 0);
    if (invocationDelta !== 0) return invocationDelta;
    return a.label.localeCompare(b.label);
  });
}

export function buildPersistedLlmEvents({
  llmCalls = [],
  agentRuns = [],
}: {
  llmCalls?: Array<Record<string, unknown>>;
  agentRuns?: Array<Record<string, unknown>>;
} = {}): NormalizedTraceEvent[] {
  const agentMap = new Map<number, { actor: string; agentType: string; invocationIndex: number }>(
    (agentRuns ?? []).map((row) => [
      Number((row as Record<string, unknown>)?.id ?? 0),
      {
        actor: String((row as Record<string, unknown>)?.actor ?? ""),
        agentType: String((row as Record<string, unknown>)?.agent_type ?? ""),
        invocationIndex: Number((row as Record<string, unknown>)?.invocation_index ?? 0),
      },
    ]),
  );

  return (llmCalls ?? []).map((row, index) => {
    const agentRunId = Number((row as Record<string, unknown>)?.agent_run_id ?? 0);
    const agent = agentMap.get(agentRunId) ?? {};
    const usageMetadata = (row as Record<string, unknown>)?.usage_metadata_json ?? {};
    const responseMetadata = (row as Record<string, unknown>)?.response_metadata_json ?? {};
    const additionalKwargs =
      (row as Record<string, unknown>)?.additional_kwargs_json ??
      (responseMetadata as Record<string, unknown>)?.additional_kwargs ??
      {};
    const cost = Number(
      (row as Record<string, unknown>)?.total_cost_usd ??
        (row as Record<string, unknown>)?.estimated_total_cost_usd ??
        0,
    );
    const costSource = String(
      (row as Record<string, unknown>)?.cost_source ??
        (usageMetadata as Record<string, unknown>)?.cost_source ??
        "",
    );
    const actor = String(
      (row as Record<string, unknown>)?.actor ??
        (agent as Record<string, unknown>).actor ??
        (row as Record<string, unknown>)?.agent_type ??
        (agent as Record<string, unknown>).agentType ??
        "llm",
    );
    const details: Record<string, unknown> = {
      provider: String((row as Record<string, unknown>)?.provider ?? ""),
      model_name: String((row as Record<string, unknown>)?.model_name ?? ""),
      input_tokens: Number((row as Record<string, unknown>)?.input_tokens ?? 0),
      output_tokens: Number((row as Record<string, unknown>)?.output_tokens ?? 0),
      context_window: Number((row as Record<string, unknown>)?.context_window ?? 0),
      estimated_total_cost_usd: cost,
      estimated_input_cost_usd: Number((row as Record<string, unknown>)?.estimated_input_cost_usd ?? 0),
      estimated_cached_input_cost_usd: Number((row as Record<string, unknown>)?.estimated_cached_input_cost_usd ?? 0),
      estimated_cache_write_cost_usd: Number((row as Record<string, unknown>)?.estimated_cache_write_cost_usd ?? 0),
      estimated_output_cost_usd: Number((row as Record<string, unknown>)?.estimated_output_cost_usd ?? 0),
      cached_input_tokens: Number(
        (row as Record<string, unknown>)?.cached_input_tokens ??
          (usageMetadata as Record<string, unknown>)?.cached_input_tokens ??
          0,
      ),
      cache_creation_input_tokens: Number(
        (row as Record<string, unknown>)?.cache_creation_input_tokens ??
          (usageMetadata as Record<string, unknown>)?.cache_creation_input_tokens ??
          0,
      ),
      new_input_tokens: Number(
        (row as Record<string, unknown>)?.new_input_tokens ??
          (usageMetadata as Record<string, unknown>)?.new_input_tokens ??
          0,
      ),
      cost_source: costSource,
      tool_calls: Number((row as Record<string, unknown>)?.tool_calls_requested ?? 0),
      tool_call_names: (row as Record<string, unknown>)?.tools_requested ?? [],
      content_preview: String((row as Record<string, unknown>)?.content_preview ?? ""),
      content_full: String(
        (row as Record<string, unknown>)?.content_full ??
          (responseMetadata as Record<string, unknown>)?.content_full ??
          (row as Record<string, unknown>)?.content_preview ??
          "",
      ),
      thinking_content: String(
        (row as Record<string, unknown>)?.thinking_content ??
          (responseMetadata as Record<string, unknown>)?.thinking_content ??
          "",
      ),
      thinking_tokens: Number(
        (row as Record<string, unknown>)?.thinking_tokens ??
          (responseMetadata as Record<string, unknown>)?.thinking_tokens ??
          0,
      ),
      usage_metadata_json: usageMetadata,
      response_metadata_json: responseMetadata,
      additional_kwargs_json: additionalKwargs,
      prompt: {
        prompt_version: String((row as Record<string, unknown>)?.prompt_version ?? ""),
        prompt_hash: String((row as Record<string, unknown>)?.prompt_hash ?? ""),
        cache_mode: String((row as Record<string, unknown>)?.cache_mode ?? ""),
      },
    };
    return {
      seq: Number((row as Record<string, unknown>)?.seq ?? index + 1),
      timestamp: String((row as Record<string, unknown>)?.created_at ?? (row as Record<string, unknown>)?.timestamp ?? ""),
      created_at: String((row as Record<string, unknown>)?.created_at ?? (row as Record<string, unknown>)?.timestamp ?? ""),
      actor,
      kind: "llm_response",
      message: details.content_preview ? "Persisted LLM response" : "Persisted LLM telemetry",
      status: "success",
      agent_run_id: agentRunId || (row as Record<string, unknown>)?.agent_run_id || null,
      details,
      details_json: details,
    } as unknown as NormalizedTraceEvent;
  });
}

export interface RunStateSummary {
  status: string;
  active: {
    type: string;
    stage: string;
    actor: string;
    title: string;
    message: string;
    event: NormalizedTraceEvent | TraceEvent | null;
  } | null;
  lastCompleted: {
    type: string;
    stage: string;
    actor: string;
    title: string;
    message: string;
  } | null;
  failure: {
    stage: string;
    actor: string;
    message: string;
    kind: string;
    event: NormalizedTraceEvent | TraceEvent | null;
  } | null;
  terminal: NormalizedTraceEvent | TraceEvent | null;
  llmCalls: LlmResponseCall[];
}

export function summarizeRunState(events: unknown[] | null | undefined = []): RunStateSummary {
  const normalized = (Array.isArray(events) ? events : [])
    .map((event) => normalizeTraceEvent(event))
    .filter((e): e is NormalizedTraceEvent => e !== null);
  if (!normalized.length) {
    return {
      status: "idle",
      active: null,
      lastCompleted: null,
      failure: null,
      terminal: null,
      llmCalls: [],
    };
  }

  const runTerminalState = getRunTerminalState(normalized);
  const toolCalls = extractToolCalls(normalized);
  const pendingTool = [...toolCalls].reverse().find((call) => call.status === "running") ?? null;
  const llmResponses = extractLlmResponses(normalized);
  const lastLlmStart = latestEvent(
    normalized,
    (event) => event.kind === "llm_turn_started",
  );
  const lastLlmTerminal = latestEvent(normalized, (event) =>
    LLM_TERMINAL_KINDS.has(event.kind ?? ""),
  );
  const llmRunning =
    lastLlmStart &&
    (!lastLlmTerminal || seqNumber(lastLlmStart) > seqNumber(lastLlmTerminal));
  const failureEvent =
    latestEvent(normalized, (event) => RUN_FAILURE_KINDS.has(event.kind ?? "")) ??
    latestEvent(
      normalized,
      (event) =>
        event.kind === "tool_call_finished" &&
        ["error", "failed", "fail"].includes(
          String(event?.details?.status ?? event?.status ?? "").toLowerCase(),
        ),
    ) ??
    null;
  const terminal =
    latestEvent(normalized, (event) =>
      ["pipeline_finished", "agent_finished", "pipeline_failed", "agent_failed", "run_cancelled", "cancel_requested"].includes(
        event.kind ?? "",
      ),
    ) ?? null;
  const lastCompleted =
    latestEvent(normalized, (event) =>
      ["llm_response", "tool_call_finished", "agent_finished", "pipeline_finished"].includes(event.kind ?? ""),
    ) ?? null;

  let active: RunStateSummary["active"] = null;
  let status: string = failureEvent ? "failed" : runTerminalState.status;
  if (!failureEvent && !runTerminalState.isTerminal) {
    status = "running";
  }

  if (failureEvent) {
    active = {
      type: "failed",
      stage: actorToStage(failureEvent.actor),
      actor: String(failureEvent.actor ?? ""),
      title: "Run failed",
      message: eventErrorMessage(failureEvent),
      event: failureEvent,
    };
  } else if (runTerminalState.status === "cancelled") {
    active = {
      type: "cancelled",
      stage: actorToStage(runTerminalState.terminal?.actor),
      actor: String(runTerminalState.terminal?.actor ?? ""),
      title: "Run cancelled",
      message:
        eventErrorMessage(runTerminalState.terminal) ||
        runTerminalState.terminal?.message ||
        "Execution was cancelled.",
      event: runTerminalState.terminal,
    };
  } else if (runTerminalState.status === "completed") {
    active = {
      type: "done",
      stage: actorToStage(runTerminalState.terminal?.actor),
      actor: String(runTerminalState.terminal?.actor ?? ""),
      title: "Run finished",
      message: runTerminalState.terminal?.message ?? "Execution completed.",
      event: runTerminalState.terminal,
    };
  } else if (llmRunning) {
    const details = (lastLlmStart?.details ?? {}) as Record<string, unknown>;
    active = {
      type: "llm",
      stage: actorToStage(lastLlmStart.actor),
      actor: String(lastLlmStart.actor ?? ""),
      title: "Model running",
      message: [
        details.provider ? String(details.provider) : "",
        details.model_name ? String(details.model_name) : "",
      ]
        .filter(Boolean)
        .join(" / "),
      event: lastLlmStart,
    };
  } else if (pendingTool) {
    active = {
      type: "tool",
      stage: pendingTool.stage,
      actor: String(pendingTool.actor ?? ""),
      title: "Tool running",
      message: [pendingTool.toolName, pendingTool.target].filter(Boolean).join(" / "),
      event: pendingTool.startedEvent,
    };
  }

  let completedSummary: RunStateSummary["lastCompleted"] = null;
  if (lastCompleted) {
    if (lastCompleted.kind === "llm_response") {
      const details = (lastCompleted.details ?? {}) as Record<string, unknown>;
      completedSummary = {
        type: "llm_response",
        stage: actorToStage(lastCompleted.actor),
        actor: String(lastCompleted.actor ?? ""),
        title: "Model responded",
        message:
          Number(details.output_tokens ?? 0) > 0
            ? `${(details.model_name as string) || "model"} / ${Number(details.output_tokens ?? 0).toLocaleString()} out`
            : `${(details.model_name as string) || "model"} responded`,
      };
    } else if (lastCompleted.kind === "tool_call_finished") {
      completedSummary = {
        type: "tool_finished",
        stage: actorToStage(lastCompleted.actor),
        actor: String(lastCompleted.actor ?? ""),
        title: "Tool finished",
        message: [ (lastCompleted.details as Record<string, unknown>)?.tool_name, (lastCompleted.details as Record<string, unknown>)?.status]
          .filter(Boolean)
          .join(" / "),
      };
    } else {
      completedSummary = {
        type: "stage_finished",
        stage: actorToStage(lastCompleted.actor),
        actor: String(lastCompleted.actor ?? ""),
        title: "Stage finished",
        message: lastCompleted.message ?? "",
      };
    }
  }

  return {
    status,
    active,
    lastCompleted: completedSummary,
    failure: failureEvent
      ? {
          stage: actorToStage(failureEvent.actor),
          actor: String(failureEvent.actor ?? ""),
          message: eventErrorMessage(failureEvent),
          kind: failureEvent.kind ?? "",
          event: failureEvent,
        }
      : null,
    terminal,
    llmCalls: llmResponses,
  };
}
