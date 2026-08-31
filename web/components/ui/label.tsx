"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";
export type LabelProps = React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & {
  required?: boolean;
};

export function Label({ className, required, children, ...props }: LabelProps) {
  return (
    <LabelPrimitive.Root
      className={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    >
      {children}
      {required ? <span className="ml-1 text-destructive" aria-hidden>*</span> : null}
    </LabelPrimitive.Root>
  );
}
