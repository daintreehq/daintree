// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import { usePulseStore } from "@/store/pulseStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore, recordSidebarWorktreeOrder } from "@/store/worktreeStore";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import type { Project } from "@shared/types/project";

const TEST_EPOCH = "test-epoch";
let _seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: TEST_EPOCH, seq: ++_seq };
}

type PortEventName = "worktree-update" | "worktree-removed" | "worktree-activated";

const listeners = new Map<PortEventName, Set<(data: unknown) => void>>();

function emit(name: PortEventName, data: unknown): void {
  for (const cb of listeners.get(name) ?? []) cb(data);
}

function makeWorktree(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name: id,
    isCurrent: false,
    branch: `branch-${id}`,
    isMainWorktree: false,
    ...overrides,
  } as WorktreeSnapshot;
}

/**
 * Install panels directly into the panel store's normalized shape — the
 * deleted-worktree row derives its membership from `panelIdsByWorktreeId`, so
 * the index has to be consistent with `panelsById`.
 */
function setPanels(entries: Array<{ id: string; worktreeId: string; location?: string }>): void {
  const panelsById: Record<string, unknown> = {};
  const panelIdsByWorktreeId: Record<string, string[]> = {};
  for (const entry of entries) {
    panelsById[entry.id] = {
      id: entry.id,
      kind: "terminal",
      title: entry.id,
      worktreeId: entry.worktreeId,
      location: entry.location ?? "grid",
    };
    const bucket = panelIdsByWorktreeId[entry.worktreeId];
    if (bucket) bucket.push(entry.id);
    else panelIdsByWorktreeId[entry.worktreeId] = [entry.id];
  }
  usePanelStore.setState({
    panelIds: entries.map((e) => e.id),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    panelsById: panelsById as never,
    panelIdsByWorktreeId,
  });
}

function setCurrentProject(path: string | null): void {
  // Only the path is read by the provider; standing up a full Project here
  // would couple this test to fields it never exercises.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const project = path ? ({ id: "p1", name: "p1", path } as unknown as Project) : null;
  useProjectStore.setState({ currentProject: project });
}

beforeEach(() => {
  listeners.clear();
  setCurrentProject("/repo/proj");
  _seq = 0;
  usePulseStore.getState().invalidateAll();
  useWorktreeSelectionStore.getState().reset();
  recordSidebarWorktreeOrder([]);
  setPanels([]);

  // Minimal worktree-port double: the provider only touches these members, so
  // the bridge is stubbed rather than reconstructed in full.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
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
  useWorktreeSelectionStore.getState().reset();
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

function removeEvent(worktreeId: string) {
  return { type: "worktree-removed", worktreeId, ...nextV() };
}

describe("WorktreeStoreProvider — surviving terminals on worktree removal", () => {
  it("keeps the panels alive instead of removing them (#11232)", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([
      { id: "agent-a", worktreeId: "wt-1" },
      { id: "agent-b", worktreeId: "wt-1" },
      { id: "other", worktreeId: "wt-2" },
    ]);

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });

    // The whole point of the issue: deleting the worktree must not destroy the
    // agent sessions that lived in it.
    expect(usePanelStore.getState().panelsById["agent-a"]).toBeDefined();
    expect(usePanelStore.getState().panelsById["agent-b"]).toBeDefined();
    expect(usePanelStore.getState().panelIds).toContain("agent-a");
  });

  it("records a deleted-worktree row carrying the last-known title and path", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });

    const row = useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1");
    expect(row).toMatchObject({ id: "wt-1", title: "branch-wt-1", path: "/repo/wt-1" });
  });

  it("falls back to the folder name when the worktree had no branch", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1", { branch: undefined })], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1")?.title).toBe("wt-1");
  });

  it("pins the row to the slot it held in the sidebar", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);
    recordSidebarWorktreeOrder(["wt-0", "wt-1", "wt-2"]);

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1")?.pinnedIndex).toBe(1);
  });

  it("creates no row when the worktree held no terminals", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([{ id: "other", worktreeId: "wt-2" }]);

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.size).toBe(0);
  });

  it("ignores panels already in the trash when deciding to create a row", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([{ id: "gone", worktreeId: "wt-1", location: "trash" }]);

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.size).toBe(0);
  });

  it("creates no row for the main worktree, which removal blocks outright", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-main", { isMainWorktree: true })], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-main" }]);

    act(() => {
      emit("worktree-removed", removeEvent("wt-main"));
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.size).toBe(0);
    expect(usePanelStore.getState().panelsById["agent-a"]).toBeDefined();
  });

  it("drops the row when its last terminal leaves", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(true);

    // Dragging the last terminal to a live worktree re-parents the panel, which
    // must silently retire the row.
    act(() => {
      setPanels([{ id: "agent-a", worktreeId: "wt-live" }]);
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(false);
  });

  it("keeps the row while any terminal remains", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([
      { id: "agent-a", worktreeId: "wt-1" },
      { id: "agent-b", worktreeId: "wt-1" },
    ]);

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });
    act(() => {
      setPanels([{ id: "agent-b", worktreeId: "wt-1" }]);
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(true);
  });

  it("drops the row when a live worktree reclaims its id", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(true);

    // A workspace-host restart re-hydrates the worktree; the real row wins so
    // the sidebar never shows two rows for one id.
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(false);
  });
});
