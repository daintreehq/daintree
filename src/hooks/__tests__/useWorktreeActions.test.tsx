// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";

const { dispatchMock, addErrorMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  addErrorMock: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: dispatchMock,
  },
}));

vi.mock("@/store", () => ({
  useErrorStore: (selector: (state: { addError: typeof addErrorMock }) => unknown) =>
    selector({ addError: addErrorMock }),
}));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: {
    getState: () => ({
      generateRecipeFromActiveTerminals: vi.fn(() => []),
    }),
  },
}));

import { useWorktreeActions } from "../useWorktreeActions";

describe("useWorktreeActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses safe fallback when copyTree payload omits fileCount", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: {},
    });

    const { result } = renderHook(() => useWorktreeActions());

    const worktree: WorktreeState = {
      id: "wt-1",
      worktreeId: "wt-1",
      path: "/repo/wt-1",
      name: "wt-1",
      branch: "main",
      isCurrent: false,
      isMainWorktree: true,
      worktreeChanges: null,
      lastActivityTimestamp: null,
    };

    const message = await result.current.handleCopyTree(worktree);

    expect(message).toBe("Copied 0 files to clipboard");
  });
});
