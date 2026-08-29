import React from "react";
import Link from "next/link";

/**
 * T37 dev-only story hub. `_dev` is an app-router private folder, so these
 * pages are never routed in production; they exist to exercise every library
 * component with static fixtures and to be covered by `tsc --noEmit`.
 */

const STORIES: Array<{ slug: string; name: string }> = [
  { slug: "reasoning-trace", name: "ReasoningTrace" },
  { slug: "step-timeline", name: "StepTimeline" },
  { slug: "status-badge", name: "StatusBadge" },
  { slug: "metric-card", name: "MetricCard" },
  { slug: "event-feed-item", name: "EventFeedItem" },
  { slug: "screenshot-card", name: "ScreenshotCard" },
  { slug: "cost-meter", name: "CostMeter" },
  { slug: "validation-badge", name: "ValidationBadge" },
  { slug: "log-viewer", name: "LogViewer" },
];

export default function DevIndexPage() {
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-semibold">Component library stories</h1>
      <p className="text-sm text-muted-foreground">
        Dev-only render matrix for web/components/library (plan task 37).
      </p>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {STORIES.map((story) => (
          <li key={story.slug}>
            {/* Private folders are unrouted; kept for local navigation aid. */}
            <span className="block rounded-md border border-border bg-muted/40 px-3 py-2 text-sm font-medium">
              {story.name}
            </span>
          </li>
        ))}
      </ul>
      <Link href="/" className="text-xs text-muted-foreground underline">
        back to console
      </Link>
    </main>
  );
}
