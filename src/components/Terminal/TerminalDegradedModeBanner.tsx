import React from "react";
import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { InlineStatusBanner } from "./InlineStatusBanner";
import { AGENT_REGISTRY } from "@/config/agents";
import type { DegradedBannerVariant } from "./restartStatus";

export interface TerminalDegradedModeBannerProps {
  variant: DegradedBannerVariant;
  onRestart: () => void;
  onDismiss: () => void;
}

function TerminalDegradedModeBannerComponent({
  variant,
  onRestart,
  onDismiss,
}: TerminalDegradedModeBannerProps) {
  if (variant.type === "none") return null;

  const agentName = AGENT_REGISTRY[variant.agentId]?.name ?? variant.agentId;

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title={`Running ${agentName} in degraded mode`}
      description="This terminal was spawned as a plain shell. Restart to give the agent its proper environment, color settings, and scrollback."
      severity="warning"
      animated={false}
      actions={[
        {
          id: "restart",
          label: "Restart as Agent",
          icon: RotateCcw,
          variant: "dangerFilled",
          onClick: onRestart,
          title: `Restart this terminal as a ${agentName} panel`,
          ariaLabel: `Restart this terminal as a ${agentName} panel`,
        },
        {
          id: "dismiss",
          label: "Dismiss",
          icon: X,
          variant: "danger",
          iconOnly: true,
          onClick: onDismiss,
          title: "Dismiss",
          ariaLabel: "Dismiss degraded-mode notice",
        },
      ]}
    />
  );
}

export const TerminalDegradedModeBanner = React.memo(TerminalDegradedModeBannerComponent);
