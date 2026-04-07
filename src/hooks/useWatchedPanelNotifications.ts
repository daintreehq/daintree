import { useEffect } from "react";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { fireWatchNotification } from "@/lib/watchNotification";

const NOTIFICATION_STAGGER_MS = 250;

export function useWatchedPanelNotifications(): void {
  useEffect(() => {
    // Sync initial watched set to main process
    window.electron?.notification?.syncWatchedPanels?.(
      Array.from(useTerminalStore.getState().watchedPanels)
    );

    // Keep main process in sync whenever the watched set changes
    let prevWatchedPanels = useTerminalStore.getState().watchedPanels;
    const unsubWatched = useTerminalStore.subscribe((state) => {
      if (state.watchedPanels !== prevWatchedPanels) {
        prevWatchedPanels = state.watchedPanels;
        window.electron?.notification?.syncWatchedPanels?.(Array.from(state.watchedPanels));
      }
    });

    let prevAgentStates = new Map<string, string | undefined>(
      useTerminalStore.getState().terminalIds.map((id) => {
        const t = useTerminalStore.getState().terminalsById[id];
        return [id, t?.agentState];
      })
    );
    const staggerQueue: Array<() => void> = [];
    let staggerTimer: ReturnType<typeof setTimeout> | null = null;

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
      staggerQueue.push(fn);
      if (!staggerTimer) {
        drainStaggerQueue();
      }
    }

    const unsubscribe = useTerminalStore.subscribe((state) => {
      const { watchedPanels, terminalsById, terminalIds } = state;
      const currentAgentStates = new Map<string, string | undefined>(
        terminalIds.map((id) => [id, terminalsById[id]?.agentState])
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
          const terminal = terminalsById[panelId];
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
            const liveTerminal = useTerminalStore.getState().terminalsById[capturedPanelId];
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
        useTerminalStore.getState().setFocused(panelId, true);
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
