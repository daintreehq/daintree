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

// Self-contained factory (no top-level refs, no generics) so vitest's mock
// hoisting stays happy. The hook only reads `runRecipeWithResults` via the
// selector at render; the handlers under test don't touch the recipe store.
vi.mock("@/store/recipeStore", () => {
  const state = {
    runRecipeWithResults: () => Promise.resolve([]),
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

function renderActions() {
  return renderHook(() =>
    useWorktreeActions({
      worktree: makeWorktree(),
      teardownCommands: [],
    })
  );
}

beforeEach(() => {
  dispatch.mockClear();
});

describe("useWorktreeActions — session-wide destructive items defer to the action's confirm", () => {
  const ITEMS = [
    ["handleCloseAll", "worktree.sessions.trashAll"],
    ["handleTerminateAll", "worktree.sessions.endAll"],
    ["handleClearHistory", "worktree.sessions.clearHistory"],
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

  it("keeps trashing and terminating on separate actions, so the reversible one stays reversible", () => {
    // Swapping the two callbacks would leave every label correct while turning
    // "Trash all sessions" into permanent termination.
    const { result } = renderActions();

    act(() => {
      result.current.handleCloseAll();
    });
    act(() => {
      result.current.handleTerminateAll();
    });

    expect(dispatch.mock.calls.map((call) => call[0])).toEqual([
      "worktree.sessions.trashAll",
      "worktree.sessions.endAll",
    ]);
  });
});
