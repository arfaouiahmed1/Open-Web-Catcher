import { actorToStage, STAGE_LABELS } from "./run-trace";
import { safeJson } from "./utils";

function safeLower(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function resolveStage(value: unknown): string {
  const direct = safeLower(value);
  return actorToStage(value) || direct;
}

function explicitStage(value: unknown): string {
  const normalized = safeLower(value);
  return Object.prototype.hasOwnProperty.call(STAGE_LABELS, normalized) ? normalized : "";
}

function matchSearch(chunks: unknown[], term: string): boolean {
  if (!term) return true;
  return chunks
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(term);
}

function serializeValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return safeJson(value);
}

export interface RunDetailFilterOptions {
  actors: string[];
  stages: Array<{ value: string; label: string }>;
}

export function buildRunDetailFilterOptions({
  events = [],
  toolCalls = [],
  agentRollups = [],
  decisions = [],
}: {
  events?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
  agentRollups?: Array<Record<string, unknown>>;
  decisions?: Array<Record<string, unknown>>;
} = {}): RunDetailFilterOptions {
  const actorSet = new Set<string>();
  const stageSet = new Set<string>();

  for (const value of [
    ...events.map((event) => event?.actor),
    ...toolCalls.map((call) => (call?.actor as string | undefined) ?? (call?.stage as string | undefined)),
    ...agentRollups.map((row) => (row?.actor as string | undefined) ?? (row?.agent_type as string | undefined)),
    ...decisions.map((row) => row?.actor),
  ]) {
    const actor = String(value ?? "").trim();
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
        label: (STAGE_LABELS as Record<string, string>)[stage] ?? stage,
      })),
  };
}

export interface SharedFilters {
  search?: unknown;
  actor?: unknown;
  stage?: unknown;
}

export interface LocalEventFilters {
  search?: unknown;
  kind?: unknown;
}

export function filterRuntimeEvents(
  events: Array<Record<string, unknown>> | null | undefined = [],
  sharedFilters: SharedFilters = {},
  localFilters: LocalEventFilters = {},
): Array<Record<string, unknown>> {
  const term = safeLower(localFilters.search ?? sharedFilters.search);
  const actor = String(sharedFilters.actor ?? "").trim();
  const stage = safeLower(sharedFilters.stage);
  const kind = String(localFilters.kind ?? "").trim();

  return (Array.isArray(events) ? events : []).filter((event) => {
    if (actor && String(event?.actor ?? "").trim() !== actor) return false;
    if (stage && resolveStage(event?.actor) !== stage) return false;
    if (kind && String(event?.kind ?? "").trim() !== kind) return false;

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

export function filterToolCalls(
  toolCalls: Array<Record<string, unknown>> | null | undefined = [],
  sharedFilters: SharedFilters = {},
  localFilters: SharedFilters & { status?: unknown } = {},
): Array<Record<string, unknown>> {
  const term = safeLower(localFilters.search ?? sharedFilters.search);
  const actor = String(sharedFilters.actor ?? "").trim();
  const stage = safeLower(sharedFilters.stage);
  const status = safeLower(localFilters.status);

  return (Array.isArray(toolCalls) ? toolCalls : []).filter((call) => {
    if (actor && String(call?.actor ?? "").trim() !== actor) return false;
    if (stage && resolveStage(call?.stage ?? call?.actor) !== stage) return false;
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

export function filterDecisionItems(
  items: Array<Record<string, unknown>> | null | undefined = [],
  sharedFilters: SharedFilters = {},
  localFilters: { search?: unknown; source?: unknown; category?: unknown; status?: unknown } = {},
): Array<Record<string, unknown>> {
  const term = safeLower(localFilters.search ?? sharedFilters.search);
  const actor = String(sharedFilters.actor ?? "").trim();
  const stage = safeLower(sharedFilters.stage);
  const source = safeLower(localFilters.source);
  const category = safeLower(localFilters.category);
  const status = safeLower(localFilters.status);

  return (Array.isArray(items) ? items : []).filter((item) => {
    const details = (item?.details ?? {}) as Record<string, unknown>;
    const sourceValue = safeLower(details?.source) || "manual";
    if (source && sourceValue !== source) return false;
    if (actor && String(item?.actor ?? "").trim() !== actor) return false;
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

export function filterDecisionEvents(
  events: Array<Record<string, unknown>> | null | undefined = [],
  sharedFilters: SharedFilters = {},
  localFilters: { search?: unknown; kind?: unknown; source?: unknown } = {},
): Array<Record<string, unknown>> {
  const source = safeLower(localFilters.source);
  if (source === "manual") return [];
  return filterRuntimeEvents(events, sharedFilters, {
    search: localFilters.search,
    kind: localFilters.kind,
  });
}
