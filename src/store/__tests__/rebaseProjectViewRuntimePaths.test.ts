import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal fake zustand-shaped stores so the rebase logic is tested without
// pulling in the heavy real panel/worktree slice systems.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface FakeStore<T> {
  getState: () => T;
  setState: (partial: Partial<T> | ((s: T) => Partial<T>)) => void;
  _reset: (next: T) => void;
}

function makeFakeStore<T extends object>(initial: T): FakeStore<T> {
  let state = initial;
  return {
    getState: () => state,
    setState: (partial) => {
      const next = typeof partial === "function" ? partial(state) : partial;
      // Mirror zustand: an updater that returns the SAME state ref is a no-op.
      if (next === state) return;
      state = { ...state, ...next };
    },
    _reset: (next) => {
      state = next;
    },
  };
}

// Mutable holder the mocks delegate to. The exported store objects are STABLE
// (so `import { usePanelStore }` binds once); each call reads the current fake.
const holders: { panels: any; selection: any } = vi.hoisted(() => ({
  panels: null,
  selection: null,
}));
const persistMruListMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../panelStore", () => ({
  usePanelStore: {
    getState: () => holders.panels.getState(),
    setState: (p: any) => holders.panels.setState(p),
  },
}));
vi.mock("../worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => holders.selection.getState(),
    setState: (p: any) => holders.selection.setState(p),
  },
  persistMruList: persistMruListMock,
}));

import { rebaseProjectViewRuntimePaths } from "../rebaseProjectViewRuntimePaths";

const OLD = "/vol/projects/proj";
const NEW = "/vol/projects/proj-renamed";

let panels: FakeStore<any>;
let selection: FakeStore<any>;

beforeEach(() => {
  panels = makeFakeStore<any>({
    panelsById: {
      main1: { kind: "terminal", cwd: `${OLD}/pkg`, worktreeId: OLD },
      main2: { kind: "file", filePath: `${OLD}/README.md`, worktreeId: OLD },
      // A linked worktree in a SEPARATE location — must be left untouched.
      linked1: { kind: "terminal", cwd: "/vol/wts/feature/x", worktreeId: "/vol/wts/feature" },
    },
    panelIds: ["main1", "main2", "linked1"],
    panelIdsByWorktreeId: {
      [OLD]: ["main1", "main2"],
      "/vol/wts/feature": ["linked1"],
    },
    tabGroups: new Map([["g1", { id: "g1", worktreeId: OLD }]]),
    trashedTerminals: new Map(),
    backgroundedTerminals: new Map(),
    mruList: [],
    preMaximizeLayout: null,
  });
  selection = makeFakeStore<any>({
    activeWorktreeId: OLD,
    restoreWorktreeId: OLD,
    focusedWorktreeId: OLD,
    pendingWorktreeId: null,
    _previousActiveWorktreeId: null,
    _previousRestoreWorktreeId: null,
    crossDiffDialog: { isOpen: false, initialWorktreeId: null },
    expandedWorktrees: new Set<string>(),
    expandedTerminals: new Set<string>(),
    lastFocusedTerminalByWorktree: new Map<string, string>(),
    maximizeByWorktree: new Map(),
  });
  holders.panels = panels;
  holders.selection = selection;
  persistMruListMock.mockClear();
});

describe("rebaseProjectViewRuntimePaths", () => {
  it("rebases main-worktree panel cwd/worktreeId/filePath to the new root", () => {
    rebaseProjectViewRuntimePaths(OLD, NEW);
    const state = panels.getState();
    expect(state.panelsById.main1).toMatchObject({ cwd: `${NEW}/pkg`, worktreeId: NEW });
    expect(state.panelsById.main2).toMatchObject({ filePath: `${NEW}/README.md`, worktreeId: NEW });
  });

  it("leaves panels on a linked worktree in a separate location untouched", () => {
    rebaseProjectViewRuntimePaths(OLD, NEW);
    const state = panels.getState();
    expect(state.panelsById.linked1).toEqual({
      kind: "terminal",
      cwd: "/vol/wts/feature/x",
      worktreeId: "/vol/wts/feature",
    });
  });

  it("rebuilds the per-worktree index under the new worktree id, preserving order", () => {
    rebaseProjectViewRuntimePaths(OLD, NEW);
    const state = panels.getState();
    expect(state.panelIdsByWorktreeId[NEW]).toEqual(["main1", "main2"]);
    expect(state.panelIdsByWorktreeId[OLD]).toBeUndefined();
    expect(state.panelIdsByWorktreeId["/vol/wts/feature"]).toEqual(["linked1"]);
  });

  it("rebases tab-group worktree bindings", () => {
    rebaseProjectViewRuntimePaths(OLD, NEW);
    expect(panels.getState().tabGroups.get("g1")).toMatchObject({ worktreeId: NEW });
  });

  it("rebases the active worktree selection id", () => {
    rebaseProjectViewRuntimePaths(OLD, NEW);
    expect(selection.getState().activeWorktreeId).toBe(NEW);
  });

  it("is a no-op for the panel store when nothing lives under the old root", () => {
    panels._reset({
      panelsById: {
        a: { kind: "terminal", cwd: "/somewhere/else", worktreeId: "/somewhere/else" },
      },
      panelIds: ["a"],
      panelIdsByWorktreeId: { "/somewhere/else": ["a"] },
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      mruList: ["worktree:/somewhere/else", "terminal:a"],
      preMaximizeLayout: { gridCols: 2, gridItemCount: 3, worktreeId: "/somewhere/else" },
    });
    const before = panels.getState();
    rebaseProjectViewRuntimePaths(OLD, NEW);
    expect(panels.getState()).toBe(before);
    expect(persistMruListMock).not.toHaveBeenCalled();
  });

  it("leaves the selection store untouched when none of its ids live under the old root", () => {
    selection._reset({
      ...selection.getState(),
      activeWorktreeId: "/vol/projects/proj-copy",
      restoreWorktreeId: "/vol/projects/proj-copy",
      focusedWorktreeId: null,
    });
    const before = selection.getState();
    rebaseProjectViewRuntimePaths(OLD, NEW);
    expect(selection.getState()).toBe(before);
  });

  it("rebases the durable restore selection and the focused worktree (#17184)", () => {
    selection._reset({
      ...selection.getState(),
      focusedWorktreeId: `${OLD}/.worktrees/focus`,
    });
    rebaseProjectViewRuntimePaths(OLD, NEW);
    const state = selection.getState();
    expect(state.restoreWorktreeId).toBe(NEW);
    expect(state.focusedWorktreeId).toBe(`${NEW}/.worktrees/focus`);
  });

  it("keeps an incidental active selection distinct from the durable restore one", () => {
    const LINKED = "/vol/wts/feature";
    selection._reset({
      ...selection.getState(),
      activeWorktreeId: LINKED,
      restoreWorktreeId: `${OLD}/.worktrees/fix`,
    });
    rebaseProjectViewRuntimePaths(OLD, NEW);
    const state = selection.getState();
    expect(state.activeWorktreeId).toBe(LINKED);
    expect(state.restoreWorktreeId).toBe(`${NEW}/.worktrees/fix`);
  });

  it("rebases pending, fleet-parked and cross-diff worktree ids (#17184)", () => {
    selection._reset({
      ...selection.getState(),
      activeWorktreeId: "/vol/wts/feature",
      pendingWorktreeId: `${OLD}/.worktrees/pending`,
      _previousActiveWorktreeId: `${OLD}/.worktrees/parked`,
      _previousRestoreWorktreeId: OLD,
      crossDiffDialog: { isOpen: true, initialWorktreeId: `${OLD}/.worktrees/diff` },
    });
    rebaseProjectViewRuntimePaths(OLD, NEW);
    const state = selection.getState();
    expect(state.activeWorktreeId).toBe("/vol/wts/feature");
    expect(state.pendingWorktreeId).toBe(`${NEW}/.worktrees/pending`);
    expect(state._previousActiveWorktreeId).toBe(`${NEW}/.worktrees/parked`);
    expect(state._previousRestoreWorktreeId).toBe(NEW);
    expect(state.crossDiffDialog).toEqual({
      isOpen: true,
      initialWorktreeId: `${NEW}/.worktrees/diff`,
    });
  });

  it("re-keys per-worktree selection state under the new root (#17184)", () => {
    const LINKED = "/vol/wts/feature";
    const maximize = (panelId: string, worktreeId: string) => ({
      maximizedId: panelId,
      maximizeTarget: { type: "group", id: `group-${panelId}` },
      preMaximizeLayout: { gridCols: 3, gridItemCount: 4, worktreeId },
    });
    selection._reset({
      ...selection.getState(),
      expandedWorktrees: new Set([OLD, LINKED]),
      expandedTerminals: new Set([OLD]),
      lastFocusedTerminalByWorktree: new Map([
        [OLD, "main1"],
        [LINKED, "linked1"],
      ]),
      maximizeByWorktree: new Map([
        [OLD, maximize("main1", OLD)],
        [LINKED, maximize("linked1", LINKED)],
      ]),
    });

    rebaseProjectViewRuntimePaths(OLD, NEW);
    const state = selection.getState();

    expect([...state.expandedWorktrees]).toEqual([NEW, LINKED]);
    expect([...state.expandedTerminals]).toEqual([NEW]);
    expect([...state.lastFocusedTerminalByWorktree]).toEqual([
      [NEW, "main1"],
      [LINKED, "linked1"],
    ]);
    expect([...state.maximizeByWorktree]).toEqual([
      [NEW, maximize("main1", NEW)],
      [LINKED, maximize("linked1", LINKED)],
    ]);
  });

  it("lets a moved entry win over a leftover already keyed by the new root", () => {
    selection._reset({
      ...selection.getState(),
      lastFocusedTerminalByWorktree: new Map([
        [NEW, "stale"],
        [OLD, "main1"],
      ]),
      maximizeByWorktree: new Map([
        [
          OLD,
          {
            maximizedId: "main1",
            maximizeTarget: { type: "panel", id: "main1" },
            preMaximizeLayout: null,
          },
        ],
        [
          NEW,
          {
            maximizedId: "stale",
            maximizeTarget: { type: "panel", id: "stale" },
            preMaximizeLayout: null,
          },
        ],
      ]),
    });
    rebaseProjectViewRuntimePaths(OLD, NEW);
    const state = selection.getState();
    expect([...state.lastFocusedTerminalByWorktree]).toEqual([[NEW, "main1"]]);
    expect([...state.maximizeByWorktree.keys()]).toEqual([NEW]);
    expect(state.maximizeByWorktree.get(NEW).maximizedId).toBe("main1");
  });

  it("keeps unchanged selection collections by identity", () => {
    const LINKED = "/vol/wts/feature";
    selection._reset({
      ...selection.getState(),
      expandedWorktrees: new Set([LINKED]),
      lastFocusedTerminalByWorktree: new Map([[LINKED, "linked1"]]),
    });
    const before = selection.getState();
    rebaseProjectViewRuntimePaths(OLD, NEW);
    const state = selection.getState();
    expect(state.restoreWorktreeId).toBe(NEW);
    expect(state.expandedWorktrees).toBe(before.expandedWorktrees);
    expect(state.lastFocusedTerminalByWorktree).toBe(before.lastFocusedTerminalByWorktree);
    expect(state.maximizeByWorktree).toBe(before.maximizeByWorktree);
    expect(state.crossDiffDialog).toBe(before.crossDiffDialog);
  });

  it("rebases worktree MRU entries and leaves terminal entries alone (#17184)", () => {
    panels._reset({
      ...panels.getState(),
      mruList: [`worktree:${OLD}`, "terminal:main1", "worktree:/vol/wts/feature"],
    });
    rebaseProjectViewRuntimePaths(OLD, NEW);
    expect(panels.getState().mruList).toEqual([
      `worktree:${NEW}`,
      "terminal:main1",
      "worktree:/vol/wts/feature",
    ]);
    expect(persistMruListMock).toHaveBeenCalledTimes(1);
    expect(persistMruListMock).toHaveBeenCalledWith(panels.getState().mruList);
  });

  it("does not write the MRU when no entry moved", () => {
    panels._reset({ ...panels.getState(), mruList: ["terminal:main1", "worktree:/vol/wts/x"] });
    rebaseProjectViewRuntimePaths(OLD, NEW);
    expect(persistMruListMock).not.toHaveBeenCalled();
  });

  it("rebases the worktree a panel waits to be docked under and a move notice's destination", () => {
    panels._reset({
      ...panels.getState(),
      panelsById: {
        ...panels.getState().panelsById,
        plugin1: {
          kind: "plugin-x",
          worktreeId: "/vol/wts/feature",
          pendingDockWorktreeId: `${OLD}/.worktrees/dock`,
        },
        scoped: { kind: "plugin-x", pendingDockWorktreeId: null },
        main1: {
          kind: "terminal",
          cwd: `${OLD}/pkg`,
          worktreeId: "/vol/wts/feature",
          worktreeMoveNotice: {
            destinationWorktreeId: `${OLD}/.worktrees/dest`,
            deliveryFailed: true,
          },
        },
      },
    });
    rebaseProjectViewRuntimePaths(OLD, NEW);
    const state = panels.getState();
    expect(state.panelsById.plugin1.pendingDockWorktreeId).toBe(`${NEW}/.worktrees/dock`);
    expect(state.panelsById.plugin1.worktreeId).toBe("/vol/wts/feature");
    expect(state.panelsById.scoped.pendingDockWorktreeId).toBeNull();
    expect(state.panelsById.main1.worktreeMoveNotice).toEqual({
      destinationWorktreeId: `${NEW}/.worktrees/dest`,
      deliveryFailed: true,
    });
  });

  it("rebases the group a trashed or backgrounded panel restores into, keeping panel-id keys", () => {
    const meta = (worktreeId: string | null) => ({
      panelIds: ["main1", "main2"],
      activeTabId: "main2",
      location: "dock",
      worktreeId,
    });
    panels._reset({
      ...panels.getState(),
      trashedTerminals: new Map([
        [
          "main1",
          { id: "main1", expiresAt: 1, originalLocation: "grid", groupMetadata: meta(OLD) },
        ],
        ["solo", { id: "solo", expiresAt: 1, originalLocation: "dock" }],
      ]),
      backgroundedTerminals: new Map([
        ["main2", { id: "main2", originalLocation: "grid", groupMetadata: meta(OLD) }],
        ["x", { id: "x", originalLocation: "grid", groupMetadata: meta(null) }],
      ]),
    });
    rebaseProjectViewRuntimePaths(OLD, NEW);
    const state = panels.getState();
    expect([...state.trashedTerminals]).toEqual([
      ["main1", { id: "main1", expiresAt: 1, originalLocation: "grid", groupMetadata: meta(NEW) }],
      ["solo", { id: "solo", expiresAt: 1, originalLocation: "dock" }],
    ]);
    expect([...state.backgroundedTerminals]).toEqual([
      ["main2", { id: "main2", originalLocation: "grid", groupMetadata: meta(NEW) }],
      ["x", { id: "x", originalLocation: "grid", groupMetadata: meta(null) }],
    ]);
  });

  it("rebases the live maximize's layout binding (#17184)", () => {
    panels._reset({
      ...panels.getState(),
      preMaximizeLayout: { gridCols: 2, gridItemCount: 5, worktreeId: OLD },
    });
    rebaseProjectViewRuntimePaths(OLD, NEW);
    expect(panels.getState().preMaximizeLayout).toEqual({
      gridCols: 2,
      gridItemCount: 5,
      worktreeId: NEW,
    });
  });

  it("rebases a file panel's pinned containment root (#17184)", () => {
    panels._reset({
      ...panels.getState(),
      panelsById: {
        ...panels.getState().panelsById,
        main2: {
          kind: "file",
          filePath: `${OLD}/docs/guide.md`,
          worktreeId: OLD,
          fileContainmentRoot: `${OLD}/docs`,
        },
      },
    });
    rebaseProjectViewRuntimePaths(OLD, NEW);
    expect(panels.getState().panelsById.main2).toMatchObject({
      filePath: `${NEW}/docs/guide.md`,
      fileContainmentRoot: `${NEW}/docs`,
    });
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
