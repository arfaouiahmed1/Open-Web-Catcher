import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  description?: string;
  error?: string;
  hint?: string;
  invalid?: boolean;
};

export function Input({ className, label, description, error, hint, invalid, id, ...props }: InputProps) {
  const autoId = React.useId();
  const inputId = id ?? autoId;
  const hasError = Boolean(error) || invalid;
  const describedBy = hasError ? `${inputId}-error` : description || hint ? `${inputId}-desc` : undefined;
  return (
    <div className={label ? "space-y-1.5" : undefined}>
      {label ? (
        <label htmlFor={inputId} className="block text-sm font-semibold leading-none text-foreground">
          {label}
          {props.required ? <span className="ml-1 text-destructive" aria-hidden>*</span> : null}
        </label>
      ) : null}
      <input
        id={inputId}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        className={cn(
          "flex h-10 w-full rounded-lg border bg-background px-3.5 py-2.5 text-sm font-medium ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50 transition-colors hover:border-input",
          hasError ? "border-destructive focus-visible:ring-destructive/40 bg-destructive/5" : "border-border focus-visible:ring-ring",
          className,
        )}
        {...props}
      />
      {hasError && error ? (
        <p id={`${inputId}-error`} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : description || hint ? (
        <p id={`${inputId}-desc`} className="text-xs text-muted-foreground">
          {description ?? hint}
        </p>
      ) : null}
    </div>
  );
}
