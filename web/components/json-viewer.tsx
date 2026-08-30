"use client";

import * as React from "react";
import { StructuredDataCard } from "@/components/structured-data-card";

export interface JsonViewerProps {
  value: unknown;
  label?: string;
}

export const JsonViewer = React.memo(function JsonViewer({ value, label }: JsonViewerProps): React.JSX.Element {
  return <StructuredDataCard title={label} data={value} defaultMode="tree" search />;
});
