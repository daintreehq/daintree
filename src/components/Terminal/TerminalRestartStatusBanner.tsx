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
