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
  // Snapshotted alongside the failure record (same broadcast), so a mixed
  // outcome names both halves — what's retryable here vs. what was already
  // disarmed as unreachable — without cross-referencing the run store, whose
  // run may belong to a newer broadcast by now (#10930).
  const disarmedCount = useFleetFailureStore((s) => s.disarmedCount);

  if (failedIds.size === 0) return null;

  const count = failedIds.size;
  const noun = count === 1 ? "terminal" : "terminals";
  const disarmedSuffix =
    disarmedCount > 0
      ? ` ${disarmedCount} unreachable ${disarmedCount === 1 ? "terminal was" : "terminals were"} disarmed.`
      : "";
  const description =
    payload === null
      ? `${count} ${noun} rejected a keystroke. Single keystrokes can't be replayed.${disarmedSuffix}`
      : `${count} ${noun} rejected the write.${disarmedSuffix}`;

  const retryAction: BannerAction | undefined =
    payload === null
      ? undefined
      : {
          id: "retry",
          label: "Retry failed",
          variant: "primary",
          onClick: () => {
            void actionService.dispatch("fleet.retryFailures", undefined, { source: "user" });
          },
        };

  return (
    <InlineStatusBanner
      icon={AlertCircle}
      severity="error"
      title="Broadcast failed"
      description={description}
      action={retryAction}
      role="alert"
      onClose={() => useFleetFailureStore.getState().clear()}
    />
  );
}
