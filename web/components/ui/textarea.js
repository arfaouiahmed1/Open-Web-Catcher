import { cn } from "@/lib/utils";

export function Textarea({
  className,
  label,
  description,
  mono = false,
  ...props
}) {
  return (
    <div className={label ? "space-y-1.5" : undefined}>
      {label && (
        <label
          className="block text-sm font-medium leading-none text-foreground"
        >
          {label}
        </label>
      )}
      <textarea
        className={cn(
          "flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          mono ? "font-mono text-[12.5px]" : "font-sans",
          className,
        )}
        {...props}
      />
      {description && (
        <p
          className="text-sm text-muted-foreground"
        >
          {description}
        </p>
      )}
    </div>
  );
}
