/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { WorktreeState } from "@/types";

// Typed explicitly so asserting on `toHaveBeenCalledWith` needs no cast.
const dispatch = vi.fn<(id: string, args: unknown, opts: unknown) => Promise<void>>(() =>
  Promise.resolve()
);

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (id: string, args: unknown, opts: unknown) => dispatch(id, args, opts),
  },
}));

vi.mock("@/lib/accessibility", () => ({
  closeAndAnnounce: (clear: () => void) => clear(),
}));

const runRecipeWithResults = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => Promise.resolve({ spawned: [], failed: [] }))
);

// Self-contained factory apart from the hoisted spy, so vitest's mock hoisting
// stays happy. The hook reads `runRecipeWithResults` via the selector at render.
vi.mock("@/store/recipeStore", () => {
  const state = {
    runRecipeWithResults: (...args: unknown[]) => runRecipeWithResults(...args),
    getRecipeById: () => undefined,
    currentProjectId: null,
  };
  const useRecipeStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state }
  );
  return { useRecipeStore };
});

vi.mock("@/components/ui/menu-source", () => ({
  useMenuActionSource: () => "user",
}));

import { useWorktreeActions } from "../useWorktreeActions";

function makeWorktree(overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    id: "wt-1",
    worktreeId: "wt-1",
    path: "/test/wt-1",
    name: "test-branch",
    branch: "feature/test",
    issueTitle: "Fix the thing",
    isCurrent: false,
    isMainWorktree: false,
    lastActivityTimestamp: 0,
    worktreeChanges: null,
    ...overrides,
  };
}

function renderActions(overrides: Partial<WorktreeState> = {}) {
  return renderHook(() =>
    useWorktreeActions({
      worktree: makeWorktree(overrides),
    })
  );
}

beforeEach(() => {
  dispatch.mockClear();
  runRecipeWithResults.mockClear();
});

describe("useWorktreeActions — running a recipe from the card (#16381)", () => {
  it("names a provider-served issue by its key, with its title", async () => {
    const { result } = renderActions({
      issueNumber: 4019283746519283,
      issueTitle: "Crash on save",
      issueProviderId: "beads",
      issueKey: "bd-a1b2",
    });

    await act(() => result.current.handleRunRecipe("recipe-1"));

    expect(runRecipeWithResults).toHaveBeenCalledWith("recipe-1", "/test/wt-1", "wt-1", {
      issueNumber: 4019283746519283,
      issueKey: "bd-a1b2",
      issueTitle: "Crash on save",
      prNumber: undefined,
      worktreePath: "/test/wt-1",
      branchName: "feature/test",
    });
  });

  it("runs with the issue the worktree is linked to now, not at first render", async () => {
    const { result, rerender } = renderHook(
      ({ worktree }: { worktree: WorktreeState }) => useWorktreeActions({ worktree }),
      { initialProps: { worktree: makeWorktree({ issueNumber: 42 }) } }
    );
    rerender({
      worktree: makeWorktree({
        issueNumber: 42,
        issueTitle: "Linked later",
        issueProviderId: "linear",
        issueKey: "ENG-42",
      }),
    });

    await act(() => result.current.handleRunRecipe("recipe-1"));

    expect(runRecipeWithResults.mock.calls[0]![3]).toMatchObject({
      issueKey: "ENG-42",
      issueTitle: "Linked later",
    });
  });

  it("drops a key no provider owns, leaving the code forge's number", async () => {
    const { result } = renderActions({ issueNumber: 42, issueKey: "ENG-42" });

    await act(() => result.current.handleRunRecipe("recipe-1"));

    expect(runRecipeWithResults.mock.calls[0]![3]).toMatchObject({
      issueNumber: 42,
      issueKey: undefined,
      issueTitle: "Fix the thing",
    });
  });
});

describe("useWorktreeActions — session-wide destructive items defer to the action's confirm", () => {
  const ITEMS = [
    ["handleCloseAll", "worktree.sessions.trashAll"],
    ["handleTerminateAll", "worktree.sessions.endAll"],
    ["handleClearHistory", "worktree.sessions.clearHistory"],
    ["handleResourceTeardown", "worktree.resource.teardown"],
  ] as const;

  it.each(ITEMS)("%s never confirms on the user's behalf", (handler, actionId) => {
    const { result } = renderActions();

    act(() => {
      result.current[handler]();
    });

    // One unconfirmed dispatch: the action's own gate stages the app-level
    // confirm, so the menu can't skip it or show a second dialog of its own.
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [id, args] = dispatch.mock.calls[0]!;
    expect(id).toBe(actionId);
    expect(args).toEqual({ worktreeId: "wt-1" });
    expect(result.current.confirmDialog.isOpen).toBe(false);
  });
});
