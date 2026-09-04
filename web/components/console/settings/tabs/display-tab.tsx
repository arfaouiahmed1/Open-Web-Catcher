"use client";

import * as React from "react";
import { Monitor, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useRunViewSettings } from "@/components/run-view-settings";

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-border/60 bg-card px-3.5 py-3 transition-colors hover:bg-muted/20">
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-foreground">{label}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} className="mt-0.5 shrink-0" />
    </label>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card/95 p-4">
      <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

export function DisplayTab(): React.JSX.Element {
  const { settings, update, reset } = useRunViewSettings();

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
        <Monitor className="h-3.5 w-3.5" />
        Display preferences control the run detail layout in this browser only. Stored in{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">owc_run_view_settings</code> via
        localStorage — no server round-trip.
        <Button type="button" variant="outline" size="sm" onClick={reset} className="ml-auto gap-1.5">
          <RotateCcw className="h-3.5 w-3.5" /> Reset defaults
        </Button>
      </div>

      <Group title="Panels visibility">
        <ToggleRow
          label="Show browser live view"
          description="Live screenshot panel with current URL and tool activity overlay."
          checked={settings.showLiveView}
          onChange={(v) => update("showLiveView", v)}
        />
        <ToggleRow
          label="Show screenshot gallery"
          description="Captured frames grid beside the live view."
          checked={settings.showScreenshots}
          onChange={(v) => update("showScreenshots", v)}
        />
        <ToggleRow
          label="Show agent execution graph"
          description="Interactive topology map with active nodes and handoffs."
          checked={settings.showGraph}
          onChange={(v) => update("showGraph", v)}
        />
        <ToggleRow
          label="Show agent plan board"
          description="Per-agent step checklist on run detail."
          checked={settings.showPlanBoard}
          onChange={(v) => update("showPlanBoard", v)}
        />
        <ToggleRow
          label="Show context window monitor"
          description="Token pressure meter for the active run."
          checked={settings.showContextMonitor}
          onChange={(v) => update("showContextMonitor", v)}
        />
        <ToggleRow
          label="Show event stream feed"
          description="Real-time event log panel."
          checked={settings.showEventStream}
          onChange={(v) => update("showEventStream", v)}
        />
      </Group>

      <Group title="Telemetry & information density">
        <ToggleRow
          label="Compact event rows"
          description="Reduce row height for higher information density."
          checked={settings.compactEvents}
          onChange={(v) => update("compactEvents", v)}
        />
        <ToggleRow
          label="Show timestamps"
          description="Event timestamp visibility in feeds."
          checked={settings.showTimestamps}
          onChange={(v) => update("showTimestamps", v)}
        />
        <ToggleRow
          label="Show tool call input arguments"
          description="Tool argument JSON in event and inspector views."
          checked={settings.showToolArgs}
          onChange={(v) => update("showToolArgs", v)}
        />
        <ToggleRow
          label="Show header cost estimates"
          description="Token usage and cost estimate in the run header."
          checked={settings.showCostEstimate}
          onChange={(v) => update("showCostEstimate", v)}
        />
        <ToggleRow
          label="Highlight errors & blockers"
          description="High-contrast warning tones for failed events."
          checked={settings.highlightErrors}
          onChange={(v) => update("highlightErrors", v)}
        />
      </Group>

      <Group title="Performance & polling">
        <Slider
          label="Screenshot live refresh interval"
          value={settings.liveRefreshMs}
          onChange={(v) => update("liveRefreshMs", Math.min(10000, Math.max(500, Math.round(v))))}
          min={500}
          max={10000}
          step={500}
          unit="ms"
          description="How often the live view polls for new screenshots (500ms–10000ms)."
        />
        <Slider
          label="Max events shown in stream"
          value={settings.eventLimit}
          onChange={(v) => update("eventLimit", Math.min(500, Math.max(20, Math.round(v))))}
          min={20}
          max={500}
          step={10}
          unit="events"
          description="Cap the rendered event window (20–500)."
        />
        <ToggleRow
          label="Auto-scroll to latest event"
          description="Follow the stream as new events arrive."
          checked={settings.autoScroll}
          onChange={(v) => update("autoScroll", v)}
        />
      </Group>
    </div>
  );
}
