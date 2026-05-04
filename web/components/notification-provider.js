"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { ArrowRight, Bell, Play, X, XCircle } from "lucide-react";
import { apiUrl } from "@/lib/api";

// ─── Constants ───────────────────────────────────────────────────────────────

const PREFS_KEY = "owc_notif_prefs";
const HISTORY_KEY = "owc_notif_history";
const MAX_HISTORY = 60;

const DEFAULT_PREFS = {
  pipeline_started: true,
  agent_started: true,
  agent_finished: true,
  agent_failed: true,
  pipeline_finished: true,
  pipeline_failed: true,
  run_cancelled: true,
};

const TERMINAL_KINDS = new Set([
  "pipeline_finished",
  "pipeline_failed",
  "run_cancelled",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw
      ? { ...DEFAULT_PREFS, ...JSON.parse(raw) }
      : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(items) {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(items.slice(0, MAX_HISTORY)),
    );
  } catch {}
}

/** Map an event object → toast metadata, or null if unrecognised. */
function toastMeta(event) {
  const kind = event.kind || "";
  const d = event.details || {};
  const msg = event.message || "";

  switch (kind) {
    case "pipeline_started":
      return {
        color: "var(--signal)",
        iconName: "play",
        text: `Pipeline started${msg ? ` — ${msg}` : ""}`,
        kind,
      };
    case "agent_started":
      return {
        color: "var(--sky)",
        iconName: "diamond",
        text: `${d.actor || event.actor || "Agent"} started`,
        kind,
      };
    case "agent_finished": {
      const dur = d.duration_seconds
        ? ` in ${Number(d.duration_seconds).toFixed(1)}s`
        : "";
      return {
        color: "var(--mint)",
        iconName: "check",
        text: `${d.actor || event.actor || "Agent"} finished${dur}`,
        kind,
      };
    }
    case "agent_failed":
      return {
        color: "var(--rose)",
        iconName: "cross",
        text: `${d.actor || event.actor || "Agent"} FAILED${
          d.error ? ` — ${String(d.error).slice(0, 60)}` : ""
        }`,
        kind,
      };
    case "pipeline_finished":
      return {
        color: "var(--mint)",
        iconName: "double-check",
        text: `Run complete${
          d.result_count != null ? ` — ${d.result_count} results` : ""
        }`,
        kind,
      };
    case "pipeline_failed":
      return {
        color: "var(--rose)",
        iconName: "cross",
        text: `Pipeline failed${
          d.error ? ` — ${String(d.error).slice(0, 60)}` : ""
        }`,
        kind,
      };
    case "run_cancelled":
      return {
        color: "var(--mute)",
        iconName: "circle",
        text: "Run cancelled",
        kind,
      };
    default:
      return null;
  }
}

/** Render a small icon glyph for a given iconName string. */
function KindIcon({ name, size = 10 }) {
  if (name === "play")
    return <Play style={{ width: size, height: size }} strokeWidth={2.5} />;
  if (name === "check")
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" fill="none">
        <polyline
          points="1.5,5.5 4,8 8.5,2.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (name === "double-check")
    return (
      <svg width={size} height={size} viewBox="0 0 12 10" fill="none">
        <polyline
          points="1,5 3.5,7.5 7.5,2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points="5,5 7.5,7.5 11.5,2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (name === "cross")
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" fill="none">
        <line
          x1="2"
          y1="2"
          x2="8"
          y2="8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <line
          x1="8"
          y1="2"
          x2="2"
          y2="8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  if (name === "diamond")
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" fill="none">
        <polygon
          points="5,1 9,5 5,9 1,5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    );
  // circle / fallback
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none">
      <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** Format a timestamp as a human-friendly relative string. */
function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) {
    const m = Math.floor(diff / 60_000);
    return `${m}m ago`;
  }
  if (diff < 86_400_000) {
    const h = Math.floor(diff / 3_600_000);
    return `${h}h ago`;
  }
  return new Date(ts).toLocaleDateString();
}

/** Return true if timestamp is today (local calendar day). */
function isToday(ts) {
  const d = new Date(ts);
  const n = new Date();
  return (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  );
}

// ─── Context ─────────────────────────────────────────────────────────────────

const NotifContext = createContext({
  prefs: DEFAULT_PREFS,
  setPrefs: () => {},
  history: [],
  unreadCount: 0,
  clearHistory: () => {},
  markAllRead: () => {},
});

export function useNotifPrefs() {
  return useContext(NotifContext);
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function Toast({ id, color, iconName, text, runId, onDismiss }) {
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const mountTimeRef = useRef(new Date().toLocaleTimeString());

  useEffect(() => {
    const t1 = setTimeout(() => setVisible(true), 10);
    const t2 = setTimeout(() => dismiss(), 5500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function dismiss() {
    setLeaving(true);
    setTimeout(() => onDismiss(id), 200);
  }

  return (
    <div
      className="flex items-start gap-3 rounded-[14px] px-4 py-3 shadow-2xl"
      style={{
        background: "var(--panel-2, var(--panel))",
        border: `1px solid color-mix(in oklch, ${color} 28%, var(--line))`,
        transform:
          visible && !leaving
            ? "translateX(0) scale(1)"
            : "translateX(20px) scale(0.97)",
        opacity: visible && !leaving ? 1 : 0,
        transition: leaving
          ? "opacity 180ms ease, transform 180ms ease"
          : "opacity 220ms ease, transform 280ms cubic-bezier(0.34,1.56,0.64,1)",
        maxWidth: "340px",
        minWidth: "240px",
        backdropFilter: "blur(12px)",
      }}
    >
      {/* Icon badge */}
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{
          background: `color-mix(in oklch, ${color} 18%, transparent)`,
          border: `1px solid color-mix(in oklch, ${color} 30%, transparent)`,
          color,
        }}
      >
        <KindIcon name={iconName} size={11} />
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1 pt-0.5">
        <div
          className="text-[12.5px] font-medium leading-snug"
          style={{ color: "var(--ink)" }}
        >
          {text}
        </div>
        <div
          className="mt-0.5 flex items-center gap-2 text-[10.5px]"
          style={{ color: "var(--mute-2)" }}
        >
          <span>{mountTimeRef.current}</span>
          {runId && (
            <Link
              href={`/runs/${runId}`}
              onClick={dismiss}
              className="ml-auto flex items-center gap-1 font-semibold transition-colors"
              style={{ color: "var(--signal)" }}
            >
              View <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      </div>

      {/* Dismiss */}
      <button
        type="button"
        onClick={dismiss}
        className="mt-0.5 shrink-0 rounded-full p-1 transition-colors hover:bg-muted/30"
        style={{ color: "var(--mute-2)" }}
        aria-label="Dismiss"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// ─── NotificationBell ────────────────────────────────────────────────────────

export function NotificationBell() {
  const { history, unreadCount, clearHistory, markAllRead } =
    useContext(NotifContext);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef(null);

  // Animate in
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => setMounted(true));
      markAllRead();
    } else {
      setMounted(false);
    }
  }, [open, markAllRead]);

  // Close on outside click
  useEffect(() => {
    function onOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  // Group history by Today / Earlier
  const todayItems = history.filter((item) => isToday(item.ts));
  const earlierItems = history.filter((item) => !isToday(item.ts));

  return (
    <div ref={ref} className="relative">
      {/* Bell button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg border transition-colors"
        style={{
          borderColor: open
            ? "color-mix(in oklch, var(--signal) 40%, var(--line))"
            : "var(--line)",
          background: open
            ? "color-mix(in oklch, var(--signal) 8%, transparent)"
            : "var(--card)",
          color: open ? "var(--signal)" : "var(--mute)",
        }}
        aria-label="Notifications"
      >
        <Bell className="h-3.5 w-3.5" />
        {unreadCount > 0 && (
          <span
            className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold"
            style={{ background: "var(--rose)", color: "#fff" }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-2 flex w-[340px] flex-col overflow-hidden rounded-[16px] border shadow-2xl"
          style={{
            background: "var(--panel-2, var(--panel))",
            borderColor: "var(--line-hi)",
            transform: mounted
              ? "translateY(0) scale(1)"
              : "translateY(-6px) scale(0.97)",
            opacity: mounted ? 1 : 0,
            transition:
              "opacity 180ms ease, transform 200ms cubic-bezier(0.34,1.56,0.64,1)",
            transformOrigin: "top right",
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between border-b px-4 py-3"
            style={{ borderColor: "var(--line)" }}
          >
            <div className="flex items-center gap-2">
              <span
                className="text-[13px] font-semibold"
                style={{ color: "var(--ink)" }}
              >
                Notifications
              </span>
              {history.length > 0 && (
                <span
                  className="flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold"
                  style={{
                    background:
                      "color-mix(in oklch, var(--signal) 15%, var(--line))",
                    color: "var(--mute)",
                  }}
                >
                  {history.length > MAX_HISTORY
                    ? `${MAX_HISTORY}+`
                    : history.length}
                </span>
              )}
            </div>
            {history.length > 0 && (
              <button
                type="button"
                onClick={clearHistory}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors hover:bg-muted/30"
                style={{ color: "var(--mute)" }}
              >
                <XCircle className="h-3 w-3" />
                Clear all
              </button>
            )}
          </div>

          {/* Body */}
          <div className="max-h-[380px] overflow-y-auto">
            {history.length === 0 ? (
              /* Empty state */
              <div className="flex flex-col items-center gap-3 px-6 py-10">
                <div
                  className="flex h-11 w-11 items-center justify-center rounded-full"
                  style={{
                    background:
                      "color-mix(in oklch, var(--mute) 12%, transparent)",
                    color: "var(--mute-2)",
                  }}
                >
                  <Bell className="h-5 w-5" />
                </div>
                <div className="text-center">
                  <p
                    className="text-[12.5px] font-medium"
                    style={{ color: "var(--ink-dim)" }}
                  >
                    All caught up
                  </p>
                  <p
                    className="mt-0.5 text-[11px]"
                    style={{ color: "var(--mute)" }}
                  >
                    Notifications from active runs will appear here.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {/* Today group */}
                {todayItems.length > 0 && (
                  <div>
                    <div
                      className="sticky top-0 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest"
                      style={{
                        color: "var(--mute)",
                        background: "var(--panel-2, var(--panel))",
                        borderBottom: "1px solid var(--line)",
                      }}
                    >
                      Today
                    </div>
                    {todayItems.map((item) => (
                      <HistoryRow
                        key={item.id}
                        item={item}
                        onNavigate={() => setOpen(false)}
                      />
                    ))}
                  </div>
                )}

                {/* Earlier group */}
                {earlierItems.length > 0 && (
                  <div>
                    <div
                      className="sticky top-0 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest"
                      style={{
                        color: "var(--mute)",
                        background: "var(--panel-2, var(--panel))",
                        borderBottom: "1px solid var(--line)",
                      }}
                    >
                      Earlier
                    </div>
                    {earlierItems.map((item) => (
                      <HistoryRow
                        key={item.id}
                        item={item}
                        onNavigate={() => setOpen(false)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Single row in the notification history list. */
function HistoryRow({ item, onNavigate }) {
  const rowContent = (
    <div
      className="flex items-start gap-3 border-b px-4 py-2.5 transition-colors"
      style={{
        borderColor: "var(--line)",
        background: item.read
          ? "transparent"
          : "color-mix(in oklch, var(--signal) 4%, transparent)",
        cursor: item.runId ? "pointer" : "default",
      }}
    >
      {/* Colored dot-badge */}
      <div
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
        style={{
          background: `color-mix(in oklch, ${item.color} 15%, transparent)`,
          color: item.color,
        }}
      >
        <KindIcon name={item.iconName} size={9} />
      </div>

      {/* Text */}
      <div className="min-w-0 flex-1">
        <div
          className="text-[12px] leading-snug"
          style={{
            color: item.read ? "var(--ink-dim)" : "var(--ink)",
            fontWeight: item.read ? 400 : 500,
          }}
        >
          {item.text}
        </div>
        <div
          className="mt-0.5 text-[10.5px]"
          style={{ color: "var(--mute-2)" }}
        >
          {relativeTime(item.ts)}
        </div>
      </div>

      {/* Right side: unread dot + navigate arrow */}
      <div className="flex shrink-0 flex-col items-center gap-1.5 pt-1">
        {!item.read && (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--signal)" }}
          />
        )}
        {item.runId && (
          <ArrowRight
            className="h-3 w-3 opacity-50"
            style={{ color: "var(--signal)" }}
          />
        )}
      </div>
    </div>
  );

  if (item.runId) {
    return (
      <Link
        href={`/runs/${item.runId}`}
        onClick={onNavigate}
        className="block hover:bg-muted/30"
      >
        {rowContent}
      </Link>
    );
  }
  return rowContent;
}

// ─── NotificationProvider ─────────────────────────────────────────────────────

export function NotificationProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [prefs, setPrefsState] = useState(DEFAULT_PREFS);
  const [history, setHistory] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const trackedRuns = useRef(new Set());
  const streamRefs = useRef({});
  const toastIdRef = useRef(0);
  const histIdRef = useRef(0);

  // Hydrate from localStorage once
  useEffect(() => {
    setPrefsState(loadPrefs());
    const h = loadHistory();
    setHistory(h);
    setUnreadCount(h.filter((item) => !item.read).length);
  }, []);

  function setPrefs(next) {
    setPrefsState(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {}
  }

  function clearHistory() {
    setHistory([]);
    setUnreadCount(0);
    saveHistory([]);
  }

  const markAllRead = useCallback(() => {
    setHistory((prev) => {
      const next = prev.map((item) => ({ ...item, read: true }));
      saveHistory(next);
      return next;
    });
    setUnreadCount(0);
  }, []);

  const pushToast = useCallback((meta) => {
    const id = ++toastIdRef.current;
    const histId = ++histIdRef.current;

    setToasts((prev) => [...prev.slice(-4), { id, ...meta }]);

    setHistory((prev) => {
      const next = [
        { id: histId, ...meta, ts: Date.now(), read: false },
        ...prev,
      ].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
    setUnreadCount((c) => c + 1);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /**
   * Open an EventSource for a run and parse both event formats:
   *   Format 1 — direct:  { kind, message, details, … }
   *   Format 2 — batched: { events: […], metrics: {…}, completed: true }
   */
  function watchRun(runId) {
    if (streamRefs.current[runId]) return;

    const es = new EventSource(apiUrl(`/ui/runs/${runId}/stream`));
    streamRefs.current[runId] = es;

    es.onmessage = (ev) => {
      let payload;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") return;

      const currentPrefs = loadPrefs();

      // Format 1: direct event object { kind, message, details }
      if (payload.kind) {
        const k = payload.kind;
        if (currentPrefs[k]) {
          const meta = toastMeta(payload);
          if (meta) pushToast({ ...meta, runId });
        }
      }

      // Format 2: batched events array { events: [...] }
      if (Array.isArray(payload.events)) {
        for (const event of payload.events) {
          if (!event || !event.kind) continue;
          const k = event.kind;
          if (!currentPrefs[k]) continue;
          const meta = toastMeta(event);
          if (meta) pushToast({ ...meta, runId });
        }
      }

      // Close stream on terminal states
      const isTerminal =
        payload.completed || payload.error || TERMINAL_KINDS.has(payload.kind);

      if (isTerminal) {
        es.close();
        delete streamRefs.current[runId];
      }
    };

    es.onerror = () => {
      es.close();
      delete streamRefs.current[runId];
    };
  }

  // Poll for active runs + listen for manual track events
  useEffect(() => {
    let alive = true;

    function onTrackRun(event) {
      const runId = event?.detail?.runId;
      if (!runId || trackedRuns.current.has(runId)) return;
      trackedRuns.current.add(runId);
      watchRun(runId);
    }

    async function poll() {
      try {
        const res = await fetch(apiUrl("/ui/runs?limit=50&offset=0"));
        if (!res.ok || !alive) return;
        const data = await res.json();
        const activeRuns = data?.rows || [];
        for (const run of activeRuns) {
          const status = String(
            run?.final_status || run?.status || "",
          ).toLowerCase();
          const id = run.run_id;
          if (
            id &&
            ["queued", "running"].includes(status) &&
            !trackedRuns.current.has(id)
          ) {
            trackedRuns.current.add(id);
            watchRun(id);
          }
        }
      } catch {
        /* ignore network errors */
      }
    }

    window.addEventListener("owc:track-run", onTrackRun);
    poll();
    const timer = setInterval(poll, 5_000);

    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("owc:track-run", onTrackRun);
      for (const es of Object.values(streamRefs.current)) {
        try {
          es.close();
        } catch {}
      }
      streamRefs.current = {};
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <NotifContext.Provider
      value={{
        prefs,
        setPrefs,
        history,
        unreadCount,
        clearHistory,
        markAllRead,
      }}
    >
      {children}

      {/* Toast stack — bottom-right, stacks upward */}
      <div
        className="pointer-events-none fixed bottom-6 right-6 z-[9999] flex flex-col-reverse items-end gap-2"
        aria-live="polite"
        aria-label="Notifications"
      >
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <Toast {...t} onDismiss={dismissToast} />
          </div>
        ))}
      </div>
    </NotifContext.Provider>
  );
}
