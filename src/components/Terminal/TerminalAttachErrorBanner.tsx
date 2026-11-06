import { RefreshCw } from "lucide-react";
import { InlineStatusBanner } from "./InlineStatusBanner";
import { sanitizeErrorText } from "@/utils/errorText";

export interface TerminalAttachErrorBannerProps {
  terminalId: string;
  error: string;
  /**
   * Whether the pane's process is known to be alive. `attachError` outlives an
   * exit or a failed spawn, so the banner can't assume it is.
   */
  processRunning: boolean;
  onRetry: (id: string) => void;
  isRetrying?: boolean;
  className?: string;
}

/**
 * T3 inline error banner for a pane whose xterm instance could not be opened
 * (#11776).
 *
 * Severity is "error", not "warning", and the distinction is the whole point:
 * the scrollback banner's terminal still works and is only missing history,
 * whereas this pane paints *nothing* while its agent keeps running and the PTY
 * keeps streaming. That is a data-visibility failure — the user is blind to a
 * live process — so it earns the error tier and a recovery action, per the
 * runtime-signal tiers in CLAUDE.md. It stays inline rather than routing
 * through notify() because both the signal and its recovery live in this one
 * pane.
 *
 * Copy leads with the reassurance that nothing is lost, because the failure
 * looks exactly like a hung agent and that is the wrong conclusion to draw.
 * It only says so while the process is running: after an exit the restart
 * banner below says what happened, and this one is just about the display.
 */
export function TerminalAttachErrorBanner({
  terminalId,
  error,
  processRunning,
  onRetry,
  isRetrying = false,
  className,
}: TerminalAttachErrorBannerProps) {
  return (
    <InlineStatusBanner
      title="Terminal display failed"
      description={
        processRunning
          ? "The process is still running and its output is being recorded."
          : undefined
      }
      // Unbounded, as the scrollback banner's is: one clipped row whose tooltip
      // holds the whole message, so the reassurance stays first.
      contextLine={sanitizeErrorText(error).replace(/\s+/g, " ").trim() || undefined}
      severity="error"
      action={{
        id: "retry-attach",
        label: "Retry",
        icon: RefreshCw,
        variant: "primary",
        onClick: () => onRetry(terminalId),
        title: "Rebuild the terminal display and replay its output",
        // Visible label stays the bare recovery verb per CLAUDE.md; the
        // accessible name carries the context a screen-reader user has no
        // other way to recover from a button announced as just "Retry".
        ariaLabel: "Retry terminal display",
        loading: isRetrying,
      }}
      className={className}
    />
  );
}
