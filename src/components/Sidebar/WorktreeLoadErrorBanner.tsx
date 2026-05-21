import { useCallback, useState } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import { boundedErrorText } from "@/utils/errorText";
import { actionService } from "@/services/ActionService";

export interface WorktreeLoadErrorBannerProps {
  /** Raw error string from the failed worktree load (sanitized before render). */
  error: string;
  className?: string;
  /**
   * Retry override for tests. In production this is undefined and the banner
   * dispatches `worktree.retryProjectLoad`, which re-runs the failed load and
   * clears the banner on success.
   */
  onRetry?: () => void | Promise<void>;
}

/**
 * Tier 3 inline recovery banner for a project switch that committed to the new
 * project but whose worktree load threw (#8400). Modeled on SpawnErrorBanner /
 * TerminalRestartStatusBanner — surfaces the failure with a single Retry action
 * instead of leaving the sidebar stuck on an empty skeleton.
 */
export function WorktreeLoadErrorBanner({
  error,
  className,
  onRetry,
}: WorktreeLoadErrorBannerProps) {
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = useCallback(async () => {
    if (isRetrying) return;
    setIsRetrying(true);
    try {
      if (onRetry) {
        await onRetry();
      } else {
        await actionService.dispatch("worktree.retryProjectLoad", undefined, { source: "user" });
      }
    } finally {
      setIsRetrying(false);
    }
  }, [isRetrying, onRetry]);

  const actions: BannerAction[] = [
    {
      id: "retry",
      label: "Retry",
      icon: RotateCcw,
      variant: "primary",
      onClick: () => void handleRetry(),
      title: "Retry loading worktrees",
      ariaLabel: "Retry loading worktrees",
      loading: isRetrying,
    },
  ];

  return (
    <InlineStatusBanner
      icon={AlertCircle}
      title="Couldn't load worktrees"
      description={boundedErrorText(error)}
      severity="error"
      actions={actions}
      className={className}
    />
  );
}
