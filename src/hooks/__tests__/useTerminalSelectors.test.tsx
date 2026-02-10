// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useTerminalStoreMock, useWorktreeDataStoreMock } = vi.hoisted(() => ({
  useTerminalStoreMock: vi.fn(),
  useWorktreeDataStoreMock: vi.fn(),
}));

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: useTerminalStoreMock,
}));

vi.mock("@/store/worktreeDataStore", () => ({
  useWorktreeDataStore: useWorktreeDataStoreMock,
}));

import { useTerminalNotificationCounts } from "../useTerminalSelectors";

describe("useTerminalSelectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not hide waiting terminals when worktree IDs are temporarily unavailable", () => {
    useWorktreeDataStoreMock.mockImplementation(
      (selector: (state: { worktrees: Map<string, { worktreeId?: string }> }) => unknown) =>
        selector({ worktrees: new Map() })
    );

    useTerminalStoreMock.mockImplementation(
      (
        selector: (state: {
          terminals: Array<{
            id: string;
            worktreeId?: string;
            agentState?: string;
            location?: string;
          }>;
          isInTrash: (id: string) => boolean;
        }) => unknown
      ) =>
        selector({
          terminals: [
            {
              id: "t-waiting",
              worktreeId: "wt-1",
              agentState: "waiting",
              location: "grid",
            },
          ],
          isInTrash: () => false,
        })
    );

    const { result } = renderHook(() => useTerminalNotificationCounts());
    expect(result.current.waitingCount).toBe(1);
    expect(result.current.failedCount).toBe(0);
  });
});
