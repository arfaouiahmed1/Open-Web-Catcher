import { cn } from "@/lib/utils";

/* Mini SVG sparkline */
function Sparkline({ data, color = "var(--signal)" }) {
  if (!data || data.length < 2) return null;
  const w = 70, h = 26;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data
    .map((v, i) => {
      const x = ((i / (data.length - 1)) * w).toFixed(1);
      const y = (h - ((v - min) / range) * h).toFixed(1);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="absolute right-3.5 top-3.5 opacity-90">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <polyline
        points={`0,${h} ${pts} ${w},${h}`}
        fill="color-mix(in oklch, var(--signal) 18%, transparent)"
        stroke="none"
      />
    </svg>
  );
}

export function KpiCard({
  label,
  value,
  description,
  delta,
  deltaDir,
  accent,          /* "mint" | "rose" | "accent" | undefined */
  bar,             /* 0-100 fill % */
  barColor,        /* css color override for bar */
  sparkData,       /* number[] for sparkline */
}) {
  const valColor =
    accent === "mint"  ? "var(--mint)"   :
    accent === "rose"  ? "var(--rose)"   :
    accent === "accent"? "var(--signal)" :
    accent /* arbitrary */                :
    "var(--ink)";

  const resolvedBarColor =
    barColor                  ? barColor          :
    accent === "mint"         ? "var(--mint)"     :
    accent === "rose"         ? "var(--rose)"     :
    "var(--signal)";

  return (
    <div
      className="relative overflow-hidden rounded-[10px] border border-[var(--line)] p-[14px_16px]"
      style={{ background: "var(--card)", boxShadow: "var(--shadow-card)" }}
    >
      {sparkData && <Sparkline data={sparkData} />}

      <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--mute)]">
        {label}
      </div>

      <div
        className="mt-2 font-['Inter_Tight',sans-serif] text-[26px] font-medium leading-none tabular-nums tracking-tight"
        style={{ color: valColor }}
      >
        {value}
      </div>

      {description && (
        <div className="mt-1.5 text-[11.5px] text-[var(--mute-2)]">{description}</div>
      )}

      {bar != null && (
        <div
          className="mt-3 h-1 overflow-hidden rounded-full"
          style={{ background: "rgba(255,255,255,0.05)" }}
        >
          <span
            className="block h-full rounded-full"
            style={{ width: `${bar}%`, background: resolvedBarColor }}
          />
        </div>
      )}

      {delta && (
        <div
          className={cn(
            "mt-2.5 inline-flex items-center gap-1 font-mono text-[11px]",
            deltaDir === "down" ? "text-[var(--rose)]" : "text-[var(--mint)]"
          )}
        >
          {delta}
        </div>
      )}
    </div>
  );
}
