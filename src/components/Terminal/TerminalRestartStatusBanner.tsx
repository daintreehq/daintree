import type { CSSProperties } from "react";
import { XCircle, Loader2, RotateCcw, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { InlineStatusBanner } from "./InlineStatusBanner";
import type { RestartBannerVariant } from "./restartStatus";
import { RESTART_BANNER_COPY } from "./restartBannerCopy";

export interface TerminalRestartStatusBannerProps {
  variant: RestartBannerVariant;
  onRestart: () => void;
  onDismiss: () => void;
  /**
   * Acknowledge the session-lost signal on every flagged pane at once (issue
   * #11589). Only supplied when more than one pane is flagged — a single
   * banner's own close control already clears the whole set — so leaving it
   * undefined keeps the banner at exactly one control.
   */
  onDismissAll?: () => void;
}

function SpinnerIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <Loader2
      className={cn("animate-spin motion-reduce:animate-none", className)}
      style={style}
      aria-hidden="true"
    />
  );
}

export function TerminalRestartStatusBanner({
  variant,
  onRestart,
  onDismiss,
  onDismissAll,
}: TerminalRestartStatusBannerProps) {
  switch (variant.type) {
    case "none":
      return null;

    case "auto-restarting":
      return (
        <InlineStatusBanner
          icon={SpinnerIcon}
          title={RESTART_BANNER_COPY["auto-restarting"].title}
          severity="info"
          animated={false}
          role="status"
          ariaLive="polite"
          actions={[]}
        />
      );

    case "restarting":
      return (
        <InlineStatusBanner
          icon={SpinnerIcon}
          title={RESTART_BANNER_COPY["restarting"].title}
          severity="info"
          animated={false}
          role="status"
          ariaLive="polite"
          actions={[]}
        />
      );

    case "session-resume-unavailable":
      // Toned down per issue #10823: the terminal already relaunched into a
      // fresh, usable session, so this is a dismissable acknowledgement, not an
      // assertive error. Warning severity + polite status role + a dismiss
      // control; no restart action (a restart would be a redundant third
      // session). The banner still surfaces the lost session so it isn't
      // dropped silently (issue #9802).
      //
      // A restart can strand this banner on a dozen panes at once, so when more
      // than one is flagged the caller supplies `onDismissAll` and we offer a
      // second, neutral control (issue #11589). Warning severity is not bound by
      // the single-action rule, so `actions` is legal here — and with a
      // description present `InlineStatusBanner` keeps the close X in the title
      // row and drops actions into their own controls row, which reads as the
      // per-pane vs. project-wide split it is.
      return (
        <InlineStatusBanner
          icon={AlertTriangle}
          title={RESTART_BANNER_COPY["session-resume-unavailable"].title}
          description={RESTART_BANNER_COPY["session-resume-unavailable"].description}
          severity="warning"
          animated={false}
          role="status"
          ariaLive="polite"
          onClose={onDismiss}
          actions={
            onDismissAll
              ? [
                  {
                    id: "dismiss-all-session-lost",
                    label: RESTART_BANNER_COPY["session-resume-unavailable"].dismissAllLabel,
                    variant: "dismiss",
                    onClick: onDismissAll,
                    ariaLabel:
                      RESTART_BANNER_COPY["session-resume-unavailable"].dismissAllAriaLabel,
                  },
                ]
              : undefined
          }
        />
      );

    case "exit-error":
      return (
        <InlineStatusBanner
          icon={XCircle}
          title={RESTART_BANNER_COPY["exit-error"]({ exitCode: variant.exitCode }).title}
          severity="error"
          animated={false}
          action={{
            id: "restart",
            label: "Restart session",
            icon: RotateCcw,
            variant: "dangerFilled",
            onClick: onRestart,
            title: "Restart session",
            ariaLabel: "Restart session",
          }}
          onClose={onDismiss}
        />
      );
  }
}
