import React from "react";
import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { InlineStatusBanner } from "./InlineStatusBanner";
import type { RestartBannerVariant } from "./restartStatus";

export interface TerminalRestartStatusBannerProps {
  variant: RestartBannerVariant;
  onRestart: () => void;
  onDismiss: () => void;
}

function TerminalRestartStatusBannerComponent({
  variant,
  onRestart,
  onDismiss,
}: TerminalRestartStatusBannerProps) {
  switch (variant.type) {
    case "none":
      return null;

    case "auto-restarting":
      return (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-daintree-text/60 bg-daintree-accent/5 border-b border-daintree-border shrink-0">
          <Spinner size="xs" className="text-daintree-accent" />
          <span>Auto-restarting…</span>
        </div>
      );

    case "exit-error":
      return (
        <InlineStatusBanner
          icon={AlertTriangle}
          title={`Session exited with code ${variant.exitCode}`}
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
        />
      );
  }
}

export const TerminalRestartStatusBanner = React.memo(TerminalRestartStatusBannerComponent);
