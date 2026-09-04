import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { StateFrame } from "@/components/library/StateFrame";

export interface SectionPanelProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  headerClassName?: string;
  actions?: React.ReactNode;
  state?: "loading" | "error" | "empty" | "success";
  loadingLabel?: string;
  errorLabel?: string;
  emptyLabel?: string;
  icon?: React.ReactNode;
}

export function SectionPanel({
  title,
  description,
  children,
  className,
  contentClassName,
  headerClassName,
  actions,
  state,
  loadingLabel,
  errorLabel,
  emptyLabel,
  icon,
}: SectionPanelProps): React.JSX.Element {
  const hasState = Boolean(state);
  return (
    <Card className={cn("overflow-hidden", className)}>
      {title || description ? (
        <CardHeader className={cn("flex flex-col gap-3 space-y-0 pb-3 lg:flex-row lg:items-start lg:justify-between", headerClassName)}>
          <div className="flex min-w-0 flex-1 items-start gap-3">
            {icon ? <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">{icon}</span> : null}
            <div className="min-w-0 flex-1">
              {title ? <CardTitle className="text-sm font-semibold">{title}</CardTitle> : null}
              {description ? <CardDescription className="text-xs leading-relaxed">{description}</CardDescription> : null}
            </div>
          </div>
          {actions ? <div className="min-w-0 w-full lg:w-auto shrink-0">{actions}</div> : null}
        </CardHeader>
      ) : null}
      <CardContent className={cn(hasState && !title && !description ? "pt-6" : undefined, contentClassName)}>
        {hasState ? (
          <StateFrame component="SectionPanel" state={state as never} loadingLabel={loadingLabel} errorLabel={errorLabel} emptyLabel={emptyLabel}>
            {children}
          </StateFrame>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

export function SectionPanelSkeleton({ className }: { className?: string }): React.JSX.Element {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="pb-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-1.5 h-3 w-48" />
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </CardContent>
    </Card>
  );
}

export default React.memo(SectionPanel);
