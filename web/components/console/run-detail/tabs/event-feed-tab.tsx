"use client";

import React, { useMemo } from "react";
import { EventFeedItem } from "@/components/library/EventFeedItem";
import { ScreenshotCard } from "@/components/library/ScreenshotCard";
import type { FeedEvent } from "@/components/library/types";
import { collectScreenshotUrls } from "@/lib/run-trace";

export interface RunEventFeedTabProps {
  events?: Array<Record<string, unknown>>;
  title?: string;
  maxItems?: number;
}

function eventLevel(event: Record<string, unknown>): FeedEvent["level"] {
  const status = String((event as { status?: string })?.status || "").toLowerCase();
  const kind = String((event as { kind?: string })?.kind || "");
  if (status === "error" || status === "failed" || kind.includes("failed") || kind === "player_failed") return "error";
  if (status === "warning" || kind.includes("warning")) return "warn";
  if (kind === "llm_response" || kind.includes("debug")) return "debug";
  return "info";
}

function toFeedEvent(raw: Record<string, unknown>, index: number): FeedEvent {
  const seq = (raw as { seq?: number })?.seq;
  const kind = String((raw as { kind?: string })?.kind || "unknown");
  const timestamp = String((raw as { timestamp?: string })?.timestamp || (raw as { created_at?: string })?.created_at || "");
  const details = ((raw as { details?: Record<string, unknown> })?.details || (raw as { details_json?: Record<string, unknown> })?.details_json || {}) as Record<string, unknown>;
  const message =
    String((raw as { message?: string })?.message || "") ||
    String(details.error_preview || details.error || details.reason || details.url || details.stream_url || "") ||
    `${kind}${(raw as { actor?: string })?.actor ? ` (${(raw as { actor?: string })?.actor})` : ""}`;
  const level = eventLevel(raw as Record<string, unknown>);
  return {
    id: String(seq != null ? seq : `ev-${index}`),
    kind,
    message: message.slice(0, 280),
    level,
    timestamp: timestamp || undefined,
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

export function RunEventFeedTab({ events, title = "Event feed", maxItems = 120 }: RunEventFeedTabProps) {
  const list = useMemo(() => (Array.isArray(events) ? events : []), [events]);
  const visible = useMemo(() => (maxItems && list.length > maxItems ? list.slice(-maxItems) : list), [list, maxItems]);
  const hasEvents = visible.length > 0;
  const omitted = list.length - visible.length;

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card" data-testid="run-event-feed-tab">
      <div className="border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          SSE-live feed via useRunStream — no polling. Typed kinds (server_activated, stream_extracted, hosting_page_discovered, player_failed) show inline.
        </p>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground" data-role="feed-meta">
          <span data-role="feed-count">{list.length} events</span>
          {omitted > 0 ? <span data-role="feed-omitted">+{omitted} earlier hidden</span> : null}
        </div>
      </div>
      <div className="space-y-2 p-0">
        {!hasEvents ? (
          <div className="p-4">
            <EventFeedItem emptyLabel="No events yet — waiting for SSE." />
          </div>
        ) : (
          <div className="divide-y divide-border/50" data-role="feed-list">
            {visible.map((raw, idx) => {
              const feed = toFeedEvent(raw as Record<string, unknown>, idx);
              const screenshots = extractScreenshotSources(raw as Record<string, unknown>);
              const isTypedKind = ["server_activated", "stream_extracted", "hosting_page_discovered", "player_failed", "queue_enqueued", "hosting_item_started", "hosting_item_finished", "pool_drained", "plan_step_update", "cost_threshold_exceeded"].includes(feed.kind);
              return (
                <div
                  key={feed.id + "-" + idx}
                  data-event-id={feed.id}
                  data-kind={feed.kind}
                  data-typed={isTypedKind ? "true" : "false"}
                  className="space-y-2 p-2"
                >
                  <EventFeedItem event={feed} />
                  {screenshots.length > 0 ? (
                    <div className="grid gap-2 pl-2 sm:grid-cols-2" data-role="inline-screenshots">
                      {screenshots.slice(0, 2).map((src, sIdx) => (
                        <ScreenshotCard
                          key={`${feed.id}-shot-${sIdx}`}
                          src={src}
                          alt={`${feed.kind} screenshot ${sIdx + 1}`}
                          caption={`${feed.kind} · ${String((raw as { actor?: string })?.actor || "").slice(0, 32)} · seq ${feed.id}`}
                        />
                      ))}
                    </div>
                  ) : null}
                  {/* Typed-kind inline badge for visual verification even without screenshot */}
                  {isTypedKind && screenshots.length === 0 ? (
                    <div className="pl-2" data-role="typed-badge">
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide" style={{ borderColor: "var(--line)", color: "var(--muted-foreground)" }}>
                        typed: {feed.kind}
                      </span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
