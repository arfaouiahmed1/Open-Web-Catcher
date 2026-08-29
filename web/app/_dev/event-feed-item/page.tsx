"use client";

import React from "react";
import { EventFeedItem } from "@/components/library";
import type { FeedEvent } from "@/components/library";

const EVENTS: FeedEvent[] = [
  {
    id: "e1",
    kind: "run_started",
    message: "Run owc_01J… started for portal.example/stream",
    level: "info",
    timestamp: "2026-08-26T09:12:00Z",
  },
  {
    id: "e2",
    kind: "plan_step_update",
    message: "step 'probe_streams' -> in_progress",
    level: "debug",
    timestamp: "2026-08-26T09:13:24Z",
  },
  {
    id: "e3",
    kind: "validation_warning",
    message: "1 stream flagged as suspected hallucination",
    level: "warn",
    timestamp: "2026-08-26T09:14:02Z",
  },
  {
    id: "e4",
    kind: "run_failed",
    message: "Judge verdict fail: playback_confidence below threshold",
    level: "error",
    timestamp: "2026-08-26T09:15:47Z",
  },
];

export default function EventFeedItemStory() {
  return (
    <>
      <EventFeedItem state="loading" loadingLabel="Connecting to event stream…" />
      <EventFeedItem state="error" errorLabel="Event stream disconnected." />
      <EventFeedItem />
      <div className="divide-y divide-border rounded-lg border border-border">
        {EVENTS.map((event) => (
          <EventFeedItem key={event.id} event={event} />
        ))}
      </div>
    </>
  );
}
