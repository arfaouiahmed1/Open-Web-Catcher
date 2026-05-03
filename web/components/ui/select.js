"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

const EMPTY_VALUE = "__owc_empty__";

export function Select({
  className,
  label,
  value,
  onChange,
  options = [],
  placeholder = "Select",
  emptyMessage = "No options available",
  disabled = false,
}) {
  const selected = options.find((option) => option.value === value) || null;
  const normalizedValue =
    value === "" ? EMPTY_VALUE : value === undefined || value === null ? undefined : value;

  return (
    <div className={cn(label ? "space-y-1.5" : undefined, className)}>
      {label ? <Label>{label}</Label> : null}

      <SelectPrimitive.Root
        value={normalizedValue}
        disabled={disabled}
        onValueChange={(nextValue) => {
          const resolvedValue = nextValue === EMPTY_VALUE ? "" : nextValue;
          const option = options.find((item) => item.value === resolvedValue) || null;
          onChange?.(resolvedValue, option);
        }}
      >
        <SelectPrimitive.Trigger className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-left text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
          <SelectPrimitive.Value placeholder={placeholder}>
            {selected ? (
              <span className="min-w-0">
                <span className="block truncate font-medium text-foreground">
                  {selected.label}
                </span>
                {selected.description ? (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {selected.description}
                  </span>
                ) : null}
              </span>
            ) : null}
          </SelectPrimitive.Value>
          <SelectPrimitive.Icon asChild>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            className="z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
          >
            <SelectPrimitive.ScrollUpButton className="flex cursor-default items-center justify-center py-1">
              <ChevronUp className="h-4 w-4" />
            </SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport className="p-1">
              {options.length ? (
                options.map((option) => (
                  <SelectPrimitive.Item
                    key={option.value || EMPTY_VALUE}
                    value={option.value === "" ? EMPTY_VALUE : option.value}
                    className="relative flex w-full cursor-default select-none items-start gap-2 rounded-sm py-2 pl-8 pr-3 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                  >
                    <span className="absolute left-2 top-2.5 flex h-4 w-4 items-center justify-center">
                      <SelectPrimitive.ItemIndicator>
                        <Check className="h-3.5 w-3.5 text-primary" />
                      </SelectPrimitive.ItemIndicator>
                    </span>
                    <span className="min-w-0 flex-1">
                      <SelectPrimitive.ItemText className="block truncate font-medium">
                        {option.label}
                      </SelectPrimitive.ItemText>
                      {option.description ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                      {option.meta ? (
                        <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                          {option.meta}
                        </span>
                      ) : null}
                    </span>
                  </SelectPrimitive.Item>
                ))
              ) : (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {emptyMessage}
                </div>
              )}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className="flex cursor-default items-center justify-center py-1">
              <ChevronDown className="h-4 w-4" />
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  );
}
