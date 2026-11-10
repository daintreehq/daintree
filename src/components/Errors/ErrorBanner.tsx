import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import { Button } from "@/components/ui/button";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import type { ErrorRecord, RetryAction } from "@/store/errorStore";
import { RECURRENCE_THRESHOLD, useErrorStore } from "@/store/errorStore";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { actionService } from "@/services/ActionService";
import { boundedErrorText, sanitizeErrorText } from "@/utils/errorText";
import { logError } from "@/utils/logger";
import { cn } from "@/lib/utils";

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

/**
 * Said in the row's own description slot when the recovery button's request
 * fails. Fixed copy: the cause is in the log, and the error row already shows
 * what went wrong in the first place.
 */
const RECOVERY_FAILED_COPY = "Recovery failed. Try again, or open Diagnostics.";

/**
 * Whether the clamp is hiding lines. `useTruncationDetection` measures width
 * only, and a line clamp overflows downward.
 */
function useClamped<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
  return [ref, clamped] as const;
}

/* Restated under the variant on purpose: Tailwind v4 compiles the
   outline-suppressing utility to an unconditional `--tw-outline-style: none`,
   which cancels `focus-visible:outline-2` unless the style is set again there. */
const FOCUS_RING =
  "outline-hidden focus-visible:outline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2";

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

  // A repeat of the same error keeps the id but replaces the timestamp (and may
  // replace the recovery action), so a failure is keyed to the occurrence it ran
  // against and a result that lands after the row has moved on is dropped. The
  // in-flight state is the row's, not the occurrence's: the button is busy, and
  // looks it, for as long as the request it started is.
  const recoveryKey = error.recoveryAction
    ? `${error.recoveryAction.actionId}@${error.timestamp}`
    : null;
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const recoveryInFlight = useRef(false);
  // The occurrence on screen now; null once the row is gone.
  const liveKey = useRef<string | null>(recoveryKey);
  useEffect(() => {
    liveKey.current = recoveryKey;
  }, [recoveryKey]);
  useEffect(() => {
    return () => {
      liveKey.current = null;
    };
  }, []);

  const handleRecovery = useCallback(async () => {
    const recoveryAction = error.recoveryAction;
    if (!recoveryAction || recoveryKey === null || recoveryInFlight.current) return;
    recoveryInFlight.current = true;
    setRecoveryPending(true);
    setFailedKey(null);
    let failure: unknown;
    let reportedByAction = false;
    try {
      const result = await actionService.dispatch(recoveryAction.actionId, recoveryAction.args, {
        source: "user",
      });
      if (!result.ok) {
        failure = result.error;
        // A push or pull-rebase names its own cause in a toast (#16667), so a
        // "Recovery failed" here would report the same failure twice. Only for
        // a throw out of run(), the one failure that promise covers.
        reportedByAction =
          result.error.code === "EXECUTION_ERROR" &&
          actionService.selfNotifiesOnExecutionError(recoveryAction.actionId);
      }
    } catch (err) {
      failure = err;
    }
    recoveryInFlight.current = false;
    setRecoveryPending(false);
    if (failure === undefined) return;
    // The arguments are left out: they can carry paths and branch names.
    logError("Recovery action failed from error banner", failure, {
      errorId: error.id,
      actionId: recoveryAction.actionId,
    });
    if (reportedByAction) return;
    if (liveKey.current !== recoveryKey) return;
    setFailedKey(recoveryKey);
    // The row stays quiet by design, so a failure after the arrival has been
    // announced needs its own, once per attempt.
    useAnnouncerStore.getState().announce(RECOVERY_FAILED_COPY, "polite");
  }, [error.id, error.recoveryAction, recoveryKey]);

  const handleOpenDiagnostics = useCallback(() => {
    // Not `handleViewErrors`: promoting the error flips this row's button to
    // "View errors", which takes away the retry the user was just told to try.
    useDiagnosticsStore.getState().openDock("problems");
  }, []);

  const message = sanitizeErrorText(error.message);
  const shown = boundedErrorText(message, MESSAGE_LIMIT);
  const [messageRef, clamped] = useClamped<HTMLSpanElement>();
  const progress = error.retryProgress;

  let action: BannerAction | undefined;
  let recoveryFailed = false;
  if (progress) {
    // An automatic retry is under way, so there is nothing to start — only
    // something to stop, and only when the host can stop it.
    action = onCancelRetry
      ? { id: "cancel-retry", label: "Cancel", onClick: () => onCancelRetry(error.id) }
      : undefined;
  } else {
    const cta = bannerCtaFor(error, Boolean(onRetry));
    if (cta === "retry") {
      action = { id: "retry", label: "Retry", icon: RefreshCw, onClick: handleRetry };
    } else if (cta === "recovery" && error.recoveryAction) {
      // Only while the button that failed is still the one on screen: once the
      // row hands recovery to the dock, a failure line would describe a
      // button that is gone.
      recoveryFailed = failedKey === recoveryKey;
      action = {
        id: "recovery",
        label: error.recoveryAction.label,
        onClick: () => void handleRecovery(),
        loading: recoveryPending,
      };
    } else {
      action = { id: "view-errors", label: "View errors", onClick: handleViewErrors };
    }
  }

  const description = progress
    ? `Retrying ${progress.attempt} of ${progress.maxAttempts}…`
    : recoveryFailed
      ? RECOVERY_FAILED_COPY
      : error.recoveryHint
        ? sanitizeErrorText(error.recoveryHint)
        : undefined;

  return (
    <InlineStatusBanner
      severity="error"
      layout="inline"
      // Rows stack, and several assertive regions talking over each other is
      // worse than none. A region mounted already filled is not reliably read
      // either, so arrivals are announced once by the list, and the row stays
      // quiet — including when the overflow popover reveals it again.
      role="status"
      ariaLive="off"
      animated={animated}
      className={className}
      title={
        // Clamped, the message becomes a tab stop whose tooltip holds the rest,
        // so the part a clamp hides is reachable without running the action.
        <TruncatedTooltip
          content={message}
          isTruncated={clamped || shown !== message}
          contentClassName="[overflow-wrap:anywhere]"
        >
          <span
            ref={messageRef}
            className={cn(
              "line-clamp-3 [overflow-wrap:anywhere] rounded-[var(--radius-sm)]",
              FOCUS_RING
            )}
          >
            {shown}
          </span>
        </TruncatedTooltip>
      }
      description={description}
      action={action}
      trailingSlot={
        recoveryFailed ? (
          <Button variant="ghost" size="sm" onClick={handleOpenDiagnostics}>
            Open diagnostics
          </Button>
        ) : undefined
      }
      onClose={() => onDismiss(error.id)}
      closeAriaLabel="Dismiss error"
    />
  );
}
