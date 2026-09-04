"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, memo } from "react";
import Link from "next/link";
import { ArrowRight, Bell, Play, X, XCircle } from "lucide-react";
import { apiUrl, eventSourceUrl } from "@/lib/api";
import { formatDate, formatTime, formatTimestamp, parseTimestamp } from "@/lib/datetime";

// ─── Constants ───────────────────────────────────────────────────────────────

const PREFS_KEY = "owc_notif_prefs";
const HISTORY_KEY = "owc_notif_history";
const MAX_HISTORY = 60;
const MAX_NOTIFICATION_STREAMS = 2;

export type NotificationKind =
  | "pipeline_started"
  | "agent_started"
  | "agent_finished"
  | "agent_failed"
  | "pipeline_finished"
  | "pipeline_failed"
  | "run_cancelled"
  | "server_activated"
  | "stream_extracted"
  | "hosting_page_discovered"
  | "player_failed"
  | "cost_threshold_exceeded"
  | "queue_enqueued"
  | "hosting_item_started"
  | "hosting_item_finished"
  | "pool_drained"
  | "plan_step_update";

export type NotificationPrefs = Record<NotificationKind, boolean>;

export const DEFAULT_PREFS: NotificationPrefs = {
  pipeline_started: true,
  agent_started: true,
  agent_finished: true,
  agent_failed: true,
  pipeline_finished: true,
  pipeline_failed: true,
  run_cancelled: true,
  server_activated: true,
  stream_extracted: true,
  hosting_page_discovered: true,
  player_failed: true,
  cost_threshold_exceeded: true,
  queue_enqueued: true,
  hosting_item_started: true,
  hosting_item_finished: true,
  pool_drained: true,
  plan_step_update: true,
};

const TERMINAL_KINDS = new Set<NotificationKind>(["pipeline_finished", "pipeline_failed", "run_cancelled"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? ({ ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<NotificationPrefs>) } as NotificationPrefs) : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function loadHistory(): NotificationHistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as NotificationHistoryItem[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(items: NotificationHistoryItem[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY)));
  } catch {
    // ignore quota
  }
}

export interface TraceEvent {
  kind?: string;
  actor?: string;
  message?: string;
  timestamp?: string;
  seq?: number;
  details?: Record<string, unknown>;
  runId?: string;
  run_id?: string;
}

export interface ToastMeta {
  color: string;
  iconName: string;
  text: string;
  kind: string;
}

/** Map an event object → toast metadata, or null if unrecognised. */
function toastMeta(event: TraceEvent): ToastMeta | null {
  const kind = (event.kind as string) || "";
  const d = (event.details ?? {}) as Record<string, unknown>;
  const msg = event.message ?? "";

  switch (kind) {
    case "pipeline_started":
      return { color: "var(--signal)", iconName: "play", text: `Pipeline started${msg ? ` — ${msg}` : ""}`, kind };
    case "agent_started":
      return { color: "var(--sky)", iconName: "diamond", text: `${(d.actor as string) ?? (event.actor as string) ?? "Agent"} started`, kind };
    case "agent_finished": {
      const dur = (d.duration_seconds as number) ? ` in ${Number(d.duration_seconds).toFixed(1)}s` : "";
      return { color: "var(--mint)", iconName: "check", text: `${(d.actor as string) ?? (event.actor as string) ?? "Agent"} finished${dur}`, kind };
    }
    case "agent_failed":
      return { color: "var(--rose)", iconName: "cross", text: `${(d.actor as string) ?? (event.actor as string) ?? "Agent"} FAILED${d.error ? ` — ${String(d.error).slice(0, 60)}` : ""}`, kind };
    case "pipeline_finished":
      return { color: "var(--mint)", iconName: "double-check", text: `Run complete${(d.result_count as number) != null ? ` — ${d.result_count as number} results` : ""}`, kind };
    case "pipeline_failed":
      return { color: "var(--rose)", iconName: "cross", text: `Pipeline failed${d.error ? ` — ${String(d.error).slice(0, 60)}` : ""}`, kind };
    case "run_cancelled":
      return { color: "var(--mute)", iconName: "circle", text: "Run cancelled", kind };
    case "server_activated": {
      const label = (d.server_label as string) ?? (d.server as string) ?? (d.url as string) ?? "server";
      const state = d.playback_confirmed === true ? "playback ✓" : d.server_up === true ? "up" : d.server_up === false ? "down" : "";
      return { color: "var(--mint)", iconName: "check", text: `Server activated${label ? `: ${String(label).slice(0, 60)}` : ""}${state ? ` — ${state}` : ""}`, kind };
    }
    case "stream_extracted": {
      const url = (d.stream_url as string) ?? (d.url as string) ?? "";
      const proto = d.protocol ? ` ${d.protocol as string}` : "";
      const qual = d.quality ? ` ${d.quality as string}` : "";
      return { color: "var(--signal)", iconName: "play", text: `Stream extracted${proto}${qual}${url ? ` — ${String(url).slice(0, 50)}` : ""}`, kind };
    }
    case "hosting_page_discovered": {
      const hUrl = (d.url as string) ?? (d.hosting_url as string) ?? msg ?? "";
      return { color: "var(--sky)", iconName: "diamond", text: `Hosting discovered${hUrl ? `: ${String(hUrl).slice(0, 60)}` : ""}`, kind };
    }
    case "player_failed": {
      const reason = (d.reason as string) ?? (d.error as string) ?? msg ?? "player failed";
      return { color: "var(--rose)", iconName: "cross", text: `Player failed — ${String(reason).slice(0, 60)}`, kind };
    }
    case "cost_threshold_exceeded": {
      const spent = d.spent_usd != null ? `$${Number(d.spent_usd).toFixed(2)}` : "";
      return { color: "var(--amber)", iconName: "circle", text: `Cost threshold exceeded${spent ? ` — ${spent}` : ""}`, kind };
    }
    case "queue_enqueued": {
      const qUrl = (d.url as string) ?? "";
      return { color: "var(--violet)", iconName: "diamond", text: `Queued${d.role ? ` ${d.role as string}` : ""}${qUrl ? `: ${String(qUrl).slice(0, 50)}` : ""}`, kind };
    }
    case "hosting_item_started": {
      const hiUrl = (d.url as string) ?? "";
      return { color: "var(--signal)", iconName: "play", text: `Hosting started${hiUrl ? `: ${String(hiUrl).slice(0, 50)}` : ""}`, kind };
    }
    case "hosting_item_finished": {
      const hfUrl = (d.url as string) ?? "";
      const st = (d.status as string) ? ` — ${String(d.status)}` : "";
      return { color: d.status === "success" || d.status === "partial" ? "var(--mint)" : "var(--signal)", iconName: d.status === "success" || d.status === "partial" ? "check" : "circle", text: `Hosting finished${hfUrl ? `: ${String(hfUrl).slice(0, 50)}` : ""}${st}`, kind };
    }
    case "pool_drained": {
      const role = (d.role as string) ?? "pool";
      return { color: "var(--mute)", iconName: "double-check", text: `${role} pool drained${d.processed != null ? ` — ${d.processed as number} items` : ""}`, kind };
    }
    case "plan_step_update": {
      const step = (d.step_id as string) ?? (d.title as string) ?? msg ?? "plan step";
      const s = (d.status as string) ? ` → ${String(d.status)}` : "";
      return { color: "var(--sky)", iconName: "diamond", text: `Plan: ${String(step).slice(0, 50)}${s}`, kind };
    }
    default:
      return null;
  }
}

/** Render a small icon glyph for a given iconName string. */
function KindIcon({ name, size = 10 }: { name: string; size?: number }): React.JSX.Element {
  if (name === "play")
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" fill="none">
        <polygon points="2,1 9,5 2,9" fill="currentColor" />
      </svg>
    );
  if (name === "check")
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" fill="none">
        <polyline points="1.5,5.5 4,8 8.5,2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (name === "double-check")
    return (
      <svg width={size} height={size} viewBox="0 0 12 10" fill="none">
        <polyline points="1,5 3.5,7.5 7.5,2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points="5,5 7.5,7.5 11.5,2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (name === "cross")
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" fill="none">
        <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  if (name === "diamond")
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" fill="none">
        <polygon points="5,1 9,5 5,9 1,5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none">
      <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export interface NotificationHistoryItem extends ToastMeta {
  id: string | number;
  runId?: string;
  ts: number;
  read?: boolean;
}

interface NotifContextValue {
  prefs: NotificationPrefs;
  setPrefs: (prefs: NotificationPrefs) => void;
  history: NotificationHistoryItem[];
  unreadCount: number;
  clearHistory: () => void;
  markAllRead: () => void;
}

const NotifContext = createContext<NotifContextValue>({
  prefs: DEFAULT_PREFS,
  setPrefs: () => {},
  history: [],
  unreadCount: 0,
  clearHistory: () => {},
  markAllRead: () => {},
});

export function useNotifPrefs(): NotifContextValue {
  return useContext(NotifContext);
}

export function useNotifications(): NotifContextValue {
  return useContext(NotifContext);
}

interface ToastProps extends ToastMeta {
  id: number;
  runId?: string;
  onDismiss: (id: number) => void;
}

const Toast = memo(function Toast({ id, color, iconName, text, runId, onDismiss }: ToastProps): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const timeLabel = useRef(new Date().toLocaleTimeString()).current;

  useEffect(() => {
    const t = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(t);
  }, []);

  function dismiss(): void {
    setLeaving(true);
    setTimeout(() => onDismiss(id), 200);
  }

  return (
    <div
      className="flex items-start gap-3 rounded-[14px] px-4 py-3 shadow-2xl"
      style={{
        background: "var(--panel-2, var(--panel))",
        border: `1px solid color-mix(in oklch, ${color} 28%, var(--line))`,
        transform: visible && !leaving ? "translateX(0) scale(1)" : "translateX(20px) scale(0.97)",
        opacity: visible && !leaving ? 1 : 0,
        transition: leaving ? "opacity 180ms ease, transform 180ms ease" : "opacity 220ms ease, transform 280ms cubic-bezier(0.34,1.56,0.64,1)",
        maxWidth: "340px",
        minWidth: "240px",
        backdropFilter: "blur(12px)",
      }}
    >
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: `color-mix(in oklch, ${color} 18%, transparent)`, border: `1px solid color-mix(in oklch, ${color} 30%, transparent)`, color }}>
        <KindIcon name={iconName} size={11} />
      </div>

      <div className="min-w-0 flex-1 pt-0.5">
        <div className="text-[12.5px] font-medium leading-snug" style={{ color: "var(--ink)" }}>{text}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[10.5px]" style={{ color: "var(--mute-2)" }}>
          <span>{timeLabel}</span>
          {runId ? (
            <Link href={`/runs/${runId}`} onClick={dismiss} className="ml-auto flex items-center gap-1 font-semibold transition-colors" style={{ color: "var(--signal)" }}>
              View <ArrowRight className="h-3 w-3" />
            </Link>
          ) : null}
        </div>
      </div>

      <button type="button" onClick={dismiss} className="mt-0.5 shrink-0 rounded-full p-1 transition-colors hover:bg-muted/30" style={{ color: "var(--mute-2)" }} aria-label="Dismiss">
        <X className="h-3 w-3" />
      </button>
    </div>
  );
});

export function NotificationBell(): React.JSX.Element {
  const { history, unreadCount, clearHistory, markAllRead } = useContext(NotifContext);
  const [open, setOpen] = useState(false);
  const [animateIn, setAnimateIn] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      const t = requestAnimationFrame(() => setAnimateIn(true));
      return () => cancelAnimationFrame(t);
    }
    setAnimateIn(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function isToday(ts: number): boolean {
    const d = new Date(ts);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }

  function fmtRelative(ts: number): string {
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
    return formatDate(ts);
  }

  const today = history.filter((h) => isToday(h.ts));
  const earlier = history.filter((h) => !isToday(h.ts));

  return (
    <div ref={rootRef} className="relative">
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
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold" style={{ background: "var(--rose)", color: "#fff" }}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="absolute right-0 top-full z-50 mt-2 flex w-[340px] flex-col overflow-hidden rounded-[16px] border shadow-2xl"
          style={{
            background: "var(--panel-2, var(--panel))",
            borderColor: "var(--line-hi)",
            transform: animateIn ? "translateY(0) scale(1)" : "translateY(-6px) scale(0.97)",
            opacity: animateIn ? 1 : 0,
            transition: "opacity 180ms ease, transform 200ms cubic-bezier(0.34,1.56,0.64,1)",
            transformOrigin: "top right",
          }}
        >
          <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold" style={{ color: "var(--ink)" }}>Notifications</span>
              {history.length > 0 ? (
                <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold" style={{ background: "color-mix(in oklch, var(--signal) 15%, var(--line))", color: "var(--mute)" }}>
                  {history.length > 60 ? "60+" : history.length}
                </span>
              ) : null}
            </div>
            {history.length > 0 ? (
              <button type="button" onClick={clearHistory} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors hover:bg-muted/30" style={{ color: "var(--mute)" }}>
                <XCircle className="h-3 w-3" />
                Clear all
              </button>
            ) : null}
          </div>

          <div className="max-h-[380px] overflow-y-auto">
            {history.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-10">
                <div className="flex h-11 w-11 items-center justify-center rounded-full" style={{ background: "color-mix(in oklch, var(--mute) 12%, transparent)", color: "var(--mute-2)" }}>
                  <Bell className="h-5 w-5" />
                </div>
                <div className="text-center">
                  <p className="text-[12.5px] font-medium" style={{ color: "var(--ink-dim)" }}>All caught up</p>
                  <p className="mt-0.5 text-[11px]" style={{ color: "var(--mute)" }}>Notifications from active runs will appear here.</p>
                </div>
              </div>
            ) : (
              <>
                {today.length > 0 ? (
                  <div>
                    <div className="sticky top-0 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--mute)", background: "var(--panel-2, var(--panel))", borderBottom: "1px solid var(--line)" }}>Today</div>
                    {today.map((item) => (
                      <NotificationRow key={item.id} item={item} onNavigate={() => setOpen(false)} fmtRelative={fmtRelative} />
                    ))}
                  </div>
                ) : null}
                {earlier.length > 0 ? (
                  <div>
                    <div className="sticky top-0 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--mute)", background: "var(--panel-2, var(--panel))", borderBottom: "1px solid var(--line)" }}>Earlier</div>
                    {earlier.map((item) => (
                      <NotificationRow key={item.id} item={item} onNavigate={() => setOpen(false)} fmtRelative={fmtRelative} />
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NotificationRow({ item, onNavigate, fmtRelative }: { item: NotificationHistoryItem; onNavigate: () => void; fmtRelative: (ts: number) => string }): React.JSX.Element {
  const inner = (
    <div className="flex items-start gap-3 border-b px-4 py-2.5 transition-colors" style={{ borderColor: "var(--line)", background: item.read ? "transparent" : "color-mix(in oklch, var(--signal) 4%, transparent)", cursor: item.runId ? "pointer" : "default" }}>
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ background: `color-mix(in oklch, ${item.color} 15%, transparent)`, color: item.color }}>
        <KindIcon name={item.iconName} size={9} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] leading-snug" style={{ color: item.read ? "var(--ink-dim)" : "var(--ink)", fontWeight: item.read ? 400 : 500 }}>{item.text}</div>
        <div className="mt-0.5 text-[10.5px]" style={{ color: "var(--mute-2)" }}>{fmtRelative(item.ts)}</div>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1.5 pt-1">
        {!item.read ? <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--signal)" }} /> : null}
        {item.runId ? <ArrowRight className="h-3 w-3 opacity-50" style={{ color: "var(--signal)" }} /> : null}
      </div>
    </div>
  );
  return item.runId ? (
    <Link href={`/runs/${item.runId}`} onClick={onNavigate} className="block hover:bg-muted/30">
      {inner}
    </Link>
  ) : (
    inner
  );
}

export interface NotificationProviderProps {
  children: React.ReactNode;
}

export function NotificationProvider({ children }: NotificationProviderProps): React.JSX.Element {
  const [toasts, setToasts] = useState<Array<ToastMeta & { id: number; runId?: string }>>([]);
  const [prefs, setPrefsState] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [history, setHistory] = useState<NotificationHistoryItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const idRef = useRef(0);
  const histIdRef = useRef(0);

  useEffect(() => {
    setPrefsState(loadPrefs());
    setHistory(loadHistory());
    const hist = loadHistory();
    setUnreadCount(hist.filter((h) => !h.read).length);
  }, []);

  const setPrefs = useCallback((next: NotificationPrefs) => {
    setPrefsState(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  const markAllRead = useCallback(() => {
    setHistory((prev) => {
      const next = prev.map((h) => ({ ...h, read: true }));
      saveHistory(next);
      return next;
    });
    setUnreadCount(0);
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    setUnreadCount(0);
    saveHistory([]);
  }, []);

  const pushToast = useCallback((meta: ToastMeta & { runId?: string }) => {
    const id = ++idRef.current;
    const histId = ++histIdRef.current;
    setToasts((prev) => [...prev.slice(-4), { id, ...meta }]);
    setHistory((prev) => {
      const next: NotificationHistoryItem[] = [{ id: histId, ...meta, ts: Date.now(), read: false }, ...prev].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
    setUnreadCount((c) => c + 1);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // SSE subscription placeholder — real subscription is handled by useRunStream elsewhere; this provider wires prefs only.
  // For live streams, consumers call pushToast via event handlers.

  return (
    <NotifContext.Provider value={{ prefs, setPrefs, history, unreadCount, clearHistory, markAllRead }}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-100 flex flex-col-reverse items-end gap-2" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <Toast {...t} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </NotifContext.Provider>
  );
}

export default NotificationProvider;
