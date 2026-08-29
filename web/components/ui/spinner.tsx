import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES: Record<string, string> = {
  sm: "h-3 w-3",
  default: "h-4 w-4",
  lg: "h-6 w-6",
  xl: "h-8 w-8",
};

export type SpinnerProps = React.ComponentPropsWithoutRef<typeof Loader2> & {
  size?: "sm" | "default" | "lg" | "xl";
};

export function Spinner({ size = "default", className, ...props }: SpinnerProps) {
  return (
    <Loader2
      role="status"
      aria-label="Loading"
      className={cn("animate-spin text-muted-foreground", SIZES[size], className)}
      {...props}
    />
  );
}
