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

describe("worktreeDataStore project switch race conditions", () => {
  beforeEach(() => {
    // Use mockReset (not just clearAllMocks) to flush any unconsumed mockReturnValueOnce
    // queues that might leak between tests.
    getAllMock.mockReset();
    refreshMock.mockReset();
    vi.clearAllMocks();
    cleanupWorktreeDataStore();
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
});
