"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, Monitor, RefreshCw, X } from "lucide-react";

import { apiUrl } from "@/lib/api";

/* ── Tool metadata ──────────────────────────────────────────────────────── */
const TOOL_META = {
  navigate:          { icon: "🌐", label: "Navigating",     color: "var(--sky)" },
  open_url:          { icon: "🌐", label: "Opening URL",    color: "var(--sky)" },
  screenshot:        { icon: "📷", label: "Screenshot",     color: "var(--violet)" },
  click_element:     { icon: "👆", label: "Clicking",       color: "var(--signal)" },
  click_css:         { icon: "👆", label: "Clicking CSS",   color: "var(--signal)" },
  click_text:        { icon: "👆", label: "Clicking text",  color: "var(--signal)" },
  click_xpath:       { icon: "👆", label: "Clicking XPath", color: "var(--signal)" },
  click_coordinates: { icon: "👆", label: "Clicking coords",color: "var(--signal)" },
  click_checkbox:    { icon: "☑️",  label: "Checking box",  color: "var(--signal)" },
  click_radio:       { icon: "🔘", label: "Selecting",      color: "var(--signal)" },
  type_into:         { icon: "⌨️",  label: "Typing",        color: "var(--mint)" },
  select_option:     { icon: "📋", label: "Selecting",      color: "var(--mint)" },
  scroll_page:       { icon: "📜", label: "Scrolling",      color: "var(--mute-2)" },
  scroll_to_element: { icon: "📜", label: "Scrolling to",   color: "var(--mute-2)" },
  swipe_region:      { icon: "👋", label: "Swiping",        color: "var(--mute-2)" },
  inspect:           { icon: "🔍", label: "Inspecting",     color: "var(--sky)" },
  inspect_landing:   { icon: "🔍", label: "Inspecting",     color: "var(--sky)" },
  inspect_hosting:   { icon: "🔍", label: "Inspecting",     color: "var(--sky)" },
  inspect_embedded:  { icon: "🔍", label: "Inspecting",     color: "var(--sky)" },
  interact:          { icon: "🖱️",  label: "Interacting",   color: "var(--sky)" },
  query_elements:    { icon: "🔎", label: "Querying DOM",   color: "var(--sky)" },
  get_page_context:  { icon: "📄", label: "Reading page",   color: "var(--sky)" },
  get_frame_tree:    { icon: "🗂️",  label: "Frame tree",    color: "var(--sky)" },
  get_element_detail:{ icon: "🔎", label: "Element detail", color: "var(--sky)" },
  go_back:           { icon: "⬅️",  label: "Going back",    color: "var(--mute-2)" },
  wait_for_page_state:{ icon:"⏳",  label: "Waiting",       color: "var(--mute-2)" },
  play_media:        { icon: "▶️",  label: "Playing media", color: "var(--rose)" },
  capture_streams:   { icon: "📡", label: "Capturing",      color: "var(--rose)" },
  harvest:           { icon: "🌾", label: "Harvesting",     color: "var(--mint)" },
  memory_lookup:     { icon: "🧠", label: "Memory lookup",  color: "var(--violet)" },
  memory_update:     { icon: "🧠", label: "Memory update",  color: "var(--violet)" },
  get_media_state:   { icon: "📡", label: "Media state",    color: "var(--rose)" },
};

function getToolMeta(name) {
  return TOOL_META[name] || { icon: "🔧", label: name || "Tool", color: "var(--sky)" };
}

/* ── Extract a useful target string from tool args ──────────────────────── */
function extractTarget(details) {
  const args = details?.args || details?.arguments || {};
  return (
    args.url || args.selector || args.css_selector || args.xpath ||
    args.text || args.value || args.element_id || ""
  );
}

/* ── Tool activity overlay ───────────────────────────────────────────────── */
function ToolOverlay({ event }) {
  if (!event) return null;
  const toolName = event.details?.tool_name || "";
  const meta = getToolMeta(toolName);
  const isActive = event.kind === "tool_call_started";
  const target = extractTarget(event.details);

  return (
    <div
      className="absolute bottom-0 left-0 right-0 flex items-start gap-2.5 px-3 py-2.5"
      style={{
        background: `linear-gradient(to top, color-mix(in oklch, ${meta.color} 22%, rgba(0,0,0,0.92)) 0%, transparent 100%)`,
        backdropFilter: "blur(4px)",
      }}
    >
      <span className="mt-0.5 text-[15px] leading-none">{meta.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {isActive && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: meta.color, animation: "breathe 1.2s ease-in-out infinite" }}
            />
          )}
          <span className="text-[11.5px] font-semibold" style={{ color: meta.color }}>
            {meta.label}
          </span>
          {!isActive && (
            <span className="text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--mint)" }}>
              done
            </span>
          )}
          {isActive && <span className="owc-spinner owc-spinner-sm" style={{ color: meta.color }} />}
        </div>
        {target && (
          <div
            className="mt-0.5 truncate font-mono text-[10px]"
            style={{ color: "rgba(255,255,255,0.5)" }}
            title={target}
          >
            {target.length > 60 ? target.slice(0, 57) + "…" : target}
          </div>
        )}
        {event.message && !target && (
          <div className="mt-0.5 truncate text-[10px]" style={{ color: "rgba(255,255,255,0.45)" }}>
            {event.message}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */
export function BrowserLiveView({
  runId,
  events = [],
  autoRefresh = true,
  standalone = false, // use /ui/browser/screenshot instead of run-based
  onClose,
}) {
  const [screenshot, setScreenshot] = useState("");
  const [isLoading, setIsLoading]   = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [lastFetch, setLastFetch]   = useState(null);
  const [fetchError, setFetchError] = useState("");
  const intervalRef = useRef(null);
  const loadingRef  = useRef(false);

  /* latest tool event (for overlay) */
  const latestToolEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.kind === "tool_call_started" || e?.kind === "tool_call_finished") return e;
    }
    return null;
  }, [events]);

  /* current page URL from navigate events */
  const currentUrl = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.kind === "tool_call_started" || e?.kind === "tool_call_finished") {
        const args = e?.details?.args || e?.details?.arguments || {};
        if (args.url) return args.url;
      }
    }
    return "";
  }, [events]);

  const fetchScreenshot = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setIsLoading(true);
    setFetchError("");
    try {
      const url = standalone
        ? apiUrl("/ui/browser/screenshot")
        : apiUrl(`/ui/runs/${runId}/screenshot`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const imgSrc = data.screenshot || data.screenshot_url || "";
      if (imgSrc) {
        setScreenshot(imgSrc);
        setLastFetch(new Date());
      }
    } catch (e) {
      setFetchError(e.message);
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  }, [runId, standalone]);

  /* auto-refresh interval */
  useEffect(() => {
    if (!autoRefresh || (!standalone && !runId)) { clearInterval(intervalRef.current); return; }
    fetchScreenshot();
    intervalRef.current = setInterval(fetchScreenshot, 2500);
    return () => clearInterval(intervalRef.current);
  }, [autoRefresh, fetchScreenshot]);

  /* fetch on tool completion (immediate feedback) */
  const lastToolSeq = latestToolEvent?.seq;
  useEffect(() => {
    if (latestToolEvent?.kind === "tool_call_finished") fetchScreenshot();
  }, [lastToolSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-[14px] border ${isFullscreen ? "fixed inset-4 z-50" : ""}`}
      style={{
        borderColor: "var(--line)",
        background: "var(--card)",
        boxShadow: isFullscreen
          ? "0 24px 72px rgba(0,0,0,0.55)"
          : "var(--shadow-card)",
        minHeight: isFullscreen ? undefined : 260,
      }}
    >
      {/* ── Browser chrome header ── */}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.018)" }}
      >
        {/* macOS traffic lights */}
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full" style={{ background: "#FF5F57" }} />
          <div className="h-2.5 w-2.5 rounded-full" style={{ background: "#FEBC2E" }} />
          <div className="h-2.5 w-2.5 rounded-full" style={{ background: "#28C840" }} />
        </div>

        {/* URL bar */}
        <div
          className="mx-2 flex flex-1 items-center gap-2 overflow-hidden rounded-md px-2.5 py-1"
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid var(--line)" }}
        >
          <Monitor className="h-3 w-3 shrink-0" style={{ color: "var(--mute-3)" }} />
          <span
            className="flex-1 truncate font-mono text-[10.5px]"
            style={{ color: currentUrl ? "var(--mute-2)" : "var(--mute-3)" }}
            title={currentUrl || undefined}
          >
            {currentUrl || "Browser live view"}
          </span>
          {isLoading && (
            <span className="owc-spinner owc-spinner-sm shrink-0" style={{ color: "var(--sky)" }} />
          )}
        </div>

        {/* Controls */}
        <button
          type="button"
          title="Refresh"
          onClick={fetchScreenshot}
          className="rounded p-1 transition-colors"
          style={{ color: "var(--mute-2)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--mute-2)")}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          onClick={() => setIsFullscreen((v) => !v)}
          className="rounded p-1 transition-colors"
          style={{ color: "var(--mute-2)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--mute-2)")}
        >
          {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        {onClose && (
          <button
            type="button"
            title="Close"
            onClick={onClose}
            className="rounded p-1 transition-colors"
            style={{ color: "var(--mute-2)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--rose)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--mute-2)")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* ── Screenshot viewport ── */}
      <div
        className="relative flex-1 overflow-hidden"
        style={{ background: "#050508", minHeight: isFullscreen ? 0 : 200 }}
      >
        {screenshot ? (
          <>
            <img
              src={screenshot}
              alt="Browser viewport"
              className="h-full w-full object-contain"
              style={{ imageRendering: "auto", display: "block" }}
            />
            {/* Scan-line aesthetic overlay */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.06) 2px, rgba(0,0,0,0.06) 4px)",
              }}
            />
          </>
        ) : (
          <div
            className="flex h-full items-center justify-center"
            style={{ color: "var(--mute-3)", minHeight: 200 }}
          >
            {fetchError ? (
              <div className="text-center px-4">
                <div className="text-[12px] font-medium" style={{ color: "var(--rose)" }}>
                  No screenshot available
                </div>
                <div className="mt-1 text-[11px] opacity-60">{fetchError}</div>
              </div>
            ) : isLoading ? (
              <div className="flex flex-col items-center gap-2">
                <span className="owc-spinner owc-spinner-lg" style={{ color: "var(--sky)" }} />
                <div className="text-[11px]">Capturing…</div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Monitor className="h-8 w-8 opacity-20" />
                <div className="text-[12px]">Waiting for browser activity…</div>
              </div>
            )}
          </div>
        )}

        {/* Tool activity overlay */}
        {screenshot && <ToolOverlay event={latestToolEvent} />}
      </div>

      {/* ── Footer status bar ── */}
      <div
        className="flex shrink-0 items-center gap-3 border-t px-3 py-1.5"
        style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.012)" }}
      >
        <span className="font-mono text-[9.5px]" style={{ color: "var(--mute-3)" }}>
          {lastFetch ? `Updated ${lastFetch.toLocaleTimeString()}` : "Waiting…"}
        </span>
        {autoRefresh && (
          <span className="flex items-center gap-1 font-mono text-[9.5px]" style={{ color: "var(--mint)" }}>
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--mint)", animation: "breathe 2s ease-in-out infinite" }}
            />
            Live
          </span>
        )}
      </div>
    </div>
  );
}

/* ── Screenshot gallery (for persisted runs) ────────────────────────────── */
export function ScreenshotGallery({ screenshots = [] }) {
  const [selected, setSelected] = useState(null);
  const [zoom, setZoom] = useState(false);

  if (!screenshots.length) {
    return (
      <div
        className="flex h-32 items-center justify-center rounded-[14px] border"
        style={{ borderColor: "var(--line)", background: "var(--card)", color: "var(--mute-3)" }}
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
      style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
    >
      {/* header */}
      <div
        className="flex items-center justify-between border-b px-4 py-2.5"
        style={{ borderColor: "var(--line)" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium" style={{ color: "var(--ink)" }}>Screenshots</span>
          <span className="font-mono text-[11px]" style={{ color: "var(--mute)" }}>
            {screenshots.length} captured
          </span>
        </div>
      </div>

      {/* main viewer */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events,jsx-a11y/no-static-element-interactions */}
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

      {/* thumbnails strip */}
      {screenshots.length > 1 && (
        <div
          className="flex gap-2 overflow-x-auto border-t p-2"
          style={{ borderColor: "var(--line)" }}
        >
          {screenshots.map((src, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setSelected(src)}
              className="shrink-0 overflow-hidden rounded-[6px] border transition-all"
              style={{
                width: 72,
                height: 48,
                borderColor: src === active ? "var(--signal)" : "var(--line)",
                boxShadow: src === active ? "0 0 0 2px color-mix(in oklch, var(--signal) 35%, transparent)" : "none",
                background: "#050508",
              }}
            >
              <img
                src={src}
                alt={`Screenshot ${idx + 1}`}
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}

      {/* fullscreen zoom modal */}
      {zoom && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.88)", backdropFilter: "blur(8px)" }}
          onClick={() => setZoom(false)}
        >
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full border p-2"
            style={{ borderColor: "var(--line)", background: "var(--card)", color: "var(--mute)" }}
            onClick={() => setZoom(false)}
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={active}
            alt="Screenshot fullscreen"
            className="max-h-[90vh] max-w-[90vw] rounded-[8px] object-contain"
            style={{ boxShadow: "0 24px 72px rgba(0,0,0,0.7)" }}
          />
        </div>
      )}
    </div>
  );
}
