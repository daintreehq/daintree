import { createContext, useEffect, useState, type ReactNode } from "react";
import {
  createWorktreeStore,
  setCurrentViewStore,
  type WorktreeViewStoreApi,
} from "@/store/createWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { usePulseStore } from "@/store/pulseStore";
import { worktreeClient } from "@/clients/worktreeClient";

export const WorktreeStoreContext = createContext<WorktreeViewStoreApi | null>(null);

interface WorktreeUpdateEvent {
  type: "worktree-update";
  worktree: WorktreeSnapshot;
}

interface WorktreeRemovedEvent {
  type: "worktree-removed";
  worktreeId: string;
}

interface PRDetectedEvent {
  type: "pr-detected";
  worktreeId: string;
  prNumber: number;
  prUrl: string;
  prState: "open" | "merged" | "closed";
  prTitle?: string;
  issueNumber?: number;
  issueTitle?: string;
}

interface PRClearedEvent {
  type: "pr-cleared";
  worktreeId: string;
}

interface IssueDetectedEvent {
  type: "issue-detected";
  worktreeId: string;
  issueNumber: number;
  issueTitle: string;
}

interface IssueNotFoundEvent {
  type: "issue-not-found";
  worktreeId: string;
  issueNumber: number;
}

interface WorktreeActivatedEvent {
  type: "worktree-activated";
  worktreeId: string;
}

export function WorktreeStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState<WorktreeViewStoreApi>(() => createWorktreeStore());

  // Register module-level store reference for non-React code (action definitions, services)
  useEffect(() => {
    setCurrentViewStore(store);
  }, [store]);

  useEffect(() => {
    const { worktreePort } = window.electron;
    const cleanups: Array<() => void> = [];
    let generation = 0;

    function fetchInitialState() {
      const thisGen = ++generation;
      // Only show loading spinner on cold start (no cached data).
      // Wake refreshes should be silent — users see existing cached data.
      const isWake = store.getState().isInitialized;
      if (!isWake) {
        store.getState().setLoading(true);
      }
      worktreePort
        .request("get-all-states")
        .then(async (response: { states: WorktreeSnapshot[] }) => {
          if (thisGen !== generation) return;

          // Hydrate manual issue associations from electron store.
          // Auto-detected issues (from branch names) are already in the snapshots,
          // but user-attached associations are stored separately.
          let states = response.states;
          try {
            const associations = await worktreeClient.getAllIssueAssociations();
            if (thisGen !== generation) return;
            if (Object.keys(associations).length > 0) {
              states = states.map((s) => {
                const assoc = associations[s.id];
                // Only apply manual association if no auto-detected issue exists
                if (assoc && !s.issueNumber) {
                  return { ...s, issueNumber: assoc.issueNumber, issueTitle: assoc.issueTitle };
                }
                return s;
              });
            }
          } catch {
            // Non-critical — proceed without manual associations
            if (thisGen !== generation) return;
          }

          // If the host crashed during the associations fetch (a separate IPC
          // that port-close cannot reject), skip applySnapshot so it does not
          // spuriously clear the Reconnecting… indicator.  The next onReady
          // cycle will deliver fresh data.
          if (!worktreePort.isReady()) return;

          store.getState().applySnapshot(states, store.getState().nextVersion());
        })
        .catch((err: Error) => {
          if (thisGen !== generation) return;
          // On wake, preserve existing data — don't show error screen
          if (!isWake) {
            store.getState().setError(err.message);
            store.getState().setLoading(false);
          }
        });
    }

    cleanups.push(
      worktreePort.onEvent("worktree-update", (data) => {
        const event = data as WorktreeUpdateEvent;
        store.getState().applyUpdate(event.worktree, store.getState().nextVersion());

        // Side effect: sync pending worktree selection
        const selectionStore = useWorktreeSelectionStore.getState();
        if (selectionStore.pendingWorktreeId === event.worktree.id) {
          selectionStore.applyPendingWorktreeSelection(event.worktree.id);
        }
      })
    );

    cleanups.push(
      worktreePort.onEvent("worktree-removed", (data) => {
        const event = data as WorktreeRemovedEvent;
        const { worktrees } = store.getState();
        const worktree = worktrees.get(event.worktreeId);

        // Block removal of main worktree
        if (worktree?.isMainWorktree) {
          console.warn("[WorktreeStore] Attempted to remove main worktree - blocked", {
            worktreeId: event.worktreeId,
            branch: worktree.branch,
          });
          return;
        }

        store.getState().applyRemove(event.worktreeId, store.getState().nextVersion());

        // Side effect: invalidate pulse cache
        usePulseStore.getState().invalidate(event.worktreeId);

        // Side effect: clear active selection if removed
        const selectionStore = useWorktreeSelectionStore.getState();
        if (selectionStore.activeWorktreeId === event.worktreeId) {
          selectionStore.setActiveWorktree(null);
        }

        // Side effect: kill associated terminals
        const terminalStore = usePanelStore.getState();
        const idsToKill: string[] = [];
        for (const id of terminalStore.panelIds) {
          const t = terminalStore.panelsById[id];
          if (t && (t.worktreeId ?? undefined) === event.worktreeId) {
            idsToKill.push(id);
          }
        }
        for (const id of idsToKill) {
          terminalStore.removePanel(id);
        }
      })
    );

    cleanups.push(
      worktreePort.onEvent("worktree-activated", (data) => {
        const event = data as WorktreeActivatedEvent;
        const selectionStore = useWorktreeSelectionStore.getState();
        selectionStore.setPendingWorktree(event.worktreeId);
        selectionStore.selectWorktree(event.worktreeId);
        if (store.getState().worktrees.has(event.worktreeId)) {
          selectionStore.applyPendingWorktreeSelection(event.worktreeId);
        }
      })
    );

    cleanups.push(
      worktreePort.onEvent("pr-detected", (data) => {
        const event = data as PRDetectedEvent;
        const { worktrees } = store.getState();
        const existing = worktrees.get(event.worktreeId);
        if (!existing) return;
        store.getState().applyUpdate(
          {
            ...existing,
            prNumber: event.prNumber,
            prUrl: event.prUrl,
            prState: event.prState,
            prTitle: event.prTitle ?? existing.prTitle,
            issueNumber: event.issueNumber ?? existing.issueNumber,
            issueTitle: event.issueTitle ?? existing.issueTitle,
          },
          store.getState().nextVersion()
        );
      })
    );

    cleanups.push(
      worktreePort.onEvent("pr-cleared", (data) => {
        const event = data as PRClearedEvent;
        const { worktrees } = store.getState();
        const existing = worktrees.get(event.worktreeId);
        if (!existing) return;
        store.getState().applyUpdate(
          {
            ...existing,
            prNumber: undefined,
            prUrl: undefined,
            prState: undefined,
            prTitle: undefined,
          },
          store.getState().nextVersion()
        );
      })
    );

    cleanups.push(
      worktreePort.onEvent("issue-detected", (data) => {
        const event = data as IssueDetectedEvent;
        const { worktrees } = store.getState();
        const existing = worktrees.get(event.worktreeId);
        if (!existing) return;
        store.getState().applyUpdate(
          {
            ...existing,
            issueNumber: event.issueNumber,
            issueTitle: event.issueTitle,
          },
          store.getState().nextVersion()
        );
      })
    );

    cleanups.push(
      worktreePort.onEvent("issue-not-found", (data) => {
        const event = data as IssueNotFoundEvent;
        const { worktrees } = store.getState();
        const existing = worktrees.get(event.worktreeId);
        if (!existing) return;
        if (existing.issueNumber !== event.issueNumber) return;
        store.getState().applyUpdate(
          {
            ...existing,
            issueNumber: undefined,
            issueTitle: undefined,
          },
          store.getState().nextVersion()
        );
      })
    );

    // Fetch on initial ready and on every port re-attach (host restart / re-broker)
    if (worktreePort.isReady()) {
      fetchInitialState();
    }
    cleanups.push(worktreePort.onReady(fetchInitialState));

    // Surface a "Reconnecting…" state the moment the workspace host dies, so
    // the UI doesn't appear frozen while we wait (up to 2–4s) for the
    // replacement port.  Cleared by applySnapshot when the new port returns
    // data — this avoids flashing the indicator during normal port replacement
    // where a new port arrives within milliseconds.
    cleanups.push(
      worktreePort.onDisconnected(() => {
        store.getState().setReconnecting(true);
      })
    );

    // If the host exhausts its restart budget, no replacement port will
    // arrive — transition to a terminal error state instead of leaving the
    // spinner stuck indefinitely.  `setFatalError` also resets
    // `isInitialized` so a successful manual restart re-hydrates as a cold
    // fetch rather than a silent wake refresh.
    cleanups.push(
      worktreePort.onFatalDisconnect(() => {
        store
          .getState()
          .setFatalError(
            "Workspace service crashed and could not recover automatically. Restart the service to reconnect."
          );
      })
    );

    // Snapshot-on-wake: when a cached view is reactivated (addChildView),
    // Chromium fires visibilitychange. Request a fresh snapshot to rehydrate
    // state that may have changed while the view was backgrounded.
    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && worktreePort.isReady()) {
        fetchInitialState();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    cleanups.push(() => document.removeEventListener("visibilitychange", handleVisibilityChange));

    return () => {
      generation++;
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [store]);

  return <WorktreeStoreContext value={store}>{children}</WorktreeStoreContext>;
}
