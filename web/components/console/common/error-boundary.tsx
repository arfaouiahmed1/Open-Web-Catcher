"use client";

import * as React from "react";
import { AlertCircle, RefreshCw, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Custom fallback to render instead of the default card. */
  fallback?: React.ReactNode;
  /** Title shown in the default fallback card. */
  fallbackTitle?: string;
  /** Description shown beneath the title. */
  fallbackDescription?: string;
  /** When true, renders `error.message` inside the fallback. Defaults to `true`. */
  showDetails?: boolean;
  /** When true (default), shows the "Reload page" affordance. */
  enableReload?: boolean;
  /** Called after the internal error state is cleared via "Try again". */
  onReset?: () => void;
  /** Called from `componentDidCatch` for logging / reporting. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Robust class error boundary that catches rendering errors in child trees
 * and renders a polite, themed fallback card.
 *
 * Uses OWC design tokens (`var(--rose)`, `var(--line)`, etc.) so the
 * fallback matches the console theme in both light and dark modes.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onError?.(error, info);
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error("[ErrorBoundary]", error, info.componentStack);
    }
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  private handleReload = (): void => {
    if (typeof window !== "undefined") window.location.reload();
  };

  render(): React.ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback, fallbackTitle, fallbackDescription, showDetails = true, enableReload = true } = this.props;

    if (!hasError) return children;
    if (fallback) return fallback;

    const title = fallbackTitle ?? "Something went wrong";
    const description =
      fallbackDescription ?? "An unexpected error occurred while rendering this view. You can try again or reload the page.";
    const rawMessage = error?.message?.trim() ?? "";
    // Avoid leaking overly long / sensitive stacks; show only the message.
    const displayMessage = rawMessage.length > 500 ? `${rawMessage.slice(0, 500)}…` : rawMessage;

    return (
      <Card
        className="overflow-hidden shadow-sm"
        style={{ borderColor: "var(--line)" }}
        role="alert"
        aria-live="assertive"
      >
        <CardHeader
          className="border-b px-5 py-4"
          style={{
            borderColor: "var(--line)",
            background:
              "linear-gradient(180deg, color-mix(in oklch, var(--rose) 7%, transparent), transparent 72%)",
          }}
        >
          <div className="flex items-start gap-3">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border"
              style={{
                borderColor: "color-mix(in oklch, var(--rose) 22%, transparent)",
                background: "color-mix(in oklch, var(--rose) 10%, transparent)",
                color: "var(--rose)",
              }}
              aria-hidden
            >
              <AlertCircle className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <CardTitle className="text-sm font-semibold leading-tight">{title}</CardTitle>
              <CardDescription className="mt-1 text-xs leading-relaxed">{description}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-5 py-4">
          {showDetails && displayMessage ? (
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{
                borderColor: "color-mix(in oklch, var(--rose) 18%, transparent)",
                background: "color-mix(in oklch, var(--rose) 7%, transparent)",
              }}
            >
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                Error details
              </div>
              <p className="mt-1 break-words font-mono text-xs leading-relaxed" style={{ color: "var(--ink)" }}>
                {displayMessage}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={this.handleReset} className="gap-1.5">
              <RotateCcw className="h-3.5 w-3.5" />
              Try again
            </Button>
            {enableReload ? (
              <Button type="button" variant="ghost" size="sm" onClick={this.handleReload} className="gap-1.5 text-muted-foreground">
                <RefreshCw className="h-3.5 w-3.5" />
                Reload page
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    );
  }
}

/**
 * HOC helper that wraps a component in an `ErrorBoundary`.
 *
 * @example
 * ```tsx
 * export default withErrorBoundary(MyPage, { fallbackTitle: "My page failed" });
 * ```
 */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  boundaryProps?: Omit<ErrorBoundaryProps, "children">
): React.ComponentType<P> {
  function Wrapped(props: P): React.JSX.Element {
    return (
      <ErrorBoundary {...boundaryProps}>
        <Component {...props} />
      </ErrorBoundary>
    );
  }

  const displayName = Component.displayName || Component.name || "Component";
  Wrapped.displayName = `withErrorBoundary(${displayName})`;
  return Wrapped;
}

export default ErrorBoundary;
