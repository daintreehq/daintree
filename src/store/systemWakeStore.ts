import { create } from "zustand";
import type { SystemWakePayload } from "@shared/types/ipc/system";
import { logDebug, logWarn } from "@/utils/logger";

export const WAKE_NOOP_THRESHOLD_MS = 30_000;
export const WAKE_LONG_SLEEP_THRESHOLD_MS = 5 * 60 * 1000;

interface SystemWakeState {
  wakeEpoch: number;
  lastSleepDuration: number;
  isWakeRevalidating: boolean;
}

export const useSystemWakeStore = create<SystemWakeState>(() => ({
  wakeEpoch: 0,
  lastSleepDuration: 0,
  isWakeRevalidating: false,
}));

let wakeUnsubscribe: (() => void) | null = null;
// Separate from wakeEpoch: only tier-3 wakes bump this. A tier-2 wake mid-refresh
// must not race the in-flight refresh's `.finally()` into clearing isWakeRevalidating.
let revalidateEpoch = 0;

function handleWake(payload: SystemWakePayload): void {
  const { sleepDuration } = payload;

  if (sleepDuration <= WAKE_NOOP_THRESHOLD_MS) return;

  logDebug("[systemWakeStore] System woke", { sleepDurationMs: sleepDuration });

  if (sleepDuration <= WAKE_LONG_SLEEP_THRESHOLD_MS) {
    useSystemWakeStore.setState((state) => ({
      wakeEpoch: state.wakeEpoch + 1,
      lastSleepDuration: sleepDuration,
    }));
    return;
  }

  useSystemWakeStore.setState((state) => ({
    wakeEpoch: state.wakeEpoch + 1,
    lastSleepDuration: sleepDuration,
    isWakeRevalidating: true,
  }));

  const capturedEpoch = ++revalidateEpoch;
  logDebug("[systemWakeStore] Long sleep detected, refreshing worktree status");
  window.electron.worktree
    .refresh()
    .catch((err) => {
      logWarn("[systemWakeStore] Failed to refresh worktrees after wake", { error: err });
    })
    .finally(() => {
      if (revalidateEpoch === capturedEpoch) {
        useSystemWakeStore.setState({ isWakeRevalidating: false });
      }
    });
}

export function setupSystemWakeListeners(): () => void {
  if (typeof window === "undefined") return () => {};
  if (wakeUnsubscribe !== null) return cleanupSystemWakeListeners;

  wakeUnsubscribe = window.electron.system.onWake(handleWake);

  return cleanupSystemWakeListeners;
}

export function cleanupSystemWakeListeners(): void {
  if (wakeUnsubscribe) {
    wakeUnsubscribe();
    wakeUnsubscribe = null;
  }
}
