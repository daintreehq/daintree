import { type ReactElement } from "react";
import { AlertCircle } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { actionService } from "@/services/ActionService";

/**
 * Tier-2 inline banner that surfaces partial fleet broadcast failures.
 * Sits above the fleet ribbon (#8705) — the Tier-1 per-pane red dots are
 * still drawn by `PanelHeader`, but a multi-terminal failure escalates one
 * tier per CLAUDE.md to make sure the user notices that *some* targets
 * dropped the write.
 *
 * The action is omitted (not disabled) when `payload === null` — single
 * keystrokes aren't meaningful to replay, and a native disabled button
 * with a Radix tooltip silently fails to show the explanation on Chromium.
 */
export function FleetFailureBanner(): ReactElement | null {
  const failedIds = useFleetFailureStore((s) => s.failedIds);
  const payload = useFleetFailureStore((s) => s.payload);

  if (failedIds.size === 0) return null;

  const count = failedIds.size;
  const noun = count === 1 ? "terminal" : "terminals";
  const description =
    payload === null
      ? `${count} ${noun} rejected a keystroke. Single keystrokes can't be replayed.`
      : `${count} ${noun} rejected the write.`;

  const actions: BannerAction[] =
    payload === null
      ? []
      : [
          {
            id: "retry",
            label: "Retry failed",
            variant: "primary",
            onClick: () => {
              void actionService.dispatch("fleet.retryFailures", undefined, { source: "user" });
            },
          },
        ];

  return (
    <InlineStatusBanner
      icon={AlertCircle}
      severity="error"
      title="Broadcast failed"
      description={description}
      actions={actions}
      role="alert"
      onClose={() => useFleetFailureStore.getState().clear()}
    />
  );
}
