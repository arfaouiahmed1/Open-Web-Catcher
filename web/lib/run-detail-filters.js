import { actorToStage, STAGE_LABELS } from "./run-trace.js";
import { safeJson } from "./utils.js";

function safeLower(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveStage(value) {
  const direct = safeLower(value);
  return actorToStage(value) || direct;
}

function explicitStage(value) {
  const normalized = safeLower(value);
  return Object.prototype.hasOwnProperty.call(STAGE_LABELS, normalized) ? normalized : "";
}

function matchSearch(chunks, term) {
  if (!term) return true;
  return chunks
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(term);
}

function serializeValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return safeJson(value);
}

export function buildRunDetailFilterOptions({
  events = [],
  toolCalls = [],
  agentRollups = [],
  decisions = [],
} = {}) {
  const actorSet = new Set();
  const stageSet = new Set();

  for (const value of [
    ...events.map((event) => event?.actor),
    ...toolCalls.map((call) => call?.actor || call?.stage),
    ...agentRollups.map((row) => row?.actor || row?.agent_type),
    ...decisions.map((row) => row?.actor),
  ]) {
    const actor = String(value || "").trim();
    if (!actor) continue;
    actorSet.add(actor);
    const stage = actorToStage(actor) || explicitStage(actor);
    if (stage) stageSet.add(stage);
  }

  return {
    actors: Array.from(actorSet).sort((a, b) => a.localeCompare(b)),
    stages: Array.from(stageSet)
      .sort((a, b) => a.localeCompare(b))
      .map((stage) => ({
        value: stage,
        label: STAGE_LABELS[stage] || stage,
      })),
  };
}

export function filterRuntimeEvents(events = [], sharedFilters = {}, localFilters = {}) {
  const term = safeLower(localFilters.search ?? sharedFilters.search);
  const actor = String(sharedFilters.actor || "").trim();
  const stage = safeLower(sharedFilters.stage);
  const kind = String(localFilters.kind || "").trim();

  return (Array.isArray(events) ? events : []).filter((event) => {
    if (actor && String(event?.actor || "").trim() !== actor) return false;
    if (stage && resolveStage(event?.actor) !== stage) return false;
    if (kind && String(event?.kind || "").trim() !== kind) return false;

    return matchSearch(
      [
        event?.kind,
        event?.actor,
        event?.status,
        event?.message,
        serializeValue(event?.details ?? event?.details_json),
      ],
      term,
    );
  });
}

export function filterToolCalls(toolCalls = [], sharedFilters = {}, localFilters = {}) {
  const term = safeLower(localFilters.search ?? sharedFilters.search);
  const actor = String(sharedFilters.actor || "").trim();
  const stage = safeLower(sharedFilters.stage);
  const status = safeLower(localFilters.status);

  return (Array.isArray(toolCalls) ? toolCalls : []).filter((call) => {
    if (actor && String(call?.actor || "").trim() !== actor) return false;
    if (stage && resolveStage(call?.stage || call?.actor) !== stage) return false;
    if (status && safeLower(call?.status) !== status) return false;

    return matchSearch(
      [
        call?.toolName,
        call?.target,
        call?.actor,
        call?.stage,
        call?.status,
        serializeValue(call?.args),
        serializeValue(call?.result),
      ],
      term,
    );
  });
}

export function filterDecisionItems(items = [], sharedFilters = {}, localFilters = {}) {
  const term = safeLower(localFilters.search ?? sharedFilters.search);
  const actor = String(sharedFilters.actor || "").trim();
  const stage = safeLower(sharedFilters.stage);
  const source = safeLower(localFilters.source);
  const category = safeLower(localFilters.category);
  const status = safeLower(localFilters.status);

  return (Array.isArray(items) ? items : []).filter((item) => {
    const sourceValue = safeLower(item?.details?.source) || "manual";
    if (source && sourceValue !== source) return false;
    if (actor && String(item?.actor || "").trim() !== actor) return false;
    if (stage && resolveStage(item?.actor) !== stage) return false;
    if (category && safeLower(item?.category) !== category) return false;
    if (status && safeLower(item?.status) !== status) return false;

    return matchSearch(
      [
        item?.title,
        item?.summary,
        item?.actor,
        item?.category,
        item?.status,
        serializeValue(item?.details),
      ],
      term,
    );
  });
}

export function filterDecisionEvents(events = [], sharedFilters = {}, localFilters = {}) {
  const source = safeLower(localFilters.source);
  if (source === "manual") return [];
  return filterRuntimeEvents(events, sharedFilters, {
    search: localFilters.search,
    kind: localFilters.kind,
  });
}
