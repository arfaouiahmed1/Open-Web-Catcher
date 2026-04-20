"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Wrench } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { JsonViewer } from "@/components/json-viewer";
import { Button } from "@/components/ui/button";
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
    query_elements: "{\n  \"selector\": \"a\"\n}",
  },
  landing: {
    inspect_landing: "{}",
    interact: "{\n  \"action\": \"click\",\n  \"text\": \"Live\"\n}",
  },
  hosting: {
    inspect_hosting: "{}",
    harvest: "{\n  \"frame_path\": \"root\"\n}",
  },
  embedded: {
    inspect_embedded: "{}",
    harvest: "{\n  \"frame_path\": \"root\"\n}",
  },
};

function collectScreenshot(value) {
  if (!value) return "";
  if (typeof value === "string") {
    if (value.startsWith("http") || value.startsWith("data:image/")) return value;
    try { return collectScreenshot(JSON.parse(value)); } catch { return ""; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = collectScreenshot(item);
      if (nested) return nested;
    }
    return "";
  }
  if (typeof value === "object") {
    if (typeof value.screenshot_url === "string" && value.screenshot_url) return value.screenshot_url;
    if (Array.isArray(value.screenshot_urls) && value.screenshot_urls.length) return value.screenshot_urls[0];
    for (const nested of Object.values(value)) {
      const candidate = collectScreenshot(nested);
      if (candidate) return candidate;
    }
  }
  return "";
}

function Heatmap({ rows }) {
  if (!rows.length) {
    return (
      <div
        className="rounded-[14px] border p-4 text-[12.5px] text-[var(--mute)]"
        style={{ borderColor: "var(--line)", background: "var(--card)" }}
      >
        No reliability data yet
      </div>
    );
  }
  return (
    <div className="rounded-[14px] border overflow-hidden" style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}>
      <div className="border-b px-[18px] py-3.5" style={{ borderColor: "var(--line)" }}>
        <span className="text-[13.5px] font-medium text-[var(--ink)]">Tool reliability heatmap</span>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map((row) => {
          const rate = Number(row.success_rate || 0);
          const border = rate > 0.8
            ? "color-mix(in oklch, var(--mint) 35%, transparent)"
            : rate > 0.5
              ? "color-mix(in oklch, var(--signal) 35%, transparent)"
              : "color-mix(in oklch, var(--rose) 35%, transparent)";
          const bg = rate > 0.8
            ? "color-mix(in oklch, var(--mint) 10%, transparent)"
            : rate > 0.5
              ? "color-mix(in oklch, var(--signal) 10%, transparent)"
              : "color-mix(in oklch, var(--rose) 10%, transparent)";
          const textColor = rate > 0.8 ? "var(--mint)" : rate > 0.5 ? "var(--signal)" : "var(--rose)";
          return (
            <div key={`${row.tool_name}-${row.profile}`}
              className="rounded-[10px] border px-3 py-2.5"
              style={{ borderColor: border, background: bg }}
            >
              <div className="font-mono text-[12px] text-[var(--ink)]">{row.tool_name}</div>
              <div className="text-[11px] text-[var(--mute)]">{row.profile}</div>
              <div className="mt-1.5 text-[12px] font-medium" style={{ color: textColor }}>
                {(rate * 100).toFixed(0)}% success
              </div>
              <div className="text-[11px] text-[var(--mute)]">
                {row.calls} calls · {Number(row.avg_duration_seconds || 0).toFixed(2)}s avg
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ToolsPage() {
  const [profile, setProfile] = useState("hosting");
  const [toolName, setToolName] = useState(TOOL_HINTS["hosting"]);
  const [argsText, setArgsText] = useState("{\n  \"frame_path\": \"root\"\n}");
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState({ rows: [], total: 0 });
  const [selectedHistory, setSelectedHistory] = useState(null);
  const [toolNames, setToolNames] = useState([]);
  const [reliability, setReliability] = useState([]);
  const [templateName, setTemplateName] = useState("");
  const [error, setError] = useState("");
  const [isRunning, setIsRunning] = useState(false);

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
    loadToolNames(profile).catch((e) => setError(e.message));
    loadReliability().catch(() => {});
  }, [profile]); // eslint-disable-line

  function selectProfile(p) {
    setProfile(p);
    setToolName(TOOL_HINTS[p] || "");
    setTemplateName("");
    setSelectedHistory(null);
  }

  async function callTool() {
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
      const res = await fetch(apiUrl("/ui/tools/call"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, tool_name: toolName, args }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.detail || `Status ${res.status}`);
      setResult(payload);
      await loadHistory(profile);
      await loadReliability();
    } catch (e) {
      setError(e.message || "Tool call failed");
      setResult({ error: e.message });
    } finally {
      setIsRunning(false);
    }
  }

  const lastScreenshot = useMemo(
    () => collectScreenshot(result?.result) || collectScreenshot(selectedHistory?.result_json),
    [result, selectedHistory]
  );
  const templates = STARTER_TEMPLATES[profile] || {};

  return (
    <div className="space-y-5">

      {/* page header */}
      <div>
        <span className="owc-eyebrow">tool playground · direct mcp calls</span>
        <h1 className="mt-2 font-['Inter_Tight',sans-serif] text-3xl font-medium tracking-tight text-[var(--ink)]">
          MCP tool workbench
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--mute)]">
          Execute MCP browser tools in isolation for debugging, verification, and reliability probes.
        </p>
      </div>

      {/* execute card */}
      <div
        className="rounded-[14px] border p-4 space-y-4"
        style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        <div className="flex items-center gap-2">
          <Wrench className="h-3.5 w-3.5" style={{ color: "var(--signal)" }} />
          <span className="text-[13.5px] font-medium text-[var(--ink)]">Execute tool</span>
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">Agent profile</label>
          <div className="flex flex-wrap gap-2">
            {PROFILES.map((p) => (
              <button
                key={p}
                onClick={() => selectProfile(p)}
                className="rounded-lg border px-3 py-1.5 text-[13px] transition-colors"
                style={profile === p
                  ? { borderColor: "color-mix(in oklch, var(--signal) 55%, transparent)", background: "color-mix(in oklch, var(--signal) 9%, transparent)", color: "var(--ink)" }
                  : { borderColor: "var(--line)", background: "var(--card-hi)", color: "var(--mute)" }
                }
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">Tool name</label>
            <input
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              list="tool-name-options"
              placeholder="inspect_hosting"
              className="w-full rounded-lg border px-3 py-2 text-[13px] font-mono focus:outline-none"
              style={{ borderColor: "var(--line)", background: "black/20", color: "var(--ink)" }}
            />
            <datalist id="tool-name-options">
              {toolNames.map((name) => <option key={name} value={name} />)}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">Starter template</label>
            <select
              value={templateName}
              onChange={(e) => {
                const next = e.target.value;
                setTemplateName(next);
                if (templates[next]) { setToolName(next); setArgsText(templates[next]); }
              }}
              className="w-full rounded-lg border px-3 py-2 text-[13px] focus:outline-none"
              style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.2)", color: "var(--ink-dim)" }}
            >
              <option value="">Select template</option>
              {Object.keys(templates).map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
        </div>

        <Textarea
          label="Arguments (JSON)"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          className="min-h-[100px]"
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
            {isRunning ? "Calling…" : "Call tool"}
          </Button>
          <Button variant="ghost" onClick={() => loadHistory(profile)} className="border border-[var(--line)]">
            Refresh history
          </Button>
        </div>
      </div>

      {lastScreenshot && (
        <div
          className="rounded-[14px] border overflow-hidden"
          style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
        >
          <div className="border-b px-[18px] py-3.5" style={{ borderColor: "var(--line)" }}>
            <span className="text-[13.5px] font-medium text-[var(--ink)]">Last screenshot</span>
          </div>
          <img src={lastScreenshot} alt="Last tool screenshot" className="h-56 w-full object-cover" />
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <DataTable
          title="Tool History"
          description={`Persisted calls for ${profile} agent`}
          columns={["created_at", "origin", "tool_name", "status", "duration_seconds", "related_run_id", "call_id"]}
          rows={history.rows || []}
          onRowClick={setSelectedHistory}
        />
        <JsonViewer label="Last result" value={result} />
      </div>

      {selectedHistory && (
        <div
          className="rounded-[14px] border p-4"
          style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
        >
          <div className="mb-3 flex items-center">
            <div className="text-[13.5px] font-medium text-[var(--ink)]">History detail</div>
            <button
              type="button"
              onClick={() => setSelectedHistory(null)}
              className="ml-auto text-[12px] text-[var(--mute)] hover:text-[var(--ink)]"
            >
              Close
            </button>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <JsonViewer label="Input args" value={selectedHistory.args_json} />
            <JsonViewer label="Output result" value={selectedHistory.result_json} />
          </div>
        </div>
      )}

      <Heatmap rows={reliability} />
    </div>
  );
}
