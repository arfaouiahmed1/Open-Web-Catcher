"use client";

import { useCallback, useEffect, useState } from "react";

export { RunViewSettingsPanel } from "@/components/run-view-settings/panel";
export { RunViewSettingsButton } from "@/components/run-view-settings/button";

const STORAGE_KEY = "owc_run_view_settings";

export interface RunViewSettings {
  autoScroll: boolean;
  showLiveView: boolean;
  showScreenshots: boolean;
  expandTables: boolean;
  showEventStream: boolean;
  liveRefreshMs: number;
  eventLimit: number;
  showTimestamps: boolean;
  showToolArgs: boolean;
  compactEvents: boolean;
  showGraphLabels: boolean;
  showCostEstimate: boolean;
  highlightErrors: boolean;
}

export const DEFAULT_RUN_VIEW_SETTINGS: RunViewSettings = {
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

type SettingsUpdate = <K extends keyof RunViewSettings>(key: K, value: RunViewSettings[K]) => void;

export function useRunViewSettings(): { settings: RunViewSettings; update: SettingsUpdate; reset: () => void } {
  const [settings, setSettings] = useState<RunViewSettings>(DEFAULT_RUN_VIEW_SETTINGS);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Partial<RunViewSettings>;
      setSettings({ ...DEFAULT_RUN_VIEW_SETTINGS, ...stored });
    } catch {
      /* ignore */
    }
  }, []);

  const update = useCallback<SettingsUpdate>((key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value } as RunViewSettings;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setSettings(DEFAULT_RUN_VIEW_SETTINGS);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return { settings, update, reset };
}
