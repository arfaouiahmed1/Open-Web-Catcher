"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/api";

/* ─── defaults ──────────────────────────────────────────────────────────── */

const PREFS_KEY = "owc_notif_prefs";
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

/* ─── kind → toast meta ─────────────────────────────────────────────────── */

function toastMeta(event) {
  const kind = event.kind || "";
  const d    = event.details || {};
  const msg  = event.message || "";

  switch (kind) {
    case "pipeline_started":
      return { color: "var(--signal)", icon: "▶", text: `Pipeline started${msg ? ` — ${msg}` : ""}` };
    case "agent_started":
      return { color: "var(--sky)", icon: "◈", text: `${d.actor || event.actor || "Agent"} started` };
    case "agent_finished": {
      const dur = d.duration_seconds ? ` in ${Number(d.duration_seconds).toFixed(1)}s` : "";
      return { color: "var(--mint)", icon: "✓", text: `${d.actor || event.actor || "Agent"} finished${dur}` };
    }
    case "agent_failed":
      return { color: "var(--rose)", icon: "✕", text: `${d.actor || event.actor || "Agent"} FAILED${d.error ? ` — ${String(d.error).slice(0, 60)}` : ""}` };
    case "pipeline_finished":
      return { color: "var(--mint)", icon: "✓✓", text: `Run complete${d.result_count != null ? ` — ${d.result_count} results` : ""}` };
    case "pipeline_failed":
      return { color: "var(--rose)", icon: "✕", text: `Pipeline failed${d.error ? ` — ${String(d.error).slice(0, 60)}` : ""}` };
    case "run_cancelled":
      return { color: "var(--mute)", icon: "◌", text: "Run cancelled" };
    default:
      return null;
  }
}

const TERMINAL_KINDS = new Set(["pipeline_finished", "pipeline_failed", "run_cancelled"]);

/* ─── context ────────────────────────────────────────────────────────────── */

const NotifContext = createContext({ prefs: DEFAULT_PREFS, setPrefs: () => {} });
export function useNotifPrefs() { return useContext(NotifContext); }

/* ─── single toast ───────────────────────────────────────────────────────── */

function Toast({ id, color, icon, text, onDismiss }) {
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setVisible(true), 10);
    const t2 = setTimeout(() => dismiss(), 4200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  function dismiss() {
    setLeaving(true);
    setTimeout(() => onDismiss(id), 180);
  }

  return (
    <div
      className="flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-[12.5px] shadow-xl"
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
      <span className="mt-px shrink-0 text-[11px] font-bold" style={{ color }}>{icon}</span>
      <span className="flex-1 leading-snug" style={{ color: "var(--ink-dim)" }}>{text}</span>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 text-[11px] leading-none transition-opacity hover:opacity-70"
        style={{ color: "var(--mute-2)" }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

/* ─── provider ───────────────────────────────────────────────────────────── */

export function NotificationProvider({ children }) {
  const [toasts, setToasts]   = useState([]);
  const [prefs, setPrefsState] = useState(DEFAULT_PREFS);
  const trackedRuns            = useRef(new Set());
  const streamRefs             = useRef({});
  const toastIdRef             = useRef(0);

  /* load prefs on mount */
  useEffect(() => { setPrefsState(loadPrefs()); }, []);

  function setPrefs(next) {
    setPrefsState(next);
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch {}
  }

  const pushToast = useCallback((meta) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev.slice(-4), { id, ...meta }]);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /* open SSE stream for a run */
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

  /* poll overview every 5s, open streams for new active runs */
  useEffect(() => {
    let alive = true;

    async function poll() {
      try {
        const res = await fetch(apiUrl("/ui/overview"));
        if (!res.ok || !alive) return;
        const data = await res.json();
        const activeRuns = data?.active_runs || [];
        for (const run of activeRuns) {
          const id = run.run_id;
          if (id && !trackedRuns.current.has(id)) {
            trackedRuns.current.add(id);
            watchRun(id);
          }
        }
      } catch { /* network hiccup — ignore */ }
    }

    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
      for (const es of Object.values(streamRefs.current)) {
        try { es.close(); } catch {}
      }
      streamRefs.current = {};
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <NotifContext.Provider value={{ prefs, setPrefs }}>
      {children}

      {/* toast stack — fixed bottom-right */}
      <div
        className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 items-end pointer-events-none"
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
