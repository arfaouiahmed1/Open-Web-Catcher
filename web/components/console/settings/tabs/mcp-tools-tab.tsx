"use client";

import * as React from "react";
import { Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const MCP_TOOLS = [
  { name: "navigate", desc: "Load a URL in the browser tab", category: "Navigation" },
  { name: "inspect", desc: "Read the current page DOM structure", category: "Inspection" },
  { name: "interact", desc: "Generic page interaction dispatcher", category: "Interaction" },
  { name: "harvest", desc: "Extract structured media data from the page", category: "Media" },
  { name: "screenshot", desc: "Capture a browser screenshot", category: "Inspection" },
  { name: "wait", desc: "Wait for load, network idle, or a selector", category: "Navigation" },
];

const BACKEND_TOOLS = [
  { name: "memory_search", desc: "Retrieve data from the agent memory store", category: "Memory" },
  { name: "plan", desc: "Read and update the agent execution plan", category: "Planning" },
];

const PROFILES: Record<string, string[]> = {
  Classification: ["navigate", "inspect", "interact", "screenshot", "wait", "memory_search"],
  Landing: ["navigate", "inspect", "interact", "screenshot", "wait", "plan", "memory_search"],
  Hosting: ["navigate", "inspect", "interact", "harvest", "screenshot", "wait", "plan", "memory_search"],
  Embedded: ["navigate", "inspect", "interact", "harvest", "screenshot", "wait", "plan", "memory_search"],
};

export function McpToolsTab({ manifestTools }: { manifestTools?: string[] }): React.JSX.Element {
  return (
    <div className="space-y-4 animate-fade-up">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Runtime driver", "Playwright 1.62.1"],
          ["MCP transport", "Streamable HTTP"],
          ["Isolation", "Isolated contexts"],
          ["Tool count", "6 MCP + 2 backend"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border/60 bg-card px-3.5 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
            <div className="mt-1 text-[14px] font-semibold text-foreground">{value}</div>
          </div>
        ))}
      </div>

      <section className="space-y-3 rounded-2xl border border-border/70 bg-card/95 p-4">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-[14px] font-semibold text-foreground">Canonical tool manifest (v2)</h3>
          <Badge tone="muted" className="ml-auto">
            read-only
          </Badge>
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Authoritative profile definitions. Tools cannot be disabled ad-hoc per run; availability is fixed per agent
          profile. Manifest reports {manifestTools?.length ?? 8} tools.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {MCP_TOOLS.map((tool) => (
            <div key={tool.name} className="rounded-xl border border-border/60 bg-background/50 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <code className="font-mono text-[12px] font-semibold text-foreground">{tool.name}</code>
                <Badge tone="muted" className="ml-auto px-1.5 py-0 text-[9px]">
                  {tool.category}
                </Badge>
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">{tool.desc}</p>
            </div>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {BACKEND_TOOLS.map((tool) => (
            <div
              key={tool.name}
              className="rounded-xl border border-primary/25 bg-primary/5 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <code className="font-mono text-[12px] font-semibold text-primary">{tool.name}</code>
                <Badge tone="signal" className="ml-auto px-1.5 py-0 text-[9px]">
                  backend · {tool.category}
                </Badge>
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">{tool.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        {Object.entries(PROFILES).map(([profile, tools]) => (
          <div key={profile} className="rounded-xl border border-border/60 bg-card p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-foreground">{profile}</span>
              <Badge tone="default" className="text-[10px]">
                {tools.length} tools
              </Badge>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[11px]">
              {tools.map((t) => (
                <span
                  key={t}
                  className={
                    t === "memory_search" || t === "plan"
                      ? "rounded bg-primary/10 px-1.5 py-0.5 text-primary"
                      : "rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                  }
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
