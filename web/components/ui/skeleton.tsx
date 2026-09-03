import * as React from "react";
import { cn } from "@/lib/utils";

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: "default" | "shimmer" | "pulse";
};

export function Skeleton({ className, variant = "default", ...props }: SkeletonProps) {
  if (variant === "shimmer") {
    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-md bg-muted",
          "after:absolute after:inset-0 after:-translate-x-full after:bg-gradient-to-r after:from-transparent after:via-white/10 after:to-transparent after:animate-[scan_1.6s_linear_infinite]",
          className
        )}
        {...props}
      />
    );
  }
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-xl border bg-card p-5 space-y-3", className)}>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <div className="grid gap-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-20" />
          <Skeleton className="h-10 w-24" />
        </div>
      ))}
    </div>
  );
}
