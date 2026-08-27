import { useState, useCallback, useEffect, useRef } from "react";
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
import { RECURRENCE_THRESHOLD, useErrorStore } from "@/store/errorStore";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { actionService } from "@/services/ActionService";

/**
 * Decide which CTA the banner should render. Pure function of `retryability`
 * plus the optional wiring (`retryAction`, `recoveryAction`, `onRetry` prop):
 *
 *   - `"auto"` + retryAction + onRetry → Retry
 *   - `"user-gated"` + recoveryAction  → run the structured recovery action
 *   - everything else                  → View errors
 */
type BannerAction = "retry" | "recovery" | "view-errors";

function bannerActionFor(error: ErrorRecord, hasOnRetry: boolean): BannerAction {
  // Once an error has been promoted to the diagnostics dock, the dock owns
  // recovery — flip the banner CTA to "View errors" so the user is routed
  // to the dock instead of seeing a stale Retry next to the open dock.
  if (error.promotedToDock) {
    return "view-errors";
  }
  // Hard exit for runaway-retry conditions: the loop already gave up
  // (retryExhausted) or the same fingerprint has fired ≥ RECURRENCE_THRESHOLD
  // times across sessions. Either way, surfacing Retry would re-run a known
  // failure path. Route to the dock instead so the user sees the full history.
  if (error.retryExhausted || (error.occurrenceCount ?? 0) >= RECURRENCE_THRESHOLD) {
    return "view-errors";
  }
  if (error.retryability === "auto" && error.retryAction && hasOnRetry) {
    return "retry";
  }
  if (error.retryability === "user-gated" && error.recoveryAction) {
    return "recovery";
  }
  return "view-errors";
}

export interface ErrorBannerProps {
  error: ErrorRecord;
  onDismiss: (id: string) => void;
  onRetry?: (id: string, action: RetryAction, args?: Record<string, unknown>) => void;
  onCancelRetry?: (id: string) => void;
  className?: string;
  compact?: boolean;
}

const ERROR_TYPE_LABELS: Record<string, string> = {
  git: "Git error",
  process: "Process error",
  filesystem: "File system error",
  network: "Network error",
  config: "Configuration error",
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
  const [copiedId, setCopiedId] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyGenerationRef = useRef(0);

  const isRetrying = !!error.retryProgress;

  useEffect(() => {
    copyGenerationRef.current += 1;
    setCopiedId(false);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
  }, [error.correlationId]);

  useEffect(() => {
    return () => {
      copyGenerationRef.current += 1;
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

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

  const handleViewErrors = useCallback(() => {
    useDiagnosticsStore.getState().openDock("problems");
    useErrorStore.getState().promoteErrors([error.id]);
  }, [error.id]);

  const handleCopyCorrelationId = useCallback(() => {
    if (!error.correlationId) return;
    if (!navigator.clipboard?.writeText) return;
    const gen = copyGenerationRef.current;
    void navigator.clipboard.writeText(error.correlationId).then(
      () => {
        if (gen !== copyGenerationRef.current) return;
        if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        setCopiedId(true);
        copyTimeoutRef.current = setTimeout(() => {
          setCopiedId(false);
          copyTimeoutRef.current = null;
        }, 2000);
      },
      () => {
        // Clipboard rejected — stay silent.
      }
    );
  }, [error.correlationId]);

  const typeLabel = ERROR_TYPE_LABELS[error.type] || "Error";
  const TypeIcon = ERROR_TYPE_ICONS[error.type] ?? XCircle;
  const action = bannerActionFor(error, Boolean(onRetry));
  const canRetry = action === "retry";
  const showRecovery = action === "recovery";

  const handleRecovery = useCallback(async () => {
    if (!error.recoveryAction) return;
    const result = await actionService.dispatch(
      error.recoveryAction.actionId,
      error.recoveryAction.args,
      { source: "user" }
    );
    if (!result.ok) {
      console.warn("Recovery action dispatch failed:", result.error);
    }
  }, [error.recoveryAction]);

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
            <span className="text-status-warning text-3xs shrink-0">{retryLabel}</span>
            <Button variant="ghost-danger" size="xs" onClick={handleCancel}>
              Cancel
            </Button>
          </>
        )}
        {!isRetrying && canRetry && (
          <Button variant="ghost-danger" size="xs" onClick={handleRetry}>
            Retry
          </Button>
        )}
        {!isRetrying && showRecovery && error.recoveryAction && (
          <Button variant="ghost-danger" size="xs" onClick={handleRecovery}>
            {error.recoveryAction.label}
          </Button>
        )}
        {!isRetrying && !canRetry && !showRecovery && (
          <Button variant="ghost-danger" size="xs" onClick={handleViewErrors}>
            View errors
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
            <button
              type="button"
              onClick={handleCopyCorrelationId}
              aria-label={
                copiedId ? "Correlation ID copied" : `Copy correlation ID ${error.correlationId}`
              }
              className="font-mono text-3xs text-status-error/40 hover:text-status-error/70 cursor-copy transition-colors text-left break-all"
            >
              Ref: {copiedId ? "Copied" : error.correlationId}
            </button>
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
              <span className="text-status-warning text-3xs">{retryLabel}</span>
              <Button variant="ghost-danger" size="xs" onClick={handleCancel}>
                Cancel
              </Button>
            </>
          )}
          {!isRetrying && canRetry && (
            <Button variant="ghost-danger" size="xs" onClick={handleRetry}>
              Retry
            </Button>
          )}
          {!isRetrying && showRecovery && error.recoveryAction && (
            <Button variant="ghost-danger" size="xs" onClick={handleRecovery}>
              {error.recoveryAction.label}
            </Button>
          )}
          {!isRetrying && !canRetry && !showRecovery && !error.details && (
            <Button variant="ghost-danger" size="xs" onClick={handleViewErrors}>
              View errors
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
