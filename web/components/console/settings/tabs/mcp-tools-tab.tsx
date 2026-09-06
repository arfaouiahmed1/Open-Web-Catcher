"use client";

import * as React from "react";
import { Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface ManifestTool {
  name: string;
  kind?: string;
  description?: string;
  profiles?: string[];
  mutates_page?: boolean;
  cacheable?: boolean;
}

export interface BrowserToolManifest {
  schema_version?: string;
  generated_at?: string;
  tools?: ManifestTool[];
}

function formatProfile(profile: string): string {
  return profile.charAt(0).toUpperCase() + profile.slice(1);
}

export function McpToolsTab({
  manifest,
}: {
  manifest?: BrowserToolManifest | null;
}): React.JSX.Element {
  const tools = Array.isArray(manifest?.tools) ? manifest.tools : [];
  const mcpTools = tools.filter((tool) => tool.kind !== "langchain");
  const backendTools = tools.filter((tool) => tool.kind === "langchain");
  const profileNames = Array.from(new Set(tools.flatMap((tool) => tool.profiles || [])));
  const available = Boolean(manifest && Array.isArray(manifest.tools));

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Manifest", manifest?.schema_version || "Unavailable"],
          ["Generated", manifest?.generated_at ? new Date(manifest.generated_at).toLocaleString() : "Unavailable"],
          ["Browser tools", String(mcpTools.length)],
          ["Backend tools", String(backendTools.length)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border/60 bg-card px-3.5 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
            <div className="mt-1 truncate text-[14px] font-semibold text-foreground" title={value}>{value}</div>
          </div>
        ))}
      </div>

      {!available ? (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          The canonical browser-tool manifest is unavailable. Reload settings before relying on tool availability.
        </div>
      ) : null}

      <section className="space-y-3 rounded-2xl border border-border/70 bg-card/95 p-4" aria-labelledby="manifest-heading">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <h3 id="manifest-heading" className="text-[14px] font-semibold text-foreground">Canonical tool manifest</h3>
          <Badge tone="muted" className="ml-auto">read-only</Badge>
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Profile membership and tool descriptions come directly from the backend manifest. Tools cannot be disabled ad hoc per run.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {tools.map((tool) => (
            <div key={`${tool.kind || "tool"}:${tool.name}`} className="rounded-xl border border-border/60 bg-background/50 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <code className="font-mono text-[12px] font-semibold text-foreground">{tool.name}</code>
                <Badge tone={tool.kind === "langchain" ? "signal" : "muted"} className="ml-auto px-1.5 py-0 text-[9px]">
                  {tool.kind === "langchain" ? "backend" : "MCP"}
                </Badge>
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">{tool.description || "No description supplied by the manifest."}</p>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                {tool.profiles?.map((profile) => <span key={profile} className="rounded bg-muted px-1.5 py-0.5">{formatProfile(profile)}</span>)}
                {tool.mutates_page !== undefined ? <span className="rounded bg-muted px-1.5 py-0.5">{tool.mutates_page ? "mutates page" : "read-only"}</span> : null}
                {tool.cacheable !== undefined ? <span className="rounded bg-muted px-1.5 py-0.5">{tool.cacheable ? "cacheable" : "not cacheable"}</span> : null}
              </div>
            </div>
          ))}
        </div>
        {available && !tools.length ? <p className="rounded-lg bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">The manifest contains no tools.</p> : null}
      </section>

      {profileNames.length ? (
        <section className="grid gap-3 sm:grid-cols-2" aria-labelledby="profiles-heading">
          <h3 id="profiles-heading" className="sr-only">Manifest profiles</h3>
          {profileNames.map((profile) => {
            const profileTools = tools.filter((tool) => tool.profiles?.includes(profile));
            return (
              <div key={profile} className="rounded-xl border border-border/60 bg-card p-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-foreground">{formatProfile(profile)}</span>
                  <Badge tone="default" className="text-[10px]">{profileTools.length} tools</Badge>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[11px]">
                  {profileTools.map((tool) => <span key={`${profile}:${tool.name}`} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{tool.name}</span>)}
                </div>
              </div>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}
