"use client";

import React from "react";
import { LogViewer } from "@/components/library";

const LINES = [
  "[09:12:00] orchestrator: run started strategy=aggressive",
  "[09:12:03] planner: emitted run plan (5 steps)",
  "[09:13:24] probe: HEAD http://portal.example/a.m3u8 -> 200 (318ms)",
  "[09:13:31] probe: HEAD http://cdn.example/b.m3u8 -> 405, retrying GET",
  "[09:13:33] probe: GET http://cdn.example/b.m3u8 -> 200 (742ms)",
  "",
  "[09:14:02] judge: evidence_score=0.55 below threshold 0.7",
  "[09:14:05] orchestrator: requesting replan (attempt 2)",
];

export default function LogViewerStory() {
  return (
    <>
      <LogViewer state="loading" loadingLabel="Waiting for logs…" />
      <LogViewer state="error" errorLabel="Log tail unavailable." />
      <LogViewer lines={[]} />
      <LogViewer lines={LINES} follow />
      {/* maxLines keeps only the tail and shows a "+N earlier" head */}
      <LogViewer lines={LINES} maxLines={3} title="Tail (last 3)" />
    </>
  );
}
