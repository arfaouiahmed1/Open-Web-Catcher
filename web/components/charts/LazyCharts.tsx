"use client";

import dynamic from "next/dynamic";
import React, { Suspense } from "react";

// Route-level code-splitting for T44: recharts is ~180kB parsed. Lazy-load ensures
// initial bundles for /runs, /settings etc. exclude it (dynamic chunks).

// Recharts chunk — loaded only when a route actually renders charts (overview).
export const LazyAreaTrend = dynamic(
  async () => {
    // next/dynamic code-splitting: recharts heavy, ssr false needs dynamic import
    const mod = await import("./AreaTrendImpl");
    return mod;
  },
  {
    ssr: false,
    loading: () => <div className="min-h-[220px] h-[220px] animate-pulse rounded-lg bg-muted/30" />,
  }
);

// reactflow is similarly heavy (~220kB). Provide a lazy wrapper for WorkflowCanvas.
// @ts-expect-error workflow-canvas is JS without types
export const LazyWorkflowCanvas = dynamic(() => import("@/components/workflow-canvas"), {
  ssr: false,
  loading: () => <div className="min-h-[320px] h-[320px] animate-pulse rounded-lg bg-muted/30" />,
});

export const LazyBarTrend = dynamic(
  async () => {
    // next/dynamic code-splitting: recharts heavy, ssr false needs dynamic import
    const mod = await import("./BarTrendImpl");
    return mod;
  },
  {
    ssr: false,
    loading: () => <div className="min-h-[220px] h-[220px] animate-pulse rounded-lg bg-muted/30" />,
  }
);

export const LazyPieDistribution = dynamic(
  async () => {
    // next/dynamic code-splitting: recharts heavy, ssr false needs dynamic import
    const mod = await import("./PieDistributionImpl");
    return mod;
  },
  {
    ssr: false,
    loading: () => <div className="min-h-[220px] h-[220px] animate-pulse rounded-lg bg-muted/30" />,
  }
);

