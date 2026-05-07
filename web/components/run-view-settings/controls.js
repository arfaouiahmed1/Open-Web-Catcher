"use client";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export function SettingToggle({ label, description, value, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{description}</div>
        ) : null}
      </div>
      <Switch checked={Boolean(value)} onCheckedChange={onChange} />
    </div>
  );
}

export function SettingNumber({
  label,
  description,
  value,
  onChange,
  min,
  max,
  step,
  unit,
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step || 1}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-8 w-20 text-right font-mono text-xs"
        />
        {unit ? <span className="text-[10.5px] text-muted-foreground">{unit}</span> : null}
      </div>
    </div>
  );
}
