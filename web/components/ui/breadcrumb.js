import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

export function Breadcrumb({ className, ...props }) {
  return <nav aria-label="Breadcrumb" className={cn("flex items-center", className)} {...props} />;
}

export function BreadcrumbList({ className, ...props }) {
  return <ol className={cn("flex items-center gap-1.5 text-sm text-muted-foreground", className)} {...props} />;
}

export function BreadcrumbItem({ className, ...props }) {
  return <li className={cn("inline-flex items-center gap-1.5", className)} {...props} />;
}

export function BreadcrumbPage({ className, ...props }) {
  return <span aria-current="page" className={cn("font-medium text-foreground", className)} {...props} />;
}

export function BreadcrumbSeparator({ className, children, ...props }) {
  return (
    <li aria-hidden="true" className={cn("text-muted-foreground/60", className)} {...props}>
      {children ?? <ChevronRight className="size-3.5" />}
    </li>
  );
}
