// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
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

import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import {
  useTerminalNotificationCounts,
  useConflictedWorktrees,
  useWaitingTerminals,
  useUnreadTerminals,
  useDemandTerminalCount,
  useBackgroundedTerminals,
  useBackgroundPanelStats,
  useErrorTerminals,
  _resetWorktreeIdCacheForTests,
} from "../useTerminalSelectors";

const isInTrashFn = () => false;

// The fleet store is real, so a snapshot one test delivers would otherwise
// carry into the next.
beforeEach(() => {
  useFleetSnapshotStore.setState({ snapshot: null });
});

type RunOverrides = Partial<FleetRunRow> & { runId: string };

function deliverRuns(runs: RunOverrides[]) {
  act(() => {
    useFleetSnapshotStore.getState().applySnapshot({
      runs: runs.map((run) => ({ workspaceId: "p1", spawnedAt: 1, cwd: "/repo", ...run })),
      changedAt: 4,
      degraded: false,
      lastSuccessfulAt: 4,
    });
  });
}

/** Canopy's unread reading of an approval: the only thing that puts a run in Waiting. */
const ASK = { kind: "asked", quote: "Run the migration?", readAt: 3, seen: false } as const;

/** The fleet reporting each of these terminals as asking for an approval, as Canopy read it. */
function deliverAsks(ids: string[]) {
  deliverRuns(
    ids.map((runId) => ({
      runId,
      agentState: "waiting",
      waitingReason: "approval" as const,
      canopy: ASK,
    }))
  );
}

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
    exitCode?: number;
    hasPty?: boolean;
    kind?: string;
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
    kind?: string;
    worktreeId?: string;
    agentState?: string;
    waitingReason?: string;
    location?: string;
    lastStateChange?: number;
    exitCode?: number;
    hasPty?: boolean;
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

  describe("useBackgroundPanelStats", () => {
    it("counts working and waiting grid panels, excluding the current one", () => {
      setupTerminals([
        { id: "current", agentState: "working", location: "grid" },
        { id: "w1", agentState: "working", location: "grid" },
        { id: "w2", agentState: "working", location: undefined },
        { id: "q1", agentState: "waiting", location: "grid" },
        { id: "idle", agentState: "idle", location: "grid" },
      ]);

      const { result } = renderHook(() => useBackgroundPanelStats("current"));
      expect(result.current.activeCount).toBe(4);
      expect(result.current.workingCount).toBe(2);
      expect(result.current.waitingCount).toBe(1);
    });

    it("ignores panels outside the grid (dock/background) in every count", () => {
      setupTerminals([
        { id: "grid-working", agentState: "working", location: "grid" },
        { id: "dock-working", agentState: "working", location: "dock" },
        { id: "bg-waiting", agentState: "waiting", location: "background" },
      ]);

      const { result } = renderHook(() => useBackgroundPanelStats("none"));
      expect(result.current.activeCount).toBe(1);
      expect(result.current.workingCount).toBe(1);
      expect(result.current.waitingCount).toBe(0);
    });

    it("counts non-PTY grid panels as active but never as working or waiting", () => {
      setupTerminals([
        { id: "term", agentState: "waiting", location: "grid" },
        { id: "browser", agentState: "working", location: "grid", kind: "browser" },
      ]);

      const { result } = renderHook(() => useBackgroundPanelStats("none"));
      expect(result.current.activeCount).toBe(2);
      expect(result.current.workingCount).toBe(0);
      expect(result.current.waitingCount).toBe(1);
    });

    it("returns all-zero stats without scanning when disabled", () => {
      setupTerminals([{ id: "w1", agentState: "working", location: "grid" }]);

      const { result } = renderHook(() => useBackgroundPanelStats("none", false));
      expect(result.current).toEqual({ activeCount: 0, workingCount: 0, waitingCount: 0 });
    });
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
    useFleetSnapshotStore.setState({ snapshot: null });
  });

  it("returns only waiting visible terminals", () => {
    setupBoth([
      { id: "t1", agentState: "waiting", location: "grid" },
      { id: "t2", agentState: "working", location: "grid" },
      { id: "t3", agentState: "waiting", location: "trash" },
      { id: "t4", agentState: "waiting", location: "background" },
    ]);
    deliverRuns([
      { runId: "t1", agentState: "waiting", waitingReason: "approval", canopy: ASK },
      { runId: "t2", agentState: "working" },
      { runId: "t3", agentState: "waiting", waitingReason: "approval", canopy: ASK },
      { runId: "t4", agentState: "waiting", waitingReason: "approval", canopy: ASK },
    ]);

    const { result } = renderHook(() => useWaitingTerminals());
    expect(result.current).toHaveLength(1);
    expect(result.current[0]!.id).toBe("t1");
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
    deliverAsks(["t1", "t2"]);

    const { result } = renderHook(() => useWaitingTerminals());
    expect(result.current).toHaveLength(1);
    expect(result.current[0]!.id).toBe("t1");
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
    expect(result.current[0]!.id).toBe("t1");
  });
});

describe("useErrorTerminals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWorktreeIdCacheForTests();
  });

  it("returns terminals that exited with a non-zero exit code", () => {
    setupBoth([
      { id: "t-error", agentState: "exited", location: "grid", exitCode: 1 },
      { id: "t-clean", agentState: "exited", location: "grid", exitCode: 0 },
      { id: "t-running", agentState: "working", location: "grid" },
      { id: "t-waiting", agentState: "waiting", location: "grid" },
    ]);

    const { result } = renderHook(() => useErrorTerminals());
    expect(result.current.map((t) => t.id)).toEqual(["t-error"]);
  });

  it("excludes exited terminals without a numeric exitCode", () => {
    setupBoth([
      { id: "t-noexit", agentState: "exited", location: "grid" },
      { id: "t-error", agentState: "exited", location: "grid", exitCode: 1 },
    ]);

    const { result } = renderHook(() => useErrorTerminals());
    expect(result.current).toHaveLength(1);
    expect(result.current[0]!.id).toBe("t-error");
  });

  it("excludes errored terminals in trash, background, or dock", () => {
    setupBoth([
      { id: "t-grid", agentState: "exited", location: "grid", exitCode: 1 },
      { id: "t-trash", agentState: "exited", location: "trash", exitCode: 1 },
      { id: "t-bg", agentState: "exited", location: "background", exitCode: 1 },
      { id: "t-dock", agentState: "exited", location: "dock", exitCode: 1 },
    ]);

    const { result } = renderHook(() => useErrorTerminals());
    expect(result.current.map((t) => t.id)).toEqual(["t-grid"]);
  });

  it("excludes terminals where hasPty is explicitly false", () => {
    setupBoth([
      { id: "t-ok", agentState: "exited", location: "grid", exitCode: 1 },
      { id: "t-nopty", agentState: "exited", location: "grid", exitCode: 1, hasPty: false },
    ]);

    const { result } = renderHook(() => useErrorTerminals());
    expect(result.current).toHaveLength(1);
    expect(result.current[0]!.id).toBe("t-ok");
  });

  it("excludes orphaned errored terminals when worktree IDs are known", () => {
    const worktrees = new Map([["wt-1", { worktreeId: "wt-1" }]]);
    setupBoth(
      [
        { id: "t-live", agentState: "exited", location: "grid", exitCode: 1, worktreeId: "wt-1" },
        {
          id: "t-orphan",
          agentState: "exited",
          location: "grid",
          exitCode: 1,
          worktreeId: "wt-gone",
        },
      ],
      worktrees
    );

    const { result } = renderHook(() => useErrorTerminals());
    expect(result.current).toHaveLength(1);
    expect(result.current[0]!.id).toBe("t-live");
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

  it("returns empty array when worktreeChanges is null", () => {
    setupWorktreesWithChanges([{ id: "wt-1", worktreeChanges: null }]);

    const { result } = renderHook(() => useConflictedWorktrees());
    expect(result.current).toEqual([]);
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
    expect(result.current[0]!.id).toBe("wt-conflict");
  });
});

describe("buildWorktreeIds memoization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWorktreeIdCacheForTests();
    useFleetSnapshotStore.setState({ snapshot: null });
    deliverAsks(["t1", "t2"]);
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
    expect(r1.current[0]!.id).toBe("t1");

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
    expect(r2.current[0]!.id).toBe("t1");
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
    expect(r1.current[0]!.id).toBe("t1");

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
    expect(r2.current[0]!.id).toBe("t1");
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
    expect(r2.current[0]!.id).toBe("t1");
  });
});

describe("hand-backs are not waits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWorktreeIdCacheForTests();
    useFleetSnapshotStore.setState({ snapshot: null });
  });

  function deliverHandBacks(ids: string[], seen: boolean) {
    act(() => {
      useFleetSnapshotStore.getState().applySnapshot({
        runs: ids.map((runId) => ({
          runId,
          workspaceId: "p1",
          spawnedAt: 1,
          cwd: "/repo",
          agentState: "waiting" as const,
          handBack: seen ? { stoppedAt: 2, seenAt: 3 } : { stoppedAt: 2 },
        })),
        changedAt: 4,
        degraded: false,
        lastSuccessfulAt: 4,
      });
    });
  }

  it("drops an unread or read hand-back from the waiting counts, and keeps an approval", () => {
    setupBoth([
      { id: "unread", agentState: "waiting", location: "grid" },
      { id: "read", agentState: "waiting", location: "grid" },
      { id: "approval", agentState: "waiting", waitingReason: "approval", location: "grid" },
    ]);
    deliverRuns([
      { runId: "unread", agentState: "waiting", handBack: { stoppedAt: 2 } },
      { runId: "read", agentState: "waiting", handBack: { stoppedAt: 2, seenAt: 3 } },
      { runId: "approval", agentState: "waiting", waitingReason: "approval", canopy: ASK },
    ]);

    const waiting = renderHook(() => useWaitingTerminals());
    expect(waiting.result.current.map((t) => t.id)).toEqual(["approval"]);
    const unread = renderHook(() => useUnreadTerminals());
    expect(unread.result.current.map((t) => t.id)).toEqual(["unread"]);
    const counts = renderHook(() => useTerminalNotificationCounts());
    expect(counts.result.current.waitingCount).toBe(1);
    const stats = renderHook(() => useBackgroundPanelStats("none", true));
    expect(stats.result.current.waitingCount).toBe(1);
  });

  it("counts a prompt wait as waiting until the fleet reports it as a hand-back", () => {
    setupBoth([{ id: "t1", agentState: "waiting", location: "grid" }]);
    const { result } = renderHook(() => useTerminalNotificationCounts());
    expect(result.current.waitingCount).toBe(1);

    deliverHandBacks(["t1"], false);
    expect(result.current.waitingCount).toBe(0);
  });
});

describe("the dock's agent pills read the fleet bands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWorktreeIdCacheForTests();
    useFleetSnapshotStore.setState({ snapshot: null });
  });

  const ids = (terminals: Array<{ id: string }>) => terminals.map((t) => t.id);

  it("holds nobody before the first fleet snapshot, whatever the panels say", () => {
    setupBoth([
      { id: "prompt", agentState: "waiting", location: "grid" },
      { id: "approval", agentState: "waiting", waitingReason: "approval", location: "grid" },
    ]);

    expect(renderHook(() => useWaitingTerminals()).result.current).toEqual([]);
    expect(renderHook(() => useUnreadTerminals()).result.current).toEqual([]);
    expect(renderHook(() => useDemandTerminalCount()).result.current).toBe(0);
    // The Dock badge and window title still count the ask they can see.
    expect(renderHook(() => useTerminalNotificationCounts()).result.current.waitingCount).toBe(2);
  });

  it("leaves parked and snoozed agents out of both pills", () => {
    setupBoth([
      { id: "parked", agentState: "waiting", waitingReason: "approval", location: "grid" },
      { id: "snoozed", agentState: "waiting", location: "grid" },
    ]);
    deliverRuns([
      {
        runId: "parked",
        agentState: "waiting",
        waitingReason: "approval",
        park: { parkedAt: 1 },
      },
      {
        runId: "snoozed",
        agentState: "waiting",
        handBack: { stoppedAt: 2 },
        snooze: { snoozedAt: 1, snoozedUntil: 10 },
      },
    ]);

    expect(renderHook(() => useWaitingTerminals()).result.current).toEqual([]);
    expect(renderHook(() => useUnreadTerminals()).result.current).toEqual([]);
  });

  it("counts a prompt wait with no hand-back record in neither pill", () => {
    setupBoth([{ id: "t1", agentState: "waiting", waitingReason: "prompt", location: "grid" }]);
    deliverRuns([{ runId: "t1", agentState: "waiting", waitingReason: "prompt" }]);

    expect(renderHook(() => useWaitingTerminals()).result.current).toEqual([]);
    expect(renderHook(() => useUnreadTerminals()).result.current).toEqual([]);
  });

  it("follows Canopy: an ask read in a hand-back waits, a question it read as no ask is unread", () => {
    setupBoth([
      { id: "asked", agentState: "completed", location: "grid" },
      { id: "not-asking", agentState: "waiting", waitingReason: "question", location: "grid" },
    ]);
    deliverRuns([
      {
        runId: "asked",
        agentState: "completed",
        handBack: { stoppedAt: 2, seenAt: 3 },
        canopy: { kind: "asked", quote: "Ship it?", readAt: 3, seen: false },
      },
      {
        runId: "not-asking",
        agentState: "waiting",
        waitingReason: "question",
        canopy: { kind: "not-asking", quote: "All tests pass.", readAt: 3, seen: false },
      },
    ]);

    expect(ids(renderHook(() => useWaitingTerminals()).result.current)).toEqual(["asked"]);
    expect(ids(renderHook(() => useUnreadTerminals()).result.current)).toEqual(["not-asking"]);
  });

  it("puts an approval or question no reading placed in Unread until looked at, never Waiting", () => {
    setupBoth([
      { id: "approval", agentState: "waiting", waitingReason: "approval", location: "grid" },
      { id: "question", agentState: "waiting", waitingReason: "question", location: "grid" },
      { id: "read-ask", agentState: "waiting", waitingReason: "approval", location: "grid" },
    ]);
    const deliver = (wait: FleetRunRow["wait"]) =>
      deliverRuns([
        { runId: "approval", agentState: "waiting", waitingReason: "approval", wait },
        { runId: "question", agentState: "waiting", waitingReason: "question", wait },
        {
          runId: "read-ask",
          agentState: "waiting",
          waitingReason: "approval",
          canopy: { ...ASK, seen: true },
        },
      ]);

    deliver({ stoppedAt: 2 });
    const waiting = renderHook(() => useWaitingTerminals());
    const unread = renderHook(() => useUnreadTerminals());
    expect(waiting.result.current).toEqual([]);
    expect(ids(unread.result.current)).toEqual(["approval", "question"]);

    // Looked at, they are no more than idle: in neither pill.
    deliver({ stoppedAt: 2, seenAt: 3 });
    expect(waiting.result.current).toEqual([]);
    expect(unread.result.current).toEqual([]);
  });

  it("drains Unread when the hand-back is seen, and keeps Unread to visible terminals", () => {
    setupBoth([
      { id: "here", agentState: "completed", location: "grid" },
      { id: "trashed", agentState: "completed", location: "trash" },
      { id: "backgrounded", agentState: "completed", location: "background" },
    ]);
    const handBacks = (handBack: FleetRunRow["handBack"]) =>
      deliverRuns(
        ["here", "trashed", "backgrounded", "no-panel"].map((runId) => ({
          runId,
          agentState: "completed" as const,
          handBack,
        }))
      );

    handBacks({ stoppedAt: 2 });
    const unread = renderHook(() => useUnreadTerminals());
    const demand = renderHook(() => useDemandTerminalCount());
    expect(ids(unread.result.current)).toEqual(["here"]);
    expect(demand.result.current).toBe(1);

    // No forced rerender: the fleet push alone has to reach a mounted pill.
    handBacks({ stoppedAt: 2, seenAt: 3 });
    expect(unread.result.current).toEqual([]);
    expect(demand.result.current).toBe(0);
  });

  it("fills a mounted pill when the first snapshot lands", () => {
    setupBoth([{ id: "t1", agentState: "waiting", waitingReason: "approval", location: "grid" }]);
    const waiting = renderHook(() => useWaitingTerminals());
    expect(waiting.result.current).toEqual([]);

    deliverAsks(["t1"]);
    expect(ids(waiting.result.current)).toEqual(["t1"]);
  });

  it("leaves out a panel the fleet hasn't reported, even once it has reported others", () => {
    setupBoth([
      { id: "reported", agentState: "waiting", waitingReason: "approval", location: "grid" },
      { id: "unreported", agentState: "waiting", waitingReason: "approval", location: "grid" },
    ]);
    deliverAsks(["reported"]);

    expect(ids(renderHook(() => useWaitingTerminals()).result.current)).toEqual(["reported"]);
    expect(renderHook(() => useDemandTerminalCount()).result.current).toBe(1);
  });

  it("counts both pills' visible agents for the dock's status", () => {
    setupBoth([
      { id: "error", agentState: "waiting", waitingReason: "error", location: "grid" },
      { id: "approval", agentState: "waiting", waitingReason: "approval", location: "grid" },
      { id: "hand-back", agentState: "completed", location: "dock" },
      { id: "read", agentState: "completed", location: "grid" },
      { id: "working", agentState: "working", location: "grid" },
      { id: "browser", kind: "browser", location: "grid" },
    ]);
    deliverRuns([
      { runId: "error", agentState: "waiting", waitingReason: "error" },
      { runId: "approval", agentState: "waiting", waitingReason: "approval" },
      { runId: "hand-back", agentState: "completed", handBack: { stoppedAt: 2 } },
      { runId: "read", agentState: "completed", handBack: { stoppedAt: 2, seenAt: 3 } },
      { runId: "working", agentState: "working" },
      // A run id that lands on a panel which isn't a terminal counts for nothing.
      { runId: "browser", agentState: "waiting", waitingReason: "approval" },
    ]);

    expect(renderHook(() => useDemandTerminalCount()).result.current).toBe(3);
  });
});
