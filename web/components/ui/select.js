import { cn } from "@/lib/utils";

export function Select({ className, label, children, ...props }) {
  return (
    <div className={label ? "space-y-1.5" : undefined}>
      {label && <label className="text-xs font-medium text-slate-400">{label}</label>}
      <select
        className={cn(
          "h-9 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white focus:border-signal/60 focus:outline-none transition-colors cursor-pointer",
          className
        )}
        {...props}
      >
        {children}
      </select>
    </div>
  );
}
