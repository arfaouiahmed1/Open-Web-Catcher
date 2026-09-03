import * as React from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode | null;
  actions?: React.ReactNode | null;
  className?: string;
  kicker?: React.ReactNode;
}
export const PageHeader = React.memo(function PageHeader({
  eyebrow,
  title,
  description,
  icon = null,
  actions = null,
  className,
  kicker,
}: PageHeaderProps): React.JSX.Element {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4 animate-fade-up", className)}>
      <div className="min-w-0 flex-1">
        {kicker ? <div className="mb-2">{kicker}</div> : null}
        {eyebrow ? <span className="owc-eyebrow">{eyebrow}</span> : null}
        <div className="mt-2 flex items-center gap-3">
          {icon ? <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-card shadow-sm text-muted-foreground">{icon}</span> : null}
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">{title}</h1>
        </div>
        {description ? <p className="mt-1.5 max-w-[68ch] text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
});
