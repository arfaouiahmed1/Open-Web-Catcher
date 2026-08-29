import * as React from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
}

export const EmptyState = React.memo(function EmptyState({ title, description, className }: EmptyStateProps): React.JSX.Element {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 py-12 text-center", className)}>
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description ? <p className="max-w-[42ch] text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
});
