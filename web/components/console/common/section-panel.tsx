import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface SectionPanelProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  headerClassName?: string;
}

export function SectionPanel({
  title,
  description,
  children,
  className,
  contentClassName,
  headerClassName,
}: SectionPanelProps): React.JSX.Element {
  return (
    <Card className={className}>
      {title || description ? (
        <CardHeader className={cn("pb-3", headerClassName)}>
          {title ? <CardTitle className="text-base">{title}</CardTitle> : null}
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}

export default React.memo(SectionPanel);
