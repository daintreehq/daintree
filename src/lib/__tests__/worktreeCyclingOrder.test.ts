import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeSnapshot } from "@shared/types";
import type { FleetRunRow } from "@shared/types/ipc/fleet";

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
const { useFleetSnapshotStore } = await import("@/store/fleetSnapshotStore");

type RunSeed = { runId: string } & Partial<FleetRunRow>;

// The quick-state buckets join agent panels to their fleet runs by id.
function setFleetRuns(runs: RunSeed[]): void {
  useFleetSnapshotStore.setState({
    snapshot: {
      runs: runs.map((r) => ({ workspaceId: "p1", spawnedAt: 0, cwd: "/repo", ...r })),
      changedAt: 0,
      degraded: false,
      lastSuccessfulAt: 0,
    },
  });
}

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

function prLinkedSnapshot(
  state: "open" | "merged" | "closed" | "declined"
): Pick<WorktreeSnapshot, "linked"> {
  return {
    linked: {
      providerId: "github",
      pr: {
        ref: { providerId: "github", owner: "test", repo: "test", number: 7, rawData: {} },
        state,
        url: "https://github.com/test/test/pull/7",
      },
    },
  } as unknown as Pick<WorktreeSnapshot, "linked">;
}

function cleanChanges(id: string): WorktreeSnapshot["worktreeChanges"] {
  return {
    worktreeId: id,
    rootPath: `/repo/${id}`,
    changes: [],
    changedFileCount: 0,
  } as unknown as WorktreeSnapshot["worktreeChanges"];
}

function setWorktrees(snaps: WorktreeSnapshot[]): void {
  mocks.worktreeViewStore.setState({
    worktrees: new Map(snaps.map((s) => [s.id, s])),
  });
}

// Parks agent terminals on each worktree, all in the given panel state.
function setAgentPanels(
  byWorktree: Record<string, string[]>,
  agentState: "working" | "waiting" = "working"
): void {
  const panelsById: Record<string, unknown> = {};
  for (const [worktreeId, ids] of Object.entries(byWorktree)) {
    for (const id of ids) {
      panelsById[id] = {
        id,
        kind: "terminal",
        type: "terminal",
        title: "T",
        cwd: "/repo",
        cols: 80,
        rows: 24,
        worktreeId,
        location: "grid",
        hasPty: true,
        isVisible: true,
        agentState,
        detectedAgentId: "claude",
      };
    }
  }
  usePanelStore.setState({
    panelsById,
    panelIds: Object.keys(panelsById),
    panelIdsByWorktreeId: byWorktree,
  } as never);
}

// Parks a single working-agent terminal on `worktreeId` so that worktree
// derives `hasWorkingAgent` and satisfies the "working" quick-state filter.
function setWorkingAgentPanel(worktreeId: string): void {
  const panelId = `term-${worktreeId}`;
  setAgentPanels({ [worktreeId]: [panelId] });
  setFleetRuns([{ runId: panelId, agentState: "working" }]);
}

function resetFilterStore(): void {
  useWorktreeFilterStore.setState({
    query: "",
    liveQuery: "",
    orderBy: "created",
    groupByType: false,
    statusFilters: new Set(),
    typeFilters: new Set(),
    prIssueFilters: new Set(),
    sessionFilters: new Set(),
    hasAgentFilter: false,
    activityFilters: new Set(),
    devServerFilters: new Set(),
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
    panelIdsByWorktreeId: {},
  });
  useFleetSnapshotStore.setState({ snapshot: null });
  resetFilterStore();
});

describe("getVisibleWorktreesForCycling", () => {
  it("returns empty list when no worktrees exist", () => {
    expect(getVisibleWorktreesForCycling()).toEqual([]);
  });

  it("places main worktree first and sorts every other worktree normally (#11433)", () => {
    // A worktree on `develop` used to be yanked out of the sorted list and
    // pinned to slot 1 purely because of its branch name. It is an ordinary
    // worktree: with alpha ordering it belongs between "bravo" and "echo",
    // not immediately after main.
    useWorktreeFilterStore.setState({ orderBy: "alpha" });
    setWorktrees([
      createSnapshot({ id: "wt-b", name: "bravo", branch: "feature/bravo" }),
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "dev", name: "charlie", branch: "develop" }),
      createSnapshot({ id: "wt-a", name: "alpha", branch: "feature/alpha" }),
      createSnapshot({ id: "wt-e", name: "echo", branch: "feature/echo" }),
    ]);

    const ordered = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ordered).toEqual(["main", "wt-a", "wt-b", "dev", "wt-e"]);
    // Appears exactly once — never both pinned and in the scrollable list.
    expect(ordered.filter((id) => id === "dev")).toHaveLength(1);
  });

  it("subjects a worktree on an integration-style branch to quickStateFilter (#11433)", () => {
    // The pinned slot bypassed quick-state filtering entirely, so a `develop`
    // worktree stayed visible under "working" with no working agent — while
    // simultaneously being excluded from the counts that drive the filter bar.
    useWorktreeFilterStore.setState({ quickStateFilter: "working" });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "dev", name: "develop", branch: "develop" }),
      createSnapshot({ id: "wt-working", name: "working", branch: "feature/working" }),
    ]);
    setWorkingAgentPanel("wt-working");

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).toContain("wt-working");
    expect(ids).not.toContain("dev");
  });

  it("cycles to external worktrees last and never into the integration slot (#11434)", () => {
    // Keyboard cycling must match the rendered order, and an external worktree
    // on develop must not claim the integration slot ahead of everything else.
    setWorktrees([
      createSnapshot({
        id: "ext",
        name: "bench-baseline",
        branch: "develop",
        path: "/private/tmp/scratch/bench-baseline",
        isExternal: true,
        createdAt: 300,
      }),
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "wt-a", name: "alpha", branch: "feature/alpha", createdAt: 200 }),
    ]);

    const ordered = getVisibleWorktreesForCycling();

    expect(ordered.map((w) => w.id)).toEqual(["main", "wt-a", "ext"]);
  });

  it("keeps external worktrees last in grouped mode", () => {
    useWorktreeFilterStore.setState({ groupByType: true, orderBy: "alpha" });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({
        id: "ext-feat",
        name: "aaa-scratch",
        branch: "feature/scratch",
        isExternal: true,
      }),
      createSnapshot({ id: "int-bug", name: "zzz-bug", branch: "bugfix/z" }),
    ]);

    const ordered = getVisibleWorktreesForCycling();

    expect(ordered.map((w) => w.id)).toEqual(["main", "int-bug", "ext-feat"]);
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
    setWorkingAgentPanel("wt-working");

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).toContain("wt-working");
    expect(ids).not.toContain("wt-idle");
    // main is always at the top, unaffected by quickStateFilter
    expect(ids[0]).toBe("main");
  });

  it("applies the live text query filter to the main and scrollable worktrees", () => {
    // Cycling mirrors the sidebar's visible list, which filters on the instant
    // liveQuery — not the debounced persisted query.
    useWorktreeFilterStore.setState({ liveQuery: "alpha" });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "wt-bravo", name: "bravo", branch: "feature/bravo" }),
      createSnapshot({ id: "wt-alpha", name: "alpha", branch: "feature/alpha" }),
    ]);

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).toEqual(["wt-alpha"]);
  });

  it("treats a whitespace-only live query as empty, keeping main in the cycle", () => {
    useWorktreeFilterStore.setState({ liveQuery: "   " });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "wt-bravo", name: "bravo", branch: "feature/bravo" }),
    ]);

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).toEqual(["main", "wt-bravo"]);
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
    // features come before bugfixes which come before chores in WORKTREE_TYPE_IDS
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

  it("ignores a future activity time when resolving the unmarked main fallback", () => {
    const now = Date.now();
    setWorktrees([
      createSnapshot({
        id: "wt-future",
        name: "future",
        branch: "feature/future",
        lastActivityTimestamp: now + 60 * 60 * 1000,
      }),
      createSnapshot({
        id: "wt-valid",
        name: "valid",
        branch: "feature/valid",
        lastActivityTimestamp: now - 1000,
      }),
    ]);
    useWorktreeFilterStore.setState({ orderBy: "alpha" });

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids[0]).toBe("wt-valid");
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

  it("excludes background terminals from quickStateFilter matching", () => {
    useWorktreeFilterStore.setState({ quickStateFilter: "waiting" });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "wt-bg", name: "bg", branch: "feature/bg" }),
    ]);
    usePanelStore.setState({
      panelsById: {
        "term-waiting": {
          id: "term-waiting",
          kind: "terminal",
          type: "terminal",
          worktreeId: "wt-bg",
          location: "background",
          agentState: "waiting",
          detectedAgentId: "claude",
        },
      } as unknown as ReturnType<typeof usePanelStore.getState>,
      panelIds: ["term-waiting"],
      panelIdsByWorktreeId: { "wt-bg": ["term-waiting"] },
    } as never);
    setFleetRuns([{ runId: "term-waiting", agentState: "waiting", waitingReason: "approval" }]);
    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).not.toContain("wt-bg");
  });

  it("excludes excludeFromPersistence terminals from quickStateFilter matching", () => {
    useWorktreeFilterStore.setState({ quickStateFilter: "waiting" });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "wt-eph", name: "eph", branch: "feature/eph" }),
    ]);
    usePanelStore.setState({
      panelsById: {
        "term-waiting": {
          id: "term-waiting",
          kind: "terminal",
          type: "terminal",
          worktreeId: "wt-eph",
          location: "grid",
          excludeFromPersistence: true,
          agentState: "waiting",
          detectedAgentId: "claude",
        },
      } as unknown as ReturnType<typeof usePanelStore.getState>,
      panelIds: ["term-waiting"],
      panelIdsByWorktreeId: { "wt-eph": ["term-waiting"] },
    } as never);
    setFleetRuns([{ runId: "term-waiting", agentState: "waiting", waitingReason: "approval" }]);
    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).not.toContain("wt-eph");
  });

  it("routes only a merged PR to Finished, not an open, closed or declined one (#9731, #13234)", () => {
    useWorktreeFilterStore.setState({ quickStateFilter: "finished" });
    const pr = (id: string, state: "open" | "merged" | "closed" | "declined") =>
      createSnapshot({
        id,
        name: id,
        branch: `feature/${id}`,
        issueNumber: 1,
        ...prLinkedSnapshot(state),
        worktreeChanges: cleanChanges(id),
      });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      pr("wt-merged", "merged"),
      pr("wt-open", "open"),
      pr("wt-closed", "closed"),
      pr("wt-declined", "declined"),
    ]);

    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).toContain("wt-merged");
    // An open PR on a clean tree says nothing about the agents (#13234).
    expect(ids).not.toContain("wt-open");
    expect(ids).not.toContain("wt-closed");
    expect(ids).not.toContain("wt-declined");
  });

  describe("buckets from the agents' fleet bands (#13234)", () => {
    beforeEach(() => {
      setWorktrees([
        createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
        createSnapshot({ id: "wt-mixed", name: "mixed", branch: "feature/mixed" }),
        createSnapshot({ id: "wt-idle", name: "idle", branch: "feature/idle" }),
        createSnapshot({ id: "wt-asking", name: "asking", branch: "feature/asking" }),
      ]);
      setAgentPanels(
        {
          "wt-mixed": ["a-working", "a-seen"],
          "wt-idle": ["a-prompt"],
          "wt-asking": ["a-approval"],
        },
        "waiting"
      );
      setFleetRuns([
        { runId: "a-working", agentState: "working" },
        {
          runId: "a-seen",
          agentState: "waiting",
          waitingReason: "prompt",
          handBack: { stoppedAt: 1, seenAt: 2 },
        },
        {
          runId: "a-prompt",
          agentState: "waiting",
          waitingReason: "prompt",
          handBack: { stoppedAt: 1 },
        },
        {
          runId: "a-approval",
          agentState: "waiting",
          waitingReason: "approval",
          canopy: { kind: "asked", quote: "Run the migration?", readAt: 1, seen: false },
        },
      ]);
    });

    function visibleUnder(filter: "working" | "waiting" | "finished"): string[] {
      useWorktreeFilterStore.setState({ quickStateFilter: filter, alwaysShowWaiting: false });
      return getVisibleWorktreesForCycling()
        .map((w) => w.id)
        .filter((id) => id !== "main");
    }

    it("counts a working agent beside an idle one as Working only", () => {
      expect(visibleUnder("working")).toEqual(["wt-mixed"]);
    });

    it("cycles Attention through agents asking for something, not agents at their prompt", () => {
      expect(visibleUnder("waiting")).toEqual(["wt-asking"]);
    });

    it("puts a lone agent that handed back at its prompt in Finished", () => {
      expect(visibleUnder("finished")).toEqual(["wt-idle"]);
    });
  });

  it("excludes non-agent terminals from quickStateFilter matching", () => {
    useWorktreeFilterStore.setState({ quickStateFilter: "waiting" });
    setWorktrees([
      createSnapshot({ id: "main", name: "main", branch: "main", isMainWorktree: true }),
      createSnapshot({ id: "wt-shell", name: "shell", branch: "feature/shell" }),
    ]);
    // Plain shell terminal — no detectedAgentId, launchAgentId, or runtimeIdentity
    usePanelStore.setState({
      panelsById: {
        "term-plain": {
          id: "term-plain",
          kind: "terminal",
          type: "terminal",
          worktreeId: "wt-shell",
          location: "grid",
          agentState: "waiting",
        },
      } as unknown as ReturnType<typeof usePanelStore.getState>,
      panelIds: ["term-plain"],
      panelIdsByWorktreeId: { "wt-shell": ["term-plain"] },
    } as never);
    setFleetRuns([{ runId: "term-plain", agentState: "waiting", waitingReason: "approval" }]);
    const ids = getVisibleWorktreesForCycling().map((w) => w.id);
    expect(ids).not.toContain("wt-shell");
  });
});
