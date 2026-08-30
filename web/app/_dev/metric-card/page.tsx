"use client";

import React from "react";
import { MetricCard } from "@/components/library";

export default function MetricCardStory() {
  return (
    <>
      <MetricCard label="Tokens out" state="loading" loadingLabel="Loading metric…" />
      <MetricCard label="Error rate" state="error" errorLabel="Metric query failed." />
      <MetricCard label="Cache hits" value="" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard
          label="LLM calls"
          value={42}
          delta={{ value: 6, direction: "up" }}
          hint="vs previous run"
        />
        <MetricCard
          label="Duration"
          value="3m 41s"
          unit=""
          hint="wall clock"
        />
        <MetricCard
          label="Tool calls"
          value={17}
          delta={{ value: 3, direction: "down" }}
        />
      </div>
    </>
  );
}
