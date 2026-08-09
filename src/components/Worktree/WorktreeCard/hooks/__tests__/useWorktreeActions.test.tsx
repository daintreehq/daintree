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

describe("useWorktreeActions — confirmed call-site dispatch (#11345)", () => {
  it("dispatches endAll with confirmed:true only after the local dialog is confirmed", () => {
    const { result } = renderActions();

    act(() => {
      result.current.handleTerminateAll();
    });
    // The dialog is open but nothing has been dispatched yet.
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.current.confirmDialog.isOpen).toBe(true);

    act(() => {
      if (result.current.confirmDialog.isOpen) result.current.confirmDialog.onConfirm();
    });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.sessions.endAll",
      { worktreeId: "wt-1", confirmed: true },
      { source: "user" }
    );
  });

  it("dispatches clearHistory with confirmed:true only after the local dialog is confirmed", () => {
    const { result } = renderActions();

    act(() => {
      result.current.handleClearHistory();
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.current.confirmDialog.isOpen).toBe(true);

    act(() => {
      if (result.current.confirmDialog.isOpen) result.current.confirmDialog.onConfirm();
    });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.sessions.clearHistory",
      { worktreeId: "wt-1", confirmed: true },
      { source: "user" }
    );
  });
});
