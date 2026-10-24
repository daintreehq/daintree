// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import type { WorktreeSnapshot } from "@shared/types";
import type { Project } from "@shared/types/project";

/**
 * The provider's half of #14313: a remote view retries a stalled worktree
 * reconnect on its own, and a delivered port that can't answer counts as lost.
 */

vi.mock("@/lib/notify", () => ({ notify: vi.fn(() => "notif-id") }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

let portReady = false;
let readyCallbacks: Array<() => void> = [];
let disconnectCallbacks: Array<() => void> = [];
let hostAnswers = true;
let seq = 0;
let retryProjectLoad: ReturnType<typeof vi.fn<() => Promise<void>>>;

function snapshotResponse() {
  seq += 1;
  return {
    states: [] as WorktreeSnapshot[],
    watcherDegraded: false,
    topologyWatcherDark: false,
    epoch: "epoch-1",
    seq,
    lastAcknowledgedMutationIds: [] as string[],
  };
}

beforeAll(async () => {
  await import("../WorktreeStoreContext");
});

beforeEach(() => {
  portReady = true;
  readyCallbacks = [];
  disconnectCallbacks = [];
  hostAnswers = true;
  seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only the fields this suite reads
  const project = { id: "p1", name: "p1", path: "/repo/proj" } as unknown as Project;
  useProjectStore.setState({ currentProject: project, worktreeLoadError: null });
  // The link store starts unbound, which reads as up: the link half is the
  // controller's own suite.
  window.__DAINTREE_HOST_ID__ = { id: "studio-03" };
  retryProjectLoad = vi.fn<() => Promise<void>>(async () => {
    // What Retry does when the host has the project again: a fresh port whose
    // snapshot lands.
    hostAnswers = true;
    readyCallbacks.forEach((cb) => cb());
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- jsdom global, stubbed per test
  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => portReady,
      request: (_name: string) =>
        hostAnswers
          ? Promise.resolve(snapshotResponse())
          : Promise.reject(new Error("Worktree host is not connected")),
      onEvent: (_name: string, _cb: (data: unknown) => void) => () => {},
      onReady: (cb: () => void) => {
        readyCallbacks.push(cb);
        return () => {
          readyCallbacks = readyCallbacks.filter((entry) => entry !== cb);
        };
      },
      onDisconnected: (cb: () => void) => {
        disconnectCallbacks.push(cb);
        return () => {
          disconnectCallbacks = disconnectCallbacks.filter((entry) => entry !== cb);
        };
      },
      onFatalDisconnect: (_cb: () => void) => () => {},
    },
    worktree: {
      getAllIssueAssociations: () => Promise.resolve({}),
      getPRStatus: () => Promise.resolve(null),
      retryProjectLoad: () => retryProjectLoad(),
    },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  vi.useRealTimers();
  delete window.__DAINTREE_HOST_ID__;
  useHostConnectionStore.getState().reset();
  useProjectStore.setState({ currentProject: null, worktreeLoadError: null });
});

async function renderProvider() {
  const { WorktreeStoreProvider, WorktreeStoreContext } = await import("../WorktreeStoreContext");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WorktreeStoreProvider>{children}</WorktreeStoreProvider>
  );
  const { result, unmount } = renderHook(() => useContext(WorktreeStoreContext), { wrapper });
  await flush();
  if (!result.current) throw new Error("WorktreeStoreContext is null");
  return { store: result.current, unmount };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The port drops, and the one delivered after it reaches no workspace host. */
async function loseHostBehindPort(): Promise<void> {
  hostAnswers = false;
  await act(async () => {
    disconnectCallbacks.forEach((cb) => cb());
    readyCallbacks.forEach((cb) => cb());
  });
  await flush();
}

describe("WorktreeStoreProvider — stalled reconnect recovery (#14313)", () => {
  it("treats a delivered port that can't answer as a lost connection", async () => {
    vi.useFakeTimers();
    const { store, unmount } = await renderProvider();
    expect(store.getState().isInitialized).toBe(true);

    hostAnswers = false;
    await act(async () => {
      readyCallbacks.forEach((cb) => cb());
    });
    await flush();

    expect(store.getState().isReconnecting).toBe(true);
    unmount();
  });

  it("runs Retry on its own once the reconnect stalls, and recovers with no banner", async () => {
    vi.useFakeTimers();
    const { store, unmount } = await renderProvider();
    await loseHostBehindPort();
    expect(store.getState().isReconnecting).toBe(true);

    await advance(29_000);
    expect(retryProjectLoad).not.toHaveBeenCalled();
    await advance(1_000);
    await flush();

    expect(retryProjectLoad).toHaveBeenCalledTimes(1);
    expect(store.getState().isReconnecting).toBe(false);
    expect(store.getState().reconnectRecovery).toBe("idle");
    unmount();
  });

  it("leaves a view on this machine to the banner's Retry", async () => {
    delete window.__DAINTREE_HOST_ID__;
    vi.useFakeTimers();
    const { store, unmount } = await renderProvider();
    await act(async () => {
      disconnectCallbacks.forEach((cb) => cb());
    });

    await advance(120_000);

    expect(retryProjectLoad).not.toHaveBeenCalled();
    expect(store.getState().isReconnecting).toBe(true);
    expect(store.getState().reconnectRecovery).toBe("idle");
    unmount();
  });
});
