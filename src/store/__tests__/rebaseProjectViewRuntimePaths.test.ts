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
const holders = vi.hoisted(() => ({ panels: null as any, selection: null as any }));

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
  });
  selection = makeFakeStore<any>({ activeWorktreeId: OLD });
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
      panelsById: { a: { kind: "terminal", cwd: "/somewhere/else", worktreeId: "/somewhere/else" } },
      panelIds: ["a"],
      panelIdsByWorktreeId: { "/somewhere/else": ["a"] },
      tabGroups: new Map(),
    });
    const before = panels.getState();
    rebaseProjectViewRuntimePaths(OLD, NEW);
    expect(panels.getState()).toBe(before);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
