"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

export function TooltipProvider({ delayDuration = 150, ...props }) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  maxWidth = 260,
  ...props
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 overflow-hidden rounded-md border border-border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md",
          className,
        )}
        style={{ maxWidth }}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export function HelpIcon({ tip, side = "top" }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-input bg-muted text-[9px] font-bold text-muted-foreground"
            aria-label="Help"
          >
            ?
          </button>
        </TooltipTrigger>
        <TooltipContent side={side}>{tip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
