"use client";

import dynamic from "next/dynamic";
import React, { Suspense } from "react";

// Route-level code-splitting for T44: recharts is ~180kB parsed. Lazy-load ensures
// initial bundles for /runs, /settings etc. exclude it (dynamic chunks).

// Recharts chunk — loaded only when a route actually renders charts (overview).
export const LazyAreaTrend = dynamic(
  async () => {
    const mod = await import("./AreaTrendImpl");
    return mod;
  },
  {
    ssr: false,
    loading: () => <div className="h-[180px] animate-pulse rounded-lg bg-muted/30" />,
  }
);

// reactflow is similarly heavy (~220kB). Provide a lazy wrapper for WorkflowCanvas.
// @ts-expect-error workflow-canvas is JS without types
export const LazyWorkflowCanvas = dynamic(() => import("@/components/workflow-canvas"), {
  ssr: false,
  loading: () => <div className="h-[320px] animate-pulse rounded-lg bg-muted/30" />,
});
