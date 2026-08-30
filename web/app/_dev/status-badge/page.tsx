"use client";

import React from "react";
import { StatusBadge } from "@/components/library";

export default function StatusBadgeStory() {
  return (
    <>
      <StatusBadge state="loading" loadingLabel="…" />
      <StatusBadge state="error" errorLabel="Status unknown." />
      <StatusBadge label="" />
      <div className="flex flex-wrap gap-2">
        <StatusBadge label="pending" tone="neutral" />
        <StatusBadge label="running" tone="info" />
        <StatusBadge label="pass" tone="success" />
        <StatusBadge label="replan" tone="warning" />
        <StatusBadge label="fail" tone="danger" />
      </div>
    </>
  );
}
