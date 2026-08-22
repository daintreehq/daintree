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

  it("records the ghost row unarmed and lets the cleanup sweep start the clock (#11259)", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });

    // Stamping a wall-clock deadline here charged the row for time a cached
    // project view spent frozen, so it came back already expired with no
    // window to rescue the surviving agents.
    const row = useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1");
    expect(row).toBeDefined();
    expect(row?.expiresAt).toBeNull();
    expect(row?.holdReason).toBeNull();
  });

  it("keeps the deleted worktree active while its terminals survive", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1", restoreWorktreeId: "wt-1" });

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });

    const selection = useWorktreeSelectionStore.getState();
    // The user may be mid-cleanup on the ghost — deletion must not yank them
    // away; the fallback to main happens only when the ghost row itself goes.
    expect(selection.activeWorktreeId).toBe("wt-1");
    // But a deleted id must never remain the durable restore target — the
    // ghost row is in-memory only and resolves to nothing after a restart.
    expect(selection.restoreWorktreeId).toBeNull();
  });

  it("clears the active selection when the removed worktree has no surviving terminals", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1", restoreWorktreeId: "wt-1" });

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBeNull();
  });

  it("suppresses the host's auto-switch echo that precedes a UI delete (activated → removed)", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1"), makeWorktree("main")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    act(() => {
      store.setState({ deletingIds: new Set(["wt-1"]) });
    });

    // The host switches itself to main before removing the worktree and
    // echoes that switch; the user mid-delete must not be yanked off wt-1.
    act(() => {
      emit("worktree-activated", { type: "worktree-activated", worktreeId: "main", ...nextV() });
    });
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(true);
  });

  it("suppresses the host's auto-switch echo that follows an external removal (removed → activated)", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1"), makeWorktree("main")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
      emit("worktree-activated", { type: "worktree-activated", worktreeId: "main", ...nextV() });
    });

    // The active id is a ghost row with survivors — the echo must not win.
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
  });

  it("still follows the host's switch when the deletion left no surviving terminals", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1"), makeWorktree("main")], nextV());
    });
    setPanels([]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
      emit("worktree-activated", { type: "worktree-activated", worktreeId: "main", ...nextV() });
    });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("main");
  });

  it("keeps the ghost selection through a duplicate removal event", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
      emit("worktree-removed", removeEvent("wt-1"));
    });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(true);
  });

  it("ignores a stale same-epoch removal replay entirely", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1", restoreWorktreeId: "wt-1" });

    act(() => {
      // seq 0 is older than the snapshot's version — applyRemove rejects it,
      // and none of the selection/ghost side effects may run either.
      emit("worktree-removed", {
        type: "worktree-removed",
        worktreeId: "wt-1",
        epoch: TEST_EPOCH,
        seq: 0,
      });
    });

    expect(store.getState().worktrees.has("wt-1")).toBe(true);
    expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBe("wt-1");
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-1")).toBe(false);
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

  it("anchors the row to the live neighbour it sat above in the sidebar", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);
    recordSidebarWorktreeOrder(["wt-0", "wt-1", "wt-2"]);

    act(() => {
      emit("worktree-removed", removeEvent("wt-1"));
    });

    expect(
      useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1")?.pinnedBeforeWorktreeId
    ).toBe("wt-2");
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

describe("WorktreeStoreProvider — worktrees dropped without a removal event (#11911)", () => {
  it("adopts stranded panels onto a row when applySnapshot drops the worktree", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1"), makeWorktree("wt-2")], nextV());
    });
    setPanels([
      { id: "agent-a", worktreeId: "wt-2" },
      { id: "agent-b", worktreeId: "wt-2" },
      { id: "live", worktreeId: "wt-1" },
    ]);

    // An external `git worktree remove` reconciles the list before any per-id
    // event arrives, so the survivors would otherwise render nowhere while
    // their PTYs stayed alive and kept counting as needing input.
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });

    const row = useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-2");
    expect(row).toBeDefined();
    expect(row?.path).toBe("/repo/wt-2");
    expect(row?.title).toBe("branch-wt-2");
    // Panels survive: "worktree gone" and "PTY dead" stay independent (#11232).
    expect(usePanelStore.getState().panelsById["agent-a"]).toBeDefined();
    expect(usePanelStore.getState().panelsById["agent-b"]).toBeDefined();
  });

  it("records the adopted row unarmed so the sweep owns the countdown", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1"), makeWorktree("wt-2")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-2" }]);

    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });

    const row = useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-2");
    expect(row?.expiresAt).toBeNull();
    expect(row?.holdReason).toBeNull();
  });

  it("anchors the adopted row to the neighbour it sat above", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1"), makeWorktree("wt-2")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);
    recordSidebarWorktreeOrder(["wt-1", "wt-2"]);

    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-2")], nextV());
    });

    expect(
      useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1")?.pinnedBeforeWorktreeId
    ).toBe("wt-2");
  });

  it("adopts nothing when the incoming snapshot is empty", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1"), makeWorktree("wt-2")], nextV());
    });
    setPanels([
      { id: "agent-a", worktreeId: "wt-1" },
      { id: "agent-b", worktreeId: "wt-2" },
    ]);

    // A successful enumeration always reports the main worktree, so [] means
    // the host isn't ready — never that every worktree was deleted (#11235).
    act(() => {
      store.getState().applySnapshot([], nextV());
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.size).toBe(0);
  });

  it("adopts nothing for a dropped worktree that held no terminals", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1"), makeWorktree("wt-2")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);

    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-2")).toBe(false);
  });

  it("adopts nothing when the dropped worktree is the main one", async () => {
    const { store } = await renderProvider();
    act(() => {
      store
        .getState()
        .applySnapshot(
          [makeWorktree("wt-main", { isMainWorktree: true }), makeWorktree("wt-2")],
          nextV()
        );
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-main" }]);

    // Main can't be deleted, so its absence is a host rebuild mid-hydration.
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-2")], nextV());
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-main")).toBe(false);
  });

  it("records every field the event handler owns without the event firing", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1"), makeWorktree("wt-2")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-1" }]);
    recordSidebarWorktreeOrder(["wt-1", "wt-2"]);

    // `applyRemove` WITHOUT emitting the event: the backstop is then the only
    // author, which is also what happens for real — it runs synchronously
    // inside `applyRemove`, before the handler's own first-write-wins call.
    // Anything the backstop can't reconstruct is lost for good, so assert the
    // full record here rather than through the handler that used to own it.
    act(() => {
      store.getState().applyRemove("wt-1", nextV());
    });

    const row = useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1");
    expect(row?.title).toBe("branch-wt-1");
    expect(row?.path).toBe("/repo/wt-1");
    expect(row?.pinnedBeforeWorktreeId).toBe("wt-2");
    expect(row?.expiresAt).toBeNull();
  });

  it("adopts each dropped worktree independently, skipping trash-only ones", async () => {
    const { store } = await renderProvider();
    act(() => {
      store
        .getState()
        .applySnapshot(
          [
            makeWorktree("wt-live"),
            makeWorktree("wt-a"),
            makeWorktree("wt-b"),
            makeWorktree("wt-trashed"),
          ],
          nextV()
        );
    });
    setPanels([
      { id: "agent-a", worktreeId: "wt-a" },
      { id: "agent-b", worktreeId: "wt-b" },
      { id: "gone", worktreeId: "wt-trashed", location: "trash" },
      { id: "live", worktreeId: "wt-live" },
    ]);

    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-live")], nextV());
    });

    // Compared as a set: one id failing to adopt must not be masked by another
    // succeeding, and insertion order is not part of the contract.
    expect([...useWorktreeSelectionStore.getState().deletedWorktrees.keys()].sort()).toEqual([
      "wt-a",
      "wt-b",
    ]);
  });

  it("still sees a removal that a not-ready snapshot straddled", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-main"), makeWorktree("wt-2")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-2" }]);

    // `[main, wt-2] → [] → [main]`. The empty read is the host not being ready,
    // and it replaces the live map — so a diff against the previous state alone
    // would never observe that wt-2 left, and its panels would stay stranded.
    act(() => {
      store.getState().applySnapshot([], nextV());
    });
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.size).toBe(0);

    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-main")], nextV());
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("wt-2")).toBe(true);
  });

  it("withdraws the row when a live worktree turns up carrying its handle", async () => {
    const { store } = await renderProvider();
    act(() => {
      store
        .getState()
        .applySnapshot(
          [makeWorktree("wt-main"), makeWorktree("/old/feature", { gitDir: "/repo/.git/wt/f" })],
          nextV()
        );
    });
    setPanels([{ id: "agent-a", worktreeId: "/old/feature" }]);

    // Production ordering for a `git worktree move`: the host tears the old
    // monitor down and announces the removal BEFORE the replacement monitor
    // reports, so the adoption-time handle check has nothing to match against
    // and a row is recorded.
    act(() => {
      store.getState().applyRemove("/old/feature", nextV());
    });
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("/old/feature")).toBe(true);

    // The replacement arrives a moment later under a new path-derived id but
    // the same admin-dir handle. The row has to be withdrawn — otherwise it
    // hands still-live agents to the cleanup sweep 60 seconds on.
    act(() => {
      store
        .getState()
        .applyUpdate(makeWorktree("/new/feature", { gitDir: "/repo/.git/wt/f" }), nextV());
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("/old/feature")).toBe(false);
  });

  it("keeps a row whose handle no live worktree claims", async () => {
    const { store } = await renderProvider();
    act(() => {
      store
        .getState()
        .applySnapshot(
          [makeWorktree("wt-main"), makeWorktree("/old/feature", { gitDir: "/repo/.git/wt/f" })],
          nextV()
        );
    });
    setPanels([{ id: "agent-a", worktreeId: "/old/feature" }]);

    act(() => {
      store.getState().applyRemove("/old/feature", nextV());
    });
    act(() => {
      store
        .getState()
        .applyUpdate(makeWorktree("/other", { gitDir: "/repo/.git/wt/other" }), nextV());
    });

    // A genuine deletion must survive the handle check, or nothing is ever
    // cleaned up.
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("/old/feature")).toBe(true);
  });

  it("does not ghost a worktree that only moved", async () => {
    const { store } = await renderProvider();
    act(() => {
      store
        .getState()
        .applySnapshot(
          [makeWorktree("wt-main"), makeWorktree("/old/feature", { gitDir: "/repo/.git/wt/f" })],
          nextV()
        );
    });
    setPanels([{ id: "agent-a", worktreeId: "/old/feature" }]);

    // A `git worktree move` re-mints the path-derived id while keeping the
    // stable admin-dir handle. Ghosting the old id would hand a LIVE
    // worktree's agents to the cleanup sweep, which trashes and kills them.
    act(() => {
      store
        .getState()
        .applySnapshot(
          [makeWorktree("wt-main"), makeWorktree("/new/feature", { gitDir: "/repo/.git/wt/f" })],
          nextV()
        );
    });

    expect(useWorktreeSelectionStore.getState().deletedWorktrees.has("/old/feature")).toBe(false);
  });

  it("demotes an adopted worktree from the durable restore target", async () => {
    const { store } = await renderProvider();
    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1"), makeWorktree("wt-2")], nextV());
    });
    setPanels([{ id: "agent-a", worktreeId: "wt-2" }]);
    act(() => {
      useWorktreeSelectionStore.getState().selectWorktree("wt-2");
    });
    expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBe("wt-2");

    act(() => {
      store.getState().applySnapshot([makeWorktree("wt-1")], nextV());
    });

    // A deleted id resolves to nothing after a restart, so it must not persist
    // as the restore point even while its ghost row is still on screen.
    expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBeNull();
  });
});
