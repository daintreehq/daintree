import { MonitorX, RotateCcw } from "lucide-react";
import { InlineStatusBanner } from "./InlineStatusBanner";
import { boundedErrorText } from "@/utils/errorText";

export interface TerminalAttachErrorBannerProps {
  terminalId: string;
  error: string;
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
 */
export function TerminalAttachErrorBanner({
  terminalId,
  error,
  onRetry,
  isRetrying = false,
  className,
}: TerminalAttachErrorBannerProps) {
  const sanitized = boundedErrorText(error);
  const tail = "The process is still running and its output is being recorded.";
  return (
    <InlineStatusBanner
      icon={MonitorX}
      title="Terminal display failed"
      description={sanitized ? `${sanitized} ${tail}` : tail}
      severity="error"
      action={{
        id: "retry-attach",
        label: "Retry",
        icon: RotateCcw,
        variant: "primary",
        onClick: () => onRetry(terminalId),
        title: "Rebuild the terminal display and replay its output",
        ariaLabel: "Retry",
        loading: isRetrying,
      }}
      className={className}
    />
  );
}
