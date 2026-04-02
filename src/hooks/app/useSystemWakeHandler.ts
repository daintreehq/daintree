/**
 * useSystemWakeHandler - Handles system wake events.
 *
 * Refreshes worktree status after long sleep periods.
 */

import { useEffect } from "react";
import { isElectronAvailable } from "../useElectron";
import { systemClient, worktreeClient } from "@/clients";
import { logDebug, logWarn } from "@/utils/logger";

const LONG_SLEEP_THRESHOLD_MS = 5 * 60 * 1000;

export function useSystemWakeHandler() {
  useEffect(() => {
    if (!isElectronAvailable()) return;

    const cleanup = systemClient.onWake(({ sleepDuration }) => {
      logDebug("[useSystemWakeHandler] System woke", { sleepDurationMs: sleepDuration });

      if (sleepDuration > LONG_SLEEP_THRESHOLD_MS) {
        logDebug("[useSystemWakeHandler] Long sleep detected, refreshing worktree status");
        worktreeClient.refresh().catch((err) => {
          logWarn("[useSystemWakeHandler] Failed to refresh worktrees after wake", { error: err });
        });
      }
    });

    return cleanup;
  }, []);
}
