"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * OWC Styled Range Slider
 *
 * Props:
 *   value        – current numeric value
 *   onChange     – called with new numeric value
 *   min          – number (default 0)
 *   max          – number (default 1)
 *   step         – number (default 0.01)
 *   label        – string, shown above
 *   description  – string, shown below
 *   color        – CSS color for the filled track (default var(--signal))
 *   unit         – optional unit label, e.g. "ms"
 *   formatValue  – optional function to format the display value
 *   disabled     – boolean
 */
export function Slider({
  value = 0,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  description,
  color = "var(--signal)",
  unit,
  formatValue,
  disabled = false,
}) {
  const trackRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);

  const clamp = useCallback(
    (v) => Math.min(max, Math.max(min, v)),
    [min, max],
  );

  const snapToStep = useCallback(
    (v) => {
      if (step === 0) return v;
      return Math.round((v - min) / step) * step + min;
    },
    [min, step],
  );

  const pct = clamp(value) === min && min === max ? 0 : ((clamp(value) - min) / (max - min)) * 100;

  const displayValue = formatValue
    ? formatValue(value)
    : typeof value === "number" && !Number.isInteger(value)
      ? value.toFixed(step < 0.1 ? 2 : 1)
      : String(value ?? "");

  function valueFromPointer(event, track) {
    const rect = track.getBoundingClientRect();
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return clamp(snapToStep(min + ratio * (max - min)));
  }

  function handleTrackClick(event) {
    if (disabled) return;
    const newVal = valueFromPointer(event, trackRef.current);
    onChange?.(newVal);
  }

  function handleMouseDown(event) {
    if (disabled) return;
    event.preventDefault();
    setDragging(true);
    const newVal = valueFromPointer(event, trackRef.current);
    onChange?.(newVal);
  }

  useEffect(() => {
    if (!dragging) return;

    function onMove(event) {
      const newVal = valueFromPointer(event, trackRef.current);
      onChange?.(newVal);
    }
    function onUp() {
      setDragging(false);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
    };
  }, [dragging]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleKeyDown(event) {
    if (disabled) return;
    const inc = step || (max - min) / 100;
    let next = value;
    if (event.key === "ArrowRight" || event.key === "ArrowUp")
      next = clamp(snapToStep(value + inc));
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown")
      next = clamp(snapToStep(value - inc));
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else return;
    event.preventDefault();
    onChange?.(next);
  }

  return (
    <div className="space-y-2">
      {/* Header row */}
      {(label || unit) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <label
              className="text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{ color: "var(--mute-2)" }}
            >
              {label}
            </label>
          )}
          <div className="flex items-center gap-1.5">
            <span
              className="rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums transition-all"
              style={{
                borderColor: `color-mix(in oklch, ${color} 30%, transparent)`,
                background: `color-mix(in oklch, ${color} 10%, transparent)`,
                color,
                minWidth: "44px",
                textAlign: "center",
              }}
            >
              {displayValue}
              {unit ? <span className="ml-0.5 opacity-70">{unit}</span> : null}
            </span>
          </div>
        </div>
      )}

      {/* Track */}
      <div
        ref={trackRef}
        role="slider"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={label}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        className="relative h-5 cursor-pointer select-none outline-none"
        style={{ opacity: disabled ? 0.45 : 1 }}
        onMouseDown={handleMouseDown}
        onTouchStart={handleMouseDown}
        onClick={handleTrackClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onKeyDown={handleKeyDown}
      >
        {/* Track background */}
        <div
          className="absolute inset-y-0 my-auto h-[4px] w-full overflow-hidden rounded-full"
          style={{ background: "var(--line)" }}
        >
          {/* Filled portion */}
          <div
            className="h-full rounded-full"
            style={{
              width: `${pct}%`,
              background: color,
              transition: dragging ? "none" : "width 80ms ease",
            }}
          />
        </div>

        {/* Thumb */}
        <div
          className="absolute inset-y-0 my-auto h-[16px] w-[16px] -translate-x-1/2 rounded-full border-2 shadow-sm transition-transform"
          style={{
            left: `${pct}%`,
            borderColor: color,
            background: "var(--panel)",
            transform: `translateX(-50%) scale(${dragging ? 1.2 : hovered ? 1.1 : 1})`,
            transition: dragging
              ? "transform 80ms ease"
              : "transform 120ms ease, left 0ms",
            boxShadow: dragging
              ? `0 0 0 4px color-mix(in oklch, ${color} 22%, transparent)`
              : `0 1px 4px rgba(0,0,0,0.35)`,
          }}
        />
      </div>

      {/* Min/max labels */}
      <div
        className="flex justify-between font-mono text-[9px]"
        style={{ color: "var(--mute-3)" }}
      >
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>

      {/* Description */}
      {description && (
        <p className="text-[11px] leading-snug" style={{ color: "var(--mute)" }}>
          {description}
        </p>
      )}
    </div>
  );
}
