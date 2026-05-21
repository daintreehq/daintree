import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { usePanelStore } from "@/store/panelStore";
import { actionService } from "@/services/ActionService";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { logError } from "@/utils/logger";

export function WatchdogDisabledBanner() {
  const watchdogStatus = usePanelStore((s) => s.watchdogStatus);
  const info = usePanelStore((s) => s.watchdogDisabledInfo);
  const [isRestarting, setIsRestarting] = useState(false);

  if (watchdogStatus !== "disabled") return null;

  const attemptCount = info?.attemptCount ?? 0;
  const description =
    attemptCount > 0
      ? `Deadlock detection stopped after ${attemptCount} restart attempts. Restart it to resume monitoring.`
      : "Deadlock detection stopped after repeated restart failures. Restart it to resume monitoring.";

  const handleRestart = async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    const result = await actionService.dispatch("watchdog.restart", undefined, {
      source: "user",
    });
    if (!result.ok) {
      logError("Failed to restart crash watchdog from disabled banner", result.error);
      setIsRestarting(false);
    }
  };

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title="Crash watchdog disabled"
      description={description}
      severity="warning"
      role="alert"
      animated={false}
      actions={[
        {
          id: "restart",
          label: isRestarting ? "Restarting…" : "Restart watchdog",
          variant: "primary",
          onClick: handleRestart,
          disabled: isRestarting,
        },
      ]}
    />
  );
}
