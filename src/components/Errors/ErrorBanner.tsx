import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { AppError, RetryAction } from "@/store/errorStore";

export interface ErrorBannerProps {
  error: AppError;
  onDismiss: (id: string) => void;
  onRetry?: (id: string, action: RetryAction, args?: Record<string, unknown>) => void;
  className?: string;
  compact?: boolean;
}

const ERROR_TYPE_LABELS: Record<string, string> = {
  git: "Git Error",
  process: "Process Error",
  filesystem: "File System Error",
  network: "Network Error",
  config: "Configuration Error",
  unknown: "Error",
};

const ERROR_TYPE_ICONS: Record<string, string> = {
  git: "📂",
  process: "⚙️",
  filesystem: "📁",
  network: "🌐",
  config: "⚠️",
  unknown: "❌",
};

export function ErrorBanner({
  error,
  onDismiss,
  onRetry,
  className,
  compact = false,
}: ErrorBannerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = useCallback(async () => {
    if (!error.retryAction || !onRetry) return;

    setIsRetrying(true);
    try {
      await onRetry(error.id, error.retryAction, error.retryArgs);
    } finally {
      setIsRetrying(false);
    }
  }, [error.id, error.retryAction, error.retryArgs, onRetry]);

  const handleDismiss = useCallback(() => {
    onDismiss(error.id);
  }, [error.id, onDismiss]);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const typeLabel = ERROR_TYPE_LABELS[error.type] || "Error";
  const typeIcon = ERROR_TYPE_ICONS[error.type] || "❌";
  const canRetry = error.isTransient && error.retryAction && onRetry;

  if (compact) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 px-2 py-1 text-xs bg-[color-mix(in_oklab,var(--color-status-error)_12%,transparent)] border border-[var(--color-status-error)]/30 rounded",
          className
        )}
      >
        <span className="shrink-0">{typeIcon}</span>
        <span className="text-[var(--color-status-error)] truncate flex-1">{error.message}</span>
        {canRetry && (
          <Button
            variant="outline"
            size="xs"
            onClick={handleRetry}
            disabled={isRetrying}
            className="border-[var(--color-status-success)]/50 text-[var(--color-status-success)] hover:text-[var(--color-status-success)]/80"
          >
            {isRetrying ? "..." : "Retry"}
          </Button>
        )}
        <Button
          variant="ghost-danger"
          size="icon-sm"
          onClick={handleDismiss}
          aria-label="Dismiss error"
        >
          ×
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "border border-[var(--color-status-error)]/30 bg-[color-mix(in_oklab,var(--color-status-error)_12%,transparent)] rounded-[var(--radius-lg)] overflow-hidden",
        className
      )}
      role="alert"
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-[color-mix(in_oklab,var(--color-status-error)_12%,transparent)]">
        <span className="shrink-0 text-lg">{typeIcon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--color-status-error)] font-medium">
              {typeLabel}
            </span>
            {error.source && (
              <span className="text-xs text-[var(--color-status-error)]/80">• {error.source}</span>
            )}
          </div>
          <p className="text-sm text-[var(--color-status-error)] truncate">{error.message}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {error.details && (
            <Button
              variant="ghost-danger"
              size="xs"
              onClick={toggleExpanded}
              aria-expanded={isExpanded}
              aria-controls={`error-details-${error.id}`}
            >
              {isExpanded ? "Hide" : "Details"}
            </Button>
          )}
          {canRetry && (
            <Button
              variant="outline"
              size="xs"
              onClick={handleRetry}
              disabled={isRetrying}
              className="border-[var(--color-status-success)]/50 text-[var(--color-status-success)] hover:text-[var(--color-status-success)]/80 hover:bg-[var(--color-status-success)]/10"
            >
              {isRetrying ? "Retrying..." : "Retry"}
            </Button>
          )}
          <Button
            variant="ghost-danger"
            size="icon-sm"
            onClick={handleDismiss}
            aria-label="Dismiss error"
          >
            ×
          </Button>
        </div>
      </div>

      {isExpanded && error.details && (
        <div
          id={`error-details-${error.id}`}
          className="px-3 py-2 border-t border-[var(--color-status-error)]/30 bg-[color-mix(in_oklab,var(--color-status-error)_12%,transparent)]"
        >
          <pre className="text-xs text-[var(--color-status-error)]/80 whitespace-pre-wrap break-all font-mono overflow-x-auto">
            {error.details}
          </pre>
        </div>
      )}
    </div>
  );
}

export default ErrorBanner;
