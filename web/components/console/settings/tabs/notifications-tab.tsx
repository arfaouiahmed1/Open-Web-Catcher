"use client";

import * as React from "react";
import { Switch } from "@/components/ui/switch";
import type { NotificationKind, NotificationPrefs } from "@/components/notification-provider";

export interface NotificationEvent {
  key: NotificationKind;
  label: string;
  note: string;
}

export const NOTIFICATION_EVENTS: NotificationEvent[] = [
  { key: "pipeline_started", label: "Pipeline started", note: "Fired when a new pipeline begins" },
  { key: "agent_started", label: "Agent transitions (started)", note: "Each agent activation" },
  { key: "agent_finished", label: "Agent transitions (finished)", note: "Each agent completion" },
  { key: "agent_failed", label: "Agent failures", note: "When an agent errors out" },
  { key: "pipeline_finished", label: "Pipeline completed", note: "Successful pipeline end" },
  { key: "pipeline_failed", label: "Pipeline failed", note: "Fatal pipeline failure" },
  { key: "run_cancelled", label: "Run cancelled", note: "User or system cancellation" },
];

export function NotificationsTab({
  prefs,
  onChange,
}: {
  prefs: NotificationPrefs;
  onChange: (next: NotificationPrefs) => void;
}): React.JSX.Element {
  return (
    <section className="space-y-4 animate-fade-up">
      <div>
        <h2 className="text-base font-semibold text-foreground">Notification Preferences</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose which pipeline events trigger toast notifications. Tool call events are never notified.
        </p>
      </div>
      <div className="space-y-2">
        {NOTIFICATION_EVENTS.map((event) => (
          <label
            key={event.key}
            className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-border/60 bg-card px-3.5 py-3 transition-colors hover:bg-muted/20"
          >
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-foreground">{event.label}</span>
              <span className="mt-0.5 block text-[12px] text-muted-foreground">{event.note}</span>
            </span>
            <Switch
              checked={Boolean(prefs[event.key])}
              onCheckedChange={(v) => onChange({ ...prefs, [event.key]: v })}
              aria-label={event.label}
              className="mt-0.5 shrink-0"
            />
          </label>
        ))}
      </div>
    </section>
  );
}
