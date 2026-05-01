import React from "react";
import { Clock, RotateCcw, AlertTriangle } from "lucide-react";
import { InlineStatusBanner } from "./InlineStatusBanner";
import type { TerminalReconnectError } from "@/types";

export interface ReconnectErrorBannerProps {
  terminalId: string;
  error: TerminalReconnectError;
  onDismiss: (id: string) => void;
  onRestart: (id: string) => void;
  className?: string;
}

function getErrorTitle(type: TerminalReconnectError["type"]): string {
  switch (type) {
    case "timeout":
      return "Reconnection timed out";
    case "not_found":
      return "Previous session not found";
    default:
      return "Reconnection failed";
  }
}

function getErrorSeverity(type: TerminalReconnectError["type"]): "warning" | "error" {
  switch (type) {
    case "timeout":
      return "warning";
    case "not_found":
    case "error":
      return "error";
    default:
      return "warning";
  }
}

function getErrorIcon(type: TerminalReconnectError["type"]) {
  switch (type) {
    case "timeout":
      return Clock;
    default:
      return AlertTriangle;
  }
}

function ReconnectErrorBannerComponent({
  terminalId,
  error,
  onDismiss,
  onRestart,
  className,
}: ReconnectErrorBannerProps) {
  return (
    <InlineStatusBanner
      icon={getErrorIcon(error.type)}
      title={getErrorTitle(error.type)}
      description={error.message}
      severity={getErrorSeverity(error.type)}
      actions={[
        {
          id: "restart",
          label: "Restart",
          icon: RotateCcw,
          variant: "primary",
          onClick: () => onRestart(terminalId),
          title: "Restart terminal",
          ariaLabel: "Restart terminal",
        },
      ]}
      onClose={() => onDismiss(terminalId)}
      className={className}
    />
  );
}

export const ReconnectErrorBanner = React.memo(ReconnectErrorBannerComponent);
