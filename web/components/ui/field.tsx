"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface FieldProps {
  label?: React.ReactNode;
  description?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}

export function Field({ label, description, error, hint, required, htmlFor, className, children }: FieldProps) {
  const hasError = Boolean(error);
  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <label htmlFor={htmlFor} className="block text-sm font-semibold leading-none text-foreground">
          {label}
          {required ? <span className="ml-1 text-destructive" aria-hidden>*</span> : null}
        </label>
      ) : null}
      {children}
      {hasError ? (
        <p role="alert" className="text-xs font-medium text-destructive animate-fade-in-soft">
          {error}
        </p>
      ) : description || hint ? (
        <p className="text-xs text-muted-foreground">{description ?? hint}</p>
      ) : null}
    </div>
  );
}

export function FieldGroup({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-3", className)}>
      {title ? <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</h4> : null}
      <div className="grid gap-3">{children}</div>
    </div>
  );
}
