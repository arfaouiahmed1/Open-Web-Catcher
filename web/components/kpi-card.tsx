"use client";

import { useEffect, useRef, useState, memo } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import type { ComponentState } from "@/components/library/types";
import { StateFrame } from "@/components/library/StateFrame";

/* ── count-up hook ── */
function useCountUp(target: number, duration = 650): number {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startTs = useRef<number | null>(null);
  const fromRef = useRef(0);

  useEffect(() => {
    if (typeof target !== "number" || Number.isNaN(target)) return;
    const from = fromRef.current;
    startTs.current = null;

    function tick(now: number): void {
      if (startTs.current == null) startTs.current = now;
      const elapsed = now - startTs.current;
      const t = Math.min(elapsed / duration, 1);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const cur = from + (target - from) * eased;
      setDisplay(cur);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
        setDisplay(target);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return display;
}

/* ── sparkline ── */
interface SparklineProps {
  data?: number[];
  color?: string;
  live?: boolean;
}
const Sparkline = memo(function Sparkline({ data, color = "var(--signal)", live = false }: SparklineProps): React.JSX.Element | null {
  const gradId = useRef(`sg-${Math.random().toString(36).slice(2)}`).current;
  if (!data || data.length < 2) return null;

  const w = 72, h = 28;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;

  const coords = data.map((v, i) => ({
    x: parseFloat(((i / (data.length - 1)) * w).toFixed(2)),
    y: parseFloat((h - ((v - min) / range) * (h - 4) - 2).toFixed(2)),
  }));

  const line = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
  const area = `${line} L ${coords.at(-1)!.x} ${h} L ${coords[0]!.x} ${h} Z`;
  const last = coords.at(-1)!;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="absolute right-3 top-3 opacity-70" aria-hidden>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.2} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
      {live ? <circle cx={last.x} cy={last.y} r={2.5} fill={color} /> : null}
    </svg>
  );
});

/* ── progress bar ── */
const AnimBar = memo(function AnimBar({ pct, color }: { pct: number; color: string }): React.JSX.Element {
  const barRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!barRef.current) return;
    barRef.current.style.width = "0%";
    const t = setTimeout(() => {
      if (barRef.current) barRef.current.style.width = `${pct}%`;
    }, 80);
    return () => clearTimeout(t);
  }, [pct]);

  return (
    <div className="mt-3 h-[3px] overflow-hidden rounded-full bg-muted">
      <span ref={barRef} className="block h-full rounded-full transition-all duration-700" style={{ width: "0%", background: color }} />
    </div>
  );
});

const ACCENT_MAP: Record<string, string> = {
  signal: "var(--signal)",
  mint: "var(--mint)",
  rose: "var(--rose)",
  sky: "var(--sky)",
  violet: "var(--violet)",
  warning: "var(--signal)",
  accent: "var(--signal)",
  success: "var(--mint)",
  danger: "var(--rose)",
};

export interface KpiCardProps {
  label: string;
  value: number | string;
  description?: string;
  delta?: string;
  deltaDir?: "up" | "down";
  accent?: string;
  bar?: number;
  barColor?: string;
  sparkData?: number[];
  live?: boolean;
  state?: ComponentState;
  emptyLabel?: string;
}

/* ── main export ── NOTE: belongs in library — this top-level shim re-exports library/MetricCard for legacy routes;
   new code should import from @/components/library/MetricCard. */
export const KpiCard = memo(function KpiCard({
  label,
  value,
  description,
  delta,
  deltaDir,
  accent,
  bar,
  barColor,
  sparkData,
  live,
  state,
  emptyLabel,
}: KpiCardProps): React.JSX.Element {
  const isNumeric = typeof value === "number" || (typeof value === "string" && !isNaN(Number(value)));
  const numValue = isNumeric ? Number(value) : 0;
  const countedUp = useCountUp(numValue);
  const prevValue = useRef<number | string>(value);
  const numRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (prevValue.current !== value && numRef.current) {
      numRef.current.style.animation = "none";
      // force reflow
      void numRef.current.offsetHeight;
      numRef.current.style.animation = "count-pop 300ms ease";
    }
    prevValue.current = value;
  }, [value]);

  const valColor = ACCENT_MAP[accent ?? ""] || accent || "var(--foreground)";
  const resolvedBarColor = barColor || ACCENT_MAP[accent ?? ""] || "var(--signal)";

  const displayValue = isNumeric
    ? Number.isInteger(numValue) ? Math.round(countedUp).toLocaleString() : countedUp.toFixed(2)
    : String(value);

  const hasValue = value !== "" && value !== null && value !== undefined;
  const resolvedState: ComponentState | undefined = state ?? (hasValue ? undefined : "empty");

  const inner = (
    <Card className="relative overflow-hidden transition-shadow hover:shadow-md animate-fade-up">
      <CardContent className="p-4">
        {sparkData ? <Sparkline data={sparkData} color={valColor} live={live} /> : null}

        <div className="flex items-center gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">{label}</p>
          {live ? <span className="h-[5px] w-[5px] rounded-full shrink-0" style={{ background: "var(--rose)", animation: "breathe 1.4s ease-in-out infinite" }} /> : null}
        </div>

        <div ref={numRef} className="mt-2 owc-stat-num text-[26px] leading-none font-semibold" style={{ color: valColor }}>
          {displayValue}
        </div>

        {description ? <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground/70">{description}</p> : null}

        {bar != null ? <AnimBar pct={bar} color={resolvedBarColor} /> : null}

        {delta ? (
          <div className={cn("mt-2.5 inline-flex items-center gap-1 font-mono text-[10.5px]", deltaDir === "down" ? "text-[var(--rose-text)]" : "text-[var(--mint-text)]")}>
            {deltaDir === "down" ? "↓" : "↑"} {delta}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );

  if (resolvedState) {
    return (
      <StateFrame component="KpiCard" state={hasValue ? "success" : resolvedState} emptyLabel={emptyLabel} className="border-0 bg-transparent p-0">
        {inner}
      </StateFrame>
    );
  }

  return inner;
});
