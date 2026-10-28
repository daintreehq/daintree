import type { PendingHostSwitch, RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import { usePendingHostSwitchStore } from "@/store/pendingHostSwitchStore";

/**
 * What the switch screen's heading says. It holds across the waiting phases,
 * so the only change is the one from waiting to given up.
 */
export function pendingHostSwitchHeading(pending: PendingHostSwitch): string {
  return pending.phase === "failed"
    ? `Couldn't switch to ${pending.hostName}`
    : `Switching to ${pending.hostName}`;
}

/**
 * What a waiting switch is doing, in words that change only with the phase:
 * learning the project's name mid-phase does not reword it.
 */
export function pendingHostSwitchStatus(
  phase: Exclude<PendingHostSwitch["phase"], "failed">
): string {
  switch (phase) {
    case "connecting":
      return "Connecting…";
    case "starting":
      return "Starting Daintree on the host…";
    case "opening":
      return "Opening the project…";
  }
}

interface RemoteHostsSwitchApi {
  onEvent?: (callback: (event: RemoteHostsEvent) => void) => () => void;
  getPendingSwitch?: () => Promise<PendingHostSwitch | null>;
}

interface WatchOptions {
  /**
   * Told each time this view is shown again after being cached behind another
   * project. Main tells only the views attached to a window, so one parked
   * mid-switch asks afresh rather than keep a switch that has since ended.
   */
  onViewRevealed?: (callback: () => void) => () => void;
  /**
   * Told when this view goes into the cache behind another. Main stops telling
   * it about the window's switch from then on, so it lets go of the one it
   * knew: the view a switch left behind would otherwise hold every send to its
   * terminals, a host's MCP dispatches among them, after the switch landed.
   */
  onViewCached?: (callback: () => void) => () => void;
}

/**
 * Keep this view told where its window's switch to a host is. The window's
 * switch screen reads it from the store; this only keeps the store right.
 */
export function watchPendingHostSwitch(
  api: RemoteHostsSwitchApi,
  options: WatchOptions = {}
): () => void {
  const store = usePendingHostSwitchStore;
  /** Bumped by every event, so an answer to a question asked before one is stale. */
  let heard = 0;
  let disposed = false;
  const stopEvents = api.onEvent?.((event) => {
    if (disposed || event.type !== "switch-pending") return;
    heard += 1;
    store.getState().setPending(event.pending);
  });
  // A view that mounts (or is shown again) while its window is switching asks;
  // an event that arrived meanwhile is newer than this answer.
  const ask = () => {
    const askedAt = heard;
    void api.getPendingSwitch?.().then(
      (pending) => {
        if (!disposed && heard === askedAt) store.getState().setPending(pending);
      },
      () => {}
    );
  };
  ask();
  const stopRevealed = options.onViewRevealed?.(ask);
  const stopCached = options.onViewCached?.(() => {
    if (disposed) return;
    // Also outdates any answer still on its way.
    heard += 1;
    store.getState().setPending(null);
  });

  return () => {
    disposed = true;
    stopEvents?.();
    stopRevealed?.();
    stopCached?.();
    store.getState().setPending(null);
  };
}
