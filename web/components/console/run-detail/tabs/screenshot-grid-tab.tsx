import React, { useMemo } from "react";
import { Image as ImageIcon, Camera } from "lucide-react";
import { ScreenshotCard } from "@/components/library/ScreenshotCard";
import { SectionPanel } from "@/components/console/common/section-panel";
import { EmptyState } from "@/components/console/common/empty-state";
import { Badge } from "@/components/ui/badge";
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
    <SectionPanel
      title={title}
      description="Annotated captures per tool_call_started — blobref aware (resolves via /blobs/{key}). Shown inline in Event Feed as well."
      icon={<ImageIcon className="h-3.5 w-3.5" />}
      actions={
        <Badge tone={hasShots ? "success" : "muted"} className="text-[10px] gap-1">
          <Camera className="h-3 w-3" />
          <span data-role="shot-count">{hasShots ? `${all.length} evidence frame${all.length === 1 ? "" : "s"} — live` : "no screenshots yet"}</span>
        </Badge>
      }
      className="animate-fade-up"
      data-testid="screenshot-grid-tab"
    >
      {!hasShots ? (
        <ScreenshotCard alt="evidence screenshot" emptyLabel="No evidence screenshots captured yet" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-role="shot-grid">
          {all.map((src, idx) => (
            <ScreenshotCard key={`${src}-${idx}`} src={src} alt={`evidence ${idx + 1}`} />
          ))}
        </div>
      )}
    </SectionPanel>
  );
}
