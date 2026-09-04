"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

export interface BarTrendImplProps {
  data: Array<Record<string, unknown>>;
  valueFormatter?: (v: number) => string;
  label?: string;
}

export default function BarTrendImpl({ data, valueFormatter }: BarTrendImplProps) {
  if (!Array.isArray(data) || data.length === 0) {
    return <div className="py-6 text-center text-xs text-muted-foreground">No trend data.</div>;
  }
  return (
    <div className="h-[220px] w-full">
      <BarChart data={data as never} margin={{ top: 6, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" opacity={0.4} />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="var(--muted-foreground)"
          tickFormatter={valueFormatter as never}
          width={56}
        />
        <Bar dataKey="value" fill="var(--signal)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </div>
  );
}
