import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";

export interface ErrorFallbackProps {
  error: Error;
  errorInfo?: React.ErrorInfo;
  resetError: () => void;
  variant?: "fullscreen" | "section" | "component";
  componentName?: string;
  onReport?: () => void;
}

const VARIANT_STYLES = {
  fullscreen: "h-screen w-screen flex items-center justify-center bg-canopy-bg",
  section: "h-full w-full flex items-center justify-center p-8",
  component:
    "p-4 rounded-[var(--radius-lg)] bg-[color-mix(in_oklab,var(--color-status-error)_12%,transparent)] border border-[var(--color-status-error)]/30",
} as const;

const VARIANT_SIZES = {
  fullscreen: {
    icon: "text-6xl",
    title: "text-2xl",
    message: "text-base",
    button: "px-6 py-3 text-base",
  },
  section: {
    icon: "text-4xl",
    title: "text-xl",
    message: "text-sm",
    button: "px-4 py-2 text-sm",
  },
  component: {
    icon: "text-2xl",
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
  onReport,
}: ErrorFallbackProps) {
  const sizes = VARIANT_SIZES[variant];

  const handleOpenLogs = () => {
    void actionService.dispatch("logs.openFile", undefined, { source: "user" });
  };

  return (
    <div className={cn(VARIANT_STYLES[variant])}>
      <div className="flex flex-col items-center gap-4 max-w-2xl">
        <div className={cn("text-[var(--color-status-error)]", sizes.icon)}>⚠️</div>

        <div className="text-center space-y-2">
          <h2 className={cn("font-semibold text-[var(--color-status-error)]", sizes.title)}>
            {variant === "fullscreen" && "Application Error"}
            {variant === "section" && "Section Error"}
            {variant === "component" && `${componentName || "Component"} Error`}
          </h2>

          <p className={cn("text-canopy-text/80", sizes.message)}>{error.message}</p>

          {variant === "fullscreen" && (
            <p className={cn("text-canopy-text/60", sizes.message)}>
              The application encountered an unexpected error. You can try restarting or check the
              logs for more details.
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={resetError}
            className={cn(
              "bg-[var(--color-status-error)] hover:bg-[color-mix(in_oklab,var(--color-status-error)_85%,transparent)] text-white rounded transition-colors",
              sizes.button
            )}
          >
            {variant === "fullscreen" ? "Restart Application" : "Try Again"}
          </button>

          {variant === "fullscreen" && onReport && (
            <button
              type="button"
              onClick={onReport}
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
            className={cn(
              "bg-canopy-border hover:bg-canopy-border/80 text-canopy-text rounded transition-colors",
              sizes.button
            )}
          >
            View Logs
          </button>
        </div>

        {errorInfo?.componentStack && variant !== "component" && (
          <details className="w-full mt-4">
            <summary className="cursor-pointer text-xs text-canopy-text/60 hover:text-canopy-text/80">
              Technical Details
            </summary>
            <pre className="mt-2 p-3 bg-black/30 rounded text-xs text-[var(--color-status-error)]/80 overflow-auto max-h-48">
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
