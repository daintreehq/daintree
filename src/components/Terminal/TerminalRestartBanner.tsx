import React from "react";
import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { InlineStatusBanner } from "./InlineStatusBanner";

export interface TerminalRestartBannerProps {
  exitCode: number;
  onRestart: () => void;
  onDismiss: () => void;
  className?: string;
}

function TerminalRestartBannerComponent({
  exitCode,
  onRestart,
  onDismiss,
  className,
}: TerminalRestartBannerProps) {
  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title={`Session exited with code ${exitCode}`}
      severity="error"
      animated={false}
      actions={[
        {
          id: "restart",
          label: "Restart Session",
          icon: RotateCcw,
          variant: "dangerFilled",
          onClick: onRestart,
          title: "Restart Session",
          ariaLabel: "Restart session",
        },
        {
          id: "dismiss",
          label: "Dismiss",
          icon: X,
          variant: "danger",
          iconOnly: true,
          onClick: onDismiss,
          title: "Dismiss",
          ariaLabel: "Dismiss restart prompt",
        },
      ]}
      className={className}
    />
  );
}

export const TerminalRestartBanner = React.memo(TerminalRestartBannerComponent);
