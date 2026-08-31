import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  description?: string;
  error?: string;
  mono?: boolean;
  invalid?: boolean;
};

export function Textarea({
  className,
  label,
  description,
  error,
  mono = false,
  invalid,
  id,
  ...props
}: TextareaProps) {
  const autoId = React.useId();
  const inputId = id ?? autoId;
  const hasError = Boolean(error) || invalid;
  const describedBy = hasError ? `${inputId}-error` : description ? `${inputId}-desc` : undefined;
  return (
    <div className={label ? "space-y-1.5" : undefined}>
      {label ? (
        <label htmlFor={inputId} className="block text-sm font-semibold leading-none text-foreground">
          {label}
          {props.required ? <span className="ml-1 text-destructive" aria-hidden>*</span> : null}
        </label>
      ) : null}
      <textarea
        id={inputId}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        className={cn(
          "flex min-h-[120px] w-full rounded-lg border bg-background px-3.5 py-2.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50 transition-colors hover:border-input",
          hasError ? "border-destructive focus-visible:ring-destructive/40 bg-destructive/5" : "border-border focus-visible:ring-ring",
          mono ? "font-mono text-sm" : "font-sans font-medium",
          className,
        )}
        {...props}
      />
      {hasError && error ? (
        <p id={`${inputId}-error`} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : description ? (
        <p id={`${inputId}-desc`} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}
