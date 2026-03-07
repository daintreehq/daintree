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

function setupEmptyWorktrees() {
  useWorktreeDataStoreMock.mockImplementation(
    (selector: (state: { worktrees: Map<string, { worktreeId?: string }> }) => unknown) =>
      selector({ worktrees: new Map() })
  );
}

function setupTerminals(
  terminals: Array<{
    id: string;
    worktreeId?: string;
    agentState?: string;
    location?: string;
    lastStateChange?: number;
  }>
) {
  useTerminalStoreMock.mockImplementation(
    (
      selector: (state: {
        terminals: typeof terminals;
        isInTrash: (id: string) => boolean;
      }) => unknown
    ) =>
      selector({
        terminals,
        isInTrash: () => false,
      })
  );
}

describe("useTerminalSelectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not hide waiting terminals when worktree IDs are temporarily unavailable", () => {
    setupEmptyWorktrees();
    setupTerminals([
      { id: "t-waiting", worktreeId: "wt-1", agentState: "waiting", location: "grid" },
    ]);

    const { result } = renderHook(() => useTerminalNotificationCounts());
    expect(result.current.waitingCount).toBe(1);
    expect(result.current.failedCount).toBe(0);
  });

  describe("blurTime filtering", () => {
    it("returns zeros when blurTime is null (window focused)", () => {
      setupEmptyWorktrees();
      setupTerminals([
        {
          id: "t1",
          agentState: "waiting",
          location: "grid",
          lastStateChange: Date.now() - 1000,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts(null));
      expect(result.current.waitingCount).toBe(0);
      expect(result.current.failedCount).toBe(0);
    });

    it("counts terminals that changed state after blurTime", () => {
      setupEmptyWorktrees();
      const blurTime = Date.now() - 60_000;
      setupTerminals([
        {
          id: "t1",
          agentState: "waiting",
          location: "grid",
          lastStateChange: Date.now() - 30_000,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts(blurTime));
      expect(result.current.waitingCount).toBe(1);
      expect(result.current.failedCount).toBe(0);
    });

    it("excludes terminals that changed state before blurTime", () => {
      setupEmptyWorktrees();
      const blurTime = Date.now() - 30_000;
      setupTerminals([
        {
          id: "t1",
          agentState: "waiting",
          location: "grid",
          lastStateChange: Date.now() - 60_000,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts(blurTime));
      expect(result.current.waitingCount).toBe(0);
    });

    it("counts terminals that changed after blurTime regardless of age", () => {
      setupEmptyWorktrees();
      const blurTime = Date.now() - 10 * 60_000;
      setupTerminals([
        {
          id: "t1",
          agentState: "failed",
          location: "grid",
          lastStateChange: Date.now() - 6 * 60_000,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts(blurTime));
      expect(result.current.failedCount).toBe(1);
    });

    it("counts terminal that changed long after blurTime", () => {
      setupEmptyWorktrees();
      const blurTime = Date.now() - 10 * 60_000;
      setupTerminals([
        {
          id: "t1",
          agentState: "waiting",
          location: "grid",
          lastStateChange: Date.now() - 5 * 60_000,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts(blurTime));
      expect(result.current.waitingCount).toBe(1);
    });

    it("excludes terminals without lastStateChange when blurTime is set", () => {
      setupEmptyWorktrees();
      const blurTime = Date.now() - 60_000;
      setupTerminals([
        {
          id: "t1",
          agentState: "waiting",
          location: "grid",
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts(blurTime));
      expect(result.current.waitingCount).toBe(0);
    });

    it("counts both waiting and failed terminals with valid timestamps", () => {
      setupEmptyWorktrees();
      const blurTime = Date.now() - 120_000;
      setupTerminals([
        {
          id: "t1",
          agentState: "waiting",
          location: "grid",
          lastStateChange: Date.now() - 60_000,
        },
        {
          id: "t2",
          agentState: "failed",
          location: "grid",
          lastStateChange: Date.now() - 30_000,
        },
        {
          id: "t3",
          agentState: "waiting",
          location: "grid",
          lastStateChange: Date.now() - 180_000,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts(blurTime));
      expect(result.current.waitingCount).toBe(1);
      expect(result.current.failedCount).toBe(1);
    });

    it("uses unfiltered behavior when blurTime is undefined", () => {
      setupEmptyWorktrees();
      setupTerminals([
        {
          id: "t1",
          agentState: "waiting",
          location: "grid",
        },
        {
          id: "t2",
          agentState: "failed",
          location: "grid",
          lastStateChange: Date.now() - 10 * 60_000,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts());
      expect(result.current.waitingCount).toBe(1);
      expect(result.current.failedCount).toBe(1);
    });

    it("excludes terminal whose lastStateChange equals blurTime exactly", () => {
      setupEmptyWorktrees();
      const blurTime = Date.now() - 30_000;
      setupTerminals([
        {
          id: "t1",
          agentState: "waiting",
          location: "grid",
          lastStateChange: blurTime,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts(blurTime));
      expect(result.current.waitingCount).toBe(0);
    });

    it("counts terminal that changed just after blurTime", () => {
      setupEmptyWorktrees();
      const blurTime = Date.now() - 60_000;
      setupTerminals([
        {
          id: "t1",
          agentState: "waiting",
          location: "grid",
          lastStateChange: blurTime + 1,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts(blurTime));
      expect(result.current.waitingCount).toBe(1);
    });

    it("does not recount a terminal from a previous blur session on re-blur", () => {
      setupEmptyWorktrees();
      const firstBlurTime = Date.now() - 120_000;
      const terminalStateChange = Date.now() - 90_000;

      setupTerminals([
        {
          id: "t1",
          agentState: "waiting",
          location: "grid",
          lastStateChange: terminalStateChange,
        },
      ]);

      // Terminal is counted during first blur
      const { result: result1 } = renderHook(() => useTerminalNotificationCounts(firstBlurTime));
      expect(result1.current.waitingCount).toBe(1);

      // After focus, count is zero
      const { result: result2 } = renderHook(() => useTerminalNotificationCounts(null));
      expect(result2.current.waitingCount).toBe(0);

      // After re-blur (new blurTime > terminalStateChange), terminal is not re-counted
      const secondBlurTime = Date.now() - 30_000;
      const { result: result3 } = renderHook(() => useTerminalNotificationCounts(secondBlurTime));
      expect(result3.current.waitingCount).toBe(0);
    });

    it("counts terminal that re-enters waiting after leaving it during blur session", () => {
      setupEmptyWorktrees();
      const blurTime = Date.now() - 120_000;

      // Terminal went waiting → working → waiting during blur; lastStateChange is the re-entry time
      const reEntryTime = Date.now() - 30_000;
      setupTerminals([
        {
          id: "t1",
          agentState: "waiting",
          location: "grid",
          lastStateChange: reEntryTime,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts(blurTime));
      expect(result.current.waitingCount).toBe(1);
    });

    it("does not count working or idle terminals even if lastStateChange is after blurTime", () => {
      setupEmptyWorktrees();
      const blurTime = Date.now() - 60_000;
      setupTerminals([
        {
          id: "t1",
          agentState: "working",
          location: "grid",
          lastStateChange: Date.now() - 30_000,
        },
        {
          id: "t2",
          agentState: "idle",
          location: "grid",
          lastStateChange: Date.now() - 10_000,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts(blurTime));
      expect(result.current.waitingCount).toBe(0);
      expect(result.current.failedCount).toBe(0);
    });
  });
});
