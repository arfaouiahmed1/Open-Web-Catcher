import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "h-3 w-3",
  default: "h-4 w-4",
  lg: "h-6 w-6",
  xl: "h-8 w-8",
};

export function Spinner({ size = "default", className, ...props }) {
  return (
    <Loader2
      role="status"
      aria-label="Loading"
      className={cn("animate-spin text-muted-foreground", SIZES[size], className)}
      {...props}
    />
  );
}
