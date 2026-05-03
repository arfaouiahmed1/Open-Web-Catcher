import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function SectionPanel({
  title,
  description,
  children,
  className,
  contentClassName,
  headerClassName,
}) {
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
