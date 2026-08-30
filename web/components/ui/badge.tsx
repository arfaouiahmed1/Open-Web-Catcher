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
          "border-[color-mix(in_oklch,var(--mint)_28%,transparent)] bg-[color-mix(in_oklch,var(--mint)_12%,transparent)] text-[var(--mint)]",
        warning:
          "border-[color-mix(in_oklch,var(--signal)_28%,transparent)] bg-[color-mix(in_oklch,var(--signal)_12%,transparent)] text-[var(--signal)]",
        danger:
          "border-[color-mix(in_oklch,var(--rose)_28%,transparent)] bg-[color-mix(in_oklch,var(--rose)_12%,transparent)] text-[var(--rose)]",
        signal:
          "border-[color-mix(in_oklch,var(--signal)_28%,transparent)] bg-[color-mix(in_oklch,var(--signal)_12%,transparent)] text-[var(--signal)]",
        violet:
          "border-[color-mix(in_oklch,var(--violet)_28%,transparent)] bg-[color-mix(in_oklch,var(--violet)_12%,transparent)] text-[var(--violet)]",
        live:
          "border-[color-mix(in_oklch,var(--violet)_28%,transparent)] bg-[color-mix(in_oklch,var(--violet)_12%,transparent)] text-[var(--violet)]",
        mint:
          "border-[color-mix(in_oklch,var(--mint)_28%,transparent)] bg-[color-mix(in_oklch,var(--mint)_12%,transparent)] text-[var(--mint)]",
        rose:
          "border-[color-mix(in_oklch,var(--rose)_28%,transparent)] bg-[color-mix(in_oklch,var(--rose)_12%,transparent)] text-[var(--rose)]",
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
