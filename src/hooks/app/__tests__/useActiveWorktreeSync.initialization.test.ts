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
  },
  projectState: {
    currentProject: { id: "project-1", path: "/repo" },
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
    mocks.useWorktrees.mockReset();
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
});
