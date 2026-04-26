"use client";

import { useCallback, useEffect, useState } from "react";
import { Settings2, X } from "lucide-react";

const STORAGE_KEY = "owc_run_view_settings";

const DEFAULTS = {
  autoScroll:      true,
  showLiveView:    true,
  showScreenshots: true,
  expandTables:    false,
  showEventStream: true,
  showJsonViewers: true,
  liveRefreshMs:   2500,
  eventLimit:      120,
};

export function useRunViewSettings() {
  const [settings, setSettings] = useState(DEFAULTS);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      setSettings({ ...DEFAULTS, ...stored });
    } catch { /* ignore */ }
  }, []);

  const update = useCallback((key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setSettings(DEFAULTS);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  return { settings, update, reset };
}

/* ── Toggle row ─────────────────────────────────────────────────────────── */
function SettingToggle({ label, description, value, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium" style={{ color: "var(--ink)" }}>{label}</div>
        {description && (
          <div className="mt-0.5 text-[11px] leading-snug" style={{ color: "var(--mute)" }}>
            {description}
          </div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className="relative shrink-0 rounded-full transition-all"
        style={{
          width: 36,
          height: 20,
          background: value
            ? "color-mix(in oklch, var(--signal) 80%, transparent)"
            : "color-mix(in oklch, var(--mute-3) 60%, transparent)",
          border: `1px solid ${value ? "color-mix(in oklch, var(--signal) 50%, transparent)" : "var(--line)"}`,
          boxShadow: value ? "0 0 8px color-mix(in oklch, var(--signal) 30%, transparent)" : "none",
        }}
      >
        <span
          className="absolute rounded-full transition-all"
          style={{
            width: 14,
            height: 14,
            top: 2,
            left: value ? 18 : 2,
            background: value ? "white" : "var(--mute-2)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          }}
        />
      </button>
    </div>
  );
}

/* ── Number input row ────────────────────────────────────────────────────── */
function SettingNumber({ label, description, value, onChange, min, max, step, unit }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium" style={{ color: "var(--ink)" }}>{label}</div>
        {description && (
          <div className="mt-0.5 text-[11px]" style={{ color: "var(--mute)" }}>{description}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step || 1}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-16 rounded-md border px-2 py-1 text-right font-mono text-[12px] focus:outline-none focus:ring-1"
          style={{
            borderColor: "var(--line)",
            background: "rgba(0,0,0,0.2)",
            color: "var(--ink-dim)",
          }}
        />
        {unit && (
          <span className="text-[10.5px]" style={{ color: "var(--mute-3)" }}>{unit}</span>
        )}
      </div>
    </div>
  );
}

/* ── Settings panel ─────────────────────────────────────────────────────── */
export function RunViewSettingsPanel({ settings, update, reset, onClose }) {
  return (
    <div
      className="overflow-hidden rounded-[14px] border"
      style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
    >
      {/* header */}
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: "var(--line)" }}
      >
        <div className="flex items-center gap-2">
          <Settings2 className="h-3.5 w-3.5" style={{ color: "var(--signal)" }} />
          <span className="text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
            Run View Settings
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded border px-2 py-0.5 text-[10.5px] transition-colors"
            style={{ borderColor: "var(--line)", color: "var(--mute)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--mute)")}
          >
            Reset
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 transition-colors"
              style={{ color: "var(--mute-2)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--mute-2)")}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* settings list */}
      <div className="divide-y px-4" style={{ divideColor: "var(--line)" }}>
        {/* View panels section */}
        <div className="py-2">
          <div className="pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--mute-3)" }}>
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
          <SettingToggle
            label="JSON Viewers"
            description="Show snapshot and raw payload JSON viewers"
            value={settings.showJsonViewers}
            onChange={(v) => update("showJsonViewers", v)}
          />
        </div>

        {/* Behavior section */}
        <div className="py-2">
          <div className="pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--mute-3)" }}>
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

        {/* Performance section */}
        <div className="py-2">
          <div className="pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--mute-3)" }}>
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
      </div>
    </div>
  );
}

/* ── Settings gear button with flyout ───────────────────────────────────── */
export function RunViewSettingsButton({ settings, update, reset }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="View settings"
        className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] transition-all"
        style={{
          borderColor: open ? "color-mix(in oklch, var(--signal) 35%, transparent)" : "var(--line)",
          background: open ? "color-mix(in oklch, var(--signal) 10%, transparent)" : "transparent",
          color: open ? "var(--signal)" : "var(--mute)",
        }}
      >
        <Settings2 className="h-3.5 w-3.5" />
        <span>View</span>
      </button>

      {open && (
        <>
          {/* backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          {/* flyout */}
          <div className="absolute right-0 top-full z-50 mt-2 w-80">
            <RunViewSettingsPanel
              settings={settings}
              update={update}
              reset={reset}
              onClose={() => setOpen(false)}
            />
          </div>
        </>
      )}
    </div>
  );
}
