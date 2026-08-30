"use client";

import React from "react";
import { ValidationBadge } from "@/components/library";

// Fixtures mirror JudgeVerdict (src/models/judge.py) JSON keys.
const PASS = {
  verdict: "pass" as const,
  evidence_score: 0.92,
  playback_confidence: 0.87,
  channel_match: true,
};

const REPLAN = {
  verdict: "replan" as const,
  evidence_score: 0.55,
  playback_confidence: 0.4,
  channel_match: false,
  required_fixes: [
    "Re-probe stream A with short-GET fallback",
    "Capture OCR text for the player overlay",
  ],
};

const FAIL = {
  verdict: "fail" as const,
  evidence_score: 0.21,
  playback_confidence: 0.05,
  channel_match: false,
  required_fixes: ["No playable stream found"],
  flagged_urls: ["http://suspect.example/fake.m3u8", "http://suspect.example/2.m3u8"],
};

export default function ValidationBadgeStory() {
  return (
    <>
      <ValidationBadge state="loading" loadingLabel="Judging…" />
      <ValidationBadge state="error" errorLabel="Judge run failed." />
      <ValidationBadge />
      <div className="space-y-3">
        <ValidationBadge {...PASS} />
        <ValidationBadge {...REPLAN} />
        <ValidationBadge {...FAIL} />
      </div>
    </>
  );
}
