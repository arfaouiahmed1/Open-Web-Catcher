import { cn } from "@/lib/utils";

export function Input({ className, label, description, ...props }) {
  return (
    <div className={label ? "space-y-2" : undefined}>
      {label && (
        <label
          className="block text-sm font-semibold leading-none text-foreground"
        >
          {label}
        </label>
      )}
      <input
        className={cn(
          "flex h-10 w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm font-medium ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 transition-colors hover:border-input",
          className,
        )}
        {...props}
      />
      {description && (
        <p
          className="text-xs text-muted-foreground"
        >
          {description}
        </p>
      )}
    </div>
  );
}
