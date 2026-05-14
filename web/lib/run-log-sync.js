import { normalizeTraceEvents } from "./run-trace.js";

function shortText(value, max = 260) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function safeObject(value) {
  return value && typeof value === "object" ? value : {};
}

function statusFromDecisionKind(kind = "", eventStatus = "") {
  const normalizedKind = String(kind || "").toLowerCase();
  const normalizedStatus = String(eventStatus || "").toLowerCase();
  if (normalizedKind.includes("failed") || normalizedStatus === "error" || normalizedStatus === "failed") {
    return "blocked";
  }
  if (normalizedKind.includes("finished") || normalizedKind.includes("completed") || normalizedStatus === "success") {
    return "approved";
  }
  return "open";
}

function decisionCategory(event) {
  const kind = String(event?.kind || "").toLowerCase();
  if (kind.includes("route") || kind.includes("handoff")) return "routing";
  if (kind.includes("pipeline")) return "pipeline";
  return "agent";
}

function decisionTitle(event) {
  const kind = String(event?.kind || "");
  const details = safeObject(event?.details);
  const actor = String(event?.actor || "").trim();
  const routedActor = String(
    details.next_actor || details.next_agent || details.selected_agent || details.route_to || "",
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
  return shortText(kind || event?.message || "Orchestrator decision", 90);
}

function decisionSummary(event) {
  const details = safeObject(event?.details);
  const parts = [];
  const reason =
    details.reasoning ||
    details.reason ||
    details.summary ||
    details.note ||
    details.explanation ||
    "";
  const next =
    details.next_action ||
    details.next_step ||
    details.next_actor ||
    details.next_agent ||
    details.selected_agent ||
    details.route_to ||
    "";
  const observed = details.observed_change || details.observation || "";
  const message = event?.message || "";

  if (message) parts.push(shortText(message, 220));
  if (next) parts.push(`Next: ${shortText(next, 140)}`);
  if (reason) parts.push(`Why: ${shortText(reason, 180)}`);
  if (observed) parts.push(`Observed: ${shortText(observed, 140)}`);
  return shortText(parts.join(" / "), 500);
}

function isDecisionEvent(event) {
  if (!event) return false;
  const kind = String(event.kind || "").toLowerCase();
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

export function buildAutoDecisionSync(events = []) {
  return normalizeTraceEvents(events)
    .filter((event) => isDecisionEvent(event))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((event, index) => {
      const details = safeObject(event.details);
      const seq = Number(event.seq || 0);
      const keySeed = seq > 0 ? `seq-${seq}` : `${event.timestamp || "na"}-${event.kind || "event"}-${event.actor || "unknown"}-${index}`;
      return {
        auto_key: `decision:${keySeed}`,
        title: decisionTitle(event),
        summary: decisionSummary(event),
        actor: String(event.actor || ""),
        category: decisionCategory(event),
        status: statusFromDecisionKind(event.kind, event.status),
        details: {
          kind: event.kind || "",
          event_status: event.status || "",
          event_seq: seq || null,
          event_timestamp: event.timestamp || "",
          source_event: details,
        },
      };
    });
}

function maybeHttp(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  if (!/^https?:\/\//i.test(text)) return "";
  return text;
}

function collectProviderLikeUrls(value, out) {
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
  for (const [key, nested] of Object.entries(value)) {
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

export function collectRunProviderUrls({ runUrl = "", snapshot = {}, events = [] } = {}) {
  const seen = new Set();
  collectProviderLikeUrls(snapshot, seen);
  for (const event of normalizeTraceEvents(events)) {
    collectProviderLikeUrls(event.details, seen);
  }
  return Array.from(seen).slice(0, 40);
}
