import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }) {
  return (
    <textarea
      className={cn(
        "min-h-[140px] w-full rounded-2xl border border-white/10 bg-ink/40 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-500 focus:border-signal",
        className
      )}
      {...props}
    />
  );
}
