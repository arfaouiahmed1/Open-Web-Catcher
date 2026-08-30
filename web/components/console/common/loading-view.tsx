import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export interface LoadingViewProps {
  label?: string;
  className?: string;
}

export const LoadingView = React.memo(function LoadingView({ label = "Loading...", className }: LoadingViewProps): React.JSX.Element {
  return (
    <div className={cn("flex items-center justify-center gap-3 py-12 text-muted-foreground", className)}>
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  );
});
