import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorktreeState } from "@shared/types";
import type {
  PRDetectedPayload,
  PRClearedPayload,
  IssueDetectedPayload,
  IssueNotFoundPayload,
} from "../../types";
import type { useWorktreeDataStore as UseWorktreeDataStoreType } from "../worktreeDataStore";

let mockOnPRDetectedCallback: ((data: PRDetectedPayload) => void) | null = null;
let mockOnPRClearedCallback: ((data: PRClearedPayload) => void) | null = null;
let mockOnIssueDetectedCallback: ((data: IssueDetectedPayload) => void) | null = null;
let mockOnIssueNotFoundCallback: ((data: IssueNotFoundPayload) => void) | null = null;

const getAllMock = vi.fn().mockResolvedValue([]);
const refreshMock = vi.fn().mockResolvedValue(undefined);
const getAllIssueAssociationsMock = vi.fn().mockResolvedValue({});

vi.mock("@/clients", () => ({
  worktreeClient: {
    getAll: getAllMock,
    refresh: refreshMock,
    getAllIssueAssociations: getAllIssueAssociationsMock,
    onUpdate: vi.fn(() => () => {}),
    onRemove: vi.fn(() => () => {}),
    onActivated: vi.fn(() => () => {}),
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
    onIssueNotFound: vi.fn((callback) => {
      mockOnIssueNotFoundCallback = callback;
      return () => {
        mockOnIssueNotFoundCallback = null;
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

vi.mock("../pulseStore", () => ({
  usePulseStore: {
    getState: vi.fn(() => ({
      invalidate: vi.fn(),
    })),
  },
}));

let useWorktreeDataStore: typeof UseWorktreeDataStoreType;

async function waitForInitialized() {
  await vi.waitFor(
    () => {
      expect(useWorktreeDataStore.getState().isInitialized).toBe(true);
      expect(mockOnPRDetectedCallback).toBeTypeOf("function");
      expect(mockOnPRClearedCallback).toBeTypeOf("function");
      expect(mockOnIssueDetectedCallback).toBeTypeOf("function");
      expect(mockOnIssueNotFoundCallback).toBeTypeOf("function");
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
  beforeEach(async () => {
    vi.clearAllMocks();
    getAllMock.mockResolvedValue([]);
    refreshMock.mockResolvedValue(undefined);
    getAllIssueAssociationsMock.mockResolvedValue({});
    mockOnPRDetectedCallback = null;
    mockOnPRClearedCallback = null;
    mockOnIssueDetectedCallback = null;
    mockOnIssueNotFoundCallback = null;

    vi.resetModules();
    const mod = await import("../worktreeDataStore");
    useWorktreeDataStore = mod.useWorktreeDataStore;
  });

  it("merges PR detected event into existing worktree", async () => {
    const mockWorktree = createMockWorktree("wt-1");

    getAllMock.mockResolvedValueOnce([mockWorktree]);
    useWorktreeDataStore.getState().initialize();
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

    const updated = useWorktreeDataStore.getState().worktrees.get("wt-1");
    expect(updated?.prNumber).toBe(123);
    expect(updated?.prUrl).toBe("https://github.com/test/repo/pull/123");
    expect(updated?.prState).toBe("open");
    expect(updated?.prTitle).toBe("Add new feature");
    expect(updated?.issueTitle).toBe("Implement new feature");
    expect(updated?.name).toBe("worktree-wt-1");
  });

  it("ignores PR detected event for non-existent worktree", async () => {
    useWorktreeDataStore.getState().initialize();
    await waitForInitialized();

    const initialWorktrees = new Map(useWorktreeDataStore.getState().worktrees);

    mockOnPRDetectedCallback!({
      worktreeId: "non-existent",
      prNumber: 456,
      prUrl: "https://github.com/test/repo/pull/456",
      prState: "open",
      timestamp: Date.now(),
    });

    expect(useWorktreeDataStore.getState().worktrees).toEqual(initialWorktrees);
  });

  it("clears PR fields when PR cleared event fires", async () => {
    const mockWorktree = createMockWorktree("wt-2", 789);

    getAllMock.mockResolvedValueOnce([mockWorktree]);
    useWorktreeDataStore.getState().initialize();
    await waitForInitialized();

    expect(useWorktreeDataStore.getState().worktrees.get("wt-2")?.prNumber).toBe(789);

    mockOnPRClearedCallback!({
      worktreeId: "wt-2",
      timestamp: Date.now(),
    });

    const updated = useWorktreeDataStore.getState().worktrees.get("wt-2");
    expect(updated?.prNumber).toBeUndefined();
    expect(updated?.prUrl).toBeUndefined();
    expect(updated?.prState).toBeUndefined();
    expect(updated?.prTitle).toBeUndefined();
    expect(updated?.name).toBe("worktree-wt-2");
  });

  it("ignores PR cleared event for non-existent worktree", async () => {
    useWorktreeDataStore.getState().initialize();
    await waitForInitialized();

    const initialWorktrees = new Map(useWorktreeDataStore.getState().worktrees);

    mockOnPRClearedCallback!({
      worktreeId: "non-existent",
      timestamp: Date.now(),
    });

    expect(useWorktreeDataStore.getState().worktrees).toEqual(initialWorktrees);
  });

  it("handles merged PR state", async () => {
    const mockWorktree = createMockWorktree("wt-3");

    getAllMock.mockResolvedValueOnce([mockWorktree]);
    useWorktreeDataStore.getState().initialize();
    await waitForInitialized();

    mockOnPRDetectedCallback!({
      worktreeId: "wt-3",
      prNumber: 999,
      prUrl: "https://github.com/test/repo/pull/999",
      prState: "merged",
      prTitle: "Merged feature",
      timestamp: Date.now(),
    });

    const updated = useWorktreeDataStore.getState().worktrees.get("wt-3");
    expect(updated?.prNumber).toBe(999);
    expect(updated?.prState).toBe("merged");
    expect(updated?.prTitle).toBe("Merged feature");
  });

  it("handles closed PR state", async () => {
    const mockWorktree = createMockWorktree("wt-4");

    getAllMock.mockResolvedValueOnce([mockWorktree]);
    useWorktreeDataStore.getState().initialize();
    await waitForInitialized();

    mockOnPRDetectedCallback!({
      worktreeId: "wt-4",
      prNumber: 888,
      prUrl: "https://github.com/test/repo/pull/888",
      prState: "closed",
      prTitle: "Closed PR",
      timestamp: Date.now(),
    });

    const updated = useWorktreeDataStore.getState().worktrees.get("wt-4");
    expect(updated?.prNumber).toBe(888);
    expect(updated?.prState).toBe("closed");
    expect(updated?.prTitle).toBe("Closed PR");
  });

  it("overwrites existing PR with new PR", async () => {
    const mockWorktree = createMockWorktree("wt-5", 100);

    getAllMock.mockResolvedValueOnce([mockWorktree]);
    useWorktreeDataStore.getState().initialize();
    await waitForInitialized();

    expect(useWorktreeDataStore.getState().worktrees.get("wt-5")?.prNumber).toBe(100);

    mockOnPRDetectedCallback!({
      worktreeId: "wt-5",
      prNumber: 200,
      prUrl: "https://github.com/test/repo/pull/200",
      prState: "open",
      prTitle: "Updated PR",
      timestamp: Date.now(),
    });

    const updated = useWorktreeDataStore.getState().worktrees.get("wt-5");
    expect(updated?.prNumber).toBe(200);
    expect(updated?.prUrl).toBe("https://github.com/test/repo/pull/200");
    expect(updated?.prState).toBe("open");
    expect(updated?.prTitle).toBe("Updated PR");
  });

  it("clears issueNumber when issue not found event fires", async () => {
    const mockWorktree: WorktreeState = {
      ...createMockWorktree("wt-6"),
      issueNumber: 2348,
      issueTitle: undefined,
    };

    getAllMock.mockResolvedValueOnce([mockWorktree]);
    useWorktreeDataStore.getState().initialize();
    await waitForInitialized();

    expect(useWorktreeDataStore.getState().worktrees.get("wt-6")?.issueNumber).toBe(2348);

    mockOnIssueNotFoundCallback!({
      worktreeId: "wt-6",
      issueNumber: 2348,
      timestamp: Date.now(),
    });

    const updated = useWorktreeDataStore.getState().worktrees.get("wt-6");
    expect(updated?.issueNumber).toBeUndefined();
    expect(updated?.issueTitle).toBeUndefined();
    expect(updated?.name).toBe("worktree-wt-6");
  });

  it("ignores issue not found event for non-existent worktree", async () => {
    useWorktreeDataStore.getState().initialize();
    await waitForInitialized();

    const initialWorktrees = new Map(useWorktreeDataStore.getState().worktrees);

    mockOnIssueNotFoundCallback!({
      worktreeId: "non-existent",
      issueNumber: 9999,
      timestamp: Date.now(),
    });

    expect(useWorktreeDataStore.getState().worktrees).toEqual(initialWorktrees);
  });

  it("ignores issue not found event when issueNumber does not match current worktree", async () => {
    const mockWorktree: WorktreeState = {
      ...createMockWorktree("wt-7"),
      issueNumber: 100,
      issueTitle: "Real issue",
    };

    getAllMock.mockResolvedValueOnce([mockWorktree]);
    useWorktreeDataStore.getState().initialize();
    await waitForInitialized();

    expect(useWorktreeDataStore.getState().worktrees.get("wt-7")?.issueNumber).toBe(100);

    mockOnIssueNotFoundCallback!({
      worktreeId: "wt-7",
      issueNumber: 999,
      timestamp: Date.now(),
    });

    const updated = useWorktreeDataStore.getState().worktrees.get("wt-7");
    expect(updated?.issueNumber).toBe(100);
    expect(updated?.issueTitle).toBe("Real issue");
  });

  it("updates issueNumber on issue detected event", async () => {
    const mockWorktree = createMockWorktree("wt-8");

    getAllMock.mockResolvedValueOnce([mockWorktree]);
    useWorktreeDataStore.getState().initialize();
    await waitForInitialized();

    mockOnIssueDetectedCallback!({
      worktreeId: "wt-8",
      issueNumber: 42,
      issueTitle: "Fix the thing",
    });

    const updated = useWorktreeDataStore.getState().worktrees.get("wt-8");
    expect(updated?.issueNumber).toBe(42);
    expect(updated?.issueTitle).toBe("Fix the thing");
  });
});
