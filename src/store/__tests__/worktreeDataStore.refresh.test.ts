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

    const refBefore = useWorktreeDataStore.getState().worktrees.get("feature-stable");
    expect(refBefore).toBeDefined();

    // Refresh with identical data for feature-stable; only main changes.
    const mainChanged = { ...main, modifiedCount: 1 };
    const featureUnchanged = { ...feature };
    getAllMock.mockResolvedValueOnce([mainChanged, featureUnchanged]);

    await useWorktreeDataStore.getState().refresh();

    const refAfter = useWorktreeDataStore.getState().worktrees.get("feature-stable");
    expect(refAfter).toBe(refBefore);
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
