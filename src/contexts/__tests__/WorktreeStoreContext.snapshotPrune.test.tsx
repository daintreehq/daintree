// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import { usePulseStore } from "@/store/pulseStore";
import type { ProjectPulse, WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import type { Project } from "@shared/types/project";

const TEST_EPOCH = "test-epoch";
let _seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: TEST_EPOCH, seq: ++_seq };
}

type PortEventName =
  | "worktree-update"
  | "worktree-removed"
  | "worktree-activated"
  | "pr-detected"
  | "pr-cleared"
  | "pr-detection-state"
  | "issue-detected"
  | "issue-not-found"
  | "inotify-limit-reached"
  | "emfile-limit-reached"
  | "watcher-recovered";

const listeners = new Map<PortEventName, Set<(data: unknown) => void>>();

function makeWorktree(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name: id,
    isCurrent: false,
    branch: "main",
    isMainWorktree: false,
    ...overrides,
  } as WorktreeSnapshot;
}

function seedPulse(worktreeId: string): void {
  usePulseStore.setState((prev) => ({
    pulses: new Map(prev.pulses).set(worktreeId, { commits: [] } as unknown as ProjectPulse),
    loading: new Map(prev.loading).set(worktreeId, false),
    errors: new Map(prev.errors).set(worktreeId, null),
  }));
}

function setCurrentProject(path: string | null): void {
  const project = path ? ({ id: "p1", name: "p1", path } as unknown as Project) : null;
  useProjectStore.setState({ currentProject: project });
}

beforeEach(() => {
  listeners.clear();
  setCurrentProject("/repo/proj");
  _seq = 0;
  usePulseStore.getState().invalidateAll();

  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => true,
      request: (_name: string) =>
        Promise.resolve({ states: [] as WorktreeSnapshot[], epoch: TEST_EPOCH, seq: 0 }),
      onEvent: (name: PortEventName, cb: (data: unknown) => void) => {
        let set = listeners.get(name);
        if (!set) {
          set = new Set();
          listeners.set(name, set);
        }
        set.add(cb);
        return () => set?.delete(cb);
      },
      onReady: (_cb: () => void) => () => {},
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
  listeners.clear();
  setCurrentProject(null);
  usePulseStore.getState().invalidateAll();
  vi.restoreAllMocks();
});

async function renderProvider() {
  const { WorktreeStoreProvider, WorktreeStoreContext } = await import("../WorktreeStoreContext");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WorktreeStoreProvider>{children}</WorktreeStoreProvider>
  );
  const rendered = renderHook(() => useContext(WorktreeStoreContext), { wrapper });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!rendered.result.current) throw new Error("WorktreeStoreContext is null");
  return { store: rendered.result.current, unmount: rendered.unmount };
}

describe("WorktreeStoreProvider — pulse-cache snapshot pruning", () => {
  it("invalidates pulse entries for worktrees dropped by applySnapshot", async () => {
    const { store } = await renderProvider();

    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1"), makeWorktree("wt-2")], nextV());
    });
    seedPulse("wt-1");
    seedPulse("wt-2");
    expect(usePulseStore.getState().pulses.has("wt-1")).toBe(true);
    expect(usePulseStore.getState().pulses.has("wt-2")).toBe(true);

    // Host restart delivers a smaller authoritative snapshot — wt-2 is gone but
    // no per-id `worktree-removed` event fires.
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });

    expect(usePulseStore.getState().pulses.has("wt-1")).toBe(true);
    expect(usePulseStore.getState().pulses.has("wt-2")).toBe(false);
    expect(usePulseStore.getState().loading.has("wt-2")).toBe(false);
    expect(usePulseStore.getState().errors.has("wt-2")).toBe(false);
  });

  it("does not invalidate when an unrelated slice changes (worktrees ref stable)", async () => {
    const { store } = await renderProvider();

    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    seedPulse("wt-1");

    const invalidateSpy = vi.spyOn(usePulseStore.getState(), "invalidate");

    act(() => {
      store.getState().setWatcherDegraded(true);
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(usePulseStore.getState().pulses.has("wt-1")).toBe(true);
  });

  it("invalidates every worktree when the snapshot empties the set", async () => {
    const { store } = await renderProvider();

    act(() => {
      store
        .getState()
        .applySnapshot([makeWorktree("wt-1"), makeWorktree("wt-2"), makeWorktree("wt-3")], nextV());
    });
    seedPulse("wt-1");
    seedPulse("wt-2");
    seedPulse("wt-3");

    act(() => {
      store.getState().applySnapshot([], nextV());
    });

    expect(usePulseStore.getState().pulses.has("wt-1")).toBe(false);
    expect(usePulseStore.getState().pulses.has("wt-2")).toBe(false);
    expect(usePulseStore.getState().pulses.has("wt-3")).toBe(false);
  });

  it("stops pruning after the provider unmounts", async () => {
    const { store, unmount } = await renderProvider();

    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1"), makeWorktree("wt-2")], nextV());
    });
    seedPulse("wt-2");

    // Tear down inside act() so the effect cleanup (which removes the
    // subscription) flushes synchronously before the next snapshot.
    act(() => {
      unmount();
    });

    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });

    // Entry remains because the subscription was torn down on unmount.
    expect(usePulseStore.getState().pulses.has("wt-2")).toBe(true);
  });
});
