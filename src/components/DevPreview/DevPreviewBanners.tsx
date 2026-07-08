import { AlertTriangle, RotateCw, WifiOff } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "../Terminal/InlineStatusBanner";
import { BannerOverflowMenu } from "../Terminal/BannerOverflowMenu";
import type { UseDevServerReturn } from "@/hooks/useDevServer";

const STUCK_REMEDY_LABELS: Record<string, string> = {
  "devPreview.restartAndClearCache": "Restart and clear cache",
  "devPreview.reinstallAndRestart": "Reinstall dependencies",
};

interface DevPreviewStuckBannerProps {
  tier: 2 | 3;
  error: UseDevServerReturn["error"];
  /** Disables the banner actions while a restart is already in flight. */
  isRestarting: boolean;
  /**
   * When `"Compiling"` at Tier 3, the banner swaps to long-compile copy
   * instead of the generic "didn't start" framing — the server clearly
   * started, the first compile is just slow.
   */
  phaseLabel?: "Compiling";
  onRestart: () => void;
  onRemedy: (actionId: string) => void;
}

/**
 * Staged stuck-start escalation banner (#8276, copy retuned #9099). Replaces
 * the old silent auto-restart with a user-driven signal: Tier 2 is a warning
 * that the server is slow (suppressed by the hook while `phaseLabel ===
 * "Compiling"` — compile evidence isn't "stuck"), Tier 3 an error that names
 * likely causes and, when the dev server emitted a recognised error, offers
 * a variant-specific remedy (`error.recommendedActionId`) alongside a plain
 * restart. At Tier 3 with `phaseLabel === "Compiling"` the copy switches to
 * a long-compile framing instead of the "didn't start" framing.
 */
export function DevPreviewStuckBanner({
  tier,
  error,
  isRestarting,
  phaseLabel,
  onRestart,
  onRemedy,
}: DevPreviewStuckBannerProps) {
  const restartAction: BannerAction = {
    id: "dev-preview-stuck-restart",
    label: "Restart dev server",
    icon: RotateCw,
    variant: "primary",
    disabled: isRestarting,
    onClick: onRestart,
  };

  if (tier === 2) {
    return (
      <InlineStatusBanner
        icon={AlertTriangle}
        severity="warning"
        title="Dev server is slow to start"
        description="It's been a while without a URL. Check the terminal logs for what it's waiting on — restarting clears those logs."
        role="status"
        ariaLive="polite"
        actions={[restartAction]}
      />
    );
  }

  const remedyId = error?.recommendedActionId;
  const remedyLabel = remedyId ? STUCK_REMEDY_LABELS[remedyId] : undefined;
  // When a specific remedy is recommended it's the single primary action and
  // the generic restart drops into the overflow menu; otherwise restart is the
  // lone action. Keeps this error banner to one inline action.
  const hasRemedy = !!(remedyId && remedyLabel);
  const primaryAction: BannerAction = hasRemedy
    ? {
        id: `dev-preview-stuck-remedy-${remedyId}`,
        label: remedyLabel,
        icon: RotateCw,
        variant: "primary",
        disabled: isRestarting,
        onClick: () => onRemedy(remedyId),
      }
    : restartAction;
  const overflowActions: BannerAction[] = hasRemedy ? [restartAction] : [];

  const isLongCompile = phaseLabel === "Compiling" && !error?.message;
  const title = isLongCompile
    ? "First compile is taking longer than usual"
    : "Dev server still hasn't started";
  const description = error?.message
    ? error.message
    : isLongCompile
      ? "The initial compile is still running. Check the terminal logs — large projects can take 45s or more."
      : "Likely causes: the port is still bound by another process, dependencies are missing, or the build cache is stuck. Check the terminal logs.";

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      severity="error"
      title={title}
      description={description}
      role="alert"
      ariaLive="assertive"
      action={primaryAction}
      trailingSlot={
        overflowActions.length > 0 ? (
          <BannerOverflowMenu actions={overflowActions} ariaLabel="More dev server options" />
        ) : undefined
      }
    />
  );
}

/**
 * Surfaces a dead Vite HMR socket (#9975). The dev server keeps logging
 * `[vite] hmr update` on every save — which fires the "Compiling" phase and
 * reads as "live reload is working" — but with a custom `server.hmr.*` config
 * the browser's socket connects off the proxy origin or fails outright, so
 * the preview is silently stale. `useDevPreviewConsoleCapture` catches Vite's
 * own failure log and flips `hmrDead`; this is a Tier 3 running-state failure
 * with a pane-local recovery (reload reconnects the socket).
 */
export function DevPreviewHmrDeadBanner({ onReload }: { onReload: () => void }) {
  return (
    <InlineStatusBanner
      icon={WifiOff}
      severity="error"
      title="Live reload disconnected"
      description="Vite's hot-reload socket dropped, so saved changes won't show up in the preview. Reload to reconnect, or drop the custom server.hmr.* config if it keeps happening."
      role="alert"
      ariaLive="assertive"
      action={{
        id: "dev-preview-hmr-dead-reload",
        label: "Reload",
        icon: RotateCw,
        variant: "primary",
        onClick: onReload,
      }}
    />
  );
}
