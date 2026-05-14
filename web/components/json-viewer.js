"use client";

import { StructuredDataCard } from "@/components/structured-data-card";

export function JsonViewer({ value, label }) {
  return (
    <StructuredDataCard
      title={label}
      data={value}
      defaultMode="tree"
      search
    />
  );
}
