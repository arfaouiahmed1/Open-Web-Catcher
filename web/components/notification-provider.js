"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Bell, X, XCircle } from "lucide-react";
import { apiUrl } from "@/lib/api";

const PREFS_KEY = "owc_notif_prefs";
const HISTORY_KEY = "owc_notif_history";
const MAX_HISTORY = 60;

const DEFAULT_PREFS = {
  pipeline_started:  true,
  agent_started:     true,
  agent_finished:    true,
  agent_failed:      true,
  pipeline_finished: true,
  pipeline_failed:   true,
  run_cancelled:     true,
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
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
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY))); } catch {}
}

function toastMeta(event) {
  const kind = event.kind || "";
  const d    = event.details || {};
  const msg  = event.message || "";

  switch (kind) {
    case "pipeline_started":
      return { color: "var(--signal)", icon: "▶", text: `Pipeline started${msg ? ` — ${msg}` : ""}`, kind };
    case "agent_started":
      return { color: "var(--sky)", icon: "◈", text: `${d.actor || event.actor || "Agent"} started`, kind };
    case "agent_finished": {
      const dur = d.duration_seconds ? ` in ${Number(d.duration_seconds).toFixed(1)}s` : "";
      return { color: "var(--mint)", icon: "✓", text: `${d.actor || event.actor || "Agent"} finished${dur}`, kind };
    }
    case "agent_failed":
      return { color: "var(--rose)", icon: "✕", text: `${d.actor || event.actor || "Agent"} FAILED${d.error ? ` — ${String(d.error).slice(0, 60)}` : ""}`, kind };
    case "pipeline_finished":
      return { color: "var(--mint)", icon: "✓✓", text: `Run complete${d.result_count != null ? ` — ${d.result_count} results` : ""}`, kind };
    case "pipeline_failed":
      return { color: "var(--rose)", icon: "✕", text: `Pipeline failed${d.error ? ` — ${String(d.error).slice(0, 60)}` : ""}`, kind };
    case "run_cancelled":
      return { color: "var(--mute)", icon: "◌", text: "Run cancelled", kind };
    default:
      return null;
  }
}

const TERMINAL_KINDS = new Set(["pipeline_finished", "pipeline_failed", "run_cancelled"]);

const NotifContext = createContext({
  prefs: DEFAULT_PREFS,
  setPrefs: () => {},
  history: [],
  unreadCount: 0,
  clearHistory: () => {},
  markAllRead: () => {},
});

export function useNotifPrefs() { return useContext(NotifContext); }

function Toast({ id, color, icon, text, onDismiss }) {
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setVisible(true), 10);
    const t2 = setTimeout(() => dismiss(), 5000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function dismiss() {
    setLeaving(true);
    setTimeout(() => onDismiss(id), 180);
  }

  return (
    <div
      className="flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[12.5px] shadow-xl"
      style={{
        background: "var(--panel-2, var(--panel))",
        border: `1px solid color-mix(in oklch, ${color} 30%, var(--line))`,
        transform: visible && !leaving ? "translateX(0)" : "translateX(24px)",
        opacity: visible && !leaving ? 1 : 0,
        transition: leaving
          ? "opacity 160ms ease, transform 160ms ease"
          : "opacity 200ms ease, transform 200ms cubic-bezier(0.34,1.56,0.64,1)",
        maxWidth: "320px",
        minWidth: "220px",
      }}
    >
      <span className="shrink-0 text-[11px] font-bold" style={{ color }}>{icon}</span>
      <span className="flex-1 leading-snug" style={{ color: "var(--ink-dim)" }}>{text}</span>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded p-0.5 transition-colors hover:bg-white/10"
        style={{ color: "var(--mute-2)" }}
        aria-label="Dismiss"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function NotificationBell() {
  const { history, unreadCount, clearHistory, markAllRead } = useContext(NotifContext);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    if (open) {
      markAllRead();
      document.addEventListener("mousedown", onOutside);
    }
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open, markAllRead]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg border transition-colors"
        style={{
          borderColor: open ? "color-mix(in oklch, var(--signal) 40%, var(--line))" : "var(--line)",
          background: open ? "color-mix(in oklch, var(--signal) 8%, transparent)" : "var(--card)",
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

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-2 flex w-[320px] flex-col overflow-hidden rounded-[14px] border shadow-xl"
          style={{
            background: "var(--panel-2, var(--panel))",
            borderColor: "var(--line-hi)",
          }}
        >
          <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
            <span className="text-[12.5px] font-semibold text-[var(--ink)]">Notifications</span>
            {history.length > 0 && (
              <button
                type="button"
                onClick={clearHistory}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors hover:bg-white/6"
                style={{ color: "var(--mute)" }}
              >
                <XCircle className="h-3 w-3" />
                Clear all
              </button>
            )}
          </div>

          <div className="max-h-[340px] overflow-y-auto">
            {history.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12px]" style={{ color: "var(--mute)" }}>
                No notifications yet
              </div>
            ) : (
              history.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-2.5 border-b px-4 py-2.5"
                  style={{ borderColor: "var(--line)" }}
                >
                  <span className="mt-0.5 shrink-0 text-[10px] font-bold" style={{ color: item.color }}>{item.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] leading-snug" style={{ color: "var(--ink-dim)" }}>{item.text}</div>
                    <div className="mt-0.5 text-[10.5px]" style={{ color: "var(--mute-2)" }}>
                      {new Date(item.ts).toLocaleTimeString()}
                    </div>
                  </div>
                  {!item.read && (
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--signal)" }} />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function NotificationProvider({ children }) {
  const [toasts, setToasts]   = useState([]);
  const [prefs, setPrefsState] = useState(DEFAULT_PREFS);
  const [history, setHistory] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const trackedRuns  = useRef(new Set());
  const streamRefs   = useRef({});
  const toastIdRef   = useRef(0);
  const histIdRef    = useRef(0);

  useEffect(() => {
    setPrefsState(loadPrefs());
    const h = loadHistory();
    setHistory(h);
    setUnreadCount(h.filter((item) => !item.read).length);
  }, []);

  function setPrefs(next) {
    setPrefsState(next);
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch {}
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
    setToasts((prev) => [...prev.slice(-4), { id, ...meta }]);

    const histId = ++histIdRef.current;
    setHistory((prev) => {
      const next = [{ id: histId, ...meta, ts: Date.now(), read: false }, ...prev].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
    setUnreadCount((c) => c + 1);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  function watchRun(runId) {
    if (streamRefs.current[runId]) return;
    const es = new EventSource(apiUrl(`/ui/runs/${runId}/stream`));
    streamRefs.current[runId] = es;

    es.onmessage = (ev) => {
      let event;
      try { event = JSON.parse(ev.data); } catch { return; }

      const currentPrefs = loadPrefs();
      const kind = event.kind || "";
      if (!currentPrefs[kind]) return;

      const meta = toastMeta(event);
      if (meta) pushToast(meta);

      if (TERMINAL_KINDS.has(kind)) {
        es.close();
        delete streamRefs.current[runId];
      }
    };
    es.onerror = () => {
      es.close();
      delete streamRefs.current[runId];
    };
  }

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
          const status = String(run?.final_status || run?.status || "").toLowerCase();
          const id = run.run_id;
          if (id && ["queued", "running"].includes(status) && !trackedRuns.current.has(id)) {
            trackedRuns.current.add(id);
            watchRun(id);
          }
        }
      } catch { /* ignore */ }
    }

    window.addEventListener("owc:track-run", onTrackRun);
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("owc:track-run", onTrackRun);
      for (const es of Object.values(streamRefs.current)) {
        try { es.close(); } catch {}
      }
      streamRefs.current = {};
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <NotifContext.Provider value={{ prefs, setPrefs, history, unreadCount, clearHistory, markAllRead }}>
      {children}

      <div
        className="fixed bottom-6 right-6 z-[9999] flex flex-col-reverse gap-2 items-end pointer-events-none"
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
