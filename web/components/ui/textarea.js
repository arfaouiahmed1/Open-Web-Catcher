import { cn } from "@/lib/utils";

export function Textarea({
  className,
  label,
  description,
  mono = false,
  ...props
}) {
  return (
    <div className={label ? "space-y-1.5" : undefined}>
      {label && (
        <label
          className="block text-[10px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: "var(--mute-2)" }}
        >
          {label}
        </label>
      )}
      <textarea
        className={cn(
          "min-h-[120px] w-full rounded-[10px] border px-3 py-2.5 text-[13px] transition-all focus:outline-none",
          "border-[var(--line-hi)] bg-white/[0.03] text-[var(--ink)] placeholder:text-[var(--mute)]",
          "focus:border-[color-mix(in_oklch,var(--signal)_45%,transparent)] focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--signal)_10%,transparent)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          mono ? "font-mono text-[12.5px]" : "font-sans",
          className,
        )}
        {...props}
      />
      {description && (
        <p
          className="text-[10.5px] leading-relaxed"
          style={{ color: "var(--mute-2)" }}
        >
          {description}
        </p>
      )}
    </div>
  );
}
