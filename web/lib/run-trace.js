export const STAGE_ORDER = ["classification", "landing", "hosting", "embedded"];

export const STAGE_LABELS = {
  classification: "Classification",
  landing: "Landing",
  hosting: "Hosting",
  embedded: "Embedded",
};

const LLM_TERMINAL_KINDS = new Set([
  "llm_response",
  "llm_error",
  "llm_timeout",
  "llm_rate_limited",
]);

const RUN_FAILURE_KINDS = new Set([
  "pipeline_failed",
  "agent_failed",
  "llm_error",
  "llm_timeout",
  "llm_rate_limited",
]);

function seqNumber(event) {
  return Number(event?.seq || 0);
}

function normalizeStageName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return STAGE_ORDER.find((stage) => normalized.includes(stage)) || normalized;
}

function latestEvent(events, predicate) {
  return [...events].reverse().find((event) => predicate(event));
}

function eventErrorMessage(event) {
  const details = event?.details || {};
  return (
    details.error_preview ||
    details.error ||
    details.cancel_reason ||
    event?.message ||
    ""
  );
}

export function normalizeTraceEvent(event) {
  if (!event || typeof event !== "object") return null;
  return {
    ...event,
    timestamp: event.timestamp || event.created_at || "",
    details: event.details ?? event.details_json ?? {},
  };
}

export function normalizeTraceEvents(events = []) {
  return (Array.isArray(events) ? events : [])
    .map((event) => normalizeTraceEvent(event))
    .filter(Boolean);
}

function eventFallbackKey(event) {
  const normalized = normalizeTraceEvent(event) || {};
  return [
    String(normalized?.timestamp || ""),
    String(normalized?.actor || ""),
    String(normalized?.kind || ""),
    String(normalized?.status || ""),
    String(normalized?.message || ""),
  ].join("|");
}

export function mergeTraceEvents(currentEvents, incomingEvents) {
  if (!Array.isArray(incomingEvents) || incomingEvents.length === 0) {
    return Array.isArray(currentEvents)
      ? currentEvents.map((event) => normalizeTraceEvent(event)).filter(Boolean)
      : [];
  }

  const merged = Array.isArray(currentEvents)
    ? currentEvents.map((event) => normalizeTraceEvent(event)).filter(Boolean)
    : [];
  const seqToIndex = new Map();
  const fallbackKeys = new Set();

  merged.forEach((event, index) => {
    const seq = Number(event?.seq);
    if (Number.isFinite(seq) && seq > 0) {
      seqToIndex.set(seq, index);
      return;
    }
    fallbackKeys.add(eventFallbackKey(event));
  });

  for (const rawEvent of incomingEvents) {
    const event = normalizeTraceEvent(rawEvent);
    if (!event) continue;

    const seq = Number(event.seq);
    if (Number.isFinite(seq) && seq > 0) {
      const existingIndex = seqToIndex.get(seq);
      if (existingIndex !== undefined) {
        merged[existingIndex] = { ...merged[existingIndex], ...event };
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
    const aSeq = Number(a?.seq);
    const bSeq = Number(b?.seq);
    const aOk = Number.isFinite(aSeq) && aSeq > 0;
    const bOk = Number.isFinite(bSeq) && bSeq > 0;

    if (aOk && bOk) return aSeq - bSeq;
    if (aOk) return -1;
    if (bOk) return 1;
    return String(a?.timestamp || "").localeCompare(String(b?.timestamp || ""));
  });

  return merged;
}

export function actorToStage(actor) {
  const normalized = String(actor || "").trim().toLowerCase();
  if (!normalized) return "";
  return STAGE_ORDER.find((stage) => normalized.includes(stage)) || "";
}

export function extractLlmResponses(events = []) {
  return (Array.isArray(events) ? events : [])
    .map((rawEvent) => normalizeTraceEvent(rawEvent))
    .filter((event) => event?.kind === "llm_response")
    .map((event) => {
      const details = event.details || {};
      const usageMetadata = details.usage_metadata || details.usage_metadata_json || {};
      const responseMetadata = details.response_metadata || details.response_metadata_json || {};
      const additionalKwargs = details.additional_kwargs || {};
      const providerCacheActive =
        details.provider_cache_active ??
        responseMetadata.provider_cache_active ??
        additionalKwargs.provider_cache_active ??
        false;
      const costSource =
        details.cost_source ||
        usageMetadata.cost_source ||
        responseMetadata.cost_source ||
        additionalKwargs.cost_source ||
        "";
      const responseClass =
        details.response_class ||
        responseMetadata.response_class ||
        additionalKwargs.response_class ||
        "";
      return {
        key: `llm-${event.seq || event.timestamp || Math.random()}`,
        seq: seqNumber(event),
        actor: String(event.actor || ""),
        stage: actorToStage(event.actor),
        kind: String(event.kind || "llm_response"),
        provider: String(details.provider || ""),
        model_name: String(details.model_name || ""),
        input_tokens: Number(details.input_tokens || 0),
        output_tokens: Number(details.output_tokens || 0),
        context_window: Number(details.context_window || 0),
        cost_source: String(costSource || ""),
        provider_cache_active: providerCacheActive,
        response_class: String(responseClass || ""),
        estimated_total_cost_usd: Number(
          details.estimated_total_cost_usd || 0,
        ),
        estimated_input_cost_usd: Number(details.estimated_input_cost_usd || 0),
        estimated_cached_input_cost_usd: Number(
          details.estimated_cached_input_cost_usd || 0,
        ),
        estimated_cache_write_cost_usd: Number(
          details.estimated_cache_write_cost_usd || 0,
        ),
        estimated_output_cost_usd: Number(details.estimated_output_cost_usd || 0),
        usage_metadata_json: {
          cached_input_tokens: Number(details.cached_input_tokens || 0),
          cache_creation_input_tokens: Number(details.cache_creation_input_tokens || 0),
          new_input_tokens: Number(details.new_input_tokens || 0),
          estimated_input_cost_usd: Number(details.estimated_input_cost_usd || 0),
          estimated_cached_input_cost_usd: Number(
            details.estimated_cached_input_cost_usd || 0,
          ),
          estimated_cache_write_cost_usd: Number(
            details.estimated_cache_write_cost_usd || 0,
          ),
          estimated_output_cost_usd: Number(details.estimated_output_cost_usd || 0),
          cache_hit: Boolean(details.cache_hit),
          provider_cache_active: Boolean(providerCacheActive),
          cost_source: String(costSource || ""),
        },
        response_metadata_json: responseMetadata,
        additional_kwargs_json: additionalKwargs,
        content_preview: String(details.content_preview || ""),
        content_full: String(details.content_full || ""),
        thinking_content: String(details.thinking_content || ""),
        thinking_tokens: Number(details.thinking_tokens || 0),
        timestamp: event.timestamp || "",
        event,
      };
    });
}

function resolveLiveContextStatus(events) {
  const normalized = Array.isArray(events) ? events : [];
  const lastEvent = [...normalized].reverse().find(Boolean) || null;
  if (!lastEvent) return "tracked";

  if (
    RUN_FAILURE_KINDS.has(lastEvent.kind) ||
    normalized.some((event) => RUN_FAILURE_KINDS.has(event.kind)) ||
    ["error", "failed", "fail"].includes(String(lastEvent?.status || "").toLowerCase()) ||
    normalized.some((event) =>
      ["error", "failed", "fail"].includes(String(event?.status || "").toLowerCase()),
    )
  ) {
    return "failed";
  }

  if (["run_cancelled", "cancel_requested"].includes(lastEvent.kind)) {
    return "cancelled";
  }

  if (
    ["agent_finished", "pipeline_finished"].includes(lastEvent.kind) ||
    ["success", "done", "completed"].includes(String(lastEvent?.status || "").toLowerCase())
  ) {
    return "done";
  }

  if (normalized.some((event) => ["agent_started", "pipeline_started"].includes(event.kind))) {
    return "running";
  }

  if (lastEvent.kind === "llm_response" || lastEvent.kind === "llm_turn_started") {
    return "running";
  }

  return String(lastEvent.status || "tracked");
}

function buildLiveAgentContexts(events = [], rootActor = "") {
  const normalized = normalizeTraceEvents(events);
  const contexts = [];
  const openRuns = new Map();
  const invocationCounts = new Map();

  for (const event of normalized) {
    const actor = String(event.actor || rootActor || "unknown") || "unknown";
    if (actor === "control-room") continue;

    const kind = String(event.kind || "");
    const isStart = kind === "agent_started" || kind === "pipeline_started";
    const isFinish =
      kind === "agent_finished" ||
      kind === "pipeline_finished" ||
      kind === "pipeline_failed" ||
      kind === "run_cancelled";
    let current = openRuns.get(actor);

    if (isStart) {
      const nextInvocation = Number(invocationCounts.get(actor) || 0) + 1;
      invocationCounts.set(actor, nextInvocation);
      current = {
        actor,
        agentType: normalizeStageName(actor) || actorToStage(actor) || actor,
        events: [event],
        startedAt: event.timestamp || "",
        finishedAt: null,
        invocationIndex: nextInvocation,
      };
      openRuns.set(actor, current);
      continue;
    }

    if (current == null) {
      const nextInvocation = Number(invocationCounts.get(actor) || 0) + 1;
      invocationCounts.set(actor, nextInvocation);
      current = {
        actor,
        agentType: normalizeStageName(actor) || actorToStage(actor) || actor,
        events: [],
        startedAt: event.timestamp || "",
        finishedAt: null,
        invocationIndex: nextInvocation,
      };
      openRuns.set(actor, current);
    }

    current.events.push(event);

    if (isFinish) {
      current.finishedAt = event.timestamp || current.startedAt || "";
      contexts.push(current);
      openRuns.delete(actor);
    }
  }

  for (const current of openRuns.values()) {
    current.finishedAt =
      current.events[current.events.length - 1]?.timestamp || current.startedAt || "";
    contexts.push(current);
  }

  contexts.sort((a, b) => {
    const byStart = String(a.startedAt || "").localeCompare(String(b.startedAt || ""));
    if (byStart !== 0) return byStart;
    const byInvocation = Number(a.invocationIndex || 0) - Number(b.invocationIndex || 0);
    if (byInvocation !== 0) return byInvocation;
    return String(a.actor || "").localeCompare(String(b.actor || ""));
  });

  return contexts.map((ctx) => {
    const stage =
      actorToStage(ctx.actor) || normalizeStageName(ctx.agentType || ctx.actor) || "unknown";
    const invocationIndex = Number(ctx.invocationIndex || 0);
    const llmCalls = extractLlmResponses(ctx.events).map((call) => ({
      ...call,
      stage,
      actor: ctx.actor,
      invocationIndex,
    }));
    const stageIndex = STAGE_ORDER.indexOf(stage);
    const order = (stageIndex >= 0 ? stageIndex : STAGE_ORDER.length) * 1000 + invocationIndex;
    return {
      key: `agent-${ctx.actor || "unknown"}-${invocationIndex || 0}`,
      order,
      label: `${STAGE_LABELS[stage] || ctx.actor || "Agent"}${invocationIndex > 0 ? ` ${invocationIndex}` : ""}`,
      stage,
      agentType: stage,
      actor: ctx.actor,
      status: resolveLiveContextStatus(ctx.events),
      invocationIndex,
      llmCalls,
      startedAt: ctx.startedAt,
      finishedAt: ctx.finishedAt,
    };
  });
}

function isScreenshotValue(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return false;
  if (text.startsWith("data:image/")) return true;
  if (!/^https?:\/\//i.test(text)) return false;

  try {
    const parsed = new URL(text);
    const path = String(parsed.pathname || "").toLowerCase();
    const query = String(parsed.search || "").toLowerCase();
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

const SCREENSHOT_SINGLE_KEYS = ["screenshot_url", "screenshot"];
const SCREENSHOT_MULTI_KEYS = ["screenshot_urls", "screenshots", "all_screenshots"];
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
];

function addScreenshotCandidate(value, out) {
  if (!isScreenshotValue(value)) return false;
  out.add(String(value).trim());
  return true;
}

function parseJsonCandidates(text) {
  const candidates = [];

  try {
    candidates.push(JSON.parse(text));
  } catch {
    // keep trying
  }

  try {
    const unescaped = text.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (unescaped !== text) candidates.push(JSON.parse(unescaped));
  } catch {
    // keep trying
  }

  return candidates;
}

function extractEmbeddedScreenshotStrings(text, out) {
  const pattern =
    /(?:\\?"(?:screenshot_url|screenshot)\\?"\s*:\s*\\?")(https?:\/\/[^"\\]+|data:image\/[^"\\]+)(?:\\?")/g;
  for (const match of text.matchAll(pattern)) {
    addScreenshotCandidate(match[1], out);
  }
}

function collectScreenshotFromObject(value, out) {
  if (!value || typeof value !== "object") return;

  const itemType = String(value.type || "").toLowerCase();
  if (itemType === "image" && typeof value.data === "string" && value.data.trim()) {
    const mime =
      String(value.mimeType || value.mime_type || "image/png").trim() || "image/png";
    addScreenshotCandidate(`data:${mime};base64,${value.data.trim()}`, out);
  }

  for (const key of SCREENSHOT_SINGLE_KEYS) {
    addScreenshotCandidate(value[key], out);
  }

  for (const key of SCREENSHOT_MULTI_KEYS) {
    const urls = value[key];
    if (Array.isArray(urls)) {
      for (const url of urls) addScreenshotCandidate(url, out);
    }
  }

  for (const key of SCREENSHOT_WRAPPER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      collectScreenshotUrls(value[key], out);
    }
  }
}

export function collectScreenshotUrls(value, out = new Set()) {
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
    collectScreenshotFromObject(value, out);
  }

  return out;
}

function toolTarget(details) {
  const args = details?.tool_args ?? details?.args ?? {};
  return (
    args.url ||
    args.mainUrl ||
    args.target_url ||
    args.player_iframe_url ||
    args.iframe_url ||
    args.base_url ||
    args.href ||
    args.selector ||
    args.css_selector ||
    args.xpath ||
    args.text ||
    args.value ||
    ""
  );
}

export function extractToolCalls(events = []) {
  const rows = [];
  const pendingById = new Map();
  const pendingByActor = new Map();

  const ensureActorStack = (actor) => {
    const key = actor || "__unknown__";
    if (!pendingByActor.has(key)) pendingByActor.set(key, []);
    return pendingByActor.get(key);
  };

  for (const rawEvent of Array.isArray(events) ? events : []) {
    const event = normalizeTraceEvent(rawEvent);
    if (!event) continue;
    if (event.kind !== "tool_call_started" && event.kind !== "tool_call_finished") continue;

    const actor = String(event.actor || "");
    const stage = actorToStage(actor);
    const details = event.details || {};
    const toolName = String(details.tool_name || "tool");
    const toolCallId = String(details.tool_call_id || "");
    const seq = Number(event.seq || 0);
    const stack = ensureActorStack(actor);

    if (event.kind === "tool_call_started") {
      const row = {
        key: toolCallId || `${actor || "unknown"}-${seq || rows.length + 1}`,
        actor,
        stage,
        toolName,
        target: toolTarget(details),
        status: "running",
        startedAt: event.timestamp || "",
        finishedAt: "",
        durationSeconds: 0,
        startSeq: seq,
        finishSeq: null,
        args: details.tool_args ?? details.args ?? {},
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

    let row = toolCallId ? pendingById.get(toolCallId) : null;
    if (!row) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]?.toolName === toolName) {
          row = stack[index];
          stack.splice(index, 1);
          break;
        }
      }
    } else {
      pendingById.delete(toolCallId);
      const stackIndex = stack.findIndex((item) => item?.key === row.key);
      if (stackIndex >= 0) stack.splice(stackIndex, 1);
    }

    if (!row) {
      row = {
        key: toolCallId || `${actor || "unknown"}-${seq || rows.length + 1}`,
        actor,
        stage,
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

    const result = details.result_full ?? details.result_preview ?? null;
    const screenshotSet = collectScreenshotUrls(details, new Set());
    collectScreenshotUrls(result, screenshotSet);
    const screenshots = Array.from(screenshotSet);
    row.status = String(details.status || event.status || "success");
    row.finishedAt = event.timestamp || "";
    row.durationSeconds = Number(details.duration_seconds || row.durationSeconds || 0);
    row.finishSeq = seq || row.finishSeq;
    row.result = result;
    row.screenshots = screenshots;
    row.finishedEvent = event;
  }

  return rows.sort((a, b) => {
    const aSeq = Number(a.startSeq || a.finishSeq || 0);
    const bSeq = Number(b.startSeq || b.finishSeq || 0);
    return aSeq - bSeq;
  });
}

function stageStatus(events) {
  const relevant = (events || []).filter((event) => event && typeof event === "object");
  if (!relevant.length) return "idle";

  const lastTerminal = [...relevant].reverse().find((event) =>
    ["agent_finished", "agent_failed", "run_cancelled", "cancel_requested"].includes(event.kind)
  );
  const lastStart = [...relevant].reverse().find((event) => event.kind === "agent_started");

  if (lastTerminal?.kind === "agent_failed") return "failed";
  if (lastTerminal?.kind === "run_cancelled" || lastTerminal?.kind === "cancel_requested") return "cancelled";
  if (lastStart && (!lastTerminal || Number(lastStart.seq || 0) > Number(lastTerminal.seq || 0))) return "running";
  if (lastTerminal?.kind === "agent_finished") return "done";
  return "active";
}

export function buildStageView(events = []) {
  const toolCalls = extractToolCalls(events);
  const llmCalls = extractLlmResponses(events);
  const stageMap = Object.fromEntries(
    STAGE_ORDER.map((stage) => [stage, {
      stage,
      label: STAGE_LABELS[stage],
      actor: stage,
      status: "idle",
      events: [],
      toolCalls: [],
      llmCalls: 0,
      frames: [],
      latestFrame: null,
      latestEventSeq: 0,
      pendingToolCount: 0,
      pendingLlmCount: 0,
      livePhase: "idle",
      liveLabel: "waiting",
      latestFailure: null,
      latestLlm: null,
      latestTool: null,
    }])
  );

  for (const rawEvent of Array.isArray(events) ? events : []) {
    const event = normalizeTraceEvent(rawEvent);
    if (!event) continue;
    const stage = actorToStage(event?.actor);
    if (!stage || !stageMap[stage]) continue;
    stageMap[stage].events.push(event);
    stageMap[stage].latestEventSeq = Math.max(stageMap[stage].latestEventSeq, Number(event?.seq || 0));
    if (event?.kind === "llm_response") stageMap[stage].llmCalls += 1;
  }

  for (const call of toolCalls) {
    if (!call?.stage || !stageMap[call.stage]) continue;
    stageMap[call.stage].toolCalls.push(call);
    if (call.status === "running") stageMap[call.stage].pendingToolCount += 1;
    stageMap[call.stage].latestTool = call;
    for (const screenshot of call.screenshots || []) {
      const frame = {
        url: screenshot,
        seq: Number(call.finishSeq || call.startSeq || 0),
        actor: call.actor,
        stage: call.stage,
        toolName: call.toolName,
        target: call.target,
        timestamp: call.finishedAt || call.startedAt || "",
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
    const lastFailure = latestEvent(stageEvents, (event) =>
      RUN_FAILURE_KINDS.has(event?.kind) ||
      ((event?.kind === "tool_call_finished" || event?.kind === "tool_call_started") &&
        ["error", "failed", "fail"].includes(String(event?.status || event?.details?.status || "").toLowerCase()))
    ) || null;
    const lastLlmStart = latestEvent(
      stageEvents,
      (event) => event?.kind === "llm_turn_started",
    );
    const lastLlmTerminal = latestEvent(stageEvents, (event) =>
      LLM_TERMINAL_KINDS.has(event?.kind),
    );
    const pendingLlmCount =
      lastLlmStart && (!lastLlmTerminal || seqNumber(lastLlmStart) > seqNumber(lastLlmTerminal))
        ? 1
        : 0;
    const status = stageStatus(stageEvents);
    let livePhase = "idle";
    let liveLabel = "waiting";
    if (lastFailure) {
      livePhase = "failed";
      liveLabel = "failed";
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
      frames: entry.frames.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0)),
    };
  });

  const lastActiveEvent = [...(Array.isArray(events) ? events : [])]
    .reverse()
    .find((event) => actorToStage(event?.actor));
  const autoStage = actorToStage(lastActiveEvent?.actor) || stages.find((stage) => stage.status === "running")?.stage || "classification";

  return { stages, toolCalls, autoStage };
}

export function buildContextWindowGroups({
  events = [],
  llmCalls = [],
  agentRuns = [],
  active = false,
} = {}) {
  if (active) {
    return buildLiveAgentContexts(events);
  }

  const agentMap = new Map(
    (agentRuns || []).map((row) => [
      Number(row?.id || 0),
      {
        actor: String(row?.actor || ""),
        stage: normalizeStageName(row?.agent_type || row?.actor || ""),
        invocationIndex: Number(row?.invocation_index || 0),
        status: String(row?.status || ""),
        agentType: String(row?.agent_type || row?.actor || ""),
      },
    ]),
  );

  const groups = new Map();
  for (const row of llmCalls || []) {
    const agentRunId = Number(row?.agent_run_id || 0);
    const agent = agentMap.get(agentRunId);
    const stage = agent?.stage || actorToStage(row?.actor) || "unknown";
    const key = agentRunId > 0 ? `agent-${agentRunId}` : `${stage}-${row?.model_name || "model"}`;
    if (!groups.has(key)) {
      const labelBase = STAGE_LABELS[stage] || stage || "Agent";
      const label =
        agent?.invocationIndex > 0 ? `${labelBase} ${agent.invocationIndex}` : labelBase;
      const stageIndex = STAGE_ORDER.indexOf(stage);
      groups.set(key, {
        key,
        order: (stageIndex >= 0 ? stageIndex : STAGE_ORDER.length) * 1000 + Number(agent?.invocationIndex || 0),
        label,
        stage,
        agentType: agent?.agentType || stage,
        actor: agent?.actor || String(row?.actor || ""),
        status: agent?.status || "",
        invocationIndex: Number(agent?.invocationIndex || 0),
        agentRunId: agentRunId > 0 ? agentRunId : 0,
        llmCalls: [],
      });
    }
    groups.get(key).llmCalls.push(row);
  }

  return [...groups.values()].sort((a, b) => {
    const stageDelta = Number(a.order || 999) - Number(b.order || 999);
    if (stageDelta !== 0) return stageDelta;
    const invocationDelta = Number(a.invocationIndex || 0) - Number(b.invocationIndex || 0);
    if (invocationDelta !== 0) return invocationDelta;
    return a.label.localeCompare(b.label);
  });
}

export function buildPersistedLlmEvents({ llmCalls = [], agentRuns = [] } = {}) {
  const agentMap = new Map(
    (agentRuns || []).map((row) => [
      Number(row?.id || 0),
      {
        actor: String(row?.actor || ""),
        agentType: String(row?.agent_type || ""),
        invocationIndex: Number(row?.invocation_index || 0),
      },
    ]),
  );

  return (llmCalls || []).map((row, index) => {
    const agentRunId = Number(row?.agent_run_id || 0);
    const agent = agentMap.get(agentRunId) || {};
    const usageMetadata = row?.usage_metadata_json || {};
    const responseMetadata = row?.response_metadata_json || {};
    const additionalKwargs =
      row?.additional_kwargs_json || responseMetadata?.additional_kwargs || {};
    const cost = Number(row?.total_cost_usd ?? row?.estimated_total_cost_usd ?? 0);
    const costSource = String(row?.cost_source || usageMetadata?.cost_source || "");
    const actor = String(row?.actor || agent.actor || row?.agent_type || agent.agentType || "llm");
    const details = {
      provider: String(row?.provider || ""),
      model_name: String(row?.model_name || ""),
      input_tokens: Number(row?.input_tokens || 0),
      output_tokens: Number(row?.output_tokens || 0),
      context_window: Number(row?.context_window || 0),
      estimated_total_cost_usd: cost,
      estimated_input_cost_usd: Number(row?.estimated_input_cost_usd || 0),
      estimated_cached_input_cost_usd: Number(row?.estimated_cached_input_cost_usd || 0),
      estimated_cache_write_cost_usd: Number(row?.estimated_cache_write_cost_usd || 0),
      estimated_output_cost_usd: Number(row?.estimated_output_cost_usd || 0),
      cached_input_tokens: Number(
        row?.cached_input_tokens || usageMetadata?.cached_input_tokens || 0,
      ),
      cache_creation_input_tokens: Number(
        row?.cache_creation_input_tokens ||
          usageMetadata?.cache_creation_input_tokens ||
          0,
      ),
      new_input_tokens: Number(row?.new_input_tokens || usageMetadata?.new_input_tokens || 0),
      cost_source: costSource,
      tool_calls: Number(row?.tool_calls_requested || 0),
      tool_call_names: row?.tools_requested || [],
      content_preview: String(row?.content_preview || ""),
      content_full: String(
        row?.content_full ||
          responseMetadata?.content_full ||
          row?.content_preview ||
          "",
      ),
      thinking_content: String(
        row?.thinking_content || responseMetadata?.thinking_content || "",
      ),
      thinking_tokens: Number(
        row?.thinking_tokens || responseMetadata?.thinking_tokens || 0,
      ),
      usage_metadata_json: usageMetadata,
      response_metadata_json: responseMetadata,
      additional_kwargs_json: additionalKwargs,
      prompt: {
        prompt_version: String(row?.prompt_version || ""),
        prompt_hash: String(row?.prompt_hash || ""),
        cache_mode: String(row?.cache_mode || ""),
      },
    };
    return {
      seq: Number(row?.seq || index + 1),
      timestamp: row?.created_at || row?.timestamp || "",
      created_at: row?.created_at || row?.timestamp || "",
      actor,
      kind: "llm_response",
      message: details.content_preview ? "Persisted LLM response" : "Persisted LLM telemetry",
      status: "success",
      agent_run_id: agentRunId || row?.agent_run_id || null,
      details,
      details_json: details,
    };
  });
}

export function summarizeRunState(events = []) {
  const normalized = (Array.isArray(events) ? events : [])
    .map((event) => normalizeTraceEvent(event))
    .filter(Boolean);
  if (!normalized.length) {
    return {
      status: "idle",
      active: null,
      lastCompleted: null,
      failure: null,
      terminal: null,
    };
  }

  const toolCalls = extractToolCalls(normalized);
  const pendingTool = [...toolCalls].reverse().find((call) => call.status === "running") || null;
  const llmResponses = extractLlmResponses(normalized);
  const lastLlmStart = latestEvent(
    normalized,
    (event) => event.kind === "llm_turn_started",
  );
  const lastLlmTerminal = latestEvent(normalized, (event) =>
    LLM_TERMINAL_KINDS.has(event.kind),
  );
  const llmRunning =
    lastLlmStart &&
    (!lastLlmTerminal || seqNumber(lastLlmStart) > seqNumber(lastLlmTerminal));
  const failureEvent =
    latestEvent(normalized, (event) => RUN_FAILURE_KINDS.has(event.kind)) ||
    latestEvent(
      normalized,
      (event) =>
        event.kind === "tool_call_finished" &&
        ["error", "failed", "fail"].includes(
          String(event?.details?.status || event?.status || "").toLowerCase(),
        ),
    ) ||
    null;
  const terminal =
    latestEvent(normalized, (event) =>
      ["pipeline_finished", "agent_finished", "pipeline_failed", "agent_failed", "run_cancelled", "cancel_requested"].includes(event.kind),
    ) || null;
  const lastCompleted =
    latestEvent(normalized, (event) =>
      ["llm_response", "tool_call_finished", "agent_finished", "pipeline_finished"].includes(event.kind),
    ) || null;

  let active = null;
  let status = "running";
  if (failureEvent) {
    status = "failed";
  } else if (terminal?.kind === "run_cancelled" || terminal?.kind === "cancel_requested") {
    status = "cancelled";
  } else if (
    terminal?.kind === "pipeline_finished" ||
    terminal?.kind === "agent_finished"
  ) {
    status = "completed";
  }

  if (failureEvent) {
    active = {
      type: "failed",
      stage: actorToStage(failureEvent.actor),
      actor: String(failureEvent.actor || ""),
      title: "Run failed",
      message: eventErrorMessage(failureEvent),
      event: failureEvent,
    };
  } else if (llmRunning) {
    const details = lastLlmStart?.details || {};
    active = {
      type: "llm",
      stage: actorToStage(lastLlmStart.actor),
      actor: String(lastLlmStart.actor || ""),
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
      actor: String(pendingTool.actor || ""),
      title: "Tool running",
      message: [pendingTool.toolName, pendingTool.target].filter(Boolean).join(" / "),
      event: pendingTool.startedEvent,
    };
  } else if (
    terminal?.kind === "pipeline_finished" ||
    terminal?.kind === "agent_finished"
  ) {
    active = {
      type: "done",
      stage: actorToStage(terminal.actor),
      actor: String(terminal.actor || ""),
      title: "Run finished",
      message: terminal.message || "Execution completed.",
      event: terminal,
    };
  }

  let completedSummary = null;
  if (lastCompleted) {
    if (lastCompleted.kind === "llm_response") {
      const details = lastCompleted.details || {};
      completedSummary = {
        type: "llm_response",
        stage: actorToStage(lastCompleted.actor),
        actor: String(lastCompleted.actor || ""),
        title: "Model responded",
        message:
          Number(details.output_tokens || 0) > 0
            ? `${details.model_name || "model"} / ${Number(details.output_tokens || 0).toLocaleString()} out`
            : `${details.model_name || "model"} responded`,
      };
    } else if (lastCompleted.kind === "tool_call_finished") {
      completedSummary = {
        type: "tool_finished",
        stage: actorToStage(lastCompleted.actor),
        actor: String(lastCompleted.actor || ""),
        title: "Tool finished",
        message: [lastCompleted.details?.tool_name, lastCompleted.details?.status]
          .filter(Boolean)
          .join(" / "),
      };
    } else {
      completedSummary = {
        type: "stage_finished",
        stage: actorToStage(lastCompleted.actor),
        actor: String(lastCompleted.actor || ""),
        title: "Stage finished",
        message: lastCompleted.message || "",
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
          actor: String(failureEvent.actor || ""),
          message: eventErrorMessage(failureEvent),
          kind: failureEvent.kind,
          event: failureEvent,
        }
      : null,
    terminal,
    llmCalls: llmResponses,
  };
}
