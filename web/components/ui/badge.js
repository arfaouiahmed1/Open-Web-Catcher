import { cn } from "@/lib/utils";

const TONES = {
  default: "bg-white/10 text-slate-300 border-white/10",
  success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  danger:  "bg-red-500/10  text-red-400  border-red-500/20",
  signal:  "bg-blue-500/10 text-blue-400 border-blue-500/20",
  violet:  "bg-violet-500/10 text-violet-400 border-violet-500/20",
};

export function Badge({ className, tone = "default", ...props }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
        TONES[tone] ?? TONES.default,
        className
      )}
      {...props}
    />
  );
}
