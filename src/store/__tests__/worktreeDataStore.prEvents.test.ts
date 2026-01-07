import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorktreeState } from "@shared/types";
import type { PRDetectedPayload, PRClearedPayload, IssueDetectedPayload } from "../../types";

let mockOnPRDetectedCallback: ((data: PRDetectedPayload) => void) | null = null;
let mockOnPRClearedCallback: ((data: PRClearedPayload) => void) | null = null;
let mockOnIssueDetectedCallback: ((data: IssueDetectedPayload) => void) | null = null;

vi.mock("@/clients", () => ({
  worktreeClient: {
    getAll: vi.fn().mockResolvedValue([]),
    refresh: vi.fn().mockResolvedValue(undefined),
    onUpdate: vi.fn(() => () => {}),
    onRemove: vi.fn(() => () => {}),
  },
  githubClient: {
    onPRDetected: vi.fn((callback) => {
      mockOnPRDetectedCallback = callback;
      return () => {
        mockOnPRDetectedCallback = null;
      };
    }),
    onPRCleared: vi.fn((callback) => {
      mockOnPRClearedCallback = callback;
      return () => {
        mockOnPRClearedCallback = null;
      };
    }),
    onIssueDetected: vi.fn((callback) => {
      mockOnIssueDetectedCallback = callback;
      return () => {
        mockOnIssueDetectedCallback = null;
      };
    }),
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
      trashTerminal: vi.fn(),
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
const { worktreeClient } = await import("@/clients");

async function waitForInitialized() {
  await vi.waitFor(
    () => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
      expect(mockOnPRDetectedCallback).toBeTypeOf("function");
      expect(mockOnPRClearedCallback).toBeTypeOf("function");
      expect(mockOnIssueDetectedCallback).toBeTypeOf("function");
    },
    { timeout: 1000 }
  );
}

function createMockWorktree(id: string, prNumber?: number): WorktreeState {
  return {
    id,
    worktreeId: id,
    name: `worktree-${id}`,
    path: `/test/${id}`,
    branch: `feature/${id}`,
    isCurrent: false,
    isMainWorktree: false,
    worktreeChanges: null,
    lastActivityTimestamp: null,
    prNumber,
    prUrl: prNumber ? `https://github.com/test/repo/pull/${prNumber}` : undefined,
    prState: prNumber ? "open" : undefined,
    prTitle: prNumber ? `Test PR ${prNumber}` : undefined,
  };
}

describe("worktreeDataStore PR events", () => {
  beforeEach(() => {
    cleanupWorktreeDataStore();
    useWorktreeDataStore.setState({ isInitialized: false });
    mockOnPRDetectedCallback = null;
    mockOnPRClearedCallback = null;
    mockOnIssueDetectedCallback = null;
  });

  it("merges PR detected event into existing worktree", async () => {
    const store = useWorktreeDataStore;
    const mockWorktree = createMockWorktree("wt-1");

    vi.mocked(worktreeClient.getAll).mockResolvedValueOnce([mockWorktree]);
    store.getState().initialize();
    await waitForInitialized();

    expect(mockOnPRDetectedCallback).toBeTruthy();

    mockOnPRDetectedCallback!({
      worktreeId: "wt-1",
      prNumber: 123,
      prUrl: "https://github.com/test/repo/pull/123",
      prState: "open",
      prTitle: "Add new feature",
      issueTitle: "Implement new feature",
      timestamp: Date.now(),
    });

    const updated = store.getState().worktrees.get("wt-1");
    expect(updated?.prNumber).toBe(123);
    expect(updated?.prUrl).toBe("https://github.com/test/repo/pull/123");
    expect(updated?.prState).toBe("open");
    expect(updated?.prTitle).toBe("Add new feature");
    expect(updated?.issueTitle).toBe("Implement new feature");
    expect(updated?.name).toBe("worktree-wt-1");
  });

  it("ignores PR detected event for non-existent worktree", async () => {
    const store = useWorktreeDataStore;

    store.getState().initialize();
    await waitForInitialized();

    const initialWorktrees = new Map(store.getState().worktrees);

    mockOnPRDetectedCallback!({
      worktreeId: "non-existent",
      prNumber: 456,
      prUrl: "https://github.com/test/repo/pull/456",
      prState: "open",
      timestamp: Date.now(),
    });

    expect(store.getState().worktrees).toEqual(initialWorktrees);
  });

  it("clears PR fields when PR cleared event fires", async () => {
    const store = useWorktreeDataStore;
    const mockWorktree = createMockWorktree("wt-2", 789);

    vi.mocked(worktreeClient.getAll).mockResolvedValueOnce([mockWorktree]);
    store.getState().initialize();
    await waitForInitialized();

    expect(store.getState().worktrees.get("wt-2")?.prNumber).toBe(789);

    mockOnPRClearedCallback!({
      worktreeId: "wt-2",
      timestamp: Date.now(),
    });

    const updated = store.getState().worktrees.get("wt-2");
    expect(updated?.prNumber).toBeUndefined();
    expect(updated?.prUrl).toBeUndefined();
    expect(updated?.prState).toBeUndefined();
    expect(updated?.prTitle).toBeUndefined();
    expect(updated?.name).toBe("worktree-wt-2");
  });

  it("ignores PR cleared event for non-existent worktree", async () => {
    const store = useWorktreeDataStore;

    store.getState().initialize();
    await waitForInitialized();

    const initialWorktrees = new Map(store.getState().worktrees);

    mockOnPRClearedCallback!({
      worktreeId: "non-existent",
      timestamp: Date.now(),
    });

    expect(store.getState().worktrees).toEqual(initialWorktrees);
  });

  it("unsubscribes from PR events on cleanup", async () => {
    const store = useWorktreeDataStore;

    store.getState().initialize();
    await waitForInitialized();

    expect(mockOnPRDetectedCallback).toBeTruthy();
    expect(mockOnPRClearedCallback).toBeTruthy();
    expect(mockOnIssueDetectedCallback).toBeTruthy();

    cleanupWorktreeDataStore();

    expect(mockOnPRDetectedCallback).toBeNull();
    expect(mockOnPRClearedCallback).toBeNull();
    expect(mockOnIssueDetectedCallback).toBeNull();
  });

  it("handles merged PR state", async () => {
    const store = useWorktreeDataStore;
    const mockWorktree = createMockWorktree("wt-3");

    vi.mocked(worktreeClient.getAll).mockResolvedValueOnce([mockWorktree]);
    store.getState().initialize();
    await waitForInitialized();

    mockOnPRDetectedCallback!({
      worktreeId: "wt-3",
      prNumber: 999,
      prUrl: "https://github.com/test/repo/pull/999",
      prState: "merged",
      prTitle: "Merged feature",
      timestamp: Date.now(),
    });

    const updated = store.getState().worktrees.get("wt-3");
    expect(updated?.prNumber).toBe(999);
    expect(updated?.prState).toBe("merged");
    expect(updated?.prTitle).toBe("Merged feature");
  });

  it("handles closed PR state", async () => {
    const store = useWorktreeDataStore;
    const mockWorktree = createMockWorktree("wt-4");

    vi.mocked(worktreeClient.getAll).mockResolvedValueOnce([mockWorktree]);
    store.getState().initialize();
    await waitForInitialized();

    mockOnPRDetectedCallback!({
      worktreeId: "wt-4",
      prNumber: 888,
      prUrl: "https://github.com/test/repo/pull/888",
      prState: "closed",
      prTitle: "Closed PR",
      timestamp: Date.now(),
    });

    const updated = store.getState().worktrees.get("wt-4");
    expect(updated?.prNumber).toBe(888);
    expect(updated?.prState).toBe("closed");
    expect(updated?.prTitle).toBe("Closed PR");
  });

  it("overwrites existing PR with new PR", async () => {
    const store = useWorktreeDataStore;
    const mockWorktree = createMockWorktree("wt-5", 100);

    vi.mocked(worktreeClient.getAll).mockResolvedValueOnce([mockWorktree]);
    store.getState().initialize();
    await waitForInitialized();

    expect(store.getState().worktrees.get("wt-5")?.prNumber).toBe(100);

    mockOnPRDetectedCallback!({
      worktreeId: "wt-5",
      prNumber: 200,
      prUrl: "https://github.com/test/repo/pull/200",
      prState: "open",
      prTitle: "Updated PR",
      timestamp: Date.now(),
    });

    const updated = store.getState().worktrees.get("wt-5");
    expect(updated?.prNumber).toBe(200);
    expect(updated?.prUrl).toBe("https://github.com/test/repo/pull/200");
    expect(updated?.prState).toBe("open");
    expect(updated?.prTitle).toBe("Updated PR");
  });
});
