import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default: "border border-input bg-background text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground hover:border-accent",
        accent: "bg-primary text-primary-foreground shadow-sm hover:opacity-90 hover:shadow-md",
        success: "bg-[var(--mint)] text-[#09090b] dark:text-primary-foreground shadow-sm hover:bg-[var(--mint)]/90",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        danger: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        outline: "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    isLoading?: boolean;
    loadingLabel?: string;
  };

export function Button({ className, variant, size, asChild = false, isLoading = false, loadingLabel, children, disabled, ...props }: ButtonProps) {
  const isDisabled = disabled || isLoading;
  const cls = cn(buttonVariants({ variant, size }), isLoading && "relative", className);
  const content = (
    <>
      {isLoading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
      {isLoading && loadingLabel ? loadingLabel : children}
    </>
  );
  if (asChild) {
    // Slot requires single element child; fall back to button if multiple or non-element
    const childCount = React.Children.count(children);
    const first = React.Children.only as unknown as (c: React.ReactNode) => React.ReactElement;
    try {
      if (childCount === 1 && React.isValidElement(React.Children.toArray(children)[0])) {
        return (
          <Slot className={cls} aria-busy={isLoading || undefined} {...(props as unknown as Record<string, unknown>)}>
            {children as React.ReactElement}
          </Slot>
        );
      }
    } catch {
      // fall through to button
    }
    // If asChild requested but children invalid for Slot, render as button to avoid crash during prerender
    return (
      <button className={cls} disabled={isDisabled} aria-busy={isLoading || undefined} {...props}>
        {content}
      </button>
    );
  }
  return (
    <button className={cls} disabled={isDisabled} aria-busy={isLoading || undefined} {...props}>
      {content}
    </button>
  );
}
