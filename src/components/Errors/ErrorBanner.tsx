import { useCallback } from "react";
import { RotateCcw } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import type { ErrorRecord, RetryAction } from "@/store/errorStore";
import { RECURRENCE_THRESHOLD, useErrorStore } from "@/store/errorStore";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { actionService } from "@/services/ActionService";
import { boundedErrorText, sanitizeErrorText } from "@/utils/errorText";

/**
 * Decide which CTA the banner should render. Pure function of `retryability`
 * plus the optional wiring (`retryAction`, `recoveryAction`, `onRetry` prop):
 *
 *   - `"auto"` + retryAction + onRetry → Retry
 *   - `"user-gated"` + recoveryAction  → run the structured recovery action
 *   - everything else                  → View errors
 */
type BannerCta = "retry" | "recovery" | "view-errors";

function bannerCtaFor(error: ErrorRecord, hasOnRetry: boolean): BannerCta {
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

/**
 * The failure itself is the one thing the row exists to say, so it gets three
 * lines before it gives way — enough for nearly every classified message at a
 * card's 320px — and the rest stays in the tooltip.
 */
const MESSAGE_LIMIT = 300;

export interface ErrorBannerProps {
  error: ErrorRecord;
  onDismiss: (id: string) => void;
  onRetry?: (id: string, action: RetryAction, args?: Record<string, unknown>) => void;
  onCancelRetry?: (id: string) => void;
  /** Off where the row is revealed rather than arriving — inside the overflow popover. */
  animated?: boolean;
  className?: string;
}

/**
 * One error from the error store, as a row of the inline banner family.
 *
 * It used to hand-roll its own row: severity-red type in three alpha steps, a
 * category glyph per error type, and a hint that kept its width while the
 * message it explained truncated to a single letter. It now renders through
 * `InlineStatusBanner`, so it carries severity the way every sibling does — the
 * band and the error glyph — and inherits their neutral type, their controls
 * that never select the host, and their focus hand-off when a row leaves.
 */
export function ErrorBanner({
  error,
  onDismiss,
  onRetry,
  onCancelRetry,
  animated,
  className,
}: ErrorBannerProps) {
  const handleRetry = useCallback(() => {
    if (!error.retryAction || !onRetry) return;
    onRetry(error.id, error.retryAction, error.retryArgs);
  }, [error.id, error.retryAction, error.retryArgs, onRetry]);

  const handleViewErrors = useCallback(() => {
    useDiagnosticsStore.getState().openDock("problems");
    useErrorStore.getState().promoteErrors([error.id]);
  }, [error.id]);

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

  const message = sanitizeErrorText(error.message);
  const progress = error.retryProgress;

  let action: BannerAction | undefined;
  if (progress) {
    // An automatic retry is under way, so there is nothing to start — only
    // something to stop, and only when the host can stop it.
    action = onCancelRetry
      ? { id: "cancel-retry", label: "Cancel", onClick: () => onCancelRetry(error.id) }
      : undefined;
  } else {
    const cta = bannerCtaFor(error, Boolean(onRetry));
    if (cta === "retry") {
      action = { id: "retry", label: "Retry", icon: RotateCcw, onClick: handleRetry };
    } else if (cta === "recovery" && error.recoveryAction) {
      action = {
        id: "recovery",
        label: error.recoveryAction.label,
        onClick: () => void handleRecovery(),
      };
    } else {
      action = { id: "view-errors", label: "View errors", onClick: handleViewErrors };
    }
  }

  const description = progress
    ? `Retrying ${progress.attempt} of ${progress.maxAttempts}…`
    : error.recoveryHint
      ? sanitizeErrorText(error.recoveryHint)
      : undefined;

  return (
    <InlineStatusBanner
      severity="error"
      layout="inline"
      // Rows stack, and several assertive regions talking over each other is
      // worse than none; a polite status still announces an arrival.
      role="status"
      animated={animated}
      className={className}
      title={
        <span className="line-clamp-3 [overflow-wrap:anywhere]" title={message}>
          {boundedErrorText(message, MESSAGE_LIMIT)}
        </span>
      }
      description={description}
      action={action}
      onClose={() => onDismiss(error.id)}
      closeAriaLabel="Dismiss error"
    />
  );
}
