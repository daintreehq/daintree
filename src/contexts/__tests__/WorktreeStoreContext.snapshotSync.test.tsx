// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import {
  pendingWorktreeSnapshot,
  resetWorktreeSnapshotSyncForTesting,
} from "@/store/worktreeSnapshotSync";
import type { WorktreeSnapshot } from "@shared/types";
import type { Project } from "@shared/types/project";

/**
 * A restored worktree port and the MCP dispatch behind it (#13348).
 *
 * Main confirms a background view's restored port and dispatches straight
 * away, while the snapshot that port triggered is still in flight. The
 * dispatch handler waits on `pendingWorktreeSnapshot`, so it has to cover the
 * fetch right up to the snapshot being in the store — including the
 * associations wait that sits between the response and `applySnapshot`.
 */

vi.mock("@/lib/notify", () => ({ notify: vi.fn(() => "notif-id") }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

let portReady = false;
let readyCallbacks: Array<() => void> = [];
let answerStates: (states: WorktreeSnapshot[]) => void = () => {};
let answerAssociations: () => void = () => {};

function worktree(id: string): WorktreeSnapshot {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only the fields the store keys on
  return { id, worktreeId: id, path: `/repo/${id}`, name: id, branch: id } as WorktreeSnapshot;
}

beforeAll(async () => {
  await import("../WorktreeStoreContext");
});

beforeEach(() => {
  portReady = false;
  readyCallbacks = [];
  resetWorktreeSnapshotSyncForTesting();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only the fields this suite reads
  useProjectStore.setState({ currentProject: { id: "p1", path: "/repo" } as unknown as Project });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- jsdom global, stubbed per test
  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => portReady,
      request: (_name: string) =>
        new Promise((resolve) => {
          answerStates = (states) =>
            resolve({
              states,
              watcherDegraded: false,
              topologyWatcherDark: false,
              epoch: "epoch-1",
              seq: 7,
              lastAcknowledgedMutationIds: [],
            });
        }),
      onEvent: (_name: string, _cb: (data: unknown) => void) => () => {},
      onReady: (cb: () => void) => {
        readyCallbacks.push(cb);
        return () => {
          readyCallbacks = readyCallbacks.filter((entry) => entry !== cb);
        };
      },
      onDisconnected: (_cb: () => void) => () => {},
      onFatalDisconnect: (_cb: () => void) => () => {},
    },
    worktree: {
      getAllIssueAssociations: () =>
        new Promise((resolve) => {
          answerAssociations = () => resolve({});
        }),
      getPRStatus: () => Promise.resolve(null),
    },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  resetWorktreeSnapshotSyncForTesting();
  useProjectStore.setState({ currentProject: null });
});

async function renderProvider() {
  const { WorktreeStoreProvider, WorktreeStoreContext } = await import("../WorktreeStoreContext");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WorktreeStoreProvider>{children}</WorktreeStoreProvider>
  );
  const { result, unmount } = renderHook(() => useContext(WorktreeStoreContext), { wrapper });
  await act(async () => {
    await Promise.resolve();
  });
  if (!result.current) throw new Error("WorktreeStoreContext is null");
  return { store: result.current, unmount };
}

describe("WorktreeStoreProvider — snapshot wait for MCP dispatch (#13348)", () => {
  it("is only done waiting once the restored port's snapshot is in the store", async () => {
    const { store, unmount } = await renderProvider();
    expect(pendingWorktreeSnapshot()).toBeNull();

    // The port arrives: the fetch starts in the same turn the receipt is sent.
    act(() => {
      portReady = true;
      readyCallbacks.forEach((cb) => cb());
    });
    const waiting = pendingWorktreeSnapshot();
    expect(waiting).not.toBeNull();

    let done = false;
    void waiting!.then(() => {
      done = true;
    });

    await act(async () => {
      answerStates([worktree("wt-new")]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The response alone is not enough: associations still gate the apply.
    expect(done).toBe(false);
    expect(store.getState().worktrees.has("wt-new")).toBe(false);

    await act(async () => {
      answerAssociations();
      await waiting;
    });
    expect(done).toBe(true);
    expect(store.getState().worktrees.has("wt-new")).toBe(true);
    expect(pendingWorktreeSnapshot()).toBeNull();

    unmount();
  });
});
