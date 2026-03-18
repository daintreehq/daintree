import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@shared/types";

let onUpdateCallback: ((state: WorktreeState) => void) | null = null;

const getAllMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("@/clients", () => ({
  worktreeClient: {
    getAll: getAllMock,
    refresh: refreshMock,
    getAllIssueAssociations: vi.fn().mockResolvedValue({}),
    onUpdate: vi.fn((callback: (state: WorktreeState) => void) => {
      onUpdateCallback = callback;
      return () => {
        onUpdateCallback = null;
      };
    }),
    onRemove: vi.fn(() => () => {}),
    onActivated: vi.fn(() => () => {}),
  },
  githubClient: {
    onPRDetected: vi.fn(() => () => {}),
    onPRCleared: vi.fn(() => () => {}),
    onIssueDetected: vi.fn(() => () => {}),
    onIssueNotFound: vi.fn(() => () => {}),
  },
}));

vi.mock("../worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: vi.fn(() => ({
      activeWorktreeId: null,
      setActiveWorktree: vi.fn(),
    })),
  },
}));

vi.mock("../terminalStore", () => ({
  useTerminalStore: {
    getState: vi.fn(() => ({
      terminals: [],
      removeTerminal: vi.fn(),
    })),
  },
}));

vi.mock("../notificationStore", () => ({
  useNotificationStore: {
    getState: vi.fn(() => ({
      addNotification: vi.fn(),
    })),
  },
}));

const { useWorktreeDataStore, cleanupWorktreeDataStore, forceReinitializeWorktreeDataStore } =
  await import("../worktreeDataStore");

function createMockWorktree(id: string, overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    id,
    worktreeId: id,
    name: id,
    path: `/tmp/${id}`,
    branch: `feature/${id}`,
    isCurrent: false,
    isMainWorktree: false,
    worktreeChanges: null,
    lastActivityTimestamp: null,
    ...overrides,
  };
}

describe("worktreeDataStore.refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onUpdateCallback = null;
    cleanupWorktreeDataStore();
    useWorktreeDataStore.setState({
      worktrees: new Map(),
      projectId: null,
      isLoading: true,
      error: null,
      isInitialized: false,
    });
  });

  it("reconciles worktrees from getAll after refresh even without push updates", async () => {
    const main = createMockWorktree("main", { isMainWorktree: true, branch: "main" });
    const created = createMockWorktree("feature-123");

    getAllMock.mockResolvedValueOnce([main]);
    refreshMock.mockResolvedValue(undefined);

    useWorktreeDataStore.getState().initialize();
    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    getAllMock.mockResolvedValueOnce([main, created]);

    await useWorktreeDataStore.getState().refresh();

    const state = useWorktreeDataStore.getState();
    expect(Array.from(state.worktrees.keys())).toEqual(["main", "feature-123"]);
  });

  it("preserves in-flight metadata when refresh snapshots are incomplete", async () => {
    const main = createMockWorktree("main", { isMainWorktree: true, branch: "main" });
    const feature = createMockWorktree("feature-abc");

    getAllMock.mockResolvedValueOnce([main, feature]);
    refreshMock.mockResolvedValue(undefined);

    useWorktreeDataStore.getState().initialize();
    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
      expect(onUpdateCallback).toBeTypeOf("function");
    });

    onUpdateCallback?.({
      ...feature,
      prNumber: 42,
      prUrl: "https://example.com/pr/42",
      prState: "open",
      prTitle: "WIP PR",
    });

    // Refresh returns a partial snapshot (missing PR metadata) plus a newly created worktree.
    const created = createMockWorktree("feature-new");
    getAllMock.mockResolvedValueOnce([main, feature, created]);

    await useWorktreeDataStore.getState().refresh();

    const refreshedFeature = useWorktreeDataStore.getState().worktrees.get("feature-abc");
    expect(refreshedFeature?.prNumber).toBe(42);
    expect(refreshedFeature?.prTitle).toBe("WIP PR");
    expect(useWorktreeDataStore.getState().worktrees.get("feature-new")).toBeDefined();
  });

  it("preserves object reference for unchanged worktrees across a refresh cycle", async () => {
    const main = createMockWorktree("main", { isMainWorktree: true, branch: "main" });
    const feature = createMockWorktree("feature-stable", {
      modifiedCount: 3,
      mood: "active",
    });

    getAllMock.mockResolvedValueOnce([main, feature]);
    refreshMock.mockResolvedValue(undefined);

    useWorktreeDataStore.getState().initialize();
    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    const mainBefore = useWorktreeDataStore.getState().worktrees.get("main");
    const featureBefore = useWorktreeDataStore.getState().worktrees.get("feature-stable");
    expect(mainBefore).toBeDefined();
    expect(featureBefore).toBeDefined();

    // Refresh: main changes its modifiedCount; feature-stable data is identical.
    const mainChanged = { ...main, modifiedCount: 1 };
    const featureUnchanged = { ...feature };
    getAllMock.mockResolvedValueOnce([mainChanged, featureUnchanged]);

    await useWorktreeDataStore.getState().refresh();

    // B (feature-stable) should keep the same reference — nothing changed.
    const featureAfter = useWorktreeDataStore.getState().worktrees.get("feature-stable");
    expect(featureAfter).toBe(featureBefore);

    // A (main) should have a new reference — modifiedCount changed.
    const mainAfter = useWorktreeDataStore.getState().worktrees.get("main");
    expect(mainAfter).not.toBe(mainBefore);
    expect(mainAfter?.modifiedCount).toBe(1);
  });

  it("preserves Map identity when refresh returns identical data", async () => {
    const main = createMockWorktree("main", { isMainWorktree: true, branch: "main" });
    const feature = createMockWorktree("feature-stable", { modifiedCount: 3 });

    getAllMock.mockResolvedValueOnce([main, feature]);
    refreshMock.mockResolvedValue(undefined);

    useWorktreeDataStore.getState().initialize();
    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    const mapBefore = useWorktreeDataStore.getState().worktrees;

    // Refresh with value-equal but new object spreads — no actual data change.
    getAllMock.mockResolvedValueOnce([{ ...main }, { ...feature }]);

    await useWorktreeDataStore.getState().refresh();

    const mapAfter = useWorktreeDataStore.getState().worktrees;
    expect(mapAfter).toBe(mapBefore);
  });

  it("returns new Map identity when a worktree changes", async () => {
    const main = createMockWorktree("main", { isMainWorktree: true, branch: "main" });
    const feature = createMockWorktree("feature-changing", { modifiedCount: 0 });

    getAllMock.mockResolvedValueOnce([main, feature]);
    refreshMock.mockResolvedValue(undefined);

    useWorktreeDataStore.getState().initialize();
    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    const mapBefore = useWorktreeDataStore.getState().worktrees;
    const mainBefore = mapBefore.get("main");

    // feature-changing gets a new modifiedCount.
    getAllMock.mockResolvedValueOnce([{ ...main }, { ...feature, modifiedCount: 5 }]);

    await useWorktreeDataStore.getState().refresh();

    const mapAfter = useWorktreeDataStore.getState().worktrees;
    expect(mapAfter).not.toBe(mapBefore);
    // Unchanged entry should still preserve its individual reference.
    expect(mapAfter.get("main")).toBe(mainBefore);
  });

  it("returns new Map identity when a worktree is added", async () => {
    const main = createMockWorktree("main", { isMainWorktree: true, branch: "main" });

    getAllMock.mockResolvedValueOnce([main]);
    refreshMock.mockResolvedValue(undefined);

    useWorktreeDataStore.getState().initialize();
    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    const mapBefore = useWorktreeDataStore.getState().worktrees;

    // A new worktree appears.
    const added = createMockWorktree("feature-new");
    getAllMock.mockResolvedValueOnce([{ ...main }, added]);

    await useWorktreeDataStore.getState().refresh();

    const mapAfter = useWorktreeDataStore.getState().worktrees;
    expect(mapAfter).not.toBe(mapBefore);
    expect(mapAfter.size).toBe(2);
  });

  it("rejects stale onUpdate events arriving after a project switch (listenerGeneration guard)", async () => {
    const main = createMockWorktree("main", { isMainWorktree: true, branch: "main" });
    const foreignWorktree = createMockWorktree("foreign-wt");

    getAllMock.mockResolvedValueOnce([main]);
    refreshMock.mockResolvedValue(undefined);

    useWorktreeDataStore.getState().initialize();
    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
      expect(onUpdateCallback).toBeTypeOf("function");
    });

    // Capture the old listener before the project switch.
    const oldOnUpdateCallback = onUpdateCallback;

    // Switch to a new project — generation changes, old listeners torn down, new ones set up.
    getAllMock.mockResolvedValueOnce([
      createMockWorktree("new-project-main", { isMainWorktree: true }),
    ]);
    forceReinitializeWorktreeDataStore("new-project");

    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    // Fire the OLD onUpdate callback (simulates a delayed IPC push from the outgoing project).
    // The generation guard must reject it — it must NOT insert foreignWorktree into the store.
    oldOnUpdateCallback?.(foreignWorktree);

    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.has("foreign-wt")).toBe(false);
    expect(state.worktrees.has("new-project-main")).toBe(true);
  });
});
