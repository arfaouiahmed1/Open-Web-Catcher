"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  Maximize2,
  Minimize2,
  Monitor,
  RefreshCw,
  X,
} from "lucide-react";

import { apiUrl } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { buildStageView, STAGE_LABELS, STAGE_ORDER } from "@/lib/run-trace";

const EMPTY_ARRAY = [];

function frameLabel(frame) {
  if (!frame) return "";
  return [frame.toolName, frame.target].filter(Boolean).join(" | ");
}

function stageTone(stage) {
  if (stage === "classification") return "var(--sky)";
  if (stage === "landing") return "var(--violet)";
  if (stage === "hosting") return "var(--mint)";
  if (stage === "embedded") return "var(--signal)";
  return "var(--mute)";
}

function StageButton({
  stage,
  active,
  autoSelected,
  disabled,
  count,
  onClick,
}) {
  const color = stageTone(stage);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-45"
      style={{
        borderColor: active
          ? `color-mix(in oklch, ${color} 40%, transparent)`
          : "var(--line)",
        background: active
          ? `color-mix(in oklch, ${color} 14%, transparent)`
          : "transparent",
        color: active ? color : "var(--mute-2)",
      }}
    >
      {STAGE_LABELS[stage]}
      <span
        className="ml-1.5 font-mono text-[10px]"
        style={{ color: active ? color : "var(--mute-3)" }}
      >
        {formatNumber(count)}
      </span>
      {autoSelected && active ? (
        <span className="ml-1.5 font-mono text-[9px]">AUTO</span>
      ) : null}
    </button>
  );
}

function FrameOverlay({ frame, status }) {
  if (!frame) return null;
  const color = stageTone(frame.stage);
  return (
    <div
      className="absolute inset-x-0 bottom-0 px-3 py-2.5"
      style={{
        background: `linear-gradient(to top, color-mix(in oklch, ${color} 28%, rgba(0,0,0,0.94)) 0%, transparent 100%)`,
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold" style={{ color }}>
          {STAGE_LABELS[frame.stage]}
        </span>
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px]"
          style={{
            background: "rgba(0,0,0,0.22)",
            color: "rgba(255,255,255,0.78)",
          }}
        >
          {frame.toolName || "screenshot"}
        </span>
        <span
          className="ml-auto font-mono text-[10px]"
          style={{ color: "rgba(255,255,255,0.74)" }}
        >
          {status}
        </span>
      </div>
      {frame.target ? (
        <div
          className="mt-1 truncate font-mono text-[10px]"
          style={{ color: "rgba(255,255,255,0.58)" }}
          title={frame.target}
        >
          {frame.target}
        </div>
      ) : null}
    </div>
  );
}

export function BrowserLiveView({
  runId,
  events = [],
  autoRefresh = true,
  standalone = false,
  onClose,
}) {
  const [manualMode, setManualMode] = useState(false);
  const [manualStage, setManualStage] = useState("classification");
  const [selectedFrameUrl, setSelectedFrameUrl] = useState("");
  const [fallbackScreenshot, setFallbackScreenshot] = useState("");
  const [fallbackTimestamp, setFallbackTimestamp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const stageView = useMemo(() => buildStageView(events), [events]);
  const stages = stageView.stages;
  const autoStage = stageView.autoStage;
  const selectedStage = manualMode ? manualStage : autoStage;
  const selectedStageData =
    stages.find((stage) => stage.stage === selectedStage) || stages[0];
  const availableFrames = selectedStageData?.frames ?? EMPTY_ARRAY;
  const latestFrame = selectedStageData?.latestFrame || null;
  const anyFrames = stages.some((stage) => (stage.frames || []).length > 0);

  useEffect(() => {
    if (!manualMode) {
      setManualStage(autoStage);
    }
  }, [autoStage, manualMode]);

  useEffect(() => {
    const nextUrl = latestFrame?.url || "";
    if (
      !manualMode ||
      !selectedFrameUrl ||
      !availableFrames.some((frame) => frame.url === selectedFrameUrl)
    ) {
      setSelectedFrameUrl(nextUrl);
    }
  }, [availableFrames, latestFrame, manualMode, selectedFrameUrl]);

  useEffect(() => {
    if (anyFrames || (!standalone && !runId) || !autoRefresh) return undefined;

    let cancelled = false;
    let timer = null;

    async function fetchScreenshot() {
      setIsLoading(true);
      try {
        const url = standalone
          ? apiUrl("/ui/browser/screenshot")
          : apiUrl(`/ui/runs/${runId}/screenshot`);
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json();
        if (cancelled) return;
        const next = payload?.screenshot || payload?.screenshot_url || "";
        if (next) {
          setFallbackScreenshot(next);
          setFallbackTimestamp(payload?.timestamp || "");
          setFetchError("");
        }
      } catch (error) {
        if (!cancelled) {
          setFetchError(
            error instanceof Error
              ? error.message
              : String(error || "Screenshot fetch failed"),
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchScreenshot();
    timer = window.setInterval(fetchScreenshot, 2500);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [anyFrames, autoRefresh, refreshNonce, runId, standalone]);

  const activeFrame =
    availableFrames.find((frame) => frame.url === selectedFrameUrl) ||
    latestFrame;
  const activeUrl = activeFrame?.url || (!anyFrames ? fallbackScreenshot : "");
  const statusLabel = selectedStageData?.status || "idle";
  const stageColor = stageTone(selectedStage);

  return (
    <div
      className={`overflow-hidden rounded-[14px] border ${isFullscreen ? "fixed inset-4 z-50" : ""}`}
      style={{
        borderColor: "var(--line)",
        background: "var(--card)",
        boxShadow: isFullscreen
          ? "0 24px 72px rgba(0,0,0,0.52)"
          : "var(--shadow-card)",
      }}
    >
      <div
        className="flex items-center gap-2 border-b px-3 py-2.5"
        style={{ borderColor: "var(--line)" }}
      >
        <div className="flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: "#FF5F57" }}
          />
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: "#FEBC2E" }}
          />
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: "#28C840" }}
          />
        </div>

        <div
          className="mx-2 flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5"
          style={{ borderColor: "var(--line)", background: "var(--card)" }}
        >
          <Monitor
            className="h-3.5 w-3.5 shrink-0"
            style={{ color: stageColor }}
          />
          <span
            className="truncate font-mono text-[10.5px]"
            style={{ color: activeUrl ? "var(--ink-dim)" : "var(--mute-3)" }}
            title={frameLabel(activeFrame) || undefined}
          >
            {frameLabel(activeFrame) || "Waiting for agent screenshots"}
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            setManualMode(false);
            setSelectedFrameUrl(latestFrame?.url || "");
          }}
          className="rounded-full border px-3 py-1 text-[11px] font-medium"
          style={{
            borderColor: !manualMode
              ? `color-mix(in oklch, ${stageColor} 40%, transparent)`
              : "var(--line)",
            background: !manualMode
              ? `color-mix(in oklch, ${stageColor} 14%, transparent)`
              : "transparent",
            color: !manualMode ? stageColor : "var(--mute-2)",
          }}
        >
          Auto
        </button>

        <button
          type="button"
          onClick={() => setRefreshNonce((value) => value + 1)}
          className="rounded p-1"
          title="Refresh screenshot"
          style={{ color: "var(--mute-2)" }}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
          />
        </button>

        <button
          type="button"
          onClick={() => setIsFullscreen((value) => !value)}
          className="rounded p-1"
          style={{ color: "var(--mute-2)" }}
        >
          {isFullscreen ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </button>

        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1"
            style={{ color: "var(--mute-2)" }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div
        className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5"
        style={{ borderColor: "var(--line)" }}
      >
        {STAGE_ORDER.map((stage) => {
          const stageData = stages.find((item) => item.stage === stage);
          return (
            <StageButton
              key={stage}
              stage={stage}
              count={stageData?.frames?.length || 0}
              active={selectedStage === stage}
              autoSelected={!manualMode && autoStage === stage}
              disabled={false}
              onClick={() => {
                setManualMode(true);
                setManualStage(stage);
                setSelectedFrameUrl(stageData?.latestFrame?.url || "");
              }}
            />
          );
        })}
        <span
          className="ml-auto font-mono text-[10px]"
          style={{ color: stageColor }}
        >
          {STAGE_LABELS[selectedStage] || "Stage"} | {statusLabel}
        </span>
      </div>

      <div
        className="relative flex items-center justify-center overflow-hidden"
        style={{
          minHeight: isFullscreen ? "calc(100vh - 220px)" : 280,
          background: "#050508",
        }}
      >
        {activeUrl ? (
          <>
            <img
              src={activeUrl}
              alt="Agent browser view"
              className="h-full w-full object-contain"
            />
            <FrameOverlay
              frame={
                activeFrame || {
                  stage: selectedStage,
                  toolName: "",
                  target: "",
                }
              }
              status={statusLabel}
            />
          </>
        ) : (
          <div className="px-4 text-center">
            <Monitor
              className="mx-auto h-8 w-8 opacity-20"
              style={{ color: "var(--mute-3)" }}
            />
            <div
              className="mt-2 text-[12px]"
              style={{ color: "var(--mute-3)" }}
            >
              {fetchError || "No screenshot captured for this stage yet."}
            </div>
          </div>
        )}
      </div>

      {availableFrames.length > 1 || (!anyFrames && fallbackScreenshot) ? (
        <div
          className="flex gap-2 overflow-x-auto border-t p-2"
          style={{ borderColor: "var(--line)" }}
        >
          {(availableFrames.length
            ? availableFrames
            : [{ url: fallbackScreenshot, seq: 0, stage: selectedStage }]
          ).map((frame, index) => (
            <button
              key={`${frame.url}-${frame.seq}-${index}`}
              type="button"
              onClick={() => {
                setManualMode(true);
                setManualStage(selectedStage);
                setSelectedFrameUrl(frame.url);
              }}
              className="shrink-0 overflow-hidden rounded-[8px] border"
              style={{
                width: 92,
                height: 58,
                borderColor:
                  frame.url === activeUrl ? stageColor : "var(--line)",
                background: "var(--bg)",
              }}
            >
              <img
                src={frame.url}
                alt={`${selectedStage} frame ${index + 1}`}
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      ) : null}

      <div
        className="flex items-center gap-3 border-t px-3 py-2"
        style={{ borderColor: "var(--line)", background: "var(--card)" }}
      >
        <span
          className="font-mono text-[10px]"
          style={{ color: "var(--mute-3)" }}
        >
          {activeFrame?.timestamp
            ? `Updated ${new Date(activeFrame.timestamp).toLocaleTimeString()}`
            : fallbackTimestamp
              ? `Updated ${new Date(fallbackTimestamp).toLocaleTimeString()}`
              : "Waiting"}
        </span>
        <span
          className="font-mono text-[10px]"
          style={{ color: "var(--mute-3)" }}
        >
          {formatNumber(availableFrames.length || (fallbackScreenshot ? 1 : 0))}{" "}
          frame
          {(availableFrames.length || fallbackScreenshot ? 1 : 0) === 1
            ? ""
            : "s"}
        </span>
        {activeUrl ? (
          <a
            href={activeUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[10px]"
            style={{ color: "var(--mute-2)" }}
          >
            open
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function ScreenshotGallery({ screenshots = [] }) {
  const [selected, setSelected] = useState(null);
  const [zoom, setZoom] = useState(false);

  if (!screenshots.length) {
    return (
      <div
        className="flex h-32 items-center justify-center rounded-[14px] border"
        style={{
          borderColor: "var(--line)",
          background: "var(--card)",
          color: "var(--mute-3)",
        }}
      >
        <div className="text-center">
          <Monitor className="mx-auto h-6 w-6 opacity-20" />
          <div className="mt-2 text-[12px]">No screenshots captured</div>
        </div>
      </div>
    );
  }

  const active = selected ?? screenshots[screenshots.length - 1];

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
        className="flex items-center justify-between border-b px-4 py-2.5"
        style={{ borderColor: "var(--line)" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="text-[13.5px] font-medium"
            style={{ color: "var(--ink)" }}
          >
            Screenshots
          </span>
          <span
            className="font-mono text-[11px]"
            style={{ color: "var(--mute)" }}
          >
            {screenshots.length} captured
          </span>
        </div>
      </div>

      <div
        className="relative cursor-zoom-in overflow-hidden"
        style={{ background: "#050508", maxHeight: 380 }}
        onClick={() => setZoom(true)}
      >
        <img
          src={active}
          alt="Screenshot"
          className="w-full object-contain"
          style={{ maxHeight: 380, display: "block" }}
        />
      </div>

      {screenshots.length > 1 ? (
        <div
          className="flex gap-2 overflow-x-auto border-t p-2"
          style={{ borderColor: "var(--line)" }}
        >
          {screenshots.map((src, index) => (
            <button
              key={`${src}-${index}`}
              type="button"
              onClick={() => setSelected(src)}
              className="shrink-0 overflow-hidden rounded-[6px] border transition-all"
              style={{
                width: 72,
                height: 48,
                borderColor: src === active ? "var(--signal)" : "var(--line)",
                background: "var(--bg)",
              }}
            >
              <img
                src={src}
                alt={`Screenshot ${index + 1}`}
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      ) : null}

      {zoom ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{
            background: "rgba(0,0,0,0.88)",
            backdropFilter: "blur(8px)",
          }}
          onClick={() => setZoom(false)}
        >
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full border p-2"
            style={{
              borderColor: "var(--line)",
              background: "var(--card)",
              color: "var(--mute)",
            }}
            onClick={() => setZoom(false)}
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={active}
            alt="Screenshot fullscreen"
            className="max-h-[90vh] max-w-[90vw] rounded-[8px] object-contain"
          />
        </div>
      ) : null}
    </div>
  );
}
