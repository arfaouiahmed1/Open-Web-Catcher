import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { EventFeedItem } from "./EventFeedItem";
import type { FeedEvent } from "./types";

const EVENT: FeedEvent = {
  id: "e1",
  kind: "plan_step_update",
  message: "step 'probe' -> in_progress",
  level: "warn",
  timestamp: "2026-08-26T09:13:24Z",
};

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("EventFeedItem", () => {
  it("renders event kind, message, level, and timestamp", () => {
    const markup = html(<EventFeedItem event={EVENT} />);
    expect(markup).toContain('data-state="success"');
    expect(markup).toContain('data-event-id="e1"');
    expect(markup).toContain('data-kind="plan_step_update"');
    expect(markup).toContain('data-level="warn"');
    expect(markup).toContain("step &#x27;probe&#x27; -&gt; in_progress");
    expect(markup).toContain('dateTime="2026-08-26T09:13:24Z"');
  });

  it("defaults level to info", () => {
    const markup = html(
      <EventFeedItem event={{ id: "e2", kind: "run_started", message: "go" }} />,
    );
    expect(markup).toContain('data-level="info"');
  });

  it("supports loading / error / empty states", () => {
    expect(html(<EventFeedItem state="loading" />)).toContain(
      'data-state="loading"',
    );
    expect(html(<EventFeedItem state="error" />)).toContain(
      'data-state="error"',
    );
    // No event prop at all derives the empty state.
    expect(html(<EventFeedItem />)).toContain('data-state="empty"');
    expect(html(<EventFeedItem emptyLabel="No events yet." />)).toContain(
      "No events yet.",
    );
  });
});
