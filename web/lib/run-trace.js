export const STAGE_ORDER = ["classification", "landing", "hosting", "embedded"];

export const STAGE_LABELS = {
  classification: "Classification",
  landing: "Landing",
  hosting: "Hosting",
  embedded: "Embedded",
};

export function normalizeTraceEvent(event) {
  if (!event || typeof event !== "object") return null;
  return {
    ...event,
    timestamp: event.timestamp || event.created_at || "",
    details: event.details ?? event.details_json ?? {},
  };
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

function isScreenshotValue(value) {
  return typeof value === "string" && value.trim().length > 0 && (value.startsWith("http") || value.startsWith("data:image/"));
}

export function collectScreenshotUrls(value, out = new Set()) {
  if (value == null) return out;

  if (typeof value === "string") {
    try {
      collectScreenshotUrls(JSON.parse(value), out);
      return out;
    } catch {
      // keep walking
    }

    try {
      const unescaped = value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      collectScreenshotUrls(JSON.parse(unescaped), out);
      return out;
    } catch {
      // keep walking
    }

    const pattern = /(?:\\?"screenshot_url\\?"\s*:\s*\\?")(https?:\/\/[^"\\]+|data:image\/[^"\\]+)(?:\\?")/g;
    for (const match of value.matchAll(pattern)) {
      const url = String(match[1] || "").trim();
      if (isScreenshotValue(url)) out.add(url);
    }
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectScreenshotUrls(item, out);
    return out;
  }

  if (typeof value === "object") {
    const screenshotUrl = value.screenshot_url;
    if (isScreenshotValue(screenshotUrl)) out.add(String(screenshotUrl).trim());

    const screenshotUrls = value.screenshot_urls;
    if (Array.isArray(screenshotUrls)) {
      for (const item of screenshotUrls) {
        if (isScreenshotValue(item)) out.add(String(item).trim());
      }
    }

    for (const nested of Object.values(value)) {
      collectScreenshotUrls(nested, out);
    }
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

  const stages = STAGE_ORDER.map((stage) => {
    const entry = stageMap[stage];
    return {
      ...entry,
      status: stageStatus(entry.events),
      frames: entry.frames.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0)),
    };
  });

  const lastActiveEvent = [...(Array.isArray(events) ? events : [])]
    .reverse()
    .find((event) => actorToStage(event?.actor));
  const autoStage = actorToStage(lastActiveEvent?.actor) || stages.find((stage) => stage.status === "running")?.stage || "classification";

  return { stages, toolCalls, autoStage };
}
