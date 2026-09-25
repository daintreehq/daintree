import { useId } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
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
  onDismiss: () => void;
}

/** A server-side rejection's output is the remote's own words; anything else is git's. */
const SERVER_OUTPUT_REASONS = new Set(["hook-rejected", "push-rejected-policy"]);

/**
 * The push failure, in the same banner grammar as every other failure on this
 * surface: an error glyph and wash, a neutral title and explanation, one
 * recovery, and a dismiss. It used to be a bespoke amber strip whose explanation
 * was set in the severity colour, which fell under 4.5:1 on the light themes and
 * made the failure harder to read than the passive rail above it.
 */
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
  onDismiss,
}: PushErrorBannerProps) {
  const detailsId = useId();
  const config = getPushBannerConfig(pushError, behindCount, forgeProviderId);
  const canCollapse = config.detailPolicy === "collapse" && pushError.rawMessage.length > 0;
  const outputLabel = SERVER_OUTPUT_REASONS.has(pushError.reason) ? "Server output" : "Git output";
  // Announced once per failure. It reads only from the failure itself: a later
  // `behindCount` or provider resolution restates the visible copy, and must not
  // interrupt a second time as though the push had failed again.
  const announcement = `Push failed. ${getPushBannerConfig(pushError).message}`;

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

  const primary = config.cta;
  const secondary = config.secondaryCta;

  // Rendered here rather than through the banner's `action` so each control keeps
  // the test id and `data-cta-kind` the hub's callers key on. Same geometry as the
  // banner's own action: `outline` at `sm`, leading the row.
  //
  // The destructive alternative is a ghost after the safe fix rather than a peer:
  // the two used to render as matching pills, and the neutral one read as the
  // louder of the pair. Its label's ellipsis says a confirm follows —
  // `git.forcePushWithLease` owns that dialog.
  const controls =
    primary || secondary ? (
      <>
        {primary && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => dispatchCta(primary)}
            loading={pullRebasing && primary.kind === "pull-rebase"}
            disabled={pullRebasing && primary.kind !== "pull-rebase"}
            // Forced colours strip the fill that sets the two apart and border
            // every button alike; weight is left alone, so the safe fix keeps it.
            className="forced-colors:font-semibold"
            data-testid="review-hub-push-error-cta"
            data-cta-kind={primary.kind}
          >
            {primary.label}
          </Button>
        )}
        {secondary && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dispatchCta(secondary)}
            disabled={pullRebasing}
            aria-haspopup={secondary.kind === "force-push" ? "dialog" : undefined}
            data-testid="review-hub-push-error-secondary-cta"
            data-cta-kind={secondary.kind}
          >
            {secondary.label}
          </Button>
        )}
      </>
    ) : undefined;

  const code = forgeErrorCode ? (
    <p
      data-testid="review-hub-push-error-code"
      className="mt-1 text-xs font-mono text-text-secondary"
    >
      {forgeErrorCode}
    </p>
  ) : null;

  const details = canCollapse ? (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={onToggleDetails}
        data-testid="review-hub-push-error-toggle"
        aria-expanded={showPushDetails}
        aria-controls={detailsId}
        className={cn(
          "-ml-1 inline-flex items-center gap-1 h-6 px-1 rounded-[var(--radius-sm)]",
          "text-xs font-medium text-text-secondary hover:text-text-primary",
          "transition-colors duration-150 ease-out",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
        )}
      >
        <ChevronRight
          className={cn(
            "w-3.5 h-3.5 shrink-0 transition-transform duration-150 ease-out",
            showPushDetails && "rotate-90"
          )}
          aria-hidden="true"
        />
        {outputLabel}
      </button>
      {showPushDetails && (
        <pre
          id={detailsId}
          tabIndex={0}
          aria-label={outputLabel}
          data-testid="review-hub-push-error-details"
          className={cn(
            "mt-1 max-h-48 overflow-auto px-2.5 py-2 rounded-[var(--radius-sm)]",
            "bg-overlay-subtle border border-divider",
            "text-2xs leading-relaxed font-mono text-text-secondary whitespace-pre-wrap break-words",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
          )}
        >
          {pushError.rawMessage}
        </pre>
      )}
    </div>
  ) : undefined;

  return (
    <div data-testid="review-hub-push-error" data-reason={pushError.reason}>
      <span role="alert" className="sr-only" data-testid="review-hub-push-error-announcement">
        {announcement}
      </span>
      {/* The visible banner is a plain region, not a live one: its controls, its
          changing copy and the expanded output are read on arrival, never
          pushed into the announcement. */}
      <InlineStatusBanner
        severity="error"
        role="status"
        ariaLive="off"
        className="px-4"
        title="Push failed"
        description={config.message}
        descriptionExtras={
          code || details ? (
            <>
              {code}
              {details}
            </>
          ) : undefined
        }
        onClose={onDismiss}
        closeAriaLabel="Dismiss push failure"
        trailingSlot={controls}
      />
    </div>
  );
}
