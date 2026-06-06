import type { CSSProperties } from "react";
import { XCircle, Loader2, RotateCcw } from "lucide-react";
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
      return (
        <InlineStatusBanner
          icon={XCircle}
          title={RESTART_BANNER_COPY["session-resume-unavailable"].title}
          description={RESTART_BANNER_COPY["session-resume-unavailable"].description}
          severity="error"
          animated={false}
          role="alert"
          action={{
            id: "start-new-session",
            label: "Start new session",
            icon: RotateCcw,
            variant: "dangerFilled",
            onClick: onRestart,
            title: "Start new session",
            ariaLabel: "Start new session",
          }}
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
