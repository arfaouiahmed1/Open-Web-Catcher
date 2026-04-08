import { cn } from "@/lib/utils";

export function KpiCard({ label, value, description, delta, accent }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-4 shadow-card">
      <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">{label}</div>
      <div className={cn("mt-2 text-2xl font-semibold tabular-nums", accent || "text-white")}>
        {value}
      </div>
      {description && (
        <div className="mt-1 text-xs text-slate-600 leading-relaxed">{description}</div>
      )}
      {delta !== undefined && (
        <div className={cn("mt-2 text-xs font-medium", delta >= 0 ? "text-surge" : "text-ember")}>
          {delta >= 0 ? "+" : ""}{delta}%
        </div>
      )}
    </div>
  );
}
