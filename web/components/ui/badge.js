import { cn } from "@/lib/utils";

export function Badge({ className, tone = "default", ...props }) {
  const tones = {
    default: "bg-white/10 text-white",
    success: "bg-emerald-500/15 text-emerald-200",
    warning: "bg-amber-500/15 text-amber-100",
    danger: "bg-red-500/15 text-red-200",
    signal: "bg-signal/20 text-signal"
  };
  return (
    <span
      className={cn("inline-flex items-center rounded-full px-3 py-1 text-xs font-medium", tones[tone], className)}
      {...props}
    />
  );
}
