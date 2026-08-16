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
  useProjectStore.setState({ worktreeLoadError: null });
  setCurrentProject("/repo/proj");

  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => portReady,
      request: (_name: string) =>
        Promise.resolve({
          states: [] as WorktreeSnapshot[],
          watcherDegraded: false,
          topologyWatcherDark: false,
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

  it("clears the timer on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = await renderProvider();

    unmount();
    await advance(60_000);

    expect(useProjectStore.getState().worktreeLoadError).toBeNull();
  });
});
