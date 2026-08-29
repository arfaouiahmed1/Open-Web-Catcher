"use client";

import React from "react";
import { ReasoningTrace } from "@/components/library";

const ENTRIES = [
  {
    id: "r1",
    title: "Enumerate candidate streams",
    thought:
      "Search results show three plausible IPTV portals; prioritize the two with .m3u8 links.",
    timestamp: "2026-08-26T09:12:00Z",
  },
  {
    id: "r2",
    title: "Probe playback reachability",
    thought: "HEAD then short-GET fallback for CDNs that reject HEAD.",
    timestamp: "2026-08-26T09:13:24Z",
  },
];

export default function ReasoningTraceStory() {
  return (
    <>
      <ReasoningTrace state="loading" loadingLabel="Loading reasoning…" />
      <ReasoningTrace state="error" errorLabel="Trace stream failed." />
      <ReasoningTrace entries={[]} />
      <ReasoningTrace entries={ENTRIES} />
    </>
  );
}
