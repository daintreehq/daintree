import { RefreshCw } from "lucide-react";
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
}

// The title says it is about reconnecting, so the glyph is the severity's own:
// a failure and a timeout must differ by shape, not only by tint.
const RECONNECT_BANNER_CONFIG = {
  timeout: { title: "Reconnection timed out", severity: "warning" },
  not_found: { title: "Previous session not found", severity: "error" },
  error: { title: "Reconnection failed", severity: "error" },
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
    icon: RefreshCw,
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
      title={config.title}
      description={boundedErrorText(error.message)}
      severity={config.severity}
      action={retryAction}
      onClose={() => onDismiss(terminalId)}
      className={className}
    />
  );
}
