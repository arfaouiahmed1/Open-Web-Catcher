"use client";

import React, { memo, useMemo } from "react";
import { Activity, Radio } from "lucide-react";
import { EventFeedItem } from "@/components/library/EventFeedItem";
import { ScreenshotCard } from "@/components/library/ScreenshotCard";
import type { FeedEvent } from "@/components/library/types";
import { VirtualizedList } from "@/components/library/VirtualizedList";
import { SectionPanel } from "@/components/console/common/section-panel";
import { Badge } from "@/components/ui/badge";
import { collectScreenshotUrls } from "@/lib/run-trace";

export interface RunEventFeedTabProps {
  events?: Array<Record<string, unknown>>;
  title?: string;
  maxItems?: number;
  /** Compact row density from display settings. */
  compact?: boolean;
  /** Hide per-event timestamps when display settings disable them. */
  showTimestamps?: boolean;
  /** Emphasize failed events when display settings enable it. */
  highlightErrors?: boolean;
}

function eventLevel(event: Record<string, unknown>): FeedEvent["level"] {
  const status = String(event.status || "").toLowerCase();
  const kind = String(event.kind || "");
  if (status === "error" || status === "failed" || kind.includes("failed") || kind === "player_failed") return "error";
  if (status === "warning" || kind.includes("warning")) return "warn";
  if (kind === "llm_response" || kind.includes("debug")) return "debug";
  return "info";
}

function toFeedEvent(raw: Record<string, unknown>, index: number, showTimestamps = true): FeedEvent {
  const seq = typeof raw.seq === "number" ? raw.seq : undefined;
  const kind = String(raw.kind || "unknown");
  const timestamp = String(raw.timestamp || raw.created_at || "");
  const details = (raw.details || raw.details_json || {}) as Record<string, unknown>;
  const actor = String(raw.actor || "");
  const message =
    String(raw.message || "") ||
    String(details.error_preview || details.error || details.reason || details.url || details.stream_url || "") ||
    `${kind}${actor ? ` (${actor})` : ""}`;
  const level = eventLevel(raw);
  return {
    id: String(seq != null ? seq : `ev-${index}`),
    kind,
    message: message.slice(0, 280),
    level,
    timestamp: showTimestamps ? timestamp || undefined : undefined,
  };
}

function extractScreenshotSources(raw: Record<string, unknown>): string[] {
  const set = new Set<string>();
  const details = (raw as { details?: unknown })?.details ?? (raw as { details_json?: unknown })?.details_json ?? raw;
  collectScreenshotUrls(details as unknown, set);
  // Also check top-level screenshot_url fields
  const top = raw as { screenshot_url?: string; screenshot?: string };
  if (top.screenshot_url) collectScreenshotUrls(top.screenshot_url, set);
  if (top.screenshot) collectScreenshotUrls(top.screenshot, set);
  // Typed notification events carry annotated screenshot refs in details
  const d = (raw as { details?: Record<string, unknown> })?.details as Record<string, unknown> | undefined;
  if (d?.screenshot_url) collectScreenshotUrls(d.screenshot_url as unknown, set);
  if (Array.isArray(d?.screenshot_urls)) collectScreenshotUrls(d.screenshot_urls as unknown, set);
  // Blobref pointers are valid screenshot sources even though collectScreenshotUrls
  // filters by URL shape; ScreenshotCard resolves them via apiUrl('/blobs/<key>')
  function captureBlobref(value: unknown) {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (/^blobref:/i.test(trimmed)) set.add(trimmed);
  }
  captureBlobref((d as Record<string, unknown> | undefined)?.screenshot_url);
  captureBlobref((top as Record<string, unknown> | undefined)?.screenshot_url);
  captureBlobref((top as Record<string, unknown> | undefined)?.screenshot);
  if (Array.isArray((d as Record<string, unknown> | undefined)?.screenshot_urls)) {
    for (const v of (d as { screenshot_urls: unknown[] }).screenshot_urls) captureBlobref(v);
  }
  // Raw details may directly be a blobref string
  captureBlobref(details);
  // Scan details object for any blobref values
  if (details && typeof details === "object") {
    for (const val of Object.values(details as Record<string, unknown>)) captureBlobref(val);
  }
  if (d && typeof d === "object") {
    for (const val of Object.values(d)) captureBlobref(val);
  }
  return Array.from(set);
}

const EventRow = memo(function EventRow({
  raw,
  feed,
  screenshots,
  isTypedKind,
  compact = false,
  highlightErrors = true,
}: {
  raw: Record<string, unknown>;
  feed: FeedEvent;
  screenshots: string[];
  isTypedKind: boolean;
  compact?: boolean;
  highlightErrors?: boolean;
}) {
  const actor = String(raw.actor || "");
  return (
    <div
      data-event-id={feed.id}
      data-kind={feed.kind}
      data-typed={isTypedKind ? "true" : "false"}
      data-compact={compact ? "true" : "false"}
      data-error-emphasis={highlightErrors && feed.level === "error" ? "true" : "false"}
      className={compact ? "space-y-1 p-1" : "space-y-2 p-2"}
      style={{ containIntrinsicSize: "0 120px", contentVisibility: "auto" } as React.CSSProperties}
    >
      <EventFeedItem event={feed} />
      {screenshots.length > 0 ? (
        <div className="grid gap-2 pl-2 sm:grid-cols-2" data-role="inline-screenshots">
          {screenshots.slice(0, 2).map((src, sIdx) => (
            <ScreenshotCard
              key={`${feed.id}-shot-${sIdx}`}
              src={src}
              alt={`${feed.kind} screenshot ${sIdx + 1}`}
              caption={`${feed.kind} · ${actor.slice(0, 32)} · seq ${feed.id}`}
            />
          ))}
        </div>
      ) : null}
      {isTypedKind && screenshots.length === 0 ? (
        <div className="pl-2" data-role="typed-badge">
          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide" style={{ borderColor: "var(--line)", color: "var(--muted-foreground)" }}>
            typed: {feed.kind}
          </span>
        </div>
      ) : null}
    </div>
  );
});

export function RunEventFeedTab({ events, title = "Event feed", maxItems = 120, compact = false, showTimestamps = true, highlightErrors = true }: RunEventFeedTabProps) {
  const list = useMemo(() => (Array.isArray(events) ? events : []), [events]);
  const visible = useMemo(() => (maxItems && list.length > maxItems ? list.slice(-maxItems) : list), [list, maxItems]);
  const hasEvents = visible.length > 0;
  const omitted = list.length - visible.length;
  const enriched = useMemo(
    () =>
      visible.map((raw, idx) => {
        const feed = toFeedEvent(raw, idx, showTimestamps);
        const screenshots = extractScreenshotSources(raw);
        const isTypedKind = ["server_activated", "stream_extracted", "hosting_page_discovered", "player_failed", "queue_enqueued", "hosting_item_started", "hosting_item_finished", "pool_drained", "plan_step_update", "cost_threshold_exceeded"].includes(feed.kind);
        return { raw, feed, screenshots, isTypedKind, key: `${feed.id}-${idx}` };
      }),
    [visible, showTimestamps]
  );

  return (
    <SectionPanel
      title={title}
      description="SSE-live feed via useRunStream — no polling. Typed kinds show inline with VirtualizedList."
      icon={<Activity className="h-3.5 w-3.5" />}
      actions={
        <div className="flex items-center gap-2">
          <Badge tone={hasEvents ? "success" : "muted"} className="text-[10px] gap-1">
            <Radio className="h-3 w-3 animate-pulse" />
            <span data-role="feed-count">{list.length} events</span>
          </Badge>
          {omitted > 0 ? <span className="text-[11px] text-muted-foreground" data-role="feed-omitted">+{omitted} earlier hidden</span> : null}
        </div>
      }
      className="animate-fade-up"
      data-testid="run-event-feed-tab"
    >
      {!hasEvents ? (
        <div className="py-2">
          <EventFeedItem emptyLabel="No events yet — waiting for SSE." />
        </div>
      ) : (
        <div className="divide-y divide-border/50 -mx-1" data-role="feed-list" data-compact={compact ? "true" : "false"} data-highlight-errors={highlightErrors ? "true" : "false"}>
          {enriched.length > 80 ? (
            <VirtualizedList
              items={enriched}
              height={Math.min(600, enriched.length * 96)}
              itemSize={compact ? 84 : 128}
              overscanCount={8}
              renderItem={(item) => <EventRow raw={item.raw} feed={item.feed} screenshots={item.screenshots} isTypedKind={item.isTypedKind} compact={compact} highlightErrors={highlightErrors} />}
            />
          ) : (
            enriched.map((item) => <EventRow key={item.key} raw={item.raw} feed={item.feed} screenshots={item.screenshots} isTypedKind={item.isTypedKind} compact={compact} highlightErrors={highlightErrors} />)
          )}
        </div>
      )}
    </SectionPanel>
  );
}
