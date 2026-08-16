// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import type { WorktreeSnapshot } from "@shared/types";
import type { Project } from "@shared/types/project";

/**
 * The initial-port watchdog (#11818).
 *
 * Nothing used to bound the wait for the worktree port to be brokered: when
 * main never brokered one, `isLoading` stayed true and the sidebar rendered its
 * skeleton forever with no route to the error banner. These cover the floor the
 * renderer now puts under that hang, and the paths that must NOT trip it.
 */

vi.mock("@/lib/notify", () => ({ notify: vi.fn(() => "notif-id") }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

const TIMEOUT_MESSAGE =
  "The workspace service didn't finish connecting, so worktrees couldn't load.";

let portReady = false;
let readyCallbacks: Array<() => void> = [];
let fatalCallbacks: Array<() => void> = [];
let requestCount = 0;

function setCurrentProject(path: string | null): void {
  const project = path ? ({ id: "p1", name: "p1", path } as unknown as Project) : null;
  useProjectStore.setState({ currentProject: project });
}

// Warm the module cache under real timers: a dynamic import while fake timers
// are installed never settles, so the import has to happen before any test
// swaps them in.
beforeAll(async () => {
  await import("../WorktreeStoreContext");
});

beforeEach(() => {
  portReady = false;
  readyCallbacks = [];
  fatalCallbacks = [];
  requestCount = 0;
  useProjectStore.setState({ worktreeLoadError: null });
  setCurrentProject("/repo/proj");

  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => portReady,
      request: (_name: string) => {
        requestCount += 1;
        return Promise.resolve({
          states: [] as WorktreeSnapshot[],
          watcherDegraded: false,
          topologyWatcherDark: false,
          epoch: "epoch-1",
          seq: 1,
          lastAcknowledgedMutationIds: [] as string[],
        });
      },
      onEvent: (_name: string, _cb: (data: unknown) => void) => () => {},
      onReady: (cb: () => void) => {
        readyCallbacks.push(cb);
        return () => {
          readyCallbacks = readyCallbacks.filter((entry) => entry !== cb);
        };
      },
      onDisconnected: (_cb: () => void) => () => {},
      onFatalDisconnect: (cb: () => void) => {
        fatalCallbacks.push(cb);
        return () => {
          fatalCallbacks = fatalCallbacks.filter((entry) => entry !== cb);
        };
      },
    },
    worktree: {
      getAllIssueAssociations: () => Promise.resolve({}),
      getPRStatus: () => Promise.resolve(null),
    },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  vi.useRealTimers();
  useProjectStore.setState({ worktreeLoadError: null });
  setCurrentProject(null);
});

async function renderProvider() {
  const { WorktreeStoreProvider, WorktreeStoreContext } = await import("../WorktreeStoreContext");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WorktreeStoreProvider>{children}</WorktreeStoreProvider>
  );
  const { result, unmount } = renderHook(() => useContext(WorktreeStoreContext), { wrapper });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!result.current) throw new Error("WorktreeStoreContext is null");
  return { store: result.current, unmount };
}

/** Fire the port-ready notification main would send once it brokers a port. */
async function becomeReady(): Promise<void> {
  portReady = true;
  await act(async () => {
    readyCallbacks.forEach((cb) => cb());
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("WorktreeStoreProvider — initial worktree-port watchdog (#11818)", () => {
  it("keeps the sidebar loading while the port is still plausibly on its way", async () => {
    vi.useFakeTimers();
    const { store } = await renderProvider();

    await advance(30_000);

    expect(useProjectStore.getState().worktreeLoadError).toBeNull();
    expect(store.getState().isLoading).toBe(true);
  });

  it("surfaces an error and settles the skeleton once the port never arrives", async () => {
    vi.useFakeTimers();
    const { store } = await renderProvider();

    await advance(60_000);

    expect(useProjectStore.getState().worktreeLoadError).toBe(TIMEOUT_MESSAGE);
    // The banner renders above the skeleton, so the skeleton has to end too or
    // Retry sits on top of a still-spinning sidebar.
    expect(store.getState().isLoading).toBe(false);
  });

  it("does not escalate to the fatal-disconnect state", async () => {
    vi.useFakeTimers();
    const { store } = await renderProvider();

    await advance(60_000);

    // A port that never arrived is not proof the host crashed — `setFatalError`
    // would offer "Restart service" instead of the load's own Retry.
    expect(store.getState().error).toBeNull();
  });

  it("arms nothing for a window with no project bound", async () => {
    setCurrentProject(null);
    vi.useFakeTimers();
    const { store } = await renderProvider();

    await advance(60_000);

    // An unbound picker view legitimately never has a port brokered for it.
    expect(useProjectStore.getState().worktreeLoadError).toBeNull();
    expect(store.getState().isLoading).toBe(true);
  });

  it("arms once a project binds after mount", async () => {
    setCurrentProject(null);
    vi.useFakeTimers();
    await renderProvider();

    await act(async () => {
      setCurrentProject("/repo/late");
      await Promise.resolve();
    });
    await advance(60_000);

    expect(useProjectStore.getState().worktreeLoadError).toBe(TIMEOUT_MESSAGE);
  });

  it("cancels the watchdog when the port arrives in time", async () => {
    vi.useFakeTimers();
    const { store } = await renderProvider();

    await becomeReady();
    await advance(60_000);

    expect(useProjectStore.getState().worktreeLoadError).toBeNull();
    expect(store.getState().isLoading).toBe(false);
  });

  it("clears its own timeout message when the port arrives late", async () => {
    vi.useFakeTimers();
    await renderProvider();

    await advance(60_000);
    expect(useProjectStore.getState().worktreeLoadError).toBe(TIMEOUT_MESSAGE);

    await becomeReady();

    expect(useProjectStore.getState().worktreeLoadError).toBeNull();
  });

  it("leaves a main-process error in place when the port arrives late", async () => {
    vi.useFakeTimers();
    await renderProvider();

    // Main described a real failure; a late port doesn't resolve it, so the
    // banner must survive.
    act(() => {
      useProjectStore.getState().setWorktreeLoadError("Repository folder is gone");
    });
    await becomeReady();

    expect(useProjectStore.getState().worktreeLoadError).toBe("Repository folder is gone");
  });

  it("settles the skeleton as soon as main reports a failure", async () => {
    vi.useFakeTimers();
    const { store } = await renderProvider();

    act(() => {
      useProjectStore.getState().setWorktreeLoadError("Repository folder is gone");
    });

    expect(store.getState().isLoading).toBe(false);

    // And the watchdog no longer overwrites main's better description.
    await advance(60_000);
    expect(useProjectStore.getState().worktreeLoadError).toBe("Repository folder is gone");
  });

  it("settles a skeleton when the error landed before the provider mounted", async () => {
    // The IPC listener that sets `worktreeLoadError` is installed at module
    // scope, so a boot failure can be recorded before React mounts anything.
    // The subscription below only sees transitions, so this has to be caught
    // when the watchdog is armed.
    useProjectStore.setState({ worktreeLoadError: "Repository folder is gone" });
    vi.useFakeTimers();
    const { store } = await renderProvider();

    expect(store.getState().isLoading).toBe(false);

    await advance(60_000);
    expect(useProjectStore.getState().worktreeLoadError).toBe("Repository folder is gone");
  });

  it("keeps a main-process error that replaced its own timeout message", async () => {
    vi.useFakeTimers();
    await renderProvider();

    await advance(60_000);
    expect(useProjectStore.getState().worktreeLoadError).toBe(TIMEOUT_MESSAGE);

    // Main described the real failure after the watchdog guessed; a late port
    // must not clear that better description.
    act(() => {
      useProjectStore.getState().setWorktreeLoadError("Repository folder is gone");
    });
    await becomeReady();

    expect(useProjectStore.getState().worktreeLoadError).toBe("Repository folder is gone");
  });

  it("cancels the watchdog on a fatal disconnect", async () => {
    vi.useFakeTimers();
    const { store } = await renderProvider();

    await act(async () => {
      fatalCallbacks.forEach((cb) => cb());
      await Promise.resolve();
    });
    await advance(60_000);

    // The fatal error is the better description, and the watchdog must not
    // stack its own banner on top of it.
    expect(store.getState().error).not.toBeNull();
    expect(useProjectStore.getState().worktreeLoadError).toBeNull();
  });

  it("refetches on every port re-attach, not just the first", async () => {
    vi.useFakeTimers();
    await renderProvider();

    await becomeReady();
    const afterFirst = requestCount;
    expect(afterFirst).toBeGreaterThan(0);

    // Host restart → the port is re-brokered and fires ready again.
    await becomeReady();

    expect(requestCount).toBeGreaterThan(afterFirst);
  });

  it("clears the timer on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = await renderProvider();

    unmount();
    await advance(60_000);

    expect(useProjectStore.getState().worktreeLoadError).toBeNull();
  });
});
