"use client";

import { Settings2, X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingNumber, SettingToggle } from "@/components/run-view-settings/controls";
import type { RunViewSettings } from "@/components/run-view-settings";

export interface RunViewSettingsPanelProps {
  settings: RunViewSettings;
  update: (key: keyof RunViewSettings, value: unknown) => void;
  reset: () => void;
  onClose?: () => void;
}

export const RunViewSettingsPanel = React.memo(function RunViewSettingsPanel({
  settings,
  update,
  reset,
  onClose,
}: RunViewSettingsPanelProps): React.JSX.Element {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border p-4">
        <div className="flex items-center gap-2">
          <Settings2 className="text-primary" />
          <CardTitle className="text-[13px]">Run View Settings</CardTitle>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={reset} variant="outline" size="sm">
            Reset
          </Button>
          {onClose ? (
            <Button type="button" onClick={onClose} variant="ghost" size="icon-sm" aria-label="Close settings">
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="divide-y divide-border px-4 py-0">
        <div className="py-2">
          <div className="pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Panels</div>
          <SettingToggle label="Browser Live View" description="Show the live screenshot of what the browser is doing" value={settings.showLiveView} onChange={(v) => update("showLiveView", v)} />
          <SettingToggle label="Screenshot Gallery" description="Show captured screenshots from the run" value={settings.showScreenshots} onChange={(v) => update("showScreenshots", v)} />
          <SettingToggle label="Agent Execution Graph" description="Show the agent topology map on run detail" value={settings.showGraph} onChange={(v) => update("showGraph", v)} />
          <SettingToggle label="Agent Plan Board" description="Show the per-agent plan checklist" value={settings.showPlanBoard} onChange={(v) => update("showPlanBoard", v)} />
          <SettingToggle label="Context Window Monitor" description="Show token context pressure on run detail" value={settings.showContextMonitor} onChange={(v) => update("showContextMonitor", v)} />
          <SettingToggle label="Event Stream" description="Show the live event feed panel" value={settings.showEventStream} onChange={(v) => update("showEventStream", v)} />
        </div>

        <div className="py-2">
          <div className="pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Display</div>
          <SettingToggle label="Show Timestamps" description="Show event timestamps in the event stream" value={settings.showTimestamps} onChange={(v) => update("showTimestamps", v)} />
          <SettingToggle label="Show Tool Arguments" description="Show tool call input arguments in the tool feed" value={settings.showToolArgs} onChange={(v) => update("showToolArgs", v)} />
          <SettingToggle label="Compact Events" description="Reduce event row height for higher information density" value={settings.compactEvents} onChange={(v) => update("compactEvents", v)} />
          <SettingToggle label="Graph Node Labels" description="Show labels on orchestrator graph nodes" value={settings.showGraphLabels} onChange={(v) => update("showGraphLabels", v)} />
          <SettingToggle label="Cost Estimate" description="Show token usage and cost estimate in the run header" value={settings.showCostEstimate} onChange={(v) => update("showCostEstimate", v)} />
          <SettingToggle label="Highlight Errors" description="Visually emphasize failed events and errors in the stream" value={settings.highlightErrors} onChange={(v) => update("highlightErrors", v)} />
        </div>

        <div className="py-2">
          <div className="pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Behavior</div>
          <SettingToggle label="Auto-scroll Events" description="Automatically scroll the event stream to the latest event" value={settings.autoScroll} onChange={(v) => update("autoScroll", v)} />
          <SettingToggle label="Expand Tables" description="Show all rows in data tables without pagination" value={settings.expandTables} onChange={(v) => update("expandTables", v)} />
        </div>

        <div className="py-2">
          <div className="pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Performance</div>
          <SettingNumber label="Screenshot refresh" description="How often to poll for new browser screenshots" value={settings.liveRefreshMs} onChange={(v) => update("liveRefreshMs", Math.max(500, v))} min={500} max={10000} step={500} unit="ms" />
          <SettingNumber label="Max events shown" description="Limit the number of events shown in the stream" value={settings.eventLimit} onChange={(v) => update("eventLimit", Math.max(20, v))} min={20} max={500} step={10} unit="events" />
        </div>
      </CardContent>
    </Card>
  );
});
