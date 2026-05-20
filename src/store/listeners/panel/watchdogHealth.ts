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

  // Clear the banner across every window when ANY window successfully
  // dispatches `watchdog.restart`. Without this, sibling windows would keep
  // showing a stale banner after the watchdog was already restarted.
  d.add(
    toDisposable(
      watchdogClient.onActive(() => {
        usePanelStore.getState().clearWatchdogDisabled();
      })
    )
  );

  return d;
}
