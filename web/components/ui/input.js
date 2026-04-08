import { cn } from "@/lib/utils";

export function Input({ className, label, ...props }) {
  return (
    <div className={label ? "space-y-1.5" : undefined}>
      {label && <label className="text-xs font-medium text-slate-400">{label}</label>}
      <input
        className={cn(
          "h-9 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white placeholder:text-slate-600 focus:border-signal/60 focus:outline-none transition-colors",
          className
        )}
        {...props}
      />
    </div>
  );
}
