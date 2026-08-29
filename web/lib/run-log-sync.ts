import { normalizeTraceEvents } from "./run-trace";

function shortText(value: unknown, max = 260): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function statusFromDecisionKind(kind = "", eventStatus = ""): string {
  const normalizedKind = String(kind ?? "").toLowerCase();
  const normalizedStatus = String(eventStatus ?? "").toLowerCase();
  if (normalizedKind.includes("failed") || normalizedStatus === "error" || normalizedStatus === "failed") {
    return "blocked";
  }
  if (normalizedKind.includes("finished") || normalizedKind.includes("completed") || normalizedStatus === "success") {
    return "approved";
  }
  return "open";
}

function decisionCategory(event: Record<string, unknown>): string {
  const kind = String(event?.kind ?? "").toLowerCase();
  if (kind.includes("route") || kind.includes("handoff")) return "routing";
  if (kind.includes("pipeline")) return "pipeline";
  return "agent";
}

function decisionTitle(event: Record<string, unknown>): string {
  const kind = String(event?.kind ?? "");
  const details = safeObject(event?.details);
  const actor = String(event?.actor ?? "").trim();
  const routedActor = String(
    (details.next_actor as string | undefined) ??
      (details.next_agent as string | undefined) ??
      (details.selected_agent as string | undefined) ??
      (details.route_to as string | undefined) ??
      "",
  ).trim();

  if (kind === "pipeline_started") return "Pipeline started";
  if (kind === "pipeline_finished") return "Pipeline finished";
  if (kind === "pipeline_failed") return "Pipeline failed";
  if (kind === "agent_started") return `Started ${actor || "agent"}`;
  if (kind === "agent_finished") return `Completed ${actor || "agent"}`;
  if (kind === "agent_failed") return `Failed ${actor || "agent"}`;
  if (kind.includes("route") || kind.includes("handoff")) {
    return routedActor ? `Route to ${routedActor}` : "Routing decision";
  }
  return shortText(kind || (event?.message as string | undefined) || "Orchestrator decision", 90);
}

function decisionSummary(event: Record<string, unknown>): string {
  const details = safeObject(event?.details);
  const parts: string[] = [];
  const reason =
    (details.reasoning as string | undefined) ??
    (details.reason as string | undefined) ??
    (details.summary as string | undefined) ??
    (details.note as string | undefined) ??
    (details.explanation as string | undefined) ??
    "";
  const next =
    (details.next_action as string | undefined) ??
    (details.next_step as string | undefined) ??
    (details.next_actor as string | undefined) ??
    (details.next_agent as string | undefined) ??
    (details.selected_agent as string | undefined) ??
    (details.route_to as string | undefined) ??
    "";
  const observed = (details.observed_change as string | undefined) ?? (details.observation as string | undefined) ?? "";
  const message = (event?.message as string | undefined) ?? "";

  if (message) parts.push(shortText(message, 220));
  if (next) parts.push(`Next: ${shortText(next, 140)}`);
  if (reason) parts.push(`Why: ${shortText(reason, 180)}`);
  if (observed) parts.push(`Observed: ${shortText(observed, 140)}`);
  return shortText(parts.join(" / "), 500);
}

function isDecisionEvent(event: Record<string, unknown> | null | undefined): boolean {
  if (!event) return false;
  const kind = String(event.kind ?? "").toLowerCase();
  if (event.actor === "orchestrator") return true;
  if (kind.includes("route") || kind.includes("handoff")) return true;
  return (
    kind === "pipeline_started" ||
    kind === "pipeline_finished" ||
    kind === "pipeline_failed" ||
    kind === "agent_started" ||
    kind === "agent_finished" ||
    kind === "agent_failed"
  );
}

export interface AutoDecision {
  auto_key: string;
  title: string;
  summary: string;
  actor: string;
  category: string;
  status: string;
  details: Record<string, unknown>;
}

export function buildAutoDecisionSync(events: unknown[] | null | undefined = []): AutoDecision[] {
  return normalizeTraceEvents(events as unknown[])
    .filter((event) => isDecisionEvent(event as unknown as Record<string, unknown>))
    .sort((a, b) => Number((a.seq as number | undefined) ?? 0) - Number((b.seq as number | undefined) ?? 0))
    .map((event, index) => {
      const details = safeObject((event as unknown as Record<string, unknown>).details);
      const seq = Number((event as unknown as Record<string, unknown>).seq ?? 0);
      const keySeed =
        seq > 0
          ? `seq-${seq}`
          : `${(event as unknown as Record<string, unknown>).timestamp ?? "na"}-${(event as unknown as Record<string, unknown>).kind ?? "event"}-${(event as unknown as Record<string, unknown>).actor ?? "unknown"}-${index}`;
      return {
        auto_key: `decision:${keySeed}`,
        title: decisionTitle(event as unknown as Record<string, unknown>),
        summary: decisionSummary(event as unknown as Record<string, unknown>),
        actor: String((event as unknown as Record<string, unknown>).actor ?? ""),
        category: decisionCategory(event as unknown as Record<string, unknown>),
        status: statusFromDecisionKind(
          String((event as unknown as Record<string, unknown>).kind ?? ""),
          String((event as unknown as Record<string, unknown>).status ?? ""),
        ),
        details: {
          kind: (event as unknown as Record<string, unknown>).kind ?? "",
          event_status: (event as unknown as Record<string, unknown>).status ?? "",
          event_seq: seq || null,
          event_timestamp: (event as unknown as Record<string, unknown>).timestamp ?? "",
          source_event: details,
        },
      };
    });
}

function maybeHttp(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  if (!/^https?:\/\//i.test(text)) return "";
  return text;
}

function collectProviderLikeUrls(value: unknown, out: Set<string>): void {
  if (!value) return;
  if (typeof value === "string") {
    const direct = maybeHttp(value);
    if (direct) out.add(direct);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProviderLikeUrls(item, out);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (
      /(^|_)(stream|playlist|provider|embed|iframe|playback|manifest|m3u8|mpd|hls|dash)(s|_url|_urls)?$/i.test(key) ||
      /^all_streams$/i.test(key)
    ) {
      collectProviderLikeUrls(nested, out);
    } else if (
      key === "provider_analysis" ||
      key === "all_streams" ||
      key === "stream_candidates" ||
      key === "stream_matches"
    ) {
      collectProviderLikeUrls(nested, out);
    }
  }
}

export function collectRunProviderUrls({
  runUrl = "",
  snapshot = {},
  events = [],
}: {
  runUrl?: string;
  snapshot?: unknown;
  events?: unknown[];
} = {}): string[] {
  void runUrl;
  const seen = new Set<string>();
  collectProviderLikeUrls(snapshot, seen);
  for (const event of normalizeTraceEvents(events as unknown[])) {
    collectProviderLikeUrls((event as unknown as Record<string, unknown>).details, seen);
  }
  return Array.from(seen).slice(0, 40);
}
