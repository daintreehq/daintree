// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usePanelStoreMock, useWorktreeStoreMock } = vi.hoisted(() => ({
  usePanelStoreMock: vi.fn(),
  useWorktreeStoreMock: vi.fn(),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: usePanelStoreMock,
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: useWorktreeStoreMock,
}));

import {
  useTerminalNotificationCounts,
  useConflictedWorktrees,
  useWaitingTerminals,
  useBackgroundedTerminals,
  useWaitingTerminalIds,
  _resetWorktreeIdCacheForTests,
} from "../useTerminalSelectors";

const isInTrashFn = () => false;

function setupEmptyWorktrees() {
  useWorktreeStoreMock.mockImplementation(
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
  const state = {
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
    isInTrash: isInTrashFn,
  };
  usePanelStoreMock.mockImplementation(
    (
      selector: (state: {
        panelsById: Record<string, (typeof terminals)[0]>;
        panelIds: string[];
        isInTrash: (id: string) => boolean;
      }) => unknown
    ) => selector(state)
  );
}

function setupBoth(
  terminals: Array<{
    id: string;
    worktreeId?: string;
    agentState?: string;
    location?: string;
    lastStateChange?: number;
  }>,
  worktrees?: Map<string, { worktreeId?: string }>
) {
  const wtMap = worktrees ?? new Map();
  useWorktreeStoreMock.mockImplementation(
    (selector: (state: { worktrees: typeof wtMap }) => unknown) => selector({ worktrees: wtMap })
  );
  const state = {
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
    isInTrash: isInTrashFn,
  };
  usePanelStoreMock.mockImplementation(
    (
      selector: (state: {
        panelsById: Record<string, (typeof terminals)[0]>;
        panelIds: string[];
        isInTrash: (id: string) => boolean;
      }) => unknown
    ) => selector(state)
  );
}

describe("useTerminalSelectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWorktreeIdCacheForTests();
  });

  it("does not hide waiting terminals when worktree IDs are temporarily unavailable", () => {
    setupEmptyWorktrees();
    setupTerminals([
      { id: "t-waiting", worktreeId: "wt-1", agentState: "waiting", location: "grid" },
    ]);

    const { result } = renderHook(() => useTerminalNotificationCounts());
    expect(result.current.waitingCount).toBe(1);
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
          agentState: "waiting",
          location: "grid",
          lastStateChange: Date.now() - 6 * 60_000,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts(blurTime));
      expect(result.current.waitingCount).toBe(1);
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

    it("counts waiting terminals with valid timestamps", () => {
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
          agentState: "completed",
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
          agentState: "completed",
          location: "grid",
          lastStateChange: Date.now() - 10 * 60_000,
        },
      ]);

      const { result } = renderHook(() => useTerminalNotificationCounts());
      expect(result.current.waitingCount).toBe(1);
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
    });
  });
});

describe("useWaitingTerminals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWorktreeIdCacheForTests();
  });

  it("returns empty array when no terminals exist", () => {
    setupBoth([]);
    const { result } = renderHook(() => useWaitingTerminals());
    expect(result.current).toEqual([]);
  });

  it("returns only waiting visible terminals", () => {
    setupBoth([
      { id: "t1", agentState: "waiting", location: "grid" },
      { id: "t2", agentState: "working", location: "grid" },
      { id: "t3", agentState: "waiting", location: "trash" },
      { id: "t4", agentState: "waiting", location: "background" },
    ]);

    const { result } = renderHook(() => useWaitingTerminals());
    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe("t1");
  });

  it("excludes orphaned terminals when worktree IDs are known", () => {
    const worktrees = new Map([["wt-1", { worktreeId: "wt-1" }]]);
    setupBoth(
      [
        { id: "t1", agentState: "waiting", location: "grid", worktreeId: "wt-1" },
        { id: "t2", agentState: "waiting", location: "grid", worktreeId: "wt-unknown" },
      ],
      worktrees
    );

    const { result } = renderHook(() => useWaitingTerminals());
    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe("t1");
  });
});

describe("useWaitingTerminalIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWorktreeIdCacheForTests();
  });

  it("returns IDs of waiting terminals", () => {
    setupBoth([
      { id: "t1", agentState: "waiting", location: "grid" },
      { id: "t2", agentState: "working", location: "grid" },
    ]);

    const { result } = renderHook(() => useWaitingTerminalIds());
    expect(result.current).toEqual(["t1"]);
  });
});

describe("useBackgroundedTerminals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWorktreeIdCacheForTests();
  });

  it("returns only background terminals that are not orphaned", () => {
    setupBoth([
      { id: "t1", location: "background" },
      { id: "t2", location: "grid" },
      { id: "t3", location: "background", worktreeId: "wt-1" },
    ]);

    const { result } = renderHook(() => useBackgroundedTerminals());
    expect(result.current).toHaveLength(2);
    expect(result.current.map((t) => t.id)).toEqual(["t1", "t3"]);
  });

  it("excludes orphaned background terminals when worktrees are known", () => {
    const worktrees = new Map([["wt-1", { worktreeId: "wt-1" }]]);
    setupBoth(
      [
        { id: "t1", location: "background", worktreeId: "wt-1" },
        { id: "t2", location: "background", worktreeId: "wt-gone" },
      ],
      worktrees
    );

    const { result } = renderHook(() => useBackgroundedTerminals());
    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe("t1");
  });
});

function setupWorktreesWithChanges(
  worktrees: Array<{
    id: string;
    worktreeId?: string;
    worktreeChanges?: { changes: Array<{ status: string }> } | null;
  }>
) {
  const map = new Map<string, (typeof worktrees)[0]>();
  for (const wt of worktrees) {
    map.set(wt.id, wt);
  }
  useWorktreeStoreMock.mockImplementation(
    (selector: (state: { worktrees: typeof map }) => unknown) => selector({ worktrees: map })
  );
}

describe("useConflictedWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWorktreeIdCacheForTests();
  });

  it("returns empty array when no worktrees exist", () => {
    setupWorktreesWithChanges([]);

    const { result } = renderHook(() => useConflictedWorktrees());
    expect(result.current).toEqual([]);
  });

  it("returns empty array when worktreeChanges is null", () => {
    setupWorktreesWithChanges([{ id: "wt-1", worktreeChanges: null }]);

    const { result } = renderHook(() => useConflictedWorktrees());
    expect(result.current).toEqual([]);
  });

  it("returns empty array when changes have no conflicted files", () => {
    setupWorktreesWithChanges([
      {
        id: "wt-1",
        worktreeChanges: { changes: [{ status: "modified" }, { status: "added" }] },
      },
    ]);

    const { result } = renderHook(() => useConflictedWorktrees());
    expect(result.current).toEqual([]);
  });

  it("returns worktree with conflicted files", () => {
    setupWorktreesWithChanges([
      {
        id: "wt-1",
        worktreeChanges: { changes: [{ status: "conflicted" }] },
      },
    ]);

    const { result } = renderHook(() => useConflictedWorktrees());
    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe("wt-1");
  });

  it("returns only conflicted worktrees from a mixed set", () => {
    setupWorktreesWithChanges([
      {
        id: "wt-clean",
        worktreeChanges: { changes: [{ status: "modified" }] },
      },
      {
        id: "wt-conflict",
        worktreeChanges: { changes: [{ status: "modified" }, { status: "conflicted" }] },
      },
      {
        id: "wt-empty",
        worktreeChanges: { changes: [] },
      },
    ]);

    const { result } = renderHook(() => useConflictedWorktrees());
    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe("wt-conflict");
  });
});

describe("buildWorktreeIds memoization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWorktreeIdCacheForTests();
  });

  it("returns correct IDs when Map reference changes but keys stay the same", () => {
    const map1 = new Map([["wt-1", { worktreeId: "wt-1" }]]);
    setupBoth(
      [
        { id: "t1", agentState: "waiting", location: "grid", worktreeId: "wt-1" },
        { id: "t2", agentState: "waiting", location: "grid", worktreeId: "wt-unknown" },
      ],
      map1 as Map<string, { worktreeId?: string }>
    );
    const { result: r1 } = renderHook(() => useWaitingTerminals());
    expect(r1.current).toHaveLength(1);
    expect(r1.current[0].id).toBe("t1");

    const map2 = new Map([["wt-1", { worktreeId: "wt-1", status: "changed" }]]);
    setupBoth(
      [
        { id: "t1", agentState: "waiting", location: "grid", worktreeId: "wt-1" },
        { id: "t2", agentState: "waiting", location: "grid", worktreeId: "wt-unknown" },
      ],
      map2 as Map<string, { worktreeId?: string }>
    );
    const { result: r2 } = renderHook(() => useWaitingTerminals());
    expect(r2.current).toHaveLength(1);
    expect(r2.current[0].id).toBe("t1");
  });

  it("detects when a worktree is added", () => {
    const map1 = new Map([["wt-1", { worktreeId: "wt-1" }]]);
    setupBoth(
      [
        { id: "t1", agentState: "waiting", location: "grid", worktreeId: "wt-1" },
        { id: "t2", agentState: "waiting", location: "grid", worktreeId: "wt-2" },
      ],
      map1 as Map<string, { worktreeId?: string }>
    );
    const { result: r1 } = renderHook(() => useWaitingTerminals());
    expect(r1.current).toHaveLength(1);
    expect(r1.current[0].id).toBe("t1");

    const map2 = new Map([
      ["wt-1", { worktreeId: "wt-1" }],
      ["wt-2", { worktreeId: "wt-2" }],
    ]);
    setupBoth(
      [
        { id: "t1", agentState: "waiting", location: "grid", worktreeId: "wt-1" },
        { id: "t2", agentState: "waiting", location: "grid", worktreeId: "wt-2" },
      ],
      map2 as Map<string, { worktreeId?: string }>
    );
    const { result: r2 } = renderHook(() => useWaitingTerminals());
    expect(r2.current).toHaveLength(2);
  });

  it("detects when a worktree is removed", () => {
    const map1 = new Map([
      ["wt-1", { worktreeId: "wt-1" }],
      ["wt-2", { worktreeId: "wt-2" }],
    ]);
    setupBoth(
      [
        { id: "t1", agentState: "waiting", location: "grid", worktreeId: "wt-1" },
        { id: "t2", agentState: "waiting", location: "grid", worktreeId: "wt-2" },
      ],
      map1 as Map<string, { worktreeId?: string }>
    );
    const { result: r1 } = renderHook(() => useWaitingTerminals());
    expect(r1.current).toHaveLength(2);

    const map2 = new Map([["wt-1", { worktreeId: "wt-1" }]]);
    setupBoth(
      [
        { id: "t1", agentState: "waiting", location: "grid", worktreeId: "wt-1" },
        { id: "t2", agentState: "waiting", location: "grid", worktreeId: "wt-2" },
      ],
      map2 as Map<string, { worktreeId?: string }>
    );
    const { result: r2 } = renderHook(() => useWaitingTerminals());
    expect(r2.current).toHaveLength(1);
    expect(r2.current[0].id).toBe("t1");
  });

  it("handles transition from empty to populated worktrees", () => {
    setupBoth([{ id: "t1", agentState: "waiting", location: "grid", worktreeId: "wt-1" }]);
    const { result: r1 } = renderHook(() => useWaitingTerminals());
    expect(r1.current).toHaveLength(1);

    const map = new Map([["wt-1", { worktreeId: "wt-1" }]]);
    setupBoth(
      [
        { id: "t1", agentState: "waiting", location: "grid", worktreeId: "wt-1" },
        { id: "t2", agentState: "waiting", location: "grid", worktreeId: "wt-unknown" },
      ],
      map as Map<string, { worktreeId?: string }>
    );
    const { result: r2 } = renderHook(() => useWaitingTerminals());
    expect(r2.current).toHaveLength(1);
    expect(r2.current[0].id).toBe("t1");
  });
});
