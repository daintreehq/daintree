import type { CSSProperties, ReactNode } from "react";
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
  /**
   * "Find session" (issue #12182), pre-built by the caller — which already
   * knows whether this pane's agent has one to offer — or `undefined` when it
   * doesn't. Only meaningful for the `session-resume-unavailable` variant.
   */
  findSessionSlot?: ReactNode;
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
  findSessionSlot,
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

    case "session-resume-unavailable": {
      // Toned down per issue #10823: the terminal already relaunched into a
      // fresh, usable session, so this is a dismissable acknowledgement, not an
      // assertive error. Warning severity + polite status role + a dismiss
      // control; no restart action (a restart would be a redundant third
      // session). The banner still surfaces the lost session so it isn't
      // dropped silently (issue #9802).
      //
      // Copy is reason-specific (issue #12182): a sibling pane already holding
      // the conversation reads very differently from there being nothing to
      // resume, and the banner should say which one happened.
      const copy = RESTART_BANNER_COPY["session-resume-unavailable"]({ reason: variant.reason });
      // A restart can strand this banner on a dozen panes at once, so when more
      // than one is flagged the caller supplies `onDismissAll` and we offer a
      // second, neutral control (issue #11589). Warning severity is not bound by
      // the single-action rule, so `actions` is legal here — and with a
      // description present `InlineStatusBanner` keeps the close X in the title
      // row and drops actions into their own controls row, which reads as the
      // per-pane vs. project-wide split it is. "Find session" (#12182) rides
      // `trailingSlot` instead of `actions`, exactly what that prop documents
      // itself for — a Popover trigger, not a plain button.
      return (
        <InlineStatusBanner
          icon={AlertTriangle}
          title={copy.title}
          description={copy.description}
          severity="warning"
          animated={false}
          role="status"
          ariaLive="polite"
          onClose={onDismiss}
          trailingSlot={findSessionSlot}
          actions={
            onDismissAll
              ? [
                  {
                    id: "dismiss-all-session-lost",
                    label: copy.dismissAllLabel,
                    variant: "dismiss",
                    onClick: onDismissAll,
                    ariaLabel: copy.dismissAllAriaLabel,
                  },
                ]
              : undefined
          }
        />
      );
    }

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
