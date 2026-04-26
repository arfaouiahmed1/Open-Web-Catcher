"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/* ── count-up hook ── */
function useCountUp(target, duration = 650) {
  const [display, setDisplay] = useState(0);
  const rafRef  = useRef(null);
  const startTs = useRef(null);
  const fromRef = useRef(0);

  useEffect(() => {
    if (typeof target !== "number" || isNaN(target)) return;
    const from = fromRef.current;
    startTs.current = null;

    function tick(now) {
      if (!startTs.current) startTs.current = now;
      const elapsed = now - startTs.current;
      const t = Math.min(elapsed / duration, 1);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const cur = from + (target - from) * eased;
      setDisplay(cur);
      if (t < 1) { rafRef.current = requestAnimationFrame(tick); }
      else        { fromRef.current = target; setDisplay(target); }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return display;
}

/* ── enhanced sparkline ── */
function Sparkline({ data, color = "var(--signal)", live = false }) {
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
  const area = `${line} L ${coords.at(-1).x} ${h} L ${coords[0].x} ${h} Z`;
  const last = coords.at(-1);

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}
      className="absolute right-3 top-3 opacity-95" aria-hidden>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={line}  fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      {live && (
        <>
          <circle cx={last.x} cy={last.y} r="2.5" fill={color} />
          <circle cx={last.x} cy={last.y} r="5"   fill={color} opacity="0"
            style={{ animation: "ping-once 1.5s ease infinite" }} />
        </>
      )}
    </svg>
  );
}

/* ── animated bar ── */
function AnimBar({ pct, color }) {
  const barRef = useRef(null);

  useEffect(() => {
    if (!barRef.current) return;
    barRef.current.style.width = "0%";
    const t = setTimeout(() => {
      if (barRef.current) barRef.current.style.width = `${pct}%`;
    }, 80);
    return () => clearTimeout(t);
  }, [pct]);

  return (
    <div className="mt-3 h-[3px] overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
      <span
        ref={barRef}
        className="block h-full rounded-full"
        style={{ width: "0%", background: color, transition: "width 600ms cubic-bezier(0.4,0,0.2,1)" }}
      />
    </div>
  );
}

/* ── main export ── */
export function KpiCard({
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
}) {
  const isNumeric = typeof value === "number" || (typeof value === "string" && !isNaN(Number(value)));
  const numValue  = isNumeric ? Number(value) : 0;
  const countedUp = useCountUp(numValue);
  const prevValue = useRef(value);
  const numRef    = useRef(null);

  /* count-pop on value change */
  useEffect(() => {
    if (prevValue.current !== value && numRef.current) {
      numRef.current.style.animation = "none";
      // eslint-disable-next-line no-unused-expressions
      numRef.current.offsetHeight;
      numRef.current.style.animation = "count-pop 300ms ease";
    }
    prevValue.current = value;
  }, [value]);

  const valColor =
    accent === "mint"   ? "var(--mint)"   :
    accent === "rose"   ? "var(--rose)"   :
    accent === "accent" ? "var(--signal)" :
    accent              ? accent           :
    "var(--ink)";

  const resolvedBarColor =
    barColor              ? barColor        :
    accent === "mint"     ? "var(--mint)"   :
    accent === "rose"     ? "var(--rose)"   :
    "var(--signal)";

  const displayValue = isNumeric
    ? (Number.isInteger(numValue) ? Math.round(countedUp).toLocaleString() : countedUp.toFixed(2))
    : value;

  return (
    <div
      className="relative overflow-hidden rounded-[12px] border p-[14px_16px] transition-shadow hover:shadow-[0_0_0_1px_color-mix(in_oklch,var(--signal)_18%,transparent)] animate-fade-up"
      style={{ background: "var(--card)", boxShadow: "var(--shadow-card)", border: "1px solid var(--line)" }}
    >
      {sparkData && <Sparkline data={sparkData} color={valColor} live={live} />}

      {/* label row */}
      <div className="flex items-center gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.15em]" style={{ color: "var(--mute)" }}>
          {label}
        </div>
        {live && (
          <span
            className="h-[5px] w-[5px] rounded-full shrink-0"
            style={{ background: "var(--rose)", animation: "breathe 1.4s ease-in-out infinite" }}
            title="Live updating"
          />
        )}
      </div>

      {/* value */}
      <div
        ref={numRef}
        className="mt-2 owc-stat-num text-[26px] leading-none"
        style={{ color: valColor }}
      >
        {displayValue}
      </div>

      {description && (
        <div className="mt-1.5 text-[11px] leading-snug" style={{ color: "var(--mute-2)" }}>{description}</div>
      )}

      {bar != null && <AnimBar pct={bar} color={resolvedBarColor} />}

      {delta && (
        <div
          className={cn(
            "mt-2.5 inline-flex items-center gap-1 font-mono text-[10.5px]",
            deltaDir === "down" ? "text-[var(--rose)]" : "text-[var(--mint)]"
          )}
        >
          {deltaDir === "down" ? "↓" : "↑"} {delta}
        </div>
      )}
    </div>
  );
}
