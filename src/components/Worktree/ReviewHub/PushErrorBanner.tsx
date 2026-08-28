import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { type PushBannerCta, type PushErrorState, getPushBannerConfig } from "./reviewHubUtils";

interface PushErrorBannerProps {
  pushError: PushErrorState;
  behindCount?: number;
  forgeProviderId: string | null;
  forgeErrorCode?: string;
  showPushDetails: boolean;
  onToggleDetails: () => void;
  pullRebasing: boolean;
  onOpenForgeSettings: (providerId: string) => void;
  onRetryPush: () => void;
  onPullRebase: () => void;
  onForcePush: () => void;
}

export function PushErrorBanner({
  pushError,
  behindCount,
  forgeProviderId,
  forgeErrorCode,
  showPushDetails,
  onToggleDetails,
  pullRebasing,
  onOpenForgeSettings,
  onRetryPush,
  onPullRebase,
  onForcePush,
}: PushErrorBannerProps) {
  const config = getPushBannerConfig(pushError, behindCount, forgeProviderId);
  const canCollapse = config.detailPolicy === "collapse" && pushError.rawMessage.length > 0;
  const dispatchCta = (cta: PushBannerCta) => {
    switch (cta.kind) {
      case "settings-forge":
        onOpenForgeSettings(cta.providerId);
        return;
      case "retry":
        onRetryPush();
        return;
      case "pull-rebase":
        onPullRebase();
        return;
      case "force-push":
        onForcePush();
        return;
    }
  };
  const renderCta = (cta: PushBannerCta, isPrimary: boolean, key: string, isLoading: boolean) => (
    <button
      key={key}
      type="button"
      onClick={() => dispatchCta(cta)}
      disabled={isLoading}
      data-testid={isPrimary ? "review-hub-push-error-cta" : "review-hub-push-error-secondary-cta"}
      data-cta-kind={cta.kind}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs font-medium transition-colors",
        "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-status-warning",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        isPrimary
          ? "bg-status-warning/20 hover:bg-status-warning/30 text-status-warning"
          : "bg-filter-selected-bg-soft hover:bg-tint/[0.14] text-text-primary"
      )}
    >
      {isLoading && cta.kind === "pull-rebase" ? "Pulling…" : cta.label}
    </button>
  );
  return (
    <div
      role="alert"
      data-testid="review-hub-push-error"
      data-reason={pushError.reason}
      className="px-4 py-2 text-xs text-status-warning bg-status-warning/10 flex items-start gap-2 shrink-0"
    >
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div>
          <span className="font-medium">Push failed.</span> <span>{config.message}</span>
        </div>
        {forgeErrorCode && (
          <div
            data-testid="review-hub-push-error-code"
            className="mt-1 text-3xs font-mono opacity-80"
          >
            {forgeErrorCode}
          </div>
        )}
        {canCollapse && (
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleDetails}
              data-testid="review-hub-push-error-toggle"
              aria-expanded={showPushDetails}
              className={cn(
                "inline-flex items-center px-1.5 py-0.5 rounded",
                "text-status-warning/80 hover:text-status-warning",
                "text-3xs font-medium underline-offset-2 hover:underline transition-colors",
                "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-status-warning"
              )}
            >
              {showPushDetails ? "Hide details" : "Show details"}
            </button>
          </div>
        )}
        {canCollapse && showPushDetails && (
          <pre
            data-testid="review-hub-push-error-details"
            className="mt-1 text-3xs font-mono whitespace-pre-wrap break-all opacity-70"
          >
            {pushError.rawMessage}
          </pre>
        )}
        {(config.cta || config.secondaryCta) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {config.cta && renderCta(config.cta, true, "primary", pullRebasing)}
            {config.secondaryCta &&
              renderCta(config.secondaryCta, false, "secondary", pullRebasing)}
          </div>
        )}
      </div>
    </div>
  );
}
