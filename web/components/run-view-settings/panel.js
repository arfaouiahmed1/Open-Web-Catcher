"use client";

import { Settings2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingNumber, SettingToggle } from "@/components/run-view-settings/controls";

export function RunViewSettingsPanel({ settings, update, reset, onClose }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border p-4 space-y-0">
        <div className="flex items-center gap-2">
          <Settings2 className="h-3.5 w-3.5 text-primary" />
          <CardTitle className="text-[13px]">Run View Settings</CardTitle>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={reset} variant="outline" size="sm">
            Reset
          </Button>
          {onClose && (
            <Button
              type="button"
              onClick={onClose}
              variant="ghost"
              size="icon-sm"
              aria-label="Close settings"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="divide-y divide-border px-4 py-0">
        <div className="py-2">
          <div className="pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-3)]">
            View Panels
          </div>
          <SettingToggle
            label="Browser Live View"
            description="Show the live screenshot of what the browser is doing"
            value={settings.showLiveView}
            onChange={(v) => update("showLiveView", v)}
          />
          <SettingToggle
            label="Screenshot Gallery"
            description="Show captured screenshots from the run"
            value={settings.showScreenshots}
            onChange={(v) => update("showScreenshots", v)}
          />
          <SettingToggle
            label="Event Stream"
            description="Show the live event feed panel"
            value={settings.showEventStream}
            onChange={(v) => update("showEventStream", v)}
          />
        </div>

        <div className="py-2">
          <div className="pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-3)]">
            Behavior
          </div>
          <SettingToggle
            label="Auto-scroll Events"
            description="Automatically scroll the event stream to the latest event"
            value={settings.autoScroll}
            onChange={(v) => update("autoScroll", v)}
          />
          <SettingToggle
            label="Expand Tables"
            description="Show all rows in data tables without pagination"
            value={settings.expandTables}
            onChange={(v) => update("expandTables", v)}
          />
        </div>

        <div className="py-2">
          <div className="pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-3)]">
            Performance
          </div>
          <SettingNumber
            label="Screenshot refresh"
            description="How often to poll for new browser screenshots"
            value={settings.liveRefreshMs}
            onChange={(v) => update("liveRefreshMs", Math.max(500, v))}
            min={500}
            max={10000}
            step={500}
            unit="ms"
          />
          <SettingNumber
            label="Max events shown"
            description="Limit the number of events shown in the stream"
            value={settings.eventLimit}
            onChange={(v) => update("eventLimit", Math.max(20, v))}
            min={20}
            max={500}
            step={10}
            unit="events"
          />
        </div>
      </CardContent>
    </Card>
  );
}
