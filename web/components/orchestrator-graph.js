"use client";

import { CheckCircle2, Clock3, Loader2, XCircle } from "lucide-react";

import { buildStageView, STAGE_LABELS, STAGE_ORDER } from "@/lib/run-trace";

function statusTone(status) {
  if (status === "running")
    return {
      color: "var(--signal)",
      bg: "color-mix(in oklch, var(--signal) 12%, transparent)",
    };
  if (status === "done")
    return {
      color: "var(--mint)",
      bg: "color-mix(in oklch, var(--mint) 12%, transparent)",
    };
  if (status === "failed" || status === "cancelled")
    return {
      color: "var(--rose)",
      bg: "color-mix(in oklch, var(--rose) 12%, transparent)",
    };
  return { color: "var(--mute-2)", bg: "rgba(255,255,255,0.03)" };
}

function StatusIcon({ status }) {
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin" />;
  if (status === "done") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "failed" || status === "cancelled")
    return <XCircle className="h-4 w-4" />;
  return <Clock3 className="h-4 w-4" />;
}

function StageCard({ stage }) {
  const tone = statusTone(stage.status);
  const latestSeq = Math.max(
    ...stage.events.map((event) => Number(event?.seq || 0)),
    0,
  );

  const animClass =
    stage.status === "failed" || stage.status === "cancelled"
      ? stage.status === "cancelled"
        ? "stage-cancelled"
        : "stage-failed"
      : stage.status === "running"
        ? "stage-running"
        : "";

  return (
    <div
      className={`min-w-0 flex-1 rounded-[14px] border p-4 transition-all ${animClass}`}
      style={{
        borderColor: `color-mix(in oklch, ${tone.color} 30%, transparent)`,
        background: tone.bg,
      }}
    >
      <div className="flex items-center gap-2">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-[10px]"
          style={{ background: "rgba(0,0,0,0.14)", color: tone.color }}
        >
          <StatusIcon status={stage.status} />
        </div>
        <div className="min-w-0">
          <div
            className="text-[12px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: tone.color }}
          >
            {STAGE_LABELS[stage.stage]}
          </div>
          <div className="text-[11px]" style={{ color: "var(--mute-2)" }}>
            {stage.status || "idle"}
          </div>
        </div>
        <span
          className="ml-auto font-mono text-[10px]"
          style={{ color: "var(--mute-3)" }}
        >
          {latestSeq ? `#${latestSeq}` : "idle"}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <div
          className="rounded-[10px] px-2 py-2 text-center"
          style={{ background: "var(--card-hi, rgba(255,255,255,0.05))" }}
        >
          <div
            className="font-mono text-[13px]"
            style={{ color: "var(--ink)" }}
          >
            {stage.toolCalls.length}
          </div>
          <div
            className="text-[9px] uppercase tracking-[0.12em]"
            style={{ color: "var(--mute-3)" }}
          >
            Tools
          </div>
        </div>
        <div
          className="rounded-[10px] px-2 py-2 text-center"
          style={{ background: "var(--card-hi, rgba(255,255,255,0.05))" }}
        >
          <div
            className="font-mono text-[13px]"
            style={{ color: "var(--ink)" }}
          >
            {stage.llmCalls}
          </div>
          <div
            className="text-[9px] uppercase tracking-[0.12em]"
            style={{ color: "var(--mute-3)" }}
          >
            LLM
          </div>
        </div>
        <div
          className="rounded-[10px] px-2 py-2 text-center"
          style={{ background: "var(--card-hi, rgba(255,255,255,0.05))" }}
        >
          <div
            className="font-mono text-[13px]"
            style={{ color: "var(--ink)" }}
          >
            {stage.frames.length}
          </div>
          <div
            className="text-[9px] uppercase tracking-[0.12em]"
            style={{ color: "var(--mute-3)" }}
          >
            Frames
          </div>
        </div>
      </div>

      <div
        className="mt-4 flex items-center gap-2 truncate font-mono text-[10px]"
        style={{ color: "var(--mute-2)" }}
        title={stage.latestFrame?.toolName || stage.status || ""}
      >
        {stage.status === "running" && (
          <span className="relative flex h-[5px] w-[5px] shrink-0">
            <span
              className="absolute inset-0 rounded-full"
              style={{
                background: "var(--signal)",
                animation: "ping 1.4s ease-in-out infinite",
                opacity: 0.5,
              }}
            />
            <span
              className="relative h-[5px] w-[5px] rounded-full"
              style={{ background: "var(--signal)" }}
            />
          </span>
        )}
        {stage.status === "failed" ? (
          <span style={{ color: "var(--rose)" }}>agent failed</span>
        ) : stage.status === "cancelled" ? (
          <span style={{ color: "var(--signal)" }}>cancelled</span>
        ) : stage.latestFrame?.toolName ? (
          `latest: ${stage.latestFrame.toolName}`
        ) : stage.status === "running" ? (
          "running..."
        ) : (
          "waiting"
        )}
      </div>
    </div>
  );
}

function Connector({ active }) {
  return (
    <div className="flex w-10 items-center justify-center xl:w-14">
      <div
        className="h-[2px] w-full rounded-full"
        style={{ background: active ? "var(--signal)" : "var(--line)" }}
      />
    </div>
  );
}

export function OrchestratorGraph({ events = [], rootActor = "orchestrator" }) {
  const stageView = buildStageView(events);
  const stages = stageView.stages;
  const totalToolCalls = stageView.toolCalls.length;

  return (
    <div
      className="overflow-hidden rounded-[14px] border"
      style={{
        borderColor: "var(--line)",
        background: "var(--card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div
        className="flex items-center gap-3 border-b px-4 py-3"
        style={{ borderColor: "var(--line)" }}
      >
        <span
          className="text-[12px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: "var(--signal)" }}
        >
          Orchestrator Graph
        </span>
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px]"
          style={{ background: "var(--line)", color: "var(--mute-2)" }}
        >
          {rootActor}
        </span>
        <span
          className="ml-auto font-mono text-[10px]"
          style={{ color: "var(--mute-3)" }}
        >
          {totalToolCalls} tool calls
        </span>
      </div>

      <div className="overflow-x-auto px-4 py-5">
        <div className="flex min-w-[920px] items-stretch">
          {STAGE_ORDER.map((stageName, index) => {
            const stage = stages.find((item) => item.stage === stageName);
            const next = stages.find(
              (item) => item.stage === STAGE_ORDER[index + 1],
            );
            return (
              <div key={stageName} className="flex min-w-0 flex-1 items-center">
                <StageCard stage={stage} />
                {next ? (
                  <Connector
                    active={
                      stage.status === "done" ||
                      stage.status === "running" ||
                      next.status !== "idle"
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
