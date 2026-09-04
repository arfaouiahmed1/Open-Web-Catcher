import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
  {
    variants: {
      tone: {
        default: "border-transparent bg-secondary text-secondary-foreground",
        success:
          "border-[color-mix(in_oklch,var(--mint)_28%,transparent)] bg-[color-mix(in_oklch,var(--mint)_12%,transparent)] text-[var(--mint-text)]",
        warning:
          "border-[color-mix(in_oklch,var(--signal)_28%,transparent)] bg-[color-mix(in_oklch,var(--signal)_12%,transparent)] text-[var(--signal-text)]",
        danger:
          "border-[color-mix(in_oklch,var(--rose)_28%,transparent)] bg-[color-mix(in_oklch,var(--rose)_12%,transparent)] text-[var(--rose-text)]",
        signal:
          "border-[color-mix(in_oklch,var(--signal)_28%,transparent)] bg-[color-mix(in_oklch,var(--signal)_12%,transparent)] text-[var(--signal-text)]",
        sky:
          "border-[color-mix(in_oklch,var(--sky)_28%,transparent)] bg-[color-mix(in_oklch,var(--sky)_12%,transparent)] text-[var(--sky-text)]",
        info:
          "border-[color-mix(in_oklch,var(--sky)_28%,transparent)] bg-[color-mix(in_oklch,var(--sky)_12%,transparent)] text-[var(--sky-text)]",
        neutral: "border-border bg-muted text-muted-foreground",
        violet:
          "border-[color-mix(in_oklch,var(--violet)_28%,transparent)] bg-[color-mix(in_oklch,var(--violet)_12%,transparent)] text-[var(--violet-text)]",
        live:
          "border-[color-mix(in_oklch,var(--violet)_28%,transparent)] bg-[color-mix(in_oklch,var(--violet)_12%,transparent)] text-[var(--violet-text)]",
        mint:
          "border-[color-mix(in_oklch,var(--mint)_28%,transparent)] bg-[color-mix(in_oklch,var(--mint)_12%,transparent)] text-[var(--mint-text)]",
        rose:
          "border-[color-mix(in_oklch,var(--rose)_28%,transparent)] bg-[color-mix(in_oklch,var(--rose)_12%,transparent)] text-[var(--rose-text)]",
        muted: "border-border bg-muted text-muted-foreground",
        source:
          "border-border bg-muted/60 text-muted-foreground font-sans text-[10px] tracking-wide uppercase",
      },
    },
    defaultVariants: {
      tone: "default",
    },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone = "default", ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
