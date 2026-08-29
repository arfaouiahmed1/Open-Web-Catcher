"use client";

import React, { useMemo } from "react";
import { ScreenshotCard } from "@/components/library/ScreenshotCard";
import { collectScreenshotUrls } from "@/lib/run-trace";

export interface ScreenshotGridTabProps {
  events?: Array<Record<string, unknown>>;
  screenshots?: Array<string | { screenshot_url?: string; url?: string; blobref?: string }>;
  title?: string;
}

function normalizeScreenshotsProp(raw: ScreenshotGridTabProps["screenshots"]): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
    else if (item && typeof item === "object") {
      const url = String((item as { screenshot_url?: string }).screenshot_url || (item as { url?: string }).url || "").trim();
      if (url) out.push(url);
    }
  }
  return out;
}

export function ScreenshotGridTab({ events, screenshots: propShots, title = "Screenshots & evidence" }: ScreenshotGridTabProps) {
  const fromEvents = useMemo(() => {
    const set = new Set<string>();
    if (Array.isArray(events)) {
      for (const ev of events) {
        collectScreenshotUrls(ev as unknown, set);
        // Blobref-aware: collectScreenshotUrls filters non-URL shapes, so also scan for blobref: strings
        const raw = ev as Record<string, unknown>;
        const d = (raw.details as Record<string, unknown> | undefined) || (raw.details_json as Record<string, unknown> | undefined) || {};
        function captureBlobref(v: unknown) {
          if (typeof v === "string" && /^blobref:/i.test(v.trim())) set.add(v.trim());
        }
        captureBlobref((d as Record<string, unknown>)?.screenshot_url);
        if (Array.isArray((d as Record<string, unknown>)?.screenshot_urls)) {
          for (const x of (d as { screenshot_urls: unknown[] }).screenshot_urls) captureBlobref(x);
        }
        captureBlobref((raw as { screenshot_url?: unknown })?.screenshot_url);
        // Also scan raw details object for any blobref values
        if (d && typeof d === "object") for (const val of Object.values(d as Record<string, unknown>)) captureBlobref(val);
      }
    }
    return Array.from(set);
  }, [events]);

  const fromProps = useMemo(() => normalizeScreenshotsProp(propShots), [propShots]);

  const all = useMemo(() => {
    const merged = new Set<string>([...fromProps, ...fromEvents]);
    return Array.from(merged);
  }, [fromProps, fromEvents]);

  const hasShots = all.length > 0;

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card" data-testid="screenshot-grid-tab">
      <div className="border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Annotated captures per tool_call_started — blobref aware (resolves via /blobs/{`{key}`}). Shown inline in Event Feed as well.
        </p>
        <div className="text-[11px] text-muted-foreground" data-role="shot-count">
          {hasShots ? `${all.length} evidence frame${all.length === 1 ? "" : "s"} — live via SSE` : "no screenshots yet"}
        </div>
      </div>
      <div className="p-3">
        {!hasShots ? (
          <ScreenshotCard alt="" src={null} emptyLabel="No evidence screenshots captured yet." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-role="shot-grid">
            {all.map((src, idx) => (
              <ScreenshotCard
                key={`${src}-${idx}`}
                src={src}
                alt={`evidence ${idx + 1}`}
                caption={`frame ${idx + 1} · ${src.startsWith("blobref:") ? "blobref" : "url"}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
