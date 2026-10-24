import type { PendingHostSwitch, RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import { usePendingHostSwitchStore } from "@/store/pendingHostSwitchStore";

/** Past this, a wait that is still going says so (the loading-gate family's "Still working…"). */
export const STILL_WORKING_MS = 5_000;

/** What the window's switch screen says the switch is doing, or that it gave up. */
export function pendingHostSwitchTitle(pending: PendingHostSwitch): string {
  switch (pending.phase) {
    case "failed":
      return `Couldn't switch to ${pending.hostName}`;
    case "connecting":
      return `Connecting to ${pending.hostName}…`;
    case "starting":
      return `Starting Daintree on ${pending.hostName}…`;
    case "opening":
      return pending.projectName
        ? `Opening ${pending.projectName} on ${pending.hostName}…`
        : `Opening ${pending.hostName}…`;
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

  return () => {
    disposed = true;
    stopEvents?.();
    stopRevealed?.();
    store.getState().setPending(null);
  };
}
