import { Clock, RotateCcw, WifiOff } from "lucide-react";
import { InlineStatusBanner } from "./InlineStatusBanner";
import { boundedErrorText } from "@/utils/errorText";
import type { TerminalReconnectError } from "@/types";

export interface ReconnectErrorBannerProps {
  terminalId: string;
  error: TerminalReconnectError;
  onDismiss: (id: string) => void;
  onRestart: (id: string) => void;
  isRestarting?: boolean;
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
      return WifiOff;
  }
}

export function ReconnectErrorBanner({
  terminalId,
  error,
  onDismiss,
  onRestart,
  isRestarting = false,
  className,
}: ReconnectErrorBannerProps) {
  const severity = getErrorSeverity(error.type);
  const retryAction = {
    id: "retry",
    label: "Retry",
    icon: RotateCcw,
    variant: "primary" as const,
    onClick: () => onRestart(terminalId),
    title: "Retry reconnecting",
    ariaLabel: "Retry reconnecting",
    loading: isRestarting,
  };

  // Severity is computed from the error type, so branch on it to satisfy the
  // discriminated union on `InlineStatusBanner` (error banners take a single
  // `action`). Either way this banner shows exactly one action.
  if (severity === "error") {
    return (
      <InlineStatusBanner
        icon={getErrorIcon(error.type)}
        title={getErrorTitle(error.type)}
        description={boundedErrorText(error.message)}
        severity="error"
        action={retryAction}
        onClose={() => onDismiss(terminalId)}
        className={className}
      />
    );
  }

  return (
    <InlineStatusBanner
      icon={getErrorIcon(error.type)}
      title={getErrorTitle(error.type)}
      description={boundedErrorText(error.message)}
      severity={severity}
      action={retryAction}
      onClose={() => onDismiss(terminalId)}
      className={className}
    />
  );
}
