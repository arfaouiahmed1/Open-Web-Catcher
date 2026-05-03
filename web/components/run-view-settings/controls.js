"use client";

export function SettingToggle({ label, description, value, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-[var(--ink)]">
          {label}
        </div>
        {description && (
          <div className="mt-0.5 text-[11px] leading-snug text-[var(--mute)]">
            {description}
          </div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className="relative shrink-0 rounded-full transition-all"
        style={{
          width: 36,
          height: 20,
          background: value
            ? "color-mix(in oklch, var(--signal) 80%, transparent)"
            : "color-mix(in oklch, var(--mute-3) 60%, transparent)",
          border: `1px solid ${value ? "color-mix(in oklch, var(--signal) 50%, transparent)" : "var(--line)"}`,
          boxShadow: value
            ? "0 0 8px color-mix(in oklch, var(--signal) 30%, transparent)"
            : "none",
        }}
      >
        <span
          className="absolute rounded-full transition-all"
          style={{
            width: 14,
            height: 14,
            top: 2,
            left: value ? 18 : 2,
            background: value ? "white" : "var(--mute-2)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          }}
        />
      </button>
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
        <div className="text-[12.5px] font-medium text-[var(--ink)]">
          {label}
        </div>
        {description && (
          <div className="mt-0.5 text-[11px] text-[var(--mute)]">
            {description}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step || 1}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-16 rounded-md border px-2 py-1 text-right font-mono text-[12px] focus:outline-none focus:ring-1"
          style={{
            borderColor: "var(--line)",
            background: "rgba(0,0,0,0.2)",
            color: "var(--ink-dim)",
          }}
        />
        {unit && (
          <span className="text-[10.5px] text-[var(--mute-3)]">{unit}</span>
        )}
      </div>
    </div>
  );
}
