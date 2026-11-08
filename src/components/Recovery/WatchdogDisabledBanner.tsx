import { useState } from "react";
import { Button } from "@/components/ui/button";
import { usePanelStore } from "@/store/panelStore";
import { useGlobalBannerDismissalStore } from "@/store/globalBannerDismissalStore";
import { actionService } from "@/services/ActionService";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { logError } from "@/utils/logger";
import { RECOVERY_FAILURE_COPY } from "./recoveryCopy";

export function WatchdogDisabledBanner() {
  const watchdogStatus = usePanelStore((s) => s.watchdogStatus);
  const info = usePanelStore((s) => s.watchdogDisabledInfo);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  const dismiss = useGlobalBannerDismissalStore((s) => s.dismiss);

  if (watchdogStatus !== "disabled") return null;

  const attemptCount = info?.attemptCount ?? 0;
  const description =
    attemptCount > 0
      ? `Deadlock detection stopped after ${attemptCount} restart attempts. Restart it to resume monitoring.`
      : "Deadlock detection stopped after repeated restart failures. Restart it to resume monitoring.";

  const handleRestart = async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    setRestartFailed(false);
    try {
      const result = await actionService.dispatch("watchdog.restart", undefined, {
        source: "user",
      });
      if (result.ok) return;
      logError("Failed to restart crash watchdog from disabled banner", result.error);
    } catch (error) {
      logError("Failed to restart crash watchdog from disabled banner", error);
    }
    setIsRestarting(false);
    setRestartFailed(true);
  };

  return (
    <InlineStatusBanner
      title="Crash watchdog disabled"
      description={description}
      descriptionExtras={
        restartFailed ? (
          <p
            className="text-xs mt-1 break-words text-text-primary"
            data-testid="watchdog-banner-restart-error"
          >
            {RECOVERY_FAILURE_COPY.watchdogRestart}
          </p>
        ) : null
      }
      trailingSlot={
        restartFailed ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => useDiagnosticsStore.getState().openDock("logs")}
          >
            Open Diagnostics
          </Button>
        ) : undefined
      }
      severity="warning"
      role="status"
      // The protection layer being down is worth knowing, not worth blocking
      // the band on: × hides it for the session and the next disable re-shows it.
      onClose={() => dismiss("watchdog-disabled")}
      closeAriaLabel="Dismiss watchdog warning"
      actions={[
        {
          id: "restart",
          label: "Restart watchdog",
          variant: "primary",
          onClick: handleRestart,
          loading: isRestarting,
        },
      ]}
    />
  );
}
