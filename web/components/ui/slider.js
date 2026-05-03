"use client";

import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

export function Slider({
  className,
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
  const displayValue = formatValue
    ? formatValue(value)
    : typeof value === "number" && !Number.isInteger(value)
      ? value.toFixed(step < 0.1 ? 2 : 1)
      : String(value ?? "");

  return (
    <div className="space-y-2">
      {(label || unit) && (
        <div className="flex items-center justify-between gap-2">
          {label ? <Label>{label}</Label> : <span />}
          <span
            className="rounded-md border border-input bg-background px-2 py-0.5 font-mono text-xs font-semibold tabular-nums text-foreground"
            style={{ minWidth: "44px", textAlign: "center" }}
          >
            {displayValue}
            {unit ? <span className="ml-0.5 opacity-70">{unit}</span> : null}
          </span>
        </div>
      )}

      <SliderPrimitive.Root
        value={[Number(value || 0)]}
        onValueChange={(values) => onChange?.(values[0] ?? min)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className={cn("relative flex w-full touch-none select-none items-center py-1", className)}
      >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary">
          <SliderPrimitive.Range className="absolute h-full rounded-full" style={{ background: color }} />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          className="block h-4 w-4 rounded-full border border-primary bg-background shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
          style={{ borderColor: color }}
        />
      </SliderPrimitive.Root>

      <div className="flex justify-between font-mono text-[9px] text-muted-foreground">
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>

      {description ? (
        <p className="text-sm leading-snug text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
