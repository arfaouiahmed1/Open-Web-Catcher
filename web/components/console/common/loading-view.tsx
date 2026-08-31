import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export interface LoadingViewProps {
  label?: string;
  className?: string;
  variant?: "spinner" | "skeleton" | "shimmer";
  rows?: number;
}

export const LoadingView = React.memo(function LoadingView({ label = "Loading…", className, variant = "spinner", rows = 3 }: LoadingViewProps): React.JSX.Element {
  if (variant === "skeleton") {
    return (
      <div className={cn("space-y-3 py-6", className)}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
    );
  }
  if (variant === "shimmer") {
    return (
      <div className={cn("space-y-3 py-6", className)}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} variant="shimmer" className="h-12 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div className={cn("flex items-center justify-center gap-3 py-12 text-muted-foreground", className)} role="status" aria-live="polite">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      <span className="text-sm">{label}</span>
    </div>
  );
});
