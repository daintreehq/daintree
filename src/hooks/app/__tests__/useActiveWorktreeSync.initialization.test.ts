// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@shared/types";
import { useActiveWorktreeSync } from "../useActiveWorktreeSync";

const mocks = vi.hoisted(() => ({
  useWorktrees: vi.fn(),
  selectionState: {
    activeWorktreeId: null as string | null,
    selectWorktree: vi.fn(),
    setActiveWorktree: vi.fn(),
    deletedWorktrees: new Map<string, unknown>(),
  },
  projectState: {
    currentProject: { id: "project-1", path: "/repo" } as { id: string; path: string } | null,
  },
  scratchState: {
    currentScratch: null as { id: string; path: string } | null,
  },
}));

vi.mock("@/hooks", () => ({
  useWorktrees: () => mocks.useWorktrees(),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (state: typeof mocks.selectionState) => unknown): unknown =>
    selector(mocks.selectionState),
}));

vi.mock("@/store", () => ({
  useProjectStore: (selector: (state: typeof mocks.projectState) => unknown): unknown =>
    selector(mocks.projectState),
}));

vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (selector: (state: typeof mocks.scratchState) => unknown): unknown =>
    selector(mocks.scratchState),
}));

vi.mock("@/hooks/app/useHomeDir", () => ({
  useHomeDir: () => ({ homeDir: "/home" }),
}));

const featureWorktree = {
  id: "feature",
  name: "feature/test-branch",
  path: "/repo-worktrees/feature",
  isMainWorktree: false,
} as WorktreeState;

const mainWorktree = {
  id: "main",
  name: "repo",
  path: "/repo",
  isMainWorktree: true,
} as WorktreeState;

describe("useActiveWorktreeSync initialization", () => {
  beforeEach(() => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.selectionState.selectWorktree.mockReset();
    mocks.selectionState.setActiveWorktree.mockReset();
    mocks.selectionState.deletedWorktrees = new Map();
    mocks.useWorktrees.mockReset();
    mocks.projectState.currentProject = { id: "project-1", path: "/repo" };
    mocks.scratchState.currentScratch = null;
  });

  it("waits for the authoritative snapshot before selecting a fallback worktree", () => {
    mocks.useWorktrees.mockReturnValue({
      worktrees: [featureWorktree],
      isInitialized: false,
    });

    const { rerender } = renderHook(() => useActiveWorktreeSync());

    expect(mocks.selectionState.selectWorktree).not.toHaveBeenCalled();

    mocks.useWorktrees.mockReturnValue({
      worktrees: [mainWorktree, featureWorktree],
      isInitialized: true,
    });
    rerender();

    expect(mocks.selectionState.selectWorktree).toHaveBeenCalledOnce();
    expect(mocks.selectionState.selectWorktree).toHaveBeenCalledWith(mainWorktree.id);
  });

  // The rescue-follow (#11273) selects the destination after the row is pruned
  // but before this effect runs, so it never reaches the branch below. Every
  // other way a deleted row can die — last terminal closed or trashed, row
  // dismissed, auto-cleanup — still lands here. The hook cannot tell those
  // causes apart, so one case covers all of them.
  it("holds the selection on a deleted row and snaps to main only once it is gone", () => {
    mocks.selectionState.activeWorktreeId = "ghost";
    mocks.selectionState.deletedWorktrees = new Map([["ghost", {}]]);
    // Feature first, so the assertion proves the fallback picks the designated
    // main worktree rather than whatever happens to sit at index zero.
    mocks.useWorktrees.mockReturnValue({
      worktrees: [featureWorktree, mainWorktree],
      isInitialized: true,
    });

    const { rerender } = renderHook(() => useActiveWorktreeSync());

    expect(mocks.selectionState.selectWorktree).not.toHaveBeenCalled();

    mocks.selectionState.deletedWorktrees = new Map();
    rerender();

    expect(mocks.selectionState.selectWorktree).toHaveBeenCalledExactlyOnceWith(mainWorktree.id);
  });
});

/**
 * A worktree-less workspace (a plain folder, or a repo opened without one) gets
 * an authoritative empty snapshot, not a pending one. Before #11654 the effect
 * bailed on the empty list and left whatever id the previous project had
 * selected, which then failed every agent launch against a worktree that does
 * not exist here.
 */
describe("useActiveWorktreeSync on a worktree-less workspace", () => {
  beforeEach(() => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.selectionState.selectWorktree.mockReset();
    mocks.selectionState.setActiveWorktree.mockReset();
    mocks.selectionState.deletedWorktrees = new Map();
    mocks.useWorktrees.mockReset();
    mocks.projectState.currentProject = { id: "project-1", path: "/plain-folder" };
    mocks.scratchState.currentScratch = null;
  });

  it("clears an inherited selection only once the empty snapshot is authoritative", () => {
    mocks.selectionState.activeWorktreeId = featureWorktree.id;
    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: false });

    const { rerender } = renderHook(() => useActiveWorktreeSync());

    // Empty-and-loading is indistinguishable from empty-and-real without the
    // flag, so nothing may be cleared yet.
    expect(mocks.selectionState.setActiveWorktree).not.toHaveBeenCalled();

    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: true });
    rerender();

    expect(mocks.selectionState.setActiveWorktree).toHaveBeenCalledExactlyOnceWith(null);
    // There is no worktree to snap to — reaching for one would read past the
    // end of the empty list.
    expect(mocks.selectionState.selectWorktree).not.toHaveBeenCalled();
  });

  it("leaves an already-cleared selection alone across repeated snapshots", () => {
    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: true });

    const { rerender } = renderHook(() => useActiveWorktreeSync());
    // A fresh array each poll, as the store hands out: the effect re-runs even
    // though nothing about the workspace changed.
    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: true });
    rerender();

    // setActiveWorktree persists and re-runs terminal policy on every call, so
    // clearing a selection that is already null is a write for no reason.
    expect(mocks.selectionState.setActiveWorktree).not.toHaveBeenCalled();
  });

  it("keeps a deleted row selected when it outlives the last live worktree", () => {
    // pruneDeletedWorktrees retains a row while it still owns a terminal, so a
    // deleted row can be the active selection with nothing live left. The user
    // is looking at its surviving terminals.
    mocks.selectionState.activeWorktreeId = "ghost";
    mocks.selectionState.deletedWorktrees = new Map([["ghost", {}]]);
    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: true });

    renderHook(() => useActiveWorktreeSync());

    expect(mocks.selectionState.setActiveWorktree).not.toHaveBeenCalled();
    expect(mocks.selectionState.selectWorktree).not.toHaveBeenCalled();
  });
});
