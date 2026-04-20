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
  const [prompts, setPrompts]             = useState([]);
  const [selected, setSelected]           = useState("");
  const [initialContent, setInitialContent] = useState("");
  const [content, setContent]             = useState("");
  const [url, setUrl]                     = useState("");
  const [testRun, setTestRun]             = useState(null);
  const [status, setStatus]               = useState("");

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
    if (!response.ok) { setStatus(payload?.detail || "Save failed"); return; }
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
    if (!response.ok) { setStatus(payload?.detail || "Prompt test failed"); return; }
    setTestRun(payload);
    setStatus("Test run started");
  }

  return (
    <div className="space-y-5">

      {/* page header */}
      <div>
        <span className="owc-eyebrow">prompts · system prompt studio</span>
        <h1 className="mt-2 font-['Inter_Tight',sans-serif] text-3xl font-medium tracking-tight text-[var(--ink)]">
          Prompt Studio
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--mute)]">
          Edit, diff, save and test prompt files directly from the console.
        </p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[260px_1fr]">
        {/* file list */}
        <div
          className="rounded-[14px] border overflow-hidden"
          style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
        >
          <div className="border-b px-[18px] py-3.5" style={{ borderColor: "var(--line)" }}>
            <span className="text-[13.5px] font-medium text-[var(--ink)]">Prompt files</span>
          </div>
          <div className="divide-y" style={{ borderColor: "var(--line)" }}>
            {prompts.map((row) => (
              <button
                key={row.name}
                type="button"
                onClick={() => setSelected(row.name)}
                className="w-full px-4 py-3 text-left transition-colors"
                style={selected === row.name
                  ? { background: "color-mix(in oklch, var(--signal) 9%, transparent)", color: "var(--ink)" }
                  : { color: "var(--ink-dim)" }
                }
                onMouseEnter={(e) => { if (selected !== row.name) e.currentTarget.style.background = "rgba(255,255,255,0.025)"; }}
                onMouseLeave={(e) => { if (selected !== row.name) e.currentTarget.style.background = "transparent"; }}
              >
                <div className="font-mono text-[12px]">{row.name}</div>
                <div className="mt-0.5 text-[11px] text-[var(--mute)]">{row.size_bytes} bytes</div>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          {/* editor card */}
          <div
            className="rounded-[14px] border p-4 space-y-3"
            style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
          >
            <div className="flex items-center gap-2">
              <div className="text-[13.5px] font-medium text-[var(--ink)]">{selected || "Select a prompt"}</div>
              <div className="ml-auto text-[12px] text-[var(--mute)]">
                {changes.length} changed line{changes.length !== 1 ? "s" : ""}
              </div>
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-[360px] w-full rounded-lg border px-3 py-2 font-mono text-[12px] focus:outline-none"
              style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.2)", color: "var(--ink-dim)" }}
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="accent" onClick={savePrompt} disabled={!selected}>
                <Save className="mr-1.5 h-3.5 w-3.5" />Save
              </Button>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/watch/123"
                className="min-w-[280px] flex-1 rounded-lg border px-3 py-2 text-[13px] focus:outline-none"
                style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.2)", color: "var(--ink)" }}
              />
              <Button variant="ghost" onClick={testPrompt} disabled={!selected || !url} className="border border-[var(--line)]">
                <Play className="mr-1.5 h-3.5 w-3.5" />Test
              </Button>
            </div>
            {status && <div className="text-[12px] text-[var(--mute)]">{status}</div>}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {/* diff viewer */}
            <div
              className="rounded-[14px] border overflow-hidden"
              style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
            >
              <div className="border-b px-[18px] py-3.5" style={{ borderColor: "var(--line)" }}>
                <span className="text-[13.5px] font-medium text-[var(--ink)]">Diff</span>
              </div>
              <div className="max-h-72 overflow-auto p-3 space-y-1 font-mono text-[11px]">
                {changes.length ? changes.map((row) => (
                  <div
                    key={row.line}
                    className="rounded-[8px] border p-2"
                    style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.2)" }}
                  >
                    <div className="text-[var(--mute)]">line {row.line}</div>
                    <div style={{ color: "var(--rose)" }}>- {row.before || "∅"}</div>
                    <div style={{ color: "var(--mint)" }}>+ {row.after || "∅"}</div>
                  </div>
                )) : <div className="text-[var(--mute-2)] p-1">No changes</div>}
              </div>
            </div>
            <JsonViewer label="Last test run" value={testRun} />
          </div>
        </div>
      </div>
    </div>
  );
}
