import { cn } from "@/lib/utils";

const TONES = {
  default: "border-[var(--line)] bg-[var(--card)] text-[var(--ink-dim)]",
  success: "border-[color-mix(in_oklch,var(--mint)_30%,transparent)] bg-[color-mix(in_oklch,var(--mint)_10%,transparent)] text-[var(--mint)]",
  warning: "border-[color-mix(in_oklch,var(--signal)_30%,transparent)] bg-[color-mix(in_oklch,var(--signal)_10%,transparent)] text-[var(--signal)]",
  danger:  "border-[color-mix(in_oklch,var(--rose)_30%,transparent)] bg-[color-mix(in_oklch,var(--rose)_10%,transparent)] text-[var(--rose)]",
  signal:  "border-[color-mix(in_oklch,var(--signal)_30%,transparent)] bg-[color-mix(in_oklch,var(--signal)_10%,transparent)] text-[var(--signal)]",
  violet:  "border-[color-mix(in_oklch,var(--violet)_30%,transparent)] bg-[color-mix(in_oklch,var(--violet)_10%,transparent)] text-[var(--violet)]",
  live:    "border-[color-mix(in_oklch,var(--violet)_30%,transparent)] bg-[color-mix(in_oklch,var(--violet)_10%,transparent)] text-[var(--violet)]",
};

export function Badge({ className, tone = "default", ...props }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-medium",
        TONES[tone] ?? TONES.default,
        className
      )}
      {...props}
    />
  );
}
