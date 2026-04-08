"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Wrench } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { JsonViewer } from "@/components/json-viewer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const PROFILES = ["classification", "landing", "hosting", "embedded"];

const TOOL_HINTS = {
  classification: "get_page_context",
  landing:        "capture_links",
  hosting:        "capture_streams",
  embedded:       "capture_iframes",
};

export default function ToolsPage() {
  const [profile, setProfile]     = useState("hosting");
  const [toolName, setToolName]   = useState(TOOL_HINTS["hosting"]);
  const [argsText, setArgsText]   = useState('{\n  "frame_path": "root"\n}');
  const [result, setResult]       = useState(null);
  const [history, setHistory]     = useState({ rows: [], total: 0 });
  const [error, setError]         = useState("");
  const [isRunning, setIsRunning] = useState(false);

  async function loadHistory(p = profile) {
    const payload = await apiFetch(`/ui/tools/history?profile=${encodeURIComponent(p)}`);
    setHistory(payload);
  }

  useEffect(() => {
    loadHistory(profile).catch((e) => setError(e.message));
  }, [profile]); // eslint-disable-line

  function selectProfile(p) {
    setProfile(p);
    setToolName(TOOL_HINTS[p] || "");
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
    } catch (e) {
      setError(e.message || "Tool call failed");
      setResult({ error: e.message });
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="space-y-5">

      {/* header */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-spark">Tool Playground</p>
        <h1 className="mt-1 text-2xl font-semibold text-white">Direct MCP tool calls</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Execute MCP browser tools in isolation for debugging, verification, and reliability probes.
        </p>
      </div>

      {/* call card */}
      <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-spark" />
          <span className="text-sm font-semibold text-white">Execute tool</span>
        </div>

        {/* profile picker */}
        <div className="space-y-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">Agent profile</label>
          <div className="flex flex-wrap gap-2">
            {PROFILES.map((p) => (
              <button
                key={p}
                onClick={() => selectProfile(p)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  profile === p
                    ? "border-signal/50 bg-signal/10 text-white"
                    : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-slate-200"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* tool name */}
        <div className="space-y-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">Tool name</label>
          <input
            value={toolName}
            onChange={(e) => setToolName(e.target.value)}
            placeholder="capture_streams"
            className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-slate-700 focus:border-signal/50 focus:outline-none font-mono"
          />
        </div>

        {/* args */}
        <Textarea
          label="Arguments (JSON)"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          className="min-h-[100px]"
        />

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-ember/30 bg-ember/10 px-3 py-2.5 text-sm text-ember">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="accent" onClick={callTool} disabled={isRunning}>
            {isRunning ? "Calling…" : "Call tool"}
          </Button>
          <Button variant="ghost" onClick={() => loadHistory(profile)} className="border border-white/10">
            Refresh history
          </Button>
        </div>
      </div>

      {/* result + history */}
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <DataTable
          title="Tool History"
          description={`Persisted calls for ${profile} agent`}
          columns={["created_at","origin","tool_name","status","duration_seconds","related_run_id","call_id"]}
          rows={history.rows || []}
        />
        <JsonViewer label="Last result" value={result} />
      </div>

    </div>
  );
}
