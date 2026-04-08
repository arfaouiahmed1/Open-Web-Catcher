"use client";

import { useEffect, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { JsonViewer } from "@/components/json-viewer";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const PROFILES = ["classification", "landing", "hosting", "embedded"];

export default function ToolsPage() {
  const [profile, setProfile] = useState("hosting");
  const [toolName, setToolName] = useState("get_page_context");
  const [argsValue, setArgsValue] = useState("{\n  \"frame_path\": \"root\"\n}");
  const [result, setResult] = useState({});
  const [history, setHistory] = useState({ rows: [], total: 0 });
  const [error, setError] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  async function loadHistory(nextProfile = "") {
    const query = nextProfile ? `?profile=${encodeURIComponent(nextProfile)}` : "";
    const payload = await apiFetch(`/ui/tools/history${query}`);
    setHistory(payload);
  }

  useEffect(() => {
    loadHistory(profile).catch((loadError) => {
      setError(loadError.message || "Failed to load tool history.");
    });
  }, [profile]);

  async function callTool() {
    setError("");
    setIsRunning(true);
    try {
      const response = await fetch(apiUrl("/ui/tools/call"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile,
          tool_name: toolName,
          args: JSON.parse(argsValue || "{}")
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.detail || `Tool call failed with ${response.status}`);
      }
      setResult(payload);
      await loadHistory(profile);
    } catch (callError) {
      setError(callError.message || "Tool call failed.");
      setResult({ error: callError.message || "Tool call failed." });
      await loadHistory(profile);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Tool Playground</CardTitle>
          <CardDescription>
            Direct MCP tool execution surface for operator verification, debugging, and reliability probes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Select value={profile} onChange={(event) => setProfile(event.target.value)}>
              {PROFILES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
            <Input value={toolName} onChange={(event) => setToolName(event.target.value)} placeholder="capture_streams" />
          </div>
          <Textarea value={argsValue} onChange={(event) => setArgsValue(event.target.value)} />
          {error ? <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</div> : null}
          <div className="flex flex-wrap gap-3">
            <Button variant="accent" onClick={callTool} disabled={isRunning}>
              {isRunning ? "Calling..." : "Call tool"}
            </Button>
            <Button variant="secondary" onClick={() => loadHistory(profile)}>
              Refresh history
            </Button>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <DataTable
          title="Tool History"
          description={`Persisted operator and evaluation tool calls for ${profile}.`}
          columns={["created_at", "origin", "tool_name", "status", "duration_seconds", "related_run_id", "call_id"]}
          rows={history.rows || []}
        />
        <JsonViewer label="Tool Result" value={result} />
      </div>
    </div>
  );
}
