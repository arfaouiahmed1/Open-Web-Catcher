// @ts-nocheck
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import {
  ScrollArea,
  ScrollAreaViewport,
  ScrollBar,
} from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate, formatTime, formatTimestamp, parseTimestamp } from "@/lib/datetime";

const EMPTY_ARRAY = [];

function BrokenShotState({ message = "No screenshot captured for this stage yet.", compact = false }) {
  return (
    <div
      className={`flex flex-col items-center justify-center px-4 text-center ${
        compact ? "h-full gap-1.5 text-[10px]" : "min-h-[320px] gap-2 text-[12px]"
      }`}
    >
      <Monitor
        className={compact ? "h-4 w-4 opacity-30" : "h-8 w-8 opacity-20"}
        style={{ color: "var(--mute-3)" }}
      />
      <div style={{ color: "var(--mute-3)" }}>{message}</div>
    </div>
  );
}

function ScreenshotImage({
  src,
  alt,
  className,
  style,
  loading,
  fallbackMessage,
  compact = false,
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    return <BrokenShotState message={fallbackMessage} compact={compact} />;
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      loading={loading}
      onError={() => setFailed(true)}
    />
  );
}

function frameLabel(frame) {
  if (!frame) return "";
  const invocation =
    frame.invocationIndex || frame.agentRunId
      ? `${frame.actor || frame.agentType || "agent"}#${frame.invocationIndex || frame.agentRunId}`
      : frame.actor || "";
  return [invocation, frame.toolName, frame.target].filter(Boolean).join(" | ");
}

function stageTone(stage) {
  if (stage === "classification") return "var(--sky)";
  if (stage === "landing") return "var(--violet)";
  if (stage === "hosting") return "var(--mint)";
  if (stage === "embedded") return "var(--signal)";
  return "var(--mute)";
}

function phaseTone(phase) {
  if (phase === "failed") return "danger";
  if (phase === "done") return "success";
  if (phase === "llm") return "violet";
  if (phase === "tool") return "signal";
  return "default";
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
        {frame.invocationIndex || frame.agentRunId ? (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10px]"
            style={{
              background: "rgba(0,0,0,0.22)",
              color: "rgba(255,255,255,0.78)",
            }}
          >
            {frame.actor || frame.agentType || "agent"} #{frame.invocationIndex || frame.agentRunId}
          </span>
        ) : null}
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

function StageTrigger({ stage, active, autoSelected, count, status, phase }) {
  const color = stageTone(stage);
  return (
    <TabsTrigger
      value={stage}
      className="h-auto min-h-14 flex-col items-start justify-start gap-1.5 rounded-lg px-3 py-2 text-left text-xs data-[state=active]:shadow-sm"
      style={{
        boxShadow: active
          ? `inset 0 0 0 1px color-mix(in oklch, ${color} 28%, transparent)`
          : undefined,
      }}
    >
      <span className="flex w-full items-center gap-1.5">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: color }}
        />
        <span className="truncate font-medium">{STAGE_LABELS[stage]}</span>
      </span>
      <span className="flex w-full items-center gap-1.5">
        <Badge tone={phaseTone(phase)} className="h-5 px-1.5 py-0 text-[9px]">
          {formatNumber(count)}
        </Badge>
        {autoSelected && active ? (
          <Badge tone="signal" className="h-5 px-1.5 py-0 text-[9px]">
            AUTO
          </Badge>
        ) : null}
        {status ? (
          <span
            className="hidden truncate font-mono text-[9px] uppercase tracking-[0.12em] md:inline"
            style={{ color: active ? color : "var(--mute-3)" }}
          >
            {status}
          </span>
        ) : null}
      </span>
    </TabsTrigger>
  );
}

function normalizePersistedScreenshotFrame(row, index, selectedStage) {
  if (typeof row === "string") {
    const url = row.trim();
    if (!url) return null;
    return {
      url,
      seq: index + 1,
      actor: "persisted",
      stage: selectedStage,
      agentType: "",
      agentRunId: 0,
      invocationIndex: 0,
      toolName: "persisted capture",
      target: "",
      timestamp: "",
    };
  }
  if (!row || typeof row !== "object") return null;
  const url = String(row.screenshot_url || row.url || "").trim();
  if (!url) return null;
  const agentType = String(row.agent_type || "");
  const stage = agentType.includes("landing")
    ? "landing"
    : agentType.includes("hosting")
      ? "hosting"
      : agentType.includes("embedded")
        ? "embedded"
        : agentType.includes("classification")
          ? "classification"
          : selectedStage;
  return {
    url,
    seq: Number(row.seq || index + 1),
    actor: String(row.actor || "persisted"),
    stage,
    agentType,
    agentRunId: Number(row.agent_run_id || 0),
    invocationIndex: Number(row.invocation_index || 0),
    toolName: String(row.tool_name || row.label || "persisted capture"),
    target: String(row.target_url || row.source_url || ""),
    timestamp: String(row.created_at || ""),
  };
}

export function BrowserLiveView({
  runId,
  events = [],
  persistedScreenshots = [],
  autoRefresh = true,
  standalone = false,
  onClose,
}) {
  const thumbnailStripRef = useRef(null);
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
  const stageByName = useMemo(
    () => new Map(stages.map((stage) => [stage.stage, stage])),
    [stages],
  );
  const selectedStage = manualMode ? manualStage : autoStage;
  const selectedStageData = stageByName.get(selectedStage) || stages[0];
  const availableFrames = selectedStageData?.frames ?? EMPTY_ARRAY;
  const latestFrame = selectedStageData?.latestFrame || null;
  const anyFrames = stages.some((stage) => (stage.frames || []).length > 0);
  const persistedFallbackFrames = useMemo(
    () =>
      (Array.isArray(persistedScreenshots) ? persistedScreenshots : EMPTY_ARRAY)
        .map((row, index) => normalizePersistedScreenshotFrame(row, index, selectedStage))
        .filter(Boolean),
    [persistedScreenshots, selectedStage],
  );
  const effectiveFrames = availableFrames.length ? availableFrames : persistedFallbackFrames;
  const thumbnailFrames = useMemo(
    () =>
      effectiveFrames.length
        ? effectiveFrames
        : fallbackScreenshot
          ? [{ url: fallbackScreenshot, seq: 0, stage: selectedStage, toolName: "latest capture" }]
          : EMPTY_ARRAY,
    [effectiveFrames, fallbackScreenshot, selectedStage],
  );
  const statusLabel =
    selectedStageData?.liveLabel || selectedStageData?.status || "idle";
  const selectedPhase =
    selectedStageData?.livePhase || selectedStageData?.status || "idle";
  const stageColor = stageTone(selectedStage);
  const frameCount = effectiveFrames.length || (fallbackScreenshot ? 1 : 0);

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
      !effectiveFrames.some((frame) => frame.url === selectedFrameUrl)
    ) {
      setSelectedFrameUrl(nextUrl || effectiveFrames[effectiveFrames.length - 1]?.url || "");
    }
  }, [effectiveFrames, latestFrame, manualMode, selectedFrameUrl]);

  useEffect(() => {
    if ((availableFrames.length > 0 && !standalone) || (!standalone && !runId)) return undefined;

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
        setFallbackScreenshot(next);
        setFallbackTimestamp(payload?.timestamp || "");
        setFetchError(payload?.error ? String(payload.error) : "");
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
    // Plan task 42 (de-polling): the screenshot refetch is driven by tab
    // focus instead of a fixed interval — the browser-live view is watched,
    // so background tabs don't need fresh frames. Manual refresh (refreshNonce)
    // still works unchanged.
    let visibilityHandler = null;
    if (autoRefresh) {
      visibilityHandler = () => {
        if (document.visibilityState === "visible") fetchScreenshot();
      };
      document.addEventListener("visibilitychange", visibilityHandler);
    }
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
      }
    };
  }, [availableFrames.length, autoRefresh, refreshNonce, runId, standalone]);

  const activeFrame =
    effectiveFrames.find((frame) => frame.url === selectedFrameUrl) ||
    latestFrame ||
    effectiveFrames[effectiveFrames.length - 1] ||
    null;
  const activeUrl = activeFrame?.url || fallbackScreenshot || "";
  const activeImageMaxHeight = isFullscreen ? "calc(100vh - 280px)" : 420;
  const activeThumbIndex = useMemo(() => {
    if (!thumbnailFrames.length || !activeUrl) return -1;
    for (let index = thumbnailFrames.length - 1; index >= 0; index -= 1) {
      if (thumbnailFrames[index]?.url === activeUrl) return index;
    }
    return -1;
  }, [activeUrl, thumbnailFrames]);

  useEffect(() => {
    if (manualMode || !autoRefresh) return;
    if (!thumbnailStripRef.current || activeThumbIndex < 0) return;
    const target = thumbnailStripRef.current.querySelector(
      `[data-frame-index="${activeThumbIndex}"]`,
    );
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({
        behavior: "smooth",
        inline: "center",
        block: "nearest",
      });
    }
  }, [activeThumbIndex, autoRefresh, manualMode, thumbnailFrames.length]);

  function handleStageChange(nextStage) {
    const next = stageByName.get(nextStage);
    setManualMode(true);
    setManualStage(nextStage);
    setSelectedFrameUrl(
      next?.latestFrame?.url ||
      persistedFallbackFrames[persistedFallbackFrames.length - 1]?.url ||
      "",
    );
  }

  return (
    <Card
      className={`overflow-hidden shadow-card ${
        isFullscreen ? "fixed inset-4 z-50 flex flex-col shadow-2xl" : ""
      }`}
      style={{
        borderColor: "var(--line)",
        background: "var(--card)",
      }}
    >
      <CardHeader
        className="space-y-4 border-b px-4 py-4"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in oklch, var(--signal) 8%, transparent), transparent 78%)",
        }}
      >
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border"
              style={{
                borderColor: "var(--line)",
                background: "color-mix(in oklch, var(--signal) 8%, transparent)",
              }}
            >
              <Monitor className="h-5 w-5" style={{ color: stageColor }} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">Browser live view</CardTitle>
                <Badge tone={manualMode ? "violet" : "success"}>
                  {manualMode ? "manual" : "auto"}
                </Badge>
                {availableFrames.length === 0 && persistedFallbackFrames.length > 0 ? (
                  <Badge tone="default">persisted fallback</Badge>
                ) : null}
                <Badge tone={frameCount > 0 ? "signal" : "default"}>
                  {formatNumber(frameCount)} frame{frameCount === 1 ? "" : "s"}
                </Badge>
              </div>
              <CardDescription
                className="mt-1 truncate font-mono text-[11px]"
                title={frameLabel(activeFrame) || undefined}
              >
                {frameLabel(activeFrame) || "Waiting for agent screenshots"}
              </CardDescription>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => {
                setManualMode(false);
                setSelectedFrameUrl(latestFrame?.url || "");
              }}
              variant={manualMode ? "outline" : "secondary"}
              size="sm"
              className="gap-1.5"
            >
              Auto
            </Button>

            <Button
              type="button"
              onClick={() => setRefreshNonce((value) => value + 1)}
              variant="ghost"
              size="icon-sm"
              title="Refresh screenshot"
              aria-label="Refresh screenshot"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
              />
            </Button>

            <Button
              type="button"
              onClick={() => setIsFullscreen((value) => !value)}
              variant="ghost"
              size="icon-sm"
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </Button>

            {onClose ? (
              <Button
                type="button"
                onClick={onClose}
                variant="ghost"
                size="icon-sm"
                title="Close"
                aria-label="Close"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Stages
          </span>
          <Badge tone={phaseTone(selectedPhase)}>{statusLabel}</Badge>
        </div>

        <Tabs
          value={selectedStage}
          onValueChange={handleStageChange}
          className="w-full"
        >
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1.5 rounded-xl border bg-muted/40 p-1.5 shadow-sm">
            {STAGE_ORDER.map((stage) => {
              const stageData = stageByName.get(stage);
              const active = selectedStage === stage;
              const status = stageData?.liveLabel || stageData?.status || "idle";
              const phase = stageData?.livePhase || stageData?.status || "idle";
              return (
                <StageTrigger
                  key={stage}
                  stage={stage}
                  count={stageData?.frames?.length || 0}
                  active={active}
                  autoSelected={!manualMode && autoStage === stage}
                  status={status}
                  phase={phase}
                />
              );
            })}
          </TabsList>
        </Tabs>
      </CardHeader>

      <CardContent className="space-y-4 px-4 py-4">
        <div
          className="relative flex items-center justify-center overflow-hidden rounded-[18px] border"
          style={{
            minHeight: isFullscreen ? "calc(100vh - 220px)" : 320,
            borderColor: "var(--line)",
            background:
              "radial-gradient(circle at top, rgba(255,255,255,0.06), transparent 28%), #050508",
          }}
        >
          {activeUrl ? (
            <>
              <ScreenshotImage
                src={activeUrl}
                alt="Agent browser view"
                className="block w-full object-contain"
                style={{ maxHeight: activeImageMaxHeight }}
                fallbackMessage="This screenshot could not be loaded."
              />
              <FrameOverlay
                frame={
                  activeFrame || {
                    stage: selectedStage,
                    toolName: persistedFallbackFrames.length ? "persisted capture" : "",
                    target: "",
                  }
                }
                status={
                  availableFrames.length > 0
                    ? statusLabel
                    : persistedFallbackFrames.length > 0
                      ? "persisted"
                      : statusLabel
                }
              />
            </>
          ) : (
            <div className="flex min-h-[320px] flex-col items-center justify-center px-4 text-center">
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
              {fetchError ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setRefreshNonce((value) => value + 1)}
                >
                  Try again
                </Button>
              ) : null}
            </div>
          )}
        </div>

        {effectiveFrames.length > 1 || fallbackScreenshot ? (
          <ScrollArea className="w-full rounded-xl border border-border bg-muted/20">
            <ScrollAreaViewport className="w-full">
              <div ref={thumbnailStripRef} className="flex gap-2 p-2 flex-nowrap overflow-x-auto">
                {thumbnailFrames.map((frame, index) => (
                  <button
                    key={`${frame.url}-${frame.seq}-${index}`}
                    data-frame-index={index}
                    type="button"
                    onClick={() => {
                      setManualMode(true);
                      setManualStage(selectedStage);
                      setSelectedFrameUrl(frame.url);
                    }}
                    className="shrink-0 overflow-hidden rounded-lg border transition-all"
                    style={{
                      width: 84,
                      height: 56,
                      borderColor:
                        frame.url === activeUrl ? stageColor : "var(--line)",
                      background: "var(--bg)",
                    }}
                  >
                    <ScreenshotImage
                      src={frame.url}
                      alt={`${selectedStage} frame ${index + 1}`}
                      className="h-full w-full object-cover"
                      loading="lazy"
                      fallbackMessage="Unavailable"
                      compact
                    />
                  </button>
                ))}
              </div>
            </ScrollAreaViewport>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center gap-3 border-t px-4 py-3">
        <Badge tone="default" className="px-2 py-0 text-[10px]">
          {availableFrames.length > 0
            ? "Event frame"
            : persistedFallbackFrames.length > 0
              ? "Persisted frame"
              : fallbackScreenshot
                ? "Fallback screenshot"
                : "No frame"}
        </Badge>
        <Badge tone={phaseTone(selectedPhase)} className="px-2 py-0 text-[10px]">
          {STAGE_LABELS[selectedStage]} / {statusLabel}
        </Badge>
        <span className="font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
          {activeFrame?.timestamp
            ? `Updated ${formatTime(activeFrame.timestamp)}`
            : fallbackTimestamp
              ? `Updated ${formatTime(fallbackTimestamp)}`
              : "Waiting"}
        </span>
        <Badge
          tone={manualMode ? "violet" : "success"}
          className="px-2 py-0 text-[10px]"
        >
          {manualMode ? "Pinned" : "Live"}
        </Badge>
        <Badge tone="default" className="px-2 py-0 text-[10px]">
          {formatNumber(frameCount)} frame{frameCount === 1 ? "" : "s"}
        </Badge>
        {activeUrl ? (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="ml-auto gap-1 px-2 text-[10px]"
          >
            <a href={activeUrl} target="_blank" rel="noreferrer">
              open
              <ExternalLink className="h-3 w-3" />
            </a>
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}

export function ScreenshotGallery({ screenshots = [] }) {
  const [selected, setSelected] = useState(null);
  const [zoom, setZoom] = useState(false);

  if (!screenshots.length) {
    return (
      <Card className="overflow-hidden shadow-card">
        <CardContent className="flex h-32 items-center justify-center px-4 py-4 text-center">
          <div>
            <Monitor className="mx-auto h-6 w-6 opacity-20" />
            <div className="mt-2 text-[12px] text-muted-foreground">
              No screenshots captured
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const active = selected ?? screenshots[screenshots.length - 1];

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm">Screenshots</CardTitle>
          <Badge tone="signal">{screenshots.length} captured</Badge>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setZoom(true)}
          aria-label="Open screenshot gallery"
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
      </CardHeader>

      <CardContent className="space-y-3 px-4 py-4">
        <button
          type="button"
          className="group relative overflow-hidden rounded-xl border border-border bg-black/95"
          onClick={() => setZoom(true)}
        >
          <ScreenshotImage
            src={active}
            alt="Screenshot"
            className="block w-full object-contain"
            style={{ maxHeight: 380 }}
            loading="lazy"
            fallbackMessage="This screenshot could not be loaded."
          />
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
        </button>

        {screenshots.length > 1 ? (
          <ScrollArea className="w-full rounded-xl border border-border bg-muted/20">
            <ScrollAreaViewport className="w-full">
              <div className="flex gap-2 p-2 flex-nowrap overflow-x-auto">
                {screenshots.map((src, index) => (
                  <button
                    key={`${src}-${index}`}
                    type="button"
                    onClick={() => setSelected(src)}
                    className="shrink-0 overflow-hidden rounded-lg border transition-all"
                    style={{
                      width: 84,
                      height: 56,
                      borderColor: src === active ? "var(--signal)" : "var(--line)",
                      background: "var(--bg)",
                    }}
                  >
                    <ScreenshotImage
                      src={src}
                      alt={`Screenshot ${index + 1}`}
                      className="h-full w-full object-cover"
                      loading="lazy"
                      fallbackMessage="Unavailable"
                      compact
                    />
                  </button>
                ))}
              </div>
            </ScrollAreaViewport>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        ) : null}
      </CardContent>

      <Dialog open={zoom} onOpenChange={setZoom}>
        <DialogContent
          className="w-[96vw] max-w-none overflow-hidden p-3 sm:w-[92vw] lg:w-[78vw]"
          showClose={false}
        >
          <div className="relative overflow-hidden rounded-xl border border-border bg-black">
            <DialogClose asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                className="absolute right-3 top-3 z-10 shadow-md"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close screenshot</span>
              </Button>
            </DialogClose>
            <ScreenshotImage
              src={active}
              alt="Screenshot fullscreen"
              className="max-h-[88vh] w-full object-contain"
              fallbackMessage="This screenshot could not be loaded."
            />
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
