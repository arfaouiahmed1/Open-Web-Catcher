"use client";

import { useCallback, useEffect, useState } from "react";

export { RunViewSettingsPanel } from "@/components/run-view-settings/panel";
export { RunViewSettingsButton } from "@/components/run-view-settings/button";

const STORAGE_KEY = "owc_run_view_settings";

const DEFAULTS = {
  autoScroll: true,
  showLiveView: true,
  showScreenshots: true,
  expandTables: false,
  showEventStream: true,
  liveRefreshMs: 2500,
  eventLimit: 120,
  showTimestamps: true,
  showToolArgs: true,
  compactEvents: false,
  showGraphLabels: true,
  showCostEstimate: true,
  highlightErrors: true,
};

export function useRunViewSettings() {
  const [settings, setSettings] = useState(DEFAULTS);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      setSettings({ ...DEFAULTS, ...stored });
    } catch {
      /* ignore */
    }
  }, []);

  const update = useCallback((key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setSettings(DEFAULTS);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return { settings, update, reset };
}
