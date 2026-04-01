import { createContext, useEffect, useRef, type ReactNode } from "react";
import { createWorktreeStore, type WorktreeViewStoreApi } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";

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

export function WorktreeStoreProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<WorktreeViewStoreApi>(null);
  if (!storeRef.current) {
    storeRef.current = createWorktreeStore();
  }
  const store = storeRef.current;

  useEffect(() => {
    const { worktreePort } = window.electron;
    const cleanups: Array<() => void> = [];
    let generation = 0;

    function fetchInitialState() {
      const thisGen = ++generation;
      store.getState().setLoading(true);
      worktreePort
        .request("get-all-states")
        .then((response: { states: WorktreeSnapshot[] }) => {
          if (thisGen !== generation) return;
          store.getState().applySnapshot(response.states, store.getState().nextVersion());
        })
        .catch((err: Error) => {
          if (thisGen !== generation) return;
          store.getState().setError(err.message);
          store.getState().setLoading(false);
        });
    }

    cleanups.push(
      worktreePort.onEvent("worktree-update", (data) => {
        const event = data as WorktreeUpdateEvent;
        store.getState().applyUpdate(event.worktree, store.getState().nextVersion());
      })
    );

    cleanups.push(
      worktreePort.onEvent("worktree-removed", (data) => {
        const event = data as WorktreeRemovedEvent;
        store.getState().applyRemove(event.worktreeId, store.getState().nextVersion());
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

    return () => {
      generation++;
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [store]);

  return <WorktreeStoreContext value={store}>{children}</WorktreeStoreContext>;
}
