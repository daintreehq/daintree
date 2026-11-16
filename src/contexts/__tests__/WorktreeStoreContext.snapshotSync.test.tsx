// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import {
  resetWorktreeSnapshotSyncForTesting,
  waitForWorktreeSnapshot,
} from "@/store/worktreeSnapshotSync";
import type { WorktreeSnapshot } from "@shared/types";
import type { Project } from "@shared/types/project";

/**
 * A restored worktree port and the MCP dispatch behind it (#13348).
 *
 * Main confirms a background view's restored port and dispatches straight
 * away, while the snapshot that port triggered is still in flight. The
 * dispatch handler waits on `waitForWorktreeSnapshot`, so it has to cover the
 * fetch right up to the snapshot being in the store — including the
 * associations wait that sits between the response and `applySnapshot`.
 */

vi.mock("@/lib/notify", () => ({ notify: vi.fn(() => "notif-id") }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

const WAIT_MS = 10_000;

let portReady = false;
let readyCallbacks: Array<() => void> = [];
let answerStates: (states: WorktreeSnapshot[], seq?: number) => void = () => {};
let answerAssociations: () => void = () => {};
let stateRequests = 0;
let associationRequests = 0;
let eventListeners = new Map<string, (data: unknown) => void>();

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
  stateRequests = 0;
  associationRequests = 0;
  eventListeners = new Map();
  resetWorktreeSnapshotSyncForTesting();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only the fields this suite reads
  useProjectStore.setState({ currentProject: { id: "p1", path: "/repo" } as unknown as Project });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- jsdom global, stubbed per test
  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => portReady,
      request: (_name: string) =>
        new Promise((resolve) => {
          stateRequests += 1;
          answerStates = (states, seq = 7) =>
            resolve({
              states,
              watcherDegraded: false,
              topologyWatcherDark: false,
              epoch: "epoch-1",
              seq,
              lastAcknowledgedMutationIds: [],
            });
        }),
      onEvent: (name: string, cb: (data: unknown) => void) => {
        eventListeners.set(name, cb);
        return () => eventListeners.delete(name);
      },
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
          associationRequests += 1;
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

/** Deliver the port, as the preload does just before it confirms the port to main. */
function deliverPort(): void {
  act(() => {
    portReady = true;
    readyCallbacks.forEach((cb) => cb());
  });
}

describe("WorktreeStoreProvider — snapshot wait for MCP dispatch (#13348)", () => {
  it("is only done waiting once the restored port's snapshot is in the store", async () => {
    const { store, unmount } = await renderProvider();
    expect(waitForWorktreeSnapshot(WAIT_MS)).toBeNull();

    // The port arrives: the fetch starts in the same turn the receipt is sent.
    deliverPort();
    const waiting = waitForWorktreeSnapshot(WAIT_MS);
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
    expect(waitForWorktreeSnapshot(WAIT_MS)).toBeNull();

    unmount();
  });

  it("still waits for the states when the associations answer first", async () => {
    const { store, unmount } = await renderProvider();
    deliverPort();
    const waiting = waitForWorktreeSnapshot(WAIT_MS)!;

    let done = false;
    void waiting.then(() => {
      done = true;
    });

    await act(async () => {
      answerAssociations();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(done).toBe(false);

    await act(async () => {
      answerStates([worktree("wt-new")]);
      await waiting;
    });
    expect(store.getState().worktrees.has("wt-new")).toBe(true);

    unmount();
  });
});

describe("WorktreeStoreProvider — re-hydrating after a port gap (#17037)", () => {
  it("fetches again when a live update overtakes the snapshot, so changes it missed still land", async () => {
    const { store, unmount } = await renderProvider();
    deliverPort();
    await act(async () => {
      answerStates([worktree("wt-a"), worktree("wt-gone")], 7);
      answerAssociations();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(store.getState().worktrees.has("wt-gone")).toBe(true);

    // The view comes back with a fresh port: "wt-gone" was deleted while it
    // held none, and an update to "wt-a" overtakes the snapshot that says so.
    deliverPort();
    await act(async () => {
      answerStates([worktree("wt-a")], 9);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => {
      eventListeners.get("worktree-update")!({
        worktree: worktree("wt-a"),
        epoch: "epoch-1",
        seq: 10,
      });
    });
    const waiting = waitForWorktreeSnapshot(WAIT_MS)!;
    let done = false;
    void waiting.then(() => {
      done = true;
    });
    await act(async () => {
      answerAssociations();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(stateRequests).toBe(3);
    expect(associationRequests).toBe(2);
    expect(done).toBe(false);

    // The retry reuses the associations it already has, so it applies as soon
    // as its states arrive, however busy the host is.
    await act(async () => {
      answerStates([worktree("wt-a")], 10);
      await waiting;
    });
    expect(store.getState().worktrees.has("wt-gone")).toBe(false);
    expect(store.getState().worktrees.has("wt-a")).toBe(true);
    expect(done).toBe(true);

    unmount();
  });
});
