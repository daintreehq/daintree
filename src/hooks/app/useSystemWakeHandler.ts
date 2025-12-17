/**
 * useSystemWakeHandler - Handles system wake events.
 *
 * Refreshes worktree status after long sleep periods.
 */

import { useEffect } from "react";
import { isElectronAvailable } from "../useElectron";
import { systemClient, worktreeClient } from "@/clients";

const LONG_SLEEP_THRESHOLD_MS = 5 * 60 * 1000;

export function useSystemWakeHandler() {
  useEffect(() => {
    if (!isElectronAvailable()) return;

    const cleanup = systemClient.onWake(({ sleepDuration }) => {
      console.log(
        `[useSystemWakeHandler] System woke after ${Math.round(sleepDuration / 1000)}s sleep`
      );

      if (sleepDuration > LONG_SLEEP_THRESHOLD_MS) {
        console.log("[useSystemWakeHandler] Long sleep detected, refreshing worktree status");
        worktreeClient.refresh().catch((err) => {
          console.warn("[useSystemWakeHandler] Failed to refresh worktrees after wake:", err);
        });
      }
    });

    return cleanup;
  }, []);
}
