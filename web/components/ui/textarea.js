import { cn } from "@/lib/utils";

export function Textarea({ className, label, ...props }) {
  return (
    <div className={label ? "space-y-1.5" : undefined}>
      {label && <label className="text-xs font-medium text-slate-400">{label}</label>}
      <textarea
        className={cn(
          "min-h-[120px] w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:border-signal/60 focus:outline-none transition-colors resize-none font-mono",
          className
        )}
        {...props}
      />
    </div>
  );
}
