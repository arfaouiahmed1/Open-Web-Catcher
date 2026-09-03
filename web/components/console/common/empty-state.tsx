import * as React from "react";
import { Inbox, SearchX, WifiOff, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type EmptyStateTone = "default" | "search" | "offline" | "error";

const TONE_ICON: Record<EmptyStateTone, React.ReactNode> = {
  default: <Inbox className="h-5 w-5" />,
  search: <SearchX className="h-5 w-5" />,
  offline: <WifiOff className="h-5 w-5" />,
  error: <AlertTriangle className="h-5 w-5" />,
};

export interface EmptyStateProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  tone?: EmptyStateTone;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

export const EmptyState = React.memo(function EmptyState({ title, description, tone = "default", icon, action, actionLabel, onAction, className }: EmptyStateProps): React.JSX.Element {
  const toneIcon = icon ?? TONE_ICON[tone];
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 py-12 text-center animate-fade-in-soft", className)}>
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground">{toneIcon}</div>
      <div className="space-y-1">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {description ? <p className="mx-auto max-w-[42ch] text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {action ? action : actionLabel && onAction ? <Button variant="outline" size="sm" onClick={onAction}>{actionLabel}</Button> : null}
    </div>
  );
});
