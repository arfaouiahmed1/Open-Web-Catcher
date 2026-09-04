"use client";

import { Cell, Pie, PieChart } from "recharts";

export interface PieDistributionImplProps {
  data: Array<{ label: string; value: number; color?: string }>;
  size?: number;
}

export default function PieDistributionImpl({ data, size = 220 }: PieDistributionImplProps) {
  const positive = (Array.isArray(data) ? data : []).filter((entry) => Number(entry.value || 0) > 0);
  if (!positive.length) {
    return (
      <div className="flex h-[220px] min-h-[220px] items-center justify-center text-[12px] text-muted-foreground/75">
        No distribution data
      </div>
    );
  }
  return (
    <div className="flex h-[220px] min-h-[220px] w-full items-center justify-center">
      <PieChart width={size} height={size}>
        <Pie
          data={positive as unknown as never}
          dataKey="value"
          nameKey="label"
          cx="50%"
          cy="50%"
          innerRadius={Math.round(size * 0.28)}
          outerRadius={Math.round(size * 0.43)}
          paddingAngle={3}
        >
          {positive.map((entry, index) => (
            <Cell
              key={`${entry.label}-${index}`}
              fill={entry.color ?? `var(--chart-${(index % 8) + 1})`}
            />
          ))}
        </Pie>
      </PieChart>
    </div>
  );
}
