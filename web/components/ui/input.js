import { cn } from "@/lib/utils";

export function Input({ className, ...props }) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-2xl border border-white/10 bg-ink/40 px-4 text-sm text-white outline-none placeholder:text-slate-500 focus:border-signal",
        className
      )}
      {...props}
    />
  );
}
