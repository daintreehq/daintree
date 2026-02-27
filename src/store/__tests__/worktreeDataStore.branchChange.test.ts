import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@shared/types";

let onUpdateCallback: ((state: WorktreeState) => void) | null = null;

const getAllMock = vi.fn();
const refreshMock = vi.fn();
const getAllIssueAssociationsMock = vi.fn();

vi.mock("@/clients", () => ({
  worktreeClient: {
    getAll: getAllMock,
    refresh: refreshMock,
    getAllIssueAssociations: getAllIssueAssociationsMock,
    onUpdate: vi.fn((callback: (state: WorktreeState) => void) => {
      onUpdateCallback = callback;
      return () => {
        onUpdateCallback = null;
      };
    }),
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

const { useWorktreeDataStore, cleanupWorktreeDataStore } = await import("../worktreeDataStore");

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

describe("worktreeDataStore branch-change clearing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAllMock.mockResolvedValue([]);
    refreshMock.mockResolvedValue(undefined);
    getAllIssueAssociationsMock.mockResolvedValue({});
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

  describe("onUpdate handler", () => {
    it("clears issue/PR metadata when branch changes", async () => {
      const feature = createMockWorktree("wt-main", {
        branch: "bugfix/issue-2383-fix-window",
        isMainWorktree: true,
        issueNumber: 2383,
        issueTitle: "Fix window chrome",
        prNumber: 50,
        prUrl: "https://github.com/test/repo/pull/50",
        prState: "open",
        prTitle: "Fix window chrome PR",
      });

      getAllMock.mockResolvedValueOnce([feature]);
      useWorktreeDataStore.getState().initialize();
      await vi.waitFor(() => {
        expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
        expect(onUpdateCallback).toBeTypeOf("function");
      });

      expect(useWorktreeDataStore.getState().worktrees.get("wt-main")?.issueNumber).toBe(2383);

      onUpdateCallback!({
        ...feature,
        branch: "develop",
        issueNumber: undefined,
        issueTitle: undefined,
        prNumber: undefined,
        prUrl: undefined,
        prState: undefined,
        prTitle: undefined,
      });

      const updated = useWorktreeDataStore.getState().worktrees.get("wt-main");
      expect(updated?.branch).toBe("develop");
      expect(updated?.issueNumber).toBeUndefined();
      expect(updated?.issueTitle).toBeUndefined();
      expect(updated?.prNumber).toBeUndefined();
      expect(updated?.prUrl).toBeUndefined();
      expect(updated?.prState).toBeUndefined();
      expect(updated?.prTitle).toBeUndefined();
    });

    it("preserves metadata when branch stays the same and incoming values are undefined", async () => {
      const feature = createMockWorktree("wt-feat", {
        branch: "feature/issue-100-add-dark-mode",
        issueNumber: 100,
        issueTitle: "Add dark mode",
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
        prTitle: "Dark mode PR",
      });

      getAllMock.mockResolvedValueOnce([feature]);
      useWorktreeDataStore.getState().initialize();
      await vi.waitFor(() => {
        expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
        expect(onUpdateCallback).toBeTypeOf("function");
      });

      onUpdateCallback!({
        ...feature,
        issueNumber: undefined,
        issueTitle: undefined,
        prNumber: undefined,
        prUrl: undefined,
        prState: undefined,
        prTitle: undefined,
      });

      const updated = useWorktreeDataStore.getState().worktrees.get("wt-feat");
      expect(updated?.issueNumber).toBe(100);
      expect(updated?.issueTitle).toBe("Add dark mode");
      expect(updated?.prNumber).toBe(42);
      expect(updated?.prUrl).toBe("https://github.com/test/repo/pull/42");
      expect(updated?.prState).toBe("open");
      expect(updated?.prTitle).toBe("Dark mode PR");
    });

    it("clears all metadata (issue and PR) when switching to detached HEAD", async () => {
      const feature = createMockWorktree("wt-detach", {
        branch: "feature/issue-200-refactor",
        issueNumber: 200,
        issueTitle: "Refactor things",
        prNumber: 75,
        prUrl: "https://github.com/test/repo/pull/75",
        prState: "open",
        prTitle: "Refactor PR",
      });

      getAllMock.mockResolvedValueOnce([feature]);
      useWorktreeDataStore.getState().initialize();
      await vi.waitFor(() => {
        expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
        expect(onUpdateCallback).toBeTypeOf("function");
      });

      onUpdateCallback!({
        ...feature,
        branch: undefined,
        issueNumber: undefined,
        issueTitle: undefined,
        prNumber: undefined,
        prUrl: undefined,
        prState: undefined,
        prTitle: undefined,
      });

      const updated = useWorktreeDataStore.getState().worktrees.get("wt-detach");
      expect(updated?.branch).toBeUndefined();
      expect(updated?.issueNumber).toBeUndefined();
      expect(updated?.issueTitle).toBeUndefined();
      expect(updated?.prNumber).toBeUndefined();
      expect(updated?.prUrl).toBeUndefined();
      expect(updated?.prState).toBeUndefined();
      expect(updated?.prTitle).toBeUndefined();
    });

    it("clears metadata when switching between two different feature branches", async () => {
      const feature = createMockWorktree("wt-switch", {
        branch: "feature/issue-100-add-dark-mode",
        issueNumber: 100,
        issueTitle: "Add dark mode",
        prNumber: 55,
        prUrl: "https://github.com/test/repo/pull/55",
        prState: "open",
        prTitle: "Dark mode PR",
      });

      getAllMock.mockResolvedValueOnce([feature]);
      useWorktreeDataStore.getState().initialize();
      await vi.waitFor(() => {
        expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
        expect(onUpdateCallback).toBeTypeOf("function");
      });

      onUpdateCallback!({
        ...feature,
        branch: "feature/issue-999-other-feature",
        issueNumber: undefined,
        issueTitle: undefined,
        prNumber: undefined,
        prUrl: undefined,
        prState: undefined,
        prTitle: undefined,
      });

      const updated = useWorktreeDataStore.getState().worktrees.get("wt-switch");
      expect(updated?.branch).toBe("feature/issue-999-other-feature");
      expect(updated?.issueNumber).toBeUndefined();
      expect(updated?.issueTitle).toBeUndefined();
      expect(updated?.prNumber).toBeUndefined();
      expect(updated?.prUrl).toBeUndefined();
      expect(updated?.prState).toBeUndefined();
      expect(updated?.prTitle).toBeUndefined();
    });
  });

  describe("mergeFetchedWorktrees (via refresh)", () => {
    it("clears stale issue/PR metadata when fetched branch differs from existing", async () => {
      const main = createMockWorktree("wt-main", {
        branch: "bugfix/issue-2383-fix-window",
        isMainWorktree: true,
        issueNumber: 2383,
        issueTitle: "Fix window chrome",
        prNumber: 50,
        prUrl: "https://github.com/test/repo/pull/50",
        prState: "open",
        prTitle: "Fix window chrome PR",
      });

      getAllMock.mockResolvedValueOnce([main]);
      refreshMock.mockResolvedValue(undefined);

      useWorktreeDataStore.getState().initialize();
      await vi.waitFor(() => {
        expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
      });

      expect(useWorktreeDataStore.getState().worktrees.get("wt-main")?.issueNumber).toBe(2383);

      const refreshedMain = createMockWorktree("wt-main", {
        branch: "develop",
        isMainWorktree: true,
      });
      getAllMock.mockResolvedValueOnce([refreshedMain]);

      await useWorktreeDataStore.getState().refresh();

      const updated = useWorktreeDataStore.getState().worktrees.get("wt-main");
      expect(updated?.branch).toBe("develop");
      expect(updated?.issueNumber).toBeUndefined();
      expect(updated?.issueTitle).toBeUndefined();
      expect(updated?.prNumber).toBeUndefined();
      expect(updated?.prUrl).toBeUndefined();
      expect(updated?.prState).toBeUndefined();
      expect(updated?.prTitle).toBeUndefined();
    });

    it("preserves in-flight metadata when fetched branch matches existing", async () => {
      const feature = createMockWorktree("wt-feat", {
        branch: "feature/issue-100-dark-mode",
        issueNumber: 100,
        issueTitle: "Add dark mode",
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
        prTitle: "Dark mode PR",
      });

      getAllMock.mockResolvedValueOnce([feature]);
      refreshMock.mockResolvedValue(undefined);

      useWorktreeDataStore.getState().initialize();
      await vi.waitFor(() => {
        expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
      });

      const refreshedFeature = createMockWorktree("wt-feat", {
        branch: "feature/issue-100-dark-mode",
      });
      getAllMock.mockResolvedValueOnce([refreshedFeature]);

      await useWorktreeDataStore.getState().refresh();

      const updated = useWorktreeDataStore.getState().worktrees.get("wt-feat");
      expect(updated?.issueNumber).toBe(100);
      expect(updated?.issueTitle).toBe("Add dark mode");
      expect(updated?.prNumber).toBe(42);
      expect(updated?.prUrl).toBe("https://github.com/test/repo/pull/42");
      expect(updated?.prState).toBe("open");
      expect(updated?.prTitle).toBe("Dark mode PR");
    });
  });
});
