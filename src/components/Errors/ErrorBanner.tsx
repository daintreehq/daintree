import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  FolderOpen,
  Globe,
  HardDrive,
  Lightbulb,
  Settings,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { ErrorRecord, RetryAction } from "@/store/errorStore";

export interface ErrorBannerProps {
  error: ErrorRecord;
  onDismiss: (id: string) => void;
  onRetry?: (id: string, action: RetryAction, args?: Record<string, unknown>) => void;
  onCancelRetry?: (id: string) => void;
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

const ERROR_TYPE_ICONS: Record<string, LucideIcon> = {
  git: FolderOpen,
  process: Settings,
  filesystem: HardDrive,
  network: Globe,
  config: TriangleAlert,
  unknown: XCircle,
};

export function ErrorBanner({
  error,
  onDismiss,
  onRetry,
  onCancelRetry,
  className,
  compact = false,
}: ErrorBannerProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const isRetrying = !!error.retryProgress;

  const handleRetry = useCallback(async () => {
    if (!error.retryAction || !onRetry) return;
    await onRetry(error.id, error.retryAction, error.retryArgs);
  }, [error.id, error.retryAction, error.retryArgs, onRetry]);

  const handleCancel = useCallback(() => {
    onCancelRetry?.(error.id);
  }, [error.id, onCancelRetry]);

  const handleDismiss = useCallback(() => {
    onDismiss(error.id);
  }, [error.id, onDismiss]);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const typeLabel = ERROR_TYPE_LABELS[error.type] || "Error";
  const TypeIcon = ERROR_TYPE_ICONS[error.type] ?? XCircle;
  const canRetry = error.isTransient && error.retryAction && onRetry;

  const retryLabel = error.retryProgress
    ? `Retrying ${error.retryProgress.attempt}/${error.retryProgress.maxAttempts}...`
    : "Retry";

  if (compact) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 px-2 py-1 text-xs bg-[color-mix(in_oklab,var(--color-status-error)_12%,transparent)] border border-status-error/30 rounded",
          className
        )}
      >
        <TypeIcon className="w-4 h-4 shrink-0 text-status-error" />
        <span className="text-status-error truncate flex-1">{error.message}</span>
        {error.recoveryHint && (
          <span className="text-status-error/70 text-xs shrink-0 truncate max-w-[40%]">
            {error.recoveryHint}
          </span>
        )}
        {isRetrying && onCancelRetry && (
          <>
            <span className="text-status-warning text-[10px] shrink-0">{retryLabel}</span>
            <Button variant="ghost-danger" size="xs" onClick={handleCancel}>
              Cancel
            </Button>
          </>
        )}
        {!isRetrying && canRetry && (
          <Button
            variant="outline"
            size="xs"
            onClick={handleRetry}
            className="border-status-success/50 text-status-success hover:text-status-success/80"
          >
            Retry
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
        "border border-status-error/30 bg-[color-mix(in_oklab,var(--color-status-error)_12%,transparent)] rounded-[var(--radius-lg)] overflow-hidden",
        className
      )}
      role="alert"
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-[color-mix(in_oklab,var(--color-status-error)_12%,transparent)]">
        <TypeIcon className="w-5 h-5 shrink-0 text-status-error" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-status-error font-medium">{typeLabel}</span>
            {error.source && <span className="text-xs text-status-error/80">• {error.source}</span>}
          </div>
          <p className="text-sm text-status-error truncate">{error.message}</p>
          {error.recoveryHint && (
            <p className="flex items-center gap-1 text-xs text-status-error/70 mt-0.5">
              <Lightbulb className="w-3 h-3 shrink-0" />
              {error.recoveryHint}
            </p>
          )}
          {error.correlationId && (
            <span className="font-mono text-[10px] text-status-error/40">
              Ref: {error.correlationId.split("-")[0]}
            </span>
          )}
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
          {isRetrying && onCancelRetry && (
            <>
              <span className="text-status-warning text-[10px]">{retryLabel}</span>
              <Button variant="ghost-danger" size="xs" onClick={handleCancel}>
                Cancel
              </Button>
            </>
          )}
          {!isRetrying && canRetry && (
            <Button
              variant="outline"
              size="xs"
              onClick={handleRetry}
              className="border-status-success/50 text-status-success hover:text-status-success/80 hover:bg-status-success/10"
            >
              Retry
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
          className="px-3 py-2 border-t border-status-error/30 bg-[color-mix(in_oklab,var(--color-status-error)_12%,transparent)]"
        >
          <pre className="text-xs text-status-error/80 whitespace-pre-wrap break-all font-mono overflow-x-auto select-text">
            {error.details}
          </pre>
        </div>
      )}
    </div>
  );
}
