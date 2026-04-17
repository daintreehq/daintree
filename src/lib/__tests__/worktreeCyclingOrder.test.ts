import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeSnapshot } from "@shared/types";

const mocks = vi.hoisted(() => {
  let worktreeViewState: { worktrees: Map<string, WorktreeSnapshot> } = {
    worktrees: new Map(),
  };
  const worktreeViewStore = {
    getState: () => worktreeViewState,
    setState: (partial: Partial<typeof worktreeViewState>) => {
      worktreeViewState = { ...worktreeViewState, ...partial };
    },
  };
  return { worktreeViewStore };
});

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => mocks.worktreeViewStore,
}));

const { getVisibleWorktreesForCycling } = await import("../worktreeCyclingOrder");
const { useWorktreeFilterStore } = await import("@/store/worktreeFilterStore");
const { usePanelStore } = await import("@/store/panelStore");

function createSnapshot(overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id: overrides.id ?? "wt",
    worktreeId: overrides.worktreeId ?? overrides.id ?? "wt",
    path: overrides.path ?? `/repo/${overrides.id ?? "wt"}`,
    name: overrides.name ?? "worktree",
    branch: overrides.branch ?? "feature/x",
    isCurrent: false,
    isMainWorktree: false,
    ...overrides,
  };
}

function setWorktrees(snaps: WorktreeSnapshot[]): void {
  mocks.worktreeViewStore.setState({
    worktrees: new Map(snaps.map((s) => [s.id, s])),
  });
}

function resetFilterStore(): void {
  useWorktreeFilterStore.setState({
    query: "",
    orderBy: "created",
    groupByType: false,
    statusFilters: new Set(),
    typeFilters: new Set(),
    githubFilters: new Set(),
    sessionFilters: new Set(),
    activityFilters: new Set(),
    alwaysShowActive: true,
    alwaysShowWaiting: true,
    hideMainWorktree: false,
    pinnedWorktrees: [],
    collapsedWorktrees: [],
    manualOrder: [],
    quickStateFilter: "all",
  });
}

beforeEach(() => {
  mocks.worktreeViewStore.setState({ worktrees: new Map() });
  usePanelStore.setState({
    panelsById: {},
    panelIds: [],
  });
  resetFilterStore();
});

describe("getVisibleWorktreesForCycling", () => {
  it("returns empty list when no worktrees exist", () => {
    expect(getVisibleWorktreesForCycling()).toEqual([]);
  });

  it("places main worktree first and integration second", () => {
    setWorktrees([
      createSnapshot({ id: "wt-b", name: "bravo", branch: "feature/bravo", createdAt: 100 }),
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "dev", name: "develop", branch: "develop" }),
      createSnapshot({ id: "wt-a", name: "alpha", branch: "feature/alpha", createdAt: 200 }),
    ]);

    const ordered = getVisibleWorktreesForCycling();
    expect(ordered.map((w) => w.id)).toEqual(["main", "dev", "wt-a", "wt-b"]);
  });

  it("sorts non-main worktrees alphabetically when orderBy is alpha", () => {
    useWorktreeFilterStore.setState({ orderBy: "alpha" });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "wt-c", name: "charlie", branch: "feature/charlie" }),
      createSnapshot({ id: "wt-a", name: "alpha", branch: "feature/alpha" }),
      createSnapshot({ id: "wt-b", name: "bravo", branch: "feature/bravo" }),
    ]);

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).toEqual(["main", "wt-a", "wt-b", "wt-c"]);
  });

  it("walks manual order when orderBy is manual", () => {
    useWorktreeFilterStore.setState({
      orderBy: "manual",
      manualOrder: ["wt-b", "wt-a", "wt-c"],
    });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "wt-a", name: "alpha", branch: "feature/alpha" }),
      createSnapshot({ id: "wt-b", name: "bravo", branch: "feature/bravo" }),
      createSnapshot({ id: "wt-c", name: "charlie", branch: "feature/charlie" }),
    ]);

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).toEqual(["main", "wt-b", "wt-a", "wt-c"]);
  });

  it("promotes pinned worktrees above unpinned ones", () => {
    useWorktreeFilterStore.setState({
      orderBy: "alpha",
      pinnedWorktrees: ["wt-z"],
    });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "wt-a", name: "alpha", branch: "feature/alpha" }),
      createSnapshot({ id: "wt-z", name: "zulu", branch: "feature/zulu" }),
    ]);

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).toEqual(["main", "wt-z", "wt-a"]);
  });

  it("honors quickStateFilter by hiding worktrees without matching state", () => {
    useWorktreeFilterStore.setState({ quickStateFilter: "working" });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "wt-working", name: "working", branch: "feature/working" }),
      createSnapshot({ id: "wt-idle", name: "idle", branch: "feature/idle" }),
    ]);
    usePanelStore.setState({
      panelsById: {
        "term-working": {
          id: "term-working",
          kind: "terminal",
          type: "terminal",
          title: "T",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          worktreeId: "wt-working",
          location: "grid",
          hasPty: true,
          isVisible: true,
          agentState: "working",
        } as unknown as ReturnType<typeof usePanelStore.getState>["panelsById"][string],
      },
      panelIds: ["term-working"],
    } as never);

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).toContain("wt-working");
    expect(ids).not.toContain("wt-idle");
    // main is always at the top, unaffected by quickStateFilter
    expect(ids[0]).toBe("main");
  });

  it("applies the text query filter to main and integration worktrees", () => {
    useWorktreeFilterStore.setState({ query: "alpha" });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "dev", name: "develop", branch: "develop" }),
      createSnapshot({ id: "wt-alpha", name: "alpha", branch: "feature/alpha" }),
    ]);

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).toEqual(["wt-alpha"]);
  });

  it("respects the alwaysShowActive override for the active worktree", () => {
    useWorktreeFilterStore.setState({
      statusFilters: new Set(["active"]),
      alwaysShowActive: true,
    });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "wt-a", name: "alpha", branch: "feature/alpha" }),
      createSnapshot({ id: "wt-b", name: "bravo", branch: "feature/bravo" }),
    ]);

    const ids = getVisibleWorktreesForCycling("wt-b").map((w) => w.id);
    expect(ids).toContain("wt-b");
  });

  it("flattens grouped sections when groupByType is enabled", () => {
    useWorktreeFilterStore.setState({ groupByType: true, orderBy: "alpha" });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "bug-1", name: "bug-1", branch: "bugfix/issue-1" }),
      createSnapshot({ id: "feat-1", name: "feat-1", branch: "feature/a" }),
      createSnapshot({ id: "chore-1", name: "chore-1", branch: "chore/cleanup" }),
    ]);

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    // features come before bugfixes which come before chores in TYPE_ORDER
    const ixFeature = ids.indexOf("feat-1");
    const ixBug = ids.indexOf("bug-1");
    const ixChore = ids.indexOf("chore-1");
    expect(ixFeature).toBeGreaterThan(-1);
    expect(ixFeature).toBeLessThan(ixBug);
    expect(ixBug).toBeLessThan(ixChore);
    expect(ids[0]).toBe("main");
  });

  it("resolves main fallback via useWorktrees sort when no worktree is marked main", () => {
    // No entry has isMainWorktree=true. useWorktrees sorts by
    // (isMainWorktree desc, lastActivityTimestamp desc, name asc), so the most
    // recently active worktree should land in the main-fallback slot.
    setWorktrees([
      createSnapshot({
        id: "wt-older",
        name: "older",
        branch: "feature/older",
        lastActivityTimestamp: 100,
      }),
      createSnapshot({
        id: "wt-newer",
        name: "newer",
        branch: "feature/newer",
        lastActivityTimestamp: 500,
      }),
    ]);
    useWorktreeFilterStore.setState({ orderBy: "alpha" });

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids[0]).toBe("wt-newer");
  });

  it("walks manual order with pins promoted to the top", () => {
    useWorktreeFilterStore.setState({
      groupByType: false,
      orderBy: "manual",
      pinnedWorktrees: ["feat-1", "bug-2"],
      manualOrder: ["bug-2", "feat-2", "feat-1", "chore-1"],
    });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "feat-1", name: "feat-1", branch: "feature/one" }),
      createSnapshot({ id: "feat-2", name: "feat-2", branch: "feature/two" }),
      createSnapshot({ id: "bug-2", name: "bug-2", branch: "bugfix/two" }),
      createSnapshot({ id: "chore-1", name: "chore-1", branch: "chore/one" }),
    ]);

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    // Pins come first in pin-array order (feat-1, bug-2), then remaining
    // non-pinned entries in manualOrder (feat-2, chore-1).
    expect(ids).toEqual(["main", "feat-1", "bug-2", "feat-2", "chore-1"]);
  });

  it("walks grouped sections with pins promoted within the flattened sections", () => {
    useWorktreeFilterStore.setState({
      groupByType: true,
      orderBy: "alpha",
      pinnedWorktrees: ["feat-2", "bug-2"],
    });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "feat-1", name: "feat-1", branch: "feature/one" }),
      createSnapshot({ id: "feat-2", name: "feat-2", branch: "feature/two" }),
      createSnapshot({ id: "bug-1", name: "bug-1", branch: "bugfix/one" }),
      createSnapshot({ id: "bug-2", name: "bug-2", branch: "bugfix/two" }),
    ]);

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    // Grouped order (feature → bugfix) with pins promoted inside each section:
    // feature section = [feat-2 (pinned), feat-1]; bugfix section = [bug-2 (pinned), bug-1].
    expect(ids).toEqual(["main", "feat-2", "feat-1", "bug-2", "bug-1"]);
  });
});
