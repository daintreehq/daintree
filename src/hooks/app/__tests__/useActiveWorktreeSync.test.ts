// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActiveWorktreeSync } from "../useActiveWorktreeSync";

const mocks = vi.hoisted(() => ({
  useWorktrees: vi.fn(),
  selectionState: {
    activeWorktreeId: null as string | null,
    selectWorktree: vi.fn(),
    // Only unread today because every active id here is also a live worktree,
    // which short-circuits the `||`. One absent-worktree fixture away from a
    // TypeError without it.
    deletedWorktrees: new Map<string, unknown>(),
  },
  projectState: {
    currentProject: null as { id: string; path: string } | null,
  },
  scratchState: {
    currentScratch: null as { id: string; path: string } | null,
  },
  homeDir: { homeDir: "/home/user" as string | null },
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
  useHomeDir: () => mocks.homeDir,
}));

// The active-worktree sync effect pushes the selection over the worktree port
// whenever a project and a worktree are both set. jsdom aliases globalThis to
// window, so stubbing the global satisfies the hook's `window.electron` read
// without an unsafe cast.
vi.stubGlobal("electron", {
  worktreePort: { request: vi.fn(() => Promise.resolve()) },
});

// `useWorktrees` is mocked, so the hook reads this shape straight through — no
// cast to the full WorktreeState is needed for the fields under test.
const worktree = {
  id: "wt-1",
  name: "feature",
  path: "/repo-worktrees/feature",
  isMainWorktree: false,
};

const cwdOf = () => renderHook(() => useActiveWorktreeSync()).result.current.defaultTerminalCwd;

/**
 * The workspace is a project OR a scratch (#11076), and `terminal.new` spawns
 * into whatever this resolves to — a missed branch strands the terminal in the
 * home dir rather than the workspace the user is looking at.
 */
describe("useActiveWorktreeSync defaultTerminalCwd", () => {
  beforeEach(() => {
    mocks.selectionState.activeWorktreeId = worktree.id;
    mocks.selectionState.deletedWorktrees = new Map();
    mocks.projectState.currentProject = null;
    mocks.scratchState.currentScratch = null;
    mocks.homeDir.homeDir = "/home/user";
    mocks.useWorktrees.mockReturnValue({ worktrees: [worktree], isInitialized: true });
  });

  it("prefers the active worktree over every other workspace path", () => {
    mocks.projectState.currentProject = { id: "p1", path: "/repo" };
    mocks.scratchState.currentScratch = { id: "s1", path: "/scratches/s1" };

    expect(cwdOf()).toBe(worktree.path);
  });

  it("falls back to the project when no worktree is selected", () => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.projectState.currentProject = { id: "p1", path: "/repo" };

    expect(cwdOf()).toBe("/repo");
  });

  it("resolves to the scratch when it is the only active workspace", () => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.scratchState.currentScratch = { id: "s1", path: "/scratches/s1" };

    expect(cwdOf()).toBe("/scratches/s1");
  });

  it("resolves to the scratch before the worktree snapshot has initialized", () => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.scratchState.currentScratch = { id: "s1", path: "/scratches/s1" };
    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: false });

    expect(cwdOf()).toBe("/scratches/s1");
  });

  it("prefers the project over the scratch in a transient both-set state", () => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.projectState.currentProject = { id: "p1", path: "/repo" };
    mocks.scratchState.currentScratch = { id: "s1", path: "/scratches/s1" };

    expect(cwdOf()).toBe("/repo");
  });

  it("falls back to the home dir when no workspace is active", () => {
    mocks.selectionState.activeWorktreeId = null;

    expect(cwdOf()).toBe("/home/user");
  });

  it("never yields an empty cwd while a scratch is active but the home dir is unknown", () => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.scratchState.currentScratch = { id: "s1", path: "/scratches/s1" };
    mocks.homeDir.homeDir = null;

    expect(cwdOf()).toBe("/scratches/s1");
  });

  // Issue #4254 — a selection that predates the authoritative snapshot must not
  // decide the cwd, or terminals spawn in a worktree that may not be current.
  it("withholds a matching worktree until the snapshot is authoritative", () => {
    mocks.projectState.currentProject = { id: "p1", path: "/repo" };
    mocks.useWorktrees.mockReturnValue({ worktrees: [worktree], isInitialized: false });

    expect(cwdOf()).toBe("/repo");
  });

  it("falls back to the home dir before initialization when no workspace is active", () => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: false });

    expect(cwdOf()).toBe("/home/user");
  });

  describe("recomputes when its inputs change", () => {
    it("adopts the worktree once the snapshot becomes authoritative", () => {
      mocks.projectState.currentProject = { id: "p1", path: "/repo" };
      mocks.useWorktrees.mockReturnValue({ worktrees: [worktree], isInitialized: false });

      const { result, rerender } = renderHook(() => useActiveWorktreeSync());
      expect(result.current.defaultTerminalCwd).toBe("/repo");

      mocks.useWorktrees.mockReturnValue({ worktrees: [worktree], isInitialized: true });
      rerender();

      expect(result.current.defaultTerminalCwd).toBe(worktree.path);
    });

    it("adopts the home dir once it resolves", () => {
      mocks.selectionState.activeWorktreeId = null;
      mocks.homeDir.homeDir = null;

      const { result, rerender } = renderHook(() => useActiveWorktreeSync());
      expect(result.current.defaultTerminalCwd).toBe("");

      mocks.homeDir.homeDir = "/home/user";
      rerender();

      expect(result.current.defaultTerminalCwd).toBe("/home/user");
    });

    it("adopts a scratch the moment one becomes active", () => {
      mocks.selectionState.activeWorktreeId = null;

      const { result, rerender } = renderHook(() => useActiveWorktreeSync());
      expect(result.current.defaultTerminalCwd).toBe("/home/user");

      mocks.scratchState.currentScratch = { id: "s1", path: "/scratches/s1" };
      rerender();

      expect(result.current.defaultTerminalCwd).toBe("/scratches/s1");
    });
  });
});
