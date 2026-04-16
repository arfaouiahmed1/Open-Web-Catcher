"use client";

import { useEffect, useMemo, useState } from "react";
import { Play, Save } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { JsonViewer } from "@/components/json-viewer";

function diffLines(original, edited) {
  const a = String(original || "").split("\n");
  const b = String(edited || "").split("\n");
  const max = Math.max(a.length, b.length);
  const rows = [];
  for (let idx = 0; idx < max; idx += 1) {
    if ((a[idx] || "") === (b[idx] || "")) continue;
    rows.push({ line: idx + 1, before: a[idx] || "", after: b[idx] || "" });
  }
  return rows;
}

export default function PromptsPage() {
  const [prompts, setPrompts] = useState([]);
  const [selected, setSelected] = useState("");
  const [initialContent, setInitialContent] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [testRun, setTestRun] = useState(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    apiFetch("/ui/prompts").then((payload) => {
      const rows = payload?.prompts || [];
      setPrompts(rows);
      if (rows.length) setSelected(rows[0].name);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    apiFetch(`/ui/prompts/${selected}`).then((payload) => {
      const text = payload?.content || "";
      setInitialContent(text);
      setContent(text);
      setStatus("");
    });
  }, [selected]);

  const changes = useMemo(() => diffLines(initialContent, content), [initialContent, content]);

  async function savePrompt() {
    setStatus("Saving...");
    const response = await fetch(apiUrl(`/ui/prompts/${selected}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload?.detail || "Save failed");
      return;
    }
    setInitialContent(content);
    setStatus("Saved");
  }

  async function testPrompt() {
    setStatus("Starting test run...");
    const agent = selected.replace("_v1.md", "").replace("_page", "");
    const response = await fetch(apiUrl("/ui/prompts/test"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, url, content }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload?.detail || "Prompt test failed");
      return;
    }
    setTestRun(payload);
    setStatus("Test run started");
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-spark">Prompts</p>
        <h1 className="mt-1 text-2xl font-semibold text-white">Prompt Studio</h1>
        <p className="mt-0.5 text-sm text-slate-500">Edit, diff, save and test prompt files directly.</p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[260px_1fr]">
        <div className="rounded-xl border border-white/8 bg-white/[0.03] overflow-hidden">
          <div className="border-b border-white/6 px-4 py-3 text-xs font-semibold text-white">Prompt files</div>
          <div className="divide-y divide-white/4">
            {prompts.map((row) => (
              <button
                key={row.name}
                type="button"
                onClick={() => setSelected(row.name)}
                className={`w-full px-4 py-3 text-left text-xs transition-colors ${selected === row.name ? "bg-signal/10 text-white" : "text-slate-400 hover:bg-white/[0.04]"}`}
              >
                <div className="font-mono">{row.name}</div>
                <div className="mt-0.5 text-[11px] text-slate-600">{row.size_bytes} bytes</div>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-white">{selected || "Select a prompt"}</div>
              <div className="ml-auto text-xs text-slate-600">{changes.length} changed line{changes.length !== 1 ? "s" : ""}</div>
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-[360px] w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs text-slate-200"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="accent" onClick={savePrompt} disabled={!selected}>
                <Save className="mr-1.5 h-3.5 w-3.5" />Save
              </Button>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/watch/123"
                className="min-w-[280px] flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white"
              />
              <Button variant="ghost" onClick={testPrompt} disabled={!selected || !url}>
                <Play className="mr-1.5 h-3.5 w-3.5" />Test
              </Button>
            </div>
            {status && <div className="text-xs text-slate-500">{status}</div>}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-white/8 bg-white/[0.03] overflow-hidden">
              <div className="border-b border-white/6 px-4 py-3 text-xs font-semibold text-white">Diff</div>
              <div className="max-h-72 overflow-auto p-3 space-y-1 text-xs font-mono">
                {changes.length ? changes.map((row) => (
                  <div key={row.line} className="rounded border border-white/6 bg-black/20 p-2">
                    <div className="text-slate-600">line {row.line}</div>
                    <div className="text-red-300">- {row.before || "∅"}</div>
                    <div className="text-emerald-300">+ {row.after || "∅"}</div>
                  </div>
                )) : <div className="text-slate-700">No changes</div>}
              </div>
            </div>
            <JsonViewer label="Last test run" value={testRun} />
          </div>
        </div>
      </div>
    </div>
  );
}
