"use client";

import React from "react";
import { apiFetchBlob, apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { StateFrame, resolveState } from "./StateFrame";
import type { ComponentState } from "./types";

/**
 * Resolve a screenshot source. Plain http(s)/data URLs pass through; DB
 * blobref pointers (`blobref:<16-hex>`, see src/api/app.py read_blob_endpoint)
 * resolve against the bare `/blobs/{key}` route — note there is NO `/api`
 * prefix on that mount.
 */
export function resolveScreenshotSrc(src?: string | null): string | null {
  if (!src) return null;
  const trimmed = src.trim();
  if (!trimmed) return null;
  const blobref = /^blobref:(.+)$/i.exec(trimmed);
  if (blobref) {
    return apiUrl(`/blobs/${encodeURIComponent(blobref[1])}`);
  }
  return trimmed;
}

export interface ScreenshotCardProps {
  /** Full URL, blobref pointer (`blobref:<key>`), or raw blob key. */
  src?: string | null;
  alt?: string;
  caption?: string;
  state?: ComponentState;
  loadingLabel?: string;
  errorLabel?: string;
  emptyLabel?: string;
  className?: string;
}

/** Evidence screenshot with blobref-aware URL resolution. */
export function ScreenshotCard({
  src,
  alt = "Screenshot",
  caption,
  state,
  loadingLabel = "Loading screenshot…",
  errorLabel,
  emptyLabel = "No screenshot captured.",
  className,
}: ScreenshotCardProps) {
  const resolvedSrc = resolveScreenshotSrc(src);
  const blobKey =
    resolvedSrc && /^blobref:/i.test((src ?? "").trim())
      ? ((src ?? "").trim().replace(/^blobref:/i, "") || undefined)
      : undefined;
  const [blobSrc, setBlobSrc] = React.useState<string | null>(null);
  const [blobState, setBlobState] = React.useState<ComponentState>(blobKey ? "loading" : "success");
  const [blobError, setBlobError] = React.useState("");

  React.useEffect(() => {
    if (!blobKey) {
      setBlobSrc(null);
      setBlobState("success");
      setBlobError("");
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setBlobSrc(null);
    setBlobState("loading");
    setBlobError("");
    void apiFetchBlob(`/blobs/${encodeURIComponent(blobKey)}`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobSrc(objectUrl);
        setBlobState("success");
      })
      .catch((error) => {
        if (!cancelled) {
          setBlobState("error");
          setBlobError(error instanceof Error ? error.message : "Failed to load screenshot");
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [blobKey]);

  const displaySrc = blobKey ? blobSrc : resolvedSrc;
  const resolved =
    state ?? (blobKey ? blobState : resolveState(undefined, Boolean(displaySrc)));
  return (
    <StateFrame
      component="ScreenshotCard"
      state={resolved}
      loadingLabel={loadingLabel}
      errorLabel={blobError || errorLabel}
      emptyLabel={emptyLabel}
      className={cn("max-w-md", className)}
    >
      <figure className="space-y-1 p-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary backend-hosted evidence URLs */}
        <img
          src={displaySrc ?? undefined}
          alt={alt}
          data-blob-key={blobKey}
          className="w-full rounded-md border border-border object-contain"
          loading="lazy"
          decoding="async"
        />
        {caption ? (
          <figcaption className="px-1 text-xs text-muted-foreground">
            {caption}
          </figcaption>
        ) : null}
      </figure>
    </StateFrame>
  );
}
