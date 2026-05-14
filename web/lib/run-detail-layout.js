export function buildRunDetailTabState({
  decisionCount = 0,
  outputCount = 0,
  toolCallCount = 0,
  eventCount = 0,
  screenshotCount = 0,
  runState = null,
} = {}) {
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
        tone:
          toolCallCount > 0
            ? "signal"
            : "default",
      },
      {
        value: "events",
        label: "Events",
        count: eventCount,
        tone:
          runState?.failure
            ? "danger"
            : runState?.status === "completed"
              ? "success"
              : runState?.status === "cancelled"
                ? "warning"
                : "default",
      },
      {
        value: "decisions",
        label: "Decisions",
        count: decisionCount,
        tone: "signal",
      },
      {
        value: "screenshots",
        label: "Screenshots",
        count: screenshotCount,
        tone: screenshotCount > 0 ? "signal" : "default",
      },
    ],
  };
}
