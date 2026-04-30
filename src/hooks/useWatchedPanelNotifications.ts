import { useEffect } from "react";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { fireWatchNotification } from "@/lib/watchNotification";

const NOTIFICATION_STAGGER_MS = 250;
export const MAX_STAGGER_QUEUE_LENGTH = 50;

/**
 * Drops the oldest entry if the queue is at or above the cap. Returns true
 * when an entry was dropped, so callers can emit a one-time diagnostic log.
 * Exported for direct unit testing; the cap cannot be reliably reached via
 * the subscriber path because `drainStaggerQueue` is called synchronously
 * from every push.
 */
export function applyStaggerQueueCap<T>(queue: T[]): boolean {
  if (queue.length >= MAX_STAGGER_QUEUE_LENGTH) {
    queue.shift();
    return true;
  }
  return false;
}

export function useWatchedPanelNotifications(): void {
  useEffect(() => {
    // Sync initial watched set to main process
    window.electron?.notification?.syncWatchedPanels?.(
      Array.from(usePanelStore.getState().watchedPanels)
    );

    // Keep main process in sync whenever the watched set changes
    let prevWatchedPanels = usePanelStore.getState().watchedPanels;
    const unsubWatched = usePanelStore.subscribe((state) => {
      if (state.watchedPanels !== prevWatchedPanels) {
        prevWatchedPanels = state.watchedPanels;
        window.electron?.notification?.syncWatchedPanels?.(Array.from(state.watchedPanels));
      }
    });

    let prevAgentStates = new Map<string, string | undefined>(
      usePanelStore.getState().panelIds.map((id) => {
        const t = usePanelStore.getState().panelsById[id];
        return [id, t?.agentState];
      })
    );
    const staggerQueue: Array<() => void> = [];
    let staggerTimer: ReturnType<typeof setTimeout> | null = null;
    let hasWarnedOverflow = false;

    function drainStaggerQueue(): void {
      const fn = staggerQueue.shift();
      if (!fn) return;
      fn();
      if (staggerQueue.length > 0) {
        staggerTimer = setTimeout(drainStaggerQueue, NOTIFICATION_STAGGER_MS);
      } else {
        staggerTimer = null;
      }
    }

    function enqueueNotification(fn: () => void): void {
      if (applyStaggerQueueCap(staggerQueue) && !hasWarnedOverflow) {
        hasWarnedOverflow = true;
        console.warn("[WatchedPanel] stagger queue overflow: dropping oldest notification");
      }
      staggerQueue.push(fn);
      if (!staggerTimer) {
        drainStaggerQueue();
      }
    }

    const unsubscribe = usePanelStore.subscribe((state) => {
      const { watchedPanels, panelsById, panelIds } = state;
      const currentAgentStates = new Map<string, string | undefined>(
        panelIds.map((id) => [id, panelsById[id]?.agentState])
      );

      for (const panelId of watchedPanels) {
        const currentState = currentAgentStates.get(panelId);
        const previousState = prevAgentStates.get(panelId);

        if (
          (currentState === "completed" ||
            currentState === "waiting" ||
            currentState === "exited") &&
          currentState !== previousState
        ) {
          const terminal = panelsById[panelId];
          if (!terminal || terminal.location === "trash") {
            state.unwatchPanel(panelId);
            continue;
          }

          // Capture values for closure
          const capturedPanelId = panelId;
          const capturedTitle = terminal.title ?? panelId;
          const capturedState = currentState;

          enqueueNotification(() => {
            // Guard: skip if panel has since been removed or trashed
            const liveTerminal = usePanelStore.getState().panelsById[capturedPanelId];
            if (!liveTerminal || liveTerminal.location === "trash") return;

            fireWatchNotification(capturedPanelId, capturedTitle, capturedState);
          });

          // One-shot: auto-clear the watch after notification fires
          state.unwatchPanel(panelId);
        }
      }

      prevAgentStates = currentAgentStates;
    });

    // Listen for OS notification click → navigate
    let unsubNavigate: (() => void) | null = null;
    if (window.electron?.notification?.onWatchNavigate) {
      unsubNavigate = window.electron.notification.onWatchNavigate((context) => {
        const { panelId, worktreeId } = context;
        if (worktreeId) {
          useWorktreeSelectionStore.getState().setActiveWorktree(worktreeId);
        }
        usePanelStore.getState().setFocused(panelId, true);
      });
    }

    return () => {
      unsubWatched();
      unsubscribe();
      unsubNavigate?.();
      if (staggerTimer) {
        clearTimeout(staggerTimer);
      }
    };
  }, []);
}
