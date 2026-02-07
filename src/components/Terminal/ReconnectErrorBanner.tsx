import React from "react";
import { Clock, RotateCcw, X, AlertTriangle } from "lucide-react";
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
      return "Reconnection Timed Out";
    case "not_found":
      return "Previous Session Not Found";
    default:
      return "Reconnection Failed";
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
          title: "Restart Terminal",
          ariaLabel: "Restart terminal",
        },
        {
          id: "dismiss",
          label: "Dismiss",
          icon: X,
          variant: "dismiss",
          onClick: () => onDismiss(terminalId),
          title: "Dismiss",
          ariaLabel: "Dismiss notification",
        },
      ]}
      className={className}
    />
  );
}

export const ReconnectErrorBanner = React.memo(ReconnectErrorBannerComponent);
