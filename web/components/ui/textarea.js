import { cn } from "@/lib/utils";

export function Textarea({ className, label, mono = false, ...props }) {
  return (
    <div className={label ? "space-y-1.5" : undefined}>
      {label && (
        <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
          {label}
        </label>
      )}
      <textarea
        className={cn(
          "min-h-[120px] w-full rounded-[12px] border border-[var(--line)] bg-black/20 px-3 py-2.5 text-[13px] text-[var(--ink)] placeholder:text-[var(--mute)] transition-colors focus:border-[var(--signal)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          mono ? "font-mono text-[12.5px]" : "font-sans",
          className
        )}
        {...props}
      />
    </div>
  );
}
