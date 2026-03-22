import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { TriangleAlert } from "lucide-react";

export interface ErrorFallbackProps {
  error: Error;
  errorInfo?: React.ErrorInfo;
  resetError: () => void;
  variant?: "fullscreen" | "section" | "component";
  componentName?: string;
  incidentId?: string | null;
  onReport?: () => void;
}

const VARIANT_STYLES = {
  fullscreen: "h-screen w-screen flex items-center justify-center bg-canopy-bg",
  section: "h-full w-full flex items-center justify-center p-8",
  component:
    "p-4 rounded-[var(--radius-lg)] bg-[color-mix(in_oklab,var(--color-status-error)_12%,transparent)] border border-status-error/30",
} as const;

const VARIANT_SIZES = {
  fullscreen: {
    icon: "size-16",
    title: "text-2xl",
    message: "text-base",
    button: "px-6 py-3 text-base",
  },
  section: {
    icon: "size-9",
    title: "text-xl",
    message: "text-sm",
    button: "px-4 py-2 text-sm",
  },
  component: {
    icon: "size-6",
    title: "text-base",
    message: "text-xs",
    button: "px-3 py-1.5 text-xs",
  },
} as const;

export function ErrorFallback({
  error,
  errorInfo,
  resetError,
  variant = "component",
  componentName,
  incidentId,
  onReport,
}: ErrorFallbackProps) {
  const sizes = VARIANT_SIZES[variant];

  const handleOpenLogs = () => {
    void actionService.dispatch("logs.openFile", undefined, { source: "user" });
  };

  return (
    <div
      className={cn(VARIANT_STYLES[variant])}
      data-testid="error-fallback"
      data-variant={variant}
    >
      <div className="flex flex-col items-center gap-4 max-w-2xl">
        <TriangleAlert className={cn("text-status-error", sizes.icon)} />

        <div className="text-center space-y-2">
          <h2
            className={cn("font-semibold text-status-error", sizes.title)}
            data-testid="error-fallback-title"
          >
            {variant === "fullscreen" && "Application Error"}
            {variant === "section" && "Section Error"}
            {variant === "component" && `${componentName || "Component"} Error`}
          </h2>

          <p className={cn("text-canopy-text/80", sizes.message)}>
            {import.meta.env.DEV
              ? error.message
              : "Something went wrong. Please try again or contact support."}
          </p>

          {variant === "fullscreen" && (
            <p className={cn("text-canopy-text/60", sizes.message)}>
              The application encountered an unexpected error. You can try restarting or check the
              logs for more details.
            </p>
          )}

          {!import.meta.env.DEV && incidentId && variant !== "component" && (
            <p className={cn("text-canopy-text/50 font-mono", sizes.message)}>
              Error ID: {incidentId.slice(-7)}
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={resetError}
            data-testid="error-fallback-restart"
            className={cn(
              "bg-status-error hover:bg-[color-mix(in_oklab,var(--color-status-error)_85%,transparent)] text-canopy-bg rounded transition-colors",
              sizes.button
            )}
          >
            {variant === "fullscreen" ? "Restart Application" : "Try Again"}
          </button>

          {variant !== "component" && onReport && (
            <button
              type="button"
              onClick={onReport}
              data-testid="error-fallback-report"
              className={cn(
                "bg-canopy-border hover:bg-canopy-border/80 text-canopy-text rounded transition-colors",
                sizes.button
              )}
            >
              Report Issue
            </button>
          )}

          <button
            type="button"
            onClick={handleOpenLogs}
            data-testid="error-fallback-logs"
            className={cn(
              "bg-canopy-border hover:bg-canopy-border/80 text-canopy-text rounded transition-colors",
              sizes.button
            )}
          >
            View Logs
          </button>
        </div>

        {import.meta.env.DEV && errorInfo?.componentStack && variant !== "component" && (
          <details className="w-full mt-4">
            <summary className="cursor-pointer text-xs text-canopy-text/60 hover:text-canopy-text/80">
              Technical Details
            </summary>
            <pre className="mt-2 p-3 bg-scrim-soft rounded text-xs text-status-error/80 overflow-auto max-h-48">
              {error.stack || "No stack trace available"}
              {"\n\nComponent Stack:\n"}
              {errorInfo.componentStack}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
