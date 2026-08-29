"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

export interface AreaTrendImplProps {
  data: Array<Record<string, unknown>>;
  valueFormatter?: (v: number) => string;
  label?: string;
}

export default function AreaTrendImpl({ data, valueFormatter, label }: AreaTrendImplProps) {
  if (!Array.isArray(data) || data.length === 0) return <div className="py-6 text-center text-xs text-muted-foreground">No trend data.</div>;
  return (
    <div className="h-[180px] w-full">
      <AreaChart data={data as unknown as never} margin={{ top: 6, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" opacity={0.4} />
        <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
        <YAxis tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" tickFormatter={valueFormatter as unknown as never} width={56} />
        <Area type="monotone" dataKey="value" stroke="var(--signal)" fill="color-mix(in oklch, var(--signal) 18%, transparent)" strokeWidth={2} dot={false} />
      </AreaChart>
    </div>
  );
}
