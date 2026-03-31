import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@shared/types";

const getAllMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("@/clients", () => ({
  worktreeClient: {
    getAll: getAllMock,
    refresh: refreshMock,
    getIssueAssociation: vi.fn().mockResolvedValue(null),
    getAllIssueAssociations: vi.fn().mockResolvedValue({}),
    onUpdate: vi.fn(() => () => {}),
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

const {
  useWorktreeDataStore,
  cleanupWorktreeDataStore,
  forceReinitializeWorktreeDataStore,
  prePopulateWorktreeSnapshot,
  snapshotProjectWorktrees,
  resetSnapshotCacheForTests,
} = await import("../worktreeDataStore");

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

describe("worktreeDataStore project switch race conditions", () => {
  beforeEach(() => {
    // Use mockReset (not just clearAllMocks) to flush any unconsumed mockReturnValueOnce
    // queues that might leak between tests.
    getAllMock.mockReset();
    refreshMock.mockReset();
    vi.clearAllMocks();
    cleanupWorktreeDataStore();
    // Clear the snapshot cache so earlier test runs cannot supply pre-cached
    // data to prePopulateWorktreeSnapshot() calls in later tests.
    resetSnapshotCacheForTests();
    useWorktreeDataStore.setState({
      worktrees: new Map(),
      projectId: null,
      isLoading: true,
      error: null,
      isInitialized: false,
    });
  });

  it("discards stale initialize response that resolves after project switch", async () => {
    const projectAWorktrees = [
      createMockWorktree("project-a-main", { isMainWorktree: true }),
      createMockWorktree("project-a-feature"),
    ];
    const projectBWorktrees = [createMockWorktree("project-b-main", { isMainWorktree: true })];

    let resolveProjectA!: (value: WorktreeState[]) => void;
    const projectAPromise = new Promise<WorktreeState[]>((resolve) => {
      resolveProjectA = resolve;
    });

    getAllMock.mockReturnValueOnce(projectAPromise);
    getAllMock.mockResolvedValueOnce(projectBWorktrees);

    // Start initialization for project A (will be pending)
    useWorktreeDataStore.getState().initialize();

    // Switch to project B before the first getAll resolves
    forceReinitializeWorktreeDataStore("project-b");

    // Wait for project B to finish initializing
    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    // Now deliver the stale project A response
    resolveProjectA(projectAWorktrees);

    // Flush microtasks so stale callback can attempt to run
    await Promise.resolve();
    await Promise.resolve();

    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.has("project-b-main")).toBe(true);
    expect(state.worktrees.has("project-a-main")).toBe(false);
    expect(state.worktrees.has("project-a-feature")).toBe(false);
  });

  it("discards stale refresh getAll response that resolves after project switch", async () => {
    const projectAWorktrees = [createMockWorktree("project-a-main", { isMainWorktree: true })];
    const projectBWorktrees = [createMockWorktree("project-b-main", { isMainWorktree: true })];

    // Initialize project A
    getAllMock.mockResolvedValueOnce(projectAWorktrees);
    refreshMock.mockResolvedValue(undefined);

    useWorktreeDataStore.getState().initialize();
    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    // Use a controlled refreshMock so we can let refresh() pass its first scope check
    // before the project switch (ensuring getAll() is actually called in-flight).
    let resolveRefreshMock!: () => void;
    const refreshMockPromise = new Promise<void>((resolve) => {
      resolveRefreshMock = resolve;
    });
    refreshMock.mockReturnValueOnce(refreshMockPromise);

    // The refresh's getAll() call will hang; B's initialize will use projectBWorktrees.
    let resolveRefreshGetAll!: (value: WorktreeState[]) => void;
    const refreshGetAllPromise = new Promise<WorktreeState[]>((resolve) => {
      resolveRefreshGetAll = resolve;
    });
    getAllMock.mockReturnValueOnce(refreshGetAllPromise); // refresh's getAll
    getAllMock.mockResolvedValueOnce(projectBWorktrees); // B's initialize's getAll

    const storeRefreshPromise = useWorktreeDataStore.getState().refresh();

    // Resolve the refresh mock so that refresh() passes its first scope check and calls getAll().
    resolveRefreshMock();

    // Yield once so refresh() processes the refreshMock resolution and suspends on getAll().
    await Promise.resolve();

    // Switch project NOW — refresh()'s getAll() is in-flight, scope changes.
    forceReinitializeWorktreeDataStore("project-b");

    // Wait for project B to initialize.
    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    // Deliver the stale refresh getAll() response — should be discarded.
    resolveRefreshGetAll(projectAWorktrees);
    await storeRefreshPromise;

    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.has("project-b-main")).toBe(true);
    expect(state.worktrees.has("project-a-main")).toBe(false);
  });

  it("handles rapid back-to-back project switches with only the final project's worktrees shown", async () => {
    type Deferred = { resolve: (v: WorktreeState[]) => void; worktrees: WorktreeState[] };
    const deferred: Deferred[] = [];

    for (const project of ["a", "b", "c"]) {
      let resolveWorktrees!: (value: WorktreeState[]) => void;
      const promise = new Promise<WorktreeState[]>((resolve) => {
        resolveWorktrees = resolve;
      });
      deferred.push({
        resolve: resolveWorktrees,
        worktrees: [createMockWorktree(`${project}-main`, { isMainWorktree: true })],
      });
      getAllMock.mockReturnValueOnce(promise);
    }

    // Rapid switches: A → B → C (C is the final project)
    useWorktreeDataStore.getState().initialize();
    forceReinitializeWorktreeDataStore("project-b");
    forceReinitializeWorktreeDataStore("project-c");

    // Resolve in reverse order: C first (current project), then stale A and B.
    deferred[2].resolve(deferred[2].worktrees);
    deferred[0].resolve(deferred[0].worktrees);
    deferred[1].resolve(deferred[1].worktrees);

    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    // Flush any remaining microtasks from stale callbacks.
    await Promise.resolve();
    await Promise.resolve();

    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.has("c-main")).toBe(true);
    expect(state.worktrees.has("a-main")).toBe(false);
    expect(state.worktrees.has("b-main")).toBe(false);
    expect(state.worktrees.size).toBe(1);
  });

  it("blocks refresh() during the prePopulate→forceReinit window to prevent cross-project contamination", async () => {
    const projectAWorktrees = [createMockWorktree("project-a-main", { isMainWorktree: true })];
    const projectBWorktrees = [createMockWorktree("project-b-main", { isMainWorktree: true })];

    // Initialize project A.
    getAllMock.mockResolvedValueOnce(projectAWorktrees);
    refreshMock.mockResolvedValue(undefined);

    useWorktreeDataStore.getState().initialize();
    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    // Simulate project switch: cleanup → prePopulate (main process switch in-flight).
    cleanupWorktreeDataStore();
    prePopulateWorktreeSnapshot("project-b");

    // At this point isSwitching = true.  A refresh() triggered by the sidebar refresh
    // button must be rejected — the main process is still on project A.
    const getAllCallsBefore = getAllMock.mock.calls.length;
    const refreshCallsBefore = refreshMock.mock.calls.length;

    await useWorktreeDataStore.getState().refresh();

    // Neither worktreeClient.refresh nor worktreeClient.getAll should have been called.
    expect(refreshMock.mock.calls.length).toBe(refreshCallsBefore);
    expect(getAllMock.mock.calls.length).toBe(getAllCallsBefore);

    // Now simulate main process switch completing → forceReinit clears the lock.
    getAllMock.mockResolvedValueOnce(projectBWorktrees);
    forceReinitializeWorktreeDataStore("project-b");

    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    // Only project B's worktrees must be in the store.
    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.has("project-b-main")).toBe(true);
    expect(state.worktrees.has("project-a-main")).toBe(false);
    expect(state.projectId).toBe("project-b");
  });

  it("allows refresh() after forceReinitializeWorktreeDataStore clears the switching lock", async () => {
    const projectBWorktrees = [createMockWorktree("project-b-main", { isMainWorktree: true })];
    const projectBWorktreesAfterRefresh = [
      createMockWorktree("project-b-main", { isMainWorktree: true }),
      createMockWorktree("project-b-feature"),
    ];

    // Go through the full switch flow to project B.
    cleanupWorktreeDataStore();
    prePopulateWorktreeSnapshot("project-b");
    getAllMock.mockResolvedValueOnce(projectBWorktrees);
    forceReinitializeWorktreeDataStore("project-b");

    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    // Now refresh() must work normally (isSwitching = false after forceReinit).
    // refreshMock returns undefined (already configured) and getAll returns updated list.
    refreshMock.mockResolvedValue(undefined);
    getAllMock.mockResolvedValueOnce(projectBWorktreesAfterRefresh);

    const refreshCallsBefore = refreshMock.mock.calls.length;
    await useWorktreeDataStore.getState().refresh();

    // Verify that the IPC refresh was actually invoked (lock was cleared).
    expect(refreshMock.mock.calls.length).toBe(refreshCallsBefore + 1);

    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.has("project-b-main")).toBe(true);
    expect(state.worktrees.has("project-b-feature")).toBe(true);
    expect(state.worktrees.has("project-a-main")).toBe(false);
    expect(state.worktrees.size).toBe(2);
    expect(state.projectId).toBe("project-b");
  });
});

describe("worktreeDataStore snapshot contamination detection", () => {
  beforeEach(() => {
    getAllMock.mockReset();
    refreshMock.mockReset();
    vi.clearAllMocks();
    cleanupWorktreeDataStore();
    resetSnapshotCacheForTests();
    useWorktreeDataStore.setState({
      worktrees: new Map(),
      projectId: null,
      isLoading: true,
      error: null,
      isInitialized: false,
    });
  });

  it("snapshotProjectWorktrees refuses to cache when main worktree path does not match project path", async () => {
    const worktrees = new Map([
      [
        "wt-main",
        createMockWorktree("wt-main", {
          isMainWorktree: true,
          path: "/repos/project-b",
        }),
      ],
      [
        "wt-feature",
        createMockWorktree("wt-feature", {
          path: "/repos/project-b-worktrees/feature-1",
        }),
      ],
    ]);

    useWorktreeDataStore.setState({
      worktrees,
      projectId: "project-a",
      isLoading: false,
      isInitialized: true,
    });

    // Snapshot with project path that doesn't match the main worktree
    snapshotProjectWorktrees("project-a", "/repos/project-a");

    // Prepopulate should have nothing cached
    prePopulateWorktreeSnapshot("project-a", "/repos/project-a");
    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.size).toBe(0);
    expect(state.isLoading).toBe(true);
  });

  it("prePopulateWorktreeSnapshot discards a poisoned cached snapshot and leaves store in loading state", async () => {
    // Simulate a poisoned cache: project-a's key has project-b's worktrees
    const projectBWorktrees = [
      createMockWorktree("project-b-main", {
        isMainWorktree: true,
        path: "/repos/project-b",
      }),
    ];

    // First, put poisoned data in the cache by setting store state and snapshotting
    // WITHOUT the projectPath guard (simulating pre-fix behavior).
    useWorktreeDataStore.setState({
      worktrees: new Map(projectBWorktrees.map((wt) => [wt.id, wt])),
      projectId: "project-a",
      isLoading: false,
      isInitialized: true,
    });
    // Snapshot without path validation (simulates legacy cache entry)
    snapshotProjectWorktrees("project-a");

    // Now try to restore with path validation
    cleanupWorktreeDataStore();
    prePopulateWorktreeSnapshot("project-a", "/repos/project-a");

    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.size).toBe(0);
    expect(state.isLoading).toBe(true);
    expect(state.projectId).toBe("project-a");
  });

  it("prePopulateWorktreeSnapshot restores a valid snapshot when paths match", async () => {
    const projectAWorktrees = [
      createMockWorktree("project-a-main", {
        isMainWorktree: true,
        path: "/repos/project-a",
      }),
      createMockWorktree("project-a-feature", {
        path: "/repos/project-a-worktrees/feature-1",
      }),
    ];

    useWorktreeDataStore.setState({
      worktrees: new Map(projectAWorktrees.map((wt) => [wt.id, wt])),
      projectId: "project-a",
      isLoading: false,
      isInitialized: true,
    });
    snapshotProjectWorktrees("project-a", "/repos/project-a");

    cleanupWorktreeDataStore();
    prePopulateWorktreeSnapshot("project-a", "/repos/project-a");

    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.size).toBe(2);
    expect(state.worktrees.has("project-a-main")).toBe(true);
    expect(state.isLoading).toBe(false);
  });

  it("rejects snapshot with multiple main worktrees (contamination indicator)", () => {
    const worktrees = new Map([
      [
        "wt-main-a",
        createMockWorktree("wt-main-a", {
          isMainWorktree: true,
          path: "/repos/project-a",
        }),
      ],
      [
        "wt-main-b",
        createMockWorktree("wt-main-b", {
          isMainWorktree: true,
          path: "/repos/project-b",
        }),
      ],
    ]);

    useWorktreeDataStore.setState({
      worktrees,
      projectId: "project-a",
      isLoading: false,
      isInitialized: true,
    });

    snapshotProjectWorktrees("project-a", "/repos/project-a");

    prePopulateWorktreeSnapshot("project-a", "/repos/project-a");
    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.size).toBe(0);
    expect(state.isLoading).toBe(true);
  });
});

const { worktreeClient } = await import("@/clients");

describe("worktreeDataStore scope-based event filtering", () => {
  let capturedOnUpdate: ((state: WorktreeState, scopeId: string) => void) | null = null;

  beforeEach(() => {
    getAllMock.mockReset();
    refreshMock.mockReset();
    capturedOnUpdate = null;
    vi.mocked(worktreeClient.onUpdate).mockImplementation((cb) => {
      capturedOnUpdate = cb;
      return () => {
        capturedOnUpdate = null;
      };
    });
    cleanupWorktreeDataStore();
    resetSnapshotCacheForTests();
    useWorktreeDataStore.setState({
      worktrees: new Map(),
      projectId: null,
      isLoading: true,
      error: null,
      isInitialized: false,
    });
  });

  it("discards onUpdate events with mismatched scopeId", async () => {
    const projectBWorktrees = [createMockWorktree("project-b-main", { isMainWorktree: true })];
    getAllMock.mockResolvedValueOnce(projectBWorktrees);

    forceReinitializeWorktreeDataStore("project-b", "scope-b");

    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    expect(capturedOnUpdate).not.toBeNull();

    // Simulate stale event from old scope
    capturedOnUpdate!(createMockWorktree("stale-wt", { path: "/stale" }), "scope-a-old");

    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.has("stale-wt")).toBe(false);
    expect(state.worktrees.has("project-b-main")).toBe(true);
  });

  it("accepts onUpdate events with matching scopeId", async () => {
    const projectBWorktrees = [createMockWorktree("project-b-main", { isMainWorktree: true })];
    getAllMock.mockResolvedValueOnce(projectBWorktrees);

    forceReinitializeWorktreeDataStore("project-b", "scope-b");

    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    // Simulate valid event from current scope
    capturedOnUpdate!(createMockWorktree("new-wt", { path: "/new" }), "scope-b");

    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.has("new-wt")).toBe(true);
  });

  it("accepts events when no scopeId is set (backwards compatibility)", async () => {
    const projectBWorktrees = [createMockWorktree("project-b-main", { isMainWorktree: true })];
    getAllMock.mockResolvedValueOnce(projectBWorktrees);

    // No scopeId passed — targetScopeId stays null
    forceReinitializeWorktreeDataStore("project-b");

    await vi.waitFor(() => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
    });

    capturedOnUpdate!(createMockWorktree("any-wt", { path: "/any" }), "any-scope");

    const state = useWorktreeDataStore.getState();
    expect(state.worktrees.has("any-wt")).toBe(true);
  });
});
