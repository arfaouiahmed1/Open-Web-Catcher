export interface TabEntry {
  value: string;
  label: string;
  count: number;
  tone: string;
}

export interface RunStateLike {
  failure?: unknown;
  status?: string;
}

export interface BuildRunDetailTabStateArgs {
  decisionCount?: number;
  outputCount?: number;
  toolCallCount?: number;
  eventCount?: number;
  runState?: RunStateLike | null;
}

export function buildRunDetailTabState({
  decisionCount = 0,
  outputCount = 0,
  toolCallCount = 0,
  eventCount = 0,
  runState = null,
}: BuildRunDetailTabStateArgs = {}): { primaryTabs: TabEntry[] } {
  return {
    primaryTabs: [
      { value: "summary", label: "Summary", count: 0, tone: "default" },
      {
        value: "output",
        label: "Outputs",
        count: outputCount,
        tone: outputCount > 0 ? "signal" : "default",
      },
      {
        value: "tools",
        label: "Tool calls",
        count: toolCallCount,
        tone: toolCallCount > 0 ? "signal" : "default",
      },
      {
        value: "events",
        label: "Events",
        count: eventCount,
        tone: runState?.failure
          ? "danger"
          : runState?.status === "completed"
            ? "success"
            : runState?.status === "cancelled"
              ? "warning"
              : "default",
      },
      {
        value: "traces",
        label: "Traces",
        count: decisionCount,
        tone: "signal",
      },
    ],
  };
}
