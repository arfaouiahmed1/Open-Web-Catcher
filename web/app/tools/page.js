"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, RefreshCw, Wifi, WifiOff, Wrench, ZoomIn } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { JsonViewer } from "@/components/json-viewer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HelpIcon } from "@/components/ui/tooltip";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const PROFILES = ["classification", "landing", "hosting", "embedded"];

const TOOL_HINTS = {
  classification: "inspect",
  landing: "inspect_landing",
  hosting: "inspect_hosting",
  embedded: "inspect_embedded",
};

const STARTER_TEMPLATES = {
  classification: {
    inspect: "{}",
    query_elements: '{\n  "selector": "a"\n}',
    screenshot: "{}",
  },
  landing: {
    inspect_landing: "{}",
    interact: '{\n  "action": "click",\n  "text": "Live"\n}',
    query_elements: '{\n  "selector": "a[href]"\n}',
  },
  hosting: {
    inspect_hosting: "{}",
    harvest: '{\n  "frame_path": "root"\n}',
    capture_streams: "{}",
  },
  embedded: {
    inspect_embedded: "{}",
    harvest: '{\n  "frame_path": "root"\n}',
    play_media: "{}",
  },
};

const RELIABILITY_COLORS = {
  high:   { border: "color-mix(in oklch, var(--mint) 35%, transparent)",   bg: "color-mix(in oklch, var(--mint) 10%, transparent)",   text: "var(--mint)" },
  medium: { border: "color-mix(in oklch, var(--signal) 35%, transparent)", bg: "color-mix(in oklch, var(--signal) 10%, transparent)", text: "var(--signal)" },
  low:    { border: "color-mix(in oklch, var(--rose) 35%, transparent)",   bg: "color-mix(in oklch, var(--rose) 10%, transparent)",   text: "var(--rose)" },
};

function reliabilityBand(rate) {
  return rate > 0.8 ? "high" : rate > 0.5 ? "medium" : "low";
}

function collectScreenshot(value) {
  if (!value) return "";
  if (typeof value === "string") {
    if (value.startsWith("http") || value.startsWith("data:image/")) return value;
    try { return collectScreenshot(JSON.parse(value)); } catch { return ""; }
  }
  if (Array.isArray(value)) {
    for (const item of value) { const n = collectScreenshot(item); if (n) return n; }
    return "";
  }
  if (typeof value === "object") {
    if (typeof value.screenshot_url === "string" && value.screenshot_url) return value.screenshot_url;
    if (Array.isArray(value.screenshot_urls) && value.screenshot_urls.length) return value.screenshot_urls[0];
    for (const n of Object.values(value)) { const c = collectScreenshot(n); if (c) return c; }
  }
  return "";
}

/* ── Live screenshot panel ── */
function LivePreview({ src, autoRefresh, onManualRefresh, isRunning }) {
  const [zoomed, setZoomed] = useState(false);

  if (!src) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 rounded-[14px] border"
        style={{ minHeight: 220, borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        {isRunning ? (
          <>
            <span className="owc-spinner owc-spinner-lg" style={{ color: "var(--signal)" }} />
            <span className="text-[12.5px]" style={{ color: "var(--mute)" }}>Running tool…</span>
          </>
        ) : (
          <>
            <Wifi className="h-8 w-8 opacity-20" />
            <span className="text-[12.5px]" style={{ color: "var(--mute)" }}>No screenshot yet — run a tool to see the browser state</span>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        className="group relative overflow-hidden rounded-[14px] border"
        style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        {/* header bar */}
        <div className="flex items-center justify-between border-b px-[18px] py-2.5" style={{ borderColor: "var(--line)" }}>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: autoRefresh ? "var(--mint)" : "var(--mute-3)", animation: autoRefresh ? "breathe 1.6s ease-in-out infinite" : "none" }} />
            <span className="text-[12.5px] font-medium" style={{ color: "var(--ink)" }}>Browser view</span>
            {autoRefresh && <span className="font-mono text-[10.5px]" style={{ color: "var(--mint)" }}>live</span>}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onManualRefresh}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-white/6"
              style={{ borderColor: "var(--line)", color: "var(--mute)" }}
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setZoomed(true)}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-white/6"
              style={{ borderColor: "var(--line)", color: "var(--mute)" }}
            >
              <ZoomIn className="h-3 w-3" />
              Full
            </button>
          </div>
        </div>

        {/* screenshot */}
        <div className="relative overflow-hidden" style={{ maxHeight: 320 }}>
          <img
            src={src}
            alt="Browser screenshot"
            className="w-full object-cover object-top"
            style={{ display: "block" }}
          />
          {isRunning && (
            <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(5,8,15,0.55)" }}>
              <span className="owc-spinner owc-spinner-lg" style={{ color: "var(--signal)" }} />
            </div>
          )}
        </div>
      </div>

      {/* Fullscreen overlay */}
      {zoomed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: "rgba(0,0,0,0.88)" }}
          onClick={() => setZoomed(false)}
        >
          <img src={src} alt="Browser screenshot fullscreen" className="max-h-full max-w-full rounded-[10px] object-contain shadow-2xl" />
        </div>
      )}
    </>
  );
}

/* ── Reliability heatmap ── */
function Heatmap({ rows }) {
  if (!rows.length) return (
    <div className="rounded-[14px] border p-4 text-[12.5px]" style={{ borderColor: "var(--line)", background: "var(--card)", color: "var(--mute)" }}>
      No reliability data yet
    </div>
  );

  return (
    <div className="rounded-[14px] border overflow-hidden" style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}>
      <div className="border-b px-[18px] py-3.5" style={{ borderColor: "var(--line)" }}>
        <span className="text-[13.5px] font-medium" style={{ color: "var(--ink)" }}>Tool reliability</span>
        <span className="ml-3 font-mono text-[11px]" style={{ color: "var(--mute)" }}>{rows.length} tools tracked</span>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map((row) => {
          const rate = Number(row.success_rate || 0);
          const band = reliabilityBand(rate);
          const c = RELIABILITY_COLORS[band];
          return (
            <div
              key={`${row.tool_name}-${row.profile}`}
              className="rounded-[10px] border px-3 py-2.5"
              style={{ borderColor: c.border, background: c.bg }}
            >
              <div className="font-mono text-[12px]" style={{ color: "var(--ink)" }}>{row.tool_name}</div>
              <div className="text-[11px]" style={{ color: "var(--mute)" }}>{row.profile}</div>
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-[12px] font-semibold" style={{ color: c.text }}>{(rate * 100).toFixed(0)}%</span>
                <span className="text-[11px]" style={{ color: "var(--mute)" }}>{row.calls} calls</span>
              </div>
              {/* mini bar */}
              <div className="mt-1.5 h-1 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
                <div className="h-1 rounded-full" style={{ width: `${rate * 100}%`, background: c.text }} />
              </div>
              <div className="mt-1 text-[10.5px]" style={{ color: "var(--mute)" }}>{Number(row.avg_duration_seconds || 0).toFixed(2)}s avg</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── History table ── */
function HistoryTable({ rows, onSelect, selected }) {
  return (
    <div className="rounded-[14px] border overflow-hidden" style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}>
      <div className="border-b px-[18px] py-3.5" style={{ borderColor: "var(--line)" }}>
        <span className="text-[13.5px] font-medium" style={{ color: "var(--ink)" }}>Tool history</span>
        <span className="ml-3 font-mono text-[11px]" style={{ color: "var(--mute)" }}>{rows.length} calls</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-[12.5px]">
          <thead>
            <tr className="border-b" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.012)" }}>
              {["Tool", "Status", "Duration", "Origin", "Call ID"].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] whitespace-nowrap" style={{ color: "var(--mute)" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row) => {
              const isSelected = selected?.call_id === row.call_id;
              const ok = row.status === "success";
              return (
                <tr
                  key={row.call_id}
                  className="cursor-pointer border-b transition-colors"
                  style={{
                    borderColor: "var(--line)",
                    background: isSelected
                      ? "color-mix(in oklch, var(--signal) 8%, transparent)"
                      : undefined,
                  }}
                  onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                  onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                  onClick={() => onSelect(isSelected ? null : row)}
                >
                  <td className="px-4 py-2.5 font-mono text-[12px]" style={{ color: "var(--sky)" }}>{row.tool_name}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className="rounded-full px-2 py-0.5 font-mono text-[10.5px]"
                      style={{
                        color: ok ? "var(--mint)" : "var(--rose)",
                        background: ok ? "color-mix(in oklch, var(--mint) 12%, transparent)" : "color-mix(in oklch, var(--rose) 12%, transparent)",
                      }}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[11.5px] tabular-nums" style={{ color: "var(--mute)" }}>
                    {Number(row.duration_seconds || 0).toFixed(2)}s
                  </td>
                  <td className="px-4 py-2.5 max-w-[160px] truncate text-[11.5px]" style={{ color: "var(--mute)" }} title={row.origin}>{row.origin || "—"}</td>
                  <td className="px-4 py-2.5 font-mono text-[10.5px]" style={{ color: "var(--mute-2)" }}>{(row.call_id || "").slice(0, 12)}…</td>
                </tr>
              );
            }) : (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-[12.5px]" style={{ color: "var(--mute)" }}>No history for this profile</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Main page ── */
export default function ToolsPage() {
  const [profile, setProfile] = useState("hosting");
  const [toolName, setToolName] = useState(TOOL_HINTS["hosting"]);
  const [argsText, setArgsText] = useState('{\n  "frame_path": "root"\n}');
  const [sessionUrl, setSessionUrl] = useState("");
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState({ rows: [], total: 0 });
  const [selectedHistory, setSelectedHistory] = useState(null);
  const [toolNames, setToolNames] = useState([]);
  const [reliability, setReliability] = useState([]);
  const [templateName, setTemplateName] = useState("");
  const [error, setError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const autoRefreshRef = useRef(null);

  async function loadHistory(p = profile) {
    const payload = await apiFetch(`/ui/tools/history?profile=${encodeURIComponent(p)}`);
    setHistory(payload);
  }

  async function loadToolNames(p = profile) {
    const payload = await apiFetch(`/ui/tools/list?profile=${encodeURIComponent(p)}`);
    setToolNames(payload?.tools || []);
  }

  async function loadReliability() {
    const payload = await apiFetch("/ui/tools/reliability?limit=800");
    setReliability(payload?.rows || []);
  }

  useEffect(() => {
    loadHistory(profile).catch((e) => setError(e.message));
    loadToolNames(profile).catch(() => {});
    loadReliability().catch(() => {});
  }, [profile]); // eslint-disable-line

  function selectProfile(p) {
    setProfile(p);
    setToolName(TOOL_HINTS[p] || "");
    setTemplateName("");
    setSelectedHistory(null);
    setResult(null);
  }

  const callTool = useCallback(async () => {
    setError("");
    setIsRunning(true);
    let args = {};
    try {
      args = JSON.parse(argsText || "{}");
    } catch {
      setError("Args must be valid JSON");
      setIsRunning(false);
      return;
    }
    try {
      const body = { profile, tool_name: toolName, args };
      if (sessionUrl.trim()) body.session_url = sessionUrl.trim();
      const res = await fetch(apiUrl("/ui/tools/call"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.detail || `Status ${res.status}`);
      setResult(payload);
      setSelectedHistory(null);
      await loadHistory(profile);
      await loadReliability();
    } catch (e) {
      setError(e.message || "Tool call failed");
      setResult({ error: e.message });
    } finally {
      setIsRunning(false);
    }
  }, [profile, toolName, argsText, sessionUrl]); // eslint-disable-line

  /* Auto-refresh by re-running screenshot tool every 3s */
  useEffect(() => {
    if (!autoRefresh) {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
      return;
    }
    autoRefreshRef.current = setInterval(() => {
      if (!isRunning) {
        const savedTool = toolName;
        const savedArgs = argsText;
        setToolName("screenshot");
        setArgsText("{}");
        setTimeout(() => { setToolName(savedTool); setArgsText(savedArgs); }, 50);
      }
    }, 3000);
    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); };
  }, [autoRefresh, isRunning]); // eslint-disable-line

  const lastScreenshot = useMemo(
    () => collectScreenshot(result?.result) || collectScreenshot(selectedHistory?.result_json),
    [result, selectedHistory]
  );

  const templates = STARTER_TEMPLATES[profile] || {};
  const filteredReliability = reliability.filter((r) => r.profile === profile);

  return (
    <div className="space-y-5">

      {/* page header */}
      <div>
        <span className="owc-eyebrow">tool playground · direct mcp calls</span>
        <h1 className="mt-2 text-3xl font-semibold" style={{ color: "var(--ink)" }}>
          MCP Tool Workbench
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed" style={{ color: "var(--mute)" }}>
          Execute browser tools in isolation. See a live screenshot of the running Chrome instance, inspect results, and track reliability.
        </p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_400px]">
        {/* ── Left: controls ── */}
        <div className="space-y-4">

          {/* Execute card */}
          <div
            className="rounded-[14px] border p-4 space-y-4"
            style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Wrench className="h-3.5 w-3.5" style={{ color: "var(--signal)" }} />
                <span className="text-[13.5px] font-medium" style={{ color: "var(--ink)" }}>Execute tool</span>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-[12px]" style={{ color: autoRefresh ? "var(--mint)" : "var(--mute)" }}>
                <span>{autoRefresh ? "Auto-refresh on" : "Auto-refresh off"}</span>
                <div
                  className="relative h-5 w-9 rounded-full transition-colors"
                  style={{ background: autoRefresh ? "color-mix(in oklch, var(--mint) 55%, transparent)" : "var(--mute-3)" }}
                >
                  <input type="checkbox" className="sr-only" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
                  <span
                    className="absolute top-0.5 h-4 w-4 rounded-full transition-all"
                    style={{ background: autoRefresh ? "var(--mint)" : "var(--mute-2)", left: autoRefresh ? "calc(100% - 18px)" : "2px" }}
                  />
                </div>
              </label>
            </div>

            {/* Profile */}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--mute-2)" }}>
                Agent profile
                <HelpIcon tip="Each profile maps to an agent type and exposes a different set of MCP tools." />
              </label>
              <div className="flex flex-wrap gap-2">
                {PROFILES.map((p) => (
                  <button
                    key={p}
                    onClick={() => selectProfile(p)}
                    className="rounded-lg border px-3 py-1.5 text-[13px] transition-colors"
                    style={profile === p
                      ? { borderColor: "color-mix(in oklch, var(--signal) 55%, transparent)", background: "color-mix(in oklch, var(--signal) 9%, transparent)", color: "var(--ink)" }
                      : { borderColor: "var(--line)", background: "var(--card-hi)", color: "var(--mute)" }}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Session URL */}
            <Input
              label="Session URL (optional)"
              value={sessionUrl}
              onChange={(e) => setSessionUrl(e.target.value)}
              placeholder="https://example.com/live — navigate the browser to this URL before calling the tool"
              className="font-mono"
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Input
                  label="Tool name"
                  value={toolName}
                  onChange={(e) => setToolName(e.target.value)}
                  list="tool-name-options"
                  placeholder="inspect_hosting"
                  className="font-mono"
                />
                <datalist id="tool-name-options">
                  {toolNames.map((name) => <option key={name} value={name} />)}
                </datalist>
              </div>
              <Select
                label="Starter template"
                value={templateName}
                onChange={(value) => {
                  setTemplateName(value);
                  if (templates[value]) { setToolName(value); setArgsText(templates[value]); }
                }}
                options={[
                  { value: "", label: "Select template" },
                  ...Object.keys(templates).map((name) => ({ value: name, label: name })),
                ]}
              />
            </div>

            <Textarea
              label="Arguments (JSON)"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              className="min-h-[100px]"
              mono
            />

            {error && (
              <div
                className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]"
                style={{ borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)", background: "color-mix(in oklch, var(--rose) 10%, transparent)", color: "var(--rose)" }}
              >
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            <div className="flex gap-2">
              <Button variant="accent" onClick={callTool} disabled={isRunning}>
                {isRunning ? <><span className="owc-spinner owc-spinner-sm" />Running…</> : "Call tool"}
              </Button>
              <Button variant="ghost" onClick={() => loadHistory(profile)} className="border border-[var(--line)]">
                Refresh history
              </Button>
            </div>
          </div>

          {/* History */}
          <HistoryTable rows={history.rows || []} onSelect={setSelectedHistory} selected={selectedHistory} />

          {/* History detail */}
          {selectedHistory && (
            <div
              className="rounded-[14px] border p-4"
              style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
            >
              <div className="mb-3 flex items-center">
                <div className="text-[13.5px] font-medium" style={{ color: "var(--ink)" }}>History detail</div>
                <button type="button" onClick={() => setSelectedHistory(null)} className="ml-auto text-[12px]" style={{ color: "var(--mute)" }}>Close ×</button>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                <JsonViewer label="Input args" value={selectedHistory.args_json} />
                <JsonViewer label="Output result" value={selectedHistory.result_json} />
              </div>
            </div>
          )}
        </div>

        {/* ── Right: browser view + result ── */}
        <div className="space-y-4">
          <LivePreview
            src={lastScreenshot}
            autoRefresh={autoRefresh}
            onManualRefresh={() => {
              const t = toolName; const a = argsText;
              setToolName("screenshot"); setArgsText("{}");
              setTimeout(() => { setToolName(t); setArgsText(a); callTool(); }, 0);
            }}
            isRunning={isRunning}
          />
          <JsonViewer label="Last result" value={result} />
        </div>
      </div>

      {/* Reliability */}
      {filteredReliability.length > 0 && (
        <Heatmap rows={filteredReliability} />
      )}
    </div>
  );
}
