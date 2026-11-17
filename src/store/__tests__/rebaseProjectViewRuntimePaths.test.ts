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
    mruList: [],
    preMaximizeLayout: null,
  });
  selection = makeFakeStore<any>({
    activeWorktreeId: OLD,
    restoreWorktreeId: OLD,
    focusedWorktreeId: OLD,
    expandedWorktrees: new Set<string>(),
    expandedTerminals: new Set<string>(),
    lastFocusedTerminalByWorktree: new Map<string, string>(),
    maximizeByWorktree: new Map(),
  });
  holders.panels = panels;
  holders.selection = selection;
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
      mruList: ["worktree:/somewhere/else", "terminal:a"],
      preMaximizeLayout: { gridCols: 2, gridItemCount: 3, worktreeId: "/somewhere/else" },
    });
    const before = panels.getState();
    rebaseProjectViewRuntimePaths(OLD, NEW);
    expect(panels.getState()).toBe(before);
  });

  it("rebases the durable restore selection and the focused worktree (#17184)", () => {
    rebaseProjectViewRuntimePaths(OLD, NEW);
    const state = selection.getState();
    expect(state.restoreWorktreeId).toBe(NEW);
    expect(state.focusedWorktreeId).toBe(NEW);
  });

  it("re-keys per-worktree selection state under the new root (#17184)", () => {
    const LINKED = "/vol/wts/feature";
    const maximize = (worktreeId: string) => ({
      maximizedId: "main1",
      maximizeTarget: { type: "panel", id: "main1" },
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
        [OLD, maximize(OLD)],
        [LINKED, maximize(LINKED)],
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
    expect(state.maximizeByWorktree.has(OLD)).toBe(false);
    expect(state.maximizeByWorktree.get(NEW).preMaximizeLayout.worktreeId).toBe(NEW);
    expect(state.maximizeByWorktree.get(LINKED)).toEqual(maximize(LINKED));
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
