import { watchdogClient } from "@/clients/watchdogClient";
import { logError } from "@/utils/logger";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { usePanelStore } from "@/store/panelStore";

export function setupWatchdogHealthListeners(): DisposableStore {
  const d = new DisposableStore();

  d.add(
    toDisposable(
      watchdogClient.onDisabled((payload) => {
        logError("Crash watchdog disabled after repeated restart failures", undefined, {
          attemptCount: payload.attemptCount,
          lastExitCode: payload.lastExitCode,
          timestamp: payload.timestamp,
        });

        usePanelStore.getState().setWatchdogDisabled({
          attemptCount: payload.attemptCount,
          lastExitCode: payload.lastExitCode,
          timestamp: payload.timestamp,
        });
      })
    )
  );

  return d;
}
