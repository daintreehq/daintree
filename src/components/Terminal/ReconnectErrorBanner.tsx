import { Clock, RotateCcw, WifiOff, type LucideIcon } from "lucide-react";
import { InlineStatusBanner, type InlineStatusBannerSeverity } from "./InlineStatusBanner";
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

interface ReconnectBannerConfig {
  title: string;
  severity: InlineStatusBannerSeverity;
  icon: LucideIcon;
}

const RECONNECT_BANNER_CONFIG = {
  timeout: { title: "Reconnection timed out", severity: "warning", icon: Clock },
  not_found: { title: "Previous session not found", severity: "error", icon: WifiOff },
  error: { title: "Reconnection failed", severity: "error", icon: WifiOff },
} as const satisfies Record<TerminalReconnectError["type"], ReconnectBannerConfig>;

export function ReconnectErrorBanner({
  terminalId,
  error,
  onDismiss,
  onRestart,
  isRestarting = false,
  className,
}: ReconnectErrorBannerProps) {
  const config = RECONNECT_BANNER_CONFIG[error.type];
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
  if (config.severity === "error") {
    return (
      <InlineStatusBanner
        icon={config.icon}
        title={config.title}
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
      icon={config.icon}
      title={config.title}
      description={boundedErrorText(error.message)}
      severity={config.severity}
      action={retryAction}
      onClose={() => onDismiss(terminalId)}
      className={className}
    />
  );
}
