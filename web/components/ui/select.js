import { cn } from "@/lib/utils";

export function Select({ className, children, ...props }) {
  return (
    <select
      className={cn(
        "h-11 w-full rounded-2xl border border-white/10 bg-ink/40 px-4 text-sm text-white outline-none focus:border-signal",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}
