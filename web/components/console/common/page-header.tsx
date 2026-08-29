import * as React from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode | null;
  actions?: React.ReactNode | null;
  className?: string;
}

export const PageHeader = React.memo(function PageHeader({
  eyebrow,
  title,
  description,
  icon = null,
  actions = null,
  className,
}: PageHeaderProps): React.JSX.Element {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        {eyebrow ? <span className="owc-eyebrow">{eyebrow}</span> : null}
        <div className="mt-2 flex items-center gap-3">
          {icon}
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">{title}</h1>
        </div>
        {description ? <p className="mt-1.5 max-w-[68ch] text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
});
