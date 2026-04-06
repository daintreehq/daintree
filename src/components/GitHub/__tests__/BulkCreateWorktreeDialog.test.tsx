/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";

const mockWorktreeCreate = vi.fn();
const mockGetAvailableBranch = vi.fn();
const mockGetDefaultPath = vi.fn();
const mockListBranches = vi.fn();
const mockFetchPRBranch = vi.fn();
const mockAssignIssue = vi.fn();

vi.mock("@/clients", () => ({
  worktreeClient: {
    create: (...args: unknown[]) => mockWorktreeCreate(...args),
    getAvailableBranch: (...args: unknown[]) => mockGetAvailableBranch(...args),
    getDefaultPath: (...args: unknown[]) => mockGetDefaultPath(...args),
    listBranches: (...args: unknown[]) => mockListBranches(...args),
    fetchPRBranch: (...args: unknown[]) => mockFetchPRBranch(...args),
  },
  githubClient: {
    assignIssue: (...args: unknown[]) => mockAssignIssue(...args),
  },
}));

const mockRunRecipeWithResults = vi.fn();
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: Object.assign(() => ({ recipes: [] }), {
    getState: () => ({
      runRecipeWithResults: mockRunRecipeWithResults,
      getRecipeById: () => null,
      generateRecipeFromActiveTerminals: () => [],
    }),
  }),
}));

vi.mock("@/components/Worktree/branchPrefixUtils", () => ({
  detectPrefixFromIssue: () => "feature",
  buildBranchName: (_prefix: string, slug: string) => `feature/${slug}`,
}));

vi.mock("@/utils/textParsing", () => ({
  generateBranchSlug: (title: string) => title.toLowerCase().replace(/\s+/g, "-"),
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      assignWorktreeToSelf: false,
      setAssignWorktreeToSelf: vi.fn(),
      lastSelectedWorktreeRecipeIdByProject: {},
      setLastSelectedWorktreeRecipeIdByProject: vi.fn(),
    }),
}));

vi.mock("@/store/githubConfigStore", () => ({
  useGitHubConfigStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        config: null,
        initialize: vi.fn(),
      }),
    {
      getState: () => ({
        config: null,
      }),
    }
  ),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentProject: { id: "test-project", path: "/test/root" } }),
}));

const worktreeDataHolder: { map: Map<string, unknown> } = {
  map: new Map(),
};
worktreeDataHolder.map.set("main-wt", {
  worktreeId: "main-wt",
  branch: "main",
  path: "/test/root",
  isMainWorktree: true,
});

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ worktrees: worktreeDataHolder.map }),
  }),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: worktreeDataHolder.map }),
}));

const mockSetPendingWorktree = vi.fn();
const mockSelectWorktree = vi.fn();
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      activeWorktreeId: "source-wt",
      setPendingWorktree: mockSetPendingWorktree,
      selectWorktree: mockSelectWorktree,
    }),
  },
}));

let mockTerminals: Array<{ id: string; exitCode?: number }> = [];
vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: {
    getState: () => ({
      terminalsById: Object.fromEntries(mockTerminals.map((t) => [t.id, t])),
      terminalIds: mockTerminals.map((t) => t.id),
      addTerminal: vi.fn().mockResolvedValue("clone-terminal-id"),
    }),
  },
}));

let mockSelectedRecipeId: string | null = null;
vi.mock("@/components/Worktree/hooks/useRecipePicker", () => ({
  CLONE_LAYOUT_ID: "__clone_layout__",
  useRecipePicker: () => ({
    selectedRecipeId: mockSelectedRecipeId,
    setSelectedRecipeId: vi.fn(),
    recipePickerOpen: false,
    setRecipePickerOpen: vi.fn(),
    recipeSelectionTouchedRef: { current: false },
    selectedRecipe:
      mockSelectedRecipeId && mockSelectedRecipeId !== "__clone_layout__"
        ? { name: "Test Recipe", terminals: [{}] }
        : null,
  }),
}));

vi.mock("@/components/Worktree/hooks/useNewWorktreeProjectSettings", () => ({
  useNewWorktreeProjectSettings: () => ({
    projectSettings: null,
  }),
}));

vi.mock("@/components/ui/AppDialog", () => {
  const Dialog = ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div data-testid="bulk-create-worktree-dialog">{children}</div> : null;
  Dialog.Header = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.Title = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.CloseButton = () => <button aria-label="Close" />;
  Dialog.Body = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.Footer = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { AppDialog: Dialog };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    "data-testid"?: string;
  }) => {
    const { variant: _v, ...htmlProps } = props as Record<string, unknown>;
    return (
      <button {...(htmlProps as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children}</button>
    );
  },
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { BulkCreateWorktreeDialog } from "../BulkCreateWorktreeDialog";

async function advanceTimersGradually(totalMs: number, stepMs = 100) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
    });
  }
}

const makeIssue = (n: number, title?: string): GitHubIssue => ({
  number: n,
  title: title ?? `Issue ${n}`,
  url: `https://github.com/test/repo/issues/${n}`,
  state: "OPEN",
  updatedAt: "2026-01-01",
  author: { login: "user", avatarUrl: "" },
  assignees: [],
  commentCount: 0,
});

function setupWorktreeCreateMocks() {
  let callIndex = 0;
  mockGetAvailableBranch.mockImplementation((_root: string, branch: string) =>
    Promise.resolve(branch)
  );
  mockGetDefaultPath.mockImplementation((_root: string, branch: string) =>
    Promise.resolve(`/worktrees/${branch}`)
  );
  mockWorktreeCreate.mockImplementation(() => {
    callIndex++;
    return Promise.resolve(`wt-${callIndex}`);
  });
  mockListBranches.mockResolvedValue([
    { name: "main", current: true, remote: false },
    { name: "origin/main", current: false, remote: true },
  ]);
}

const makePR = (n: number, title?: string, headRefName?: string): GitHubPR => ({
  number: n,
  title: title ?? `PR ${n}`,
  url: `https://github.com/test/repo/pull/${n}`,
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-01-01",
  author: { login: "user", avatarUrl: "" },
  headRefName: headRefName ?? `feature/pr-${n}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  setupWorktreeCreateMocks();
  mockTerminals = [];
  mockSelectedRecipeId = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("BulkCreateWorktreeDialog", () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    mode: "issue" as const,
    selectedIssues: [makeIssue(1), makeIssue(2), makeIssue(3)],
    selectedPRs: [] as GitHubPR[],
    onComplete: vi.fn(),
  };

  it("renders idle state with issue list and create button", () => {
    render(<BulkCreateWorktreeDialog {...defaultProps} />);
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("#3")).toBeTruthy();
    expect(screen.getByTestId("bulk-create-confirm-button")).toBeTruthy();
  });

  it("creates worktrees using direct client calls", async () => {
    const resolvers: Array<(value: string) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // First worktree creation starts immediately
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(1);

    // Advance to start second task
    await advanceTimersGradually(400);
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(2);

    // Resolve first to free concurrency slot
    await act(async () => {
      resolvers[0]?.("wt-1");
      await vi.advanceTimersByTimeAsync(0);
    });

    await advanceTimersGradually(400);
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);

    // Resolve remaining
    await act(async () => {
      resolvers[1]?.("wt-2");
      resolvers[2]?.("wt-3");
      await vi.advanceTimersByTimeAsync(0);
    });

    // Advance past verification settle delay
    await advanceTimersGradually(1000);

    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();
  });

  it("shows per-item sub-step status during execution", async () => {
    const resolvers: Array<(value: string) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Should show "Creating worktree..." label
    expect(screen.getByText("Creating worktree\u2026")).toBeTruthy();

    // Resolve all
    await advanceTimersGradually(400);
    await act(async () => {
      resolvers[0]?.("wt-1");
      await vi.advanceTimersByTimeAsync(0);
    });
    await advanceTimersGradually(400);
    await act(async () => {
      resolvers[1]?.("wt-2");
      resolvers[2]?.("wt-3");
      await vi.advanceTimersByTimeAsync(0);
    });
    await advanceTimersGradually(1000);

    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();
    expect(screen.getByTestId("bulk-create-done-button")).toBeTruthy();
  });

  it("displays error messages for failed items", async () => {
    let callCount = 0;
    mockWorktreeCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("Branch already exists"));
      return Promise.resolve(`wt-${callCount}`);
    });

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Let all tasks run (with backoff delays for transient check)
    await advanceTimersGradually(5000);

    expect(screen.getByText("Branch already exists")).toBeTruthy();
    expect(screen.getByText(/2 of 3 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
  });

  it("shows Retry Failed button when there are failures", async () => {
    let callCount = 0;
    mockWorktreeCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("Some error"));
      return Promise.resolve(`wt-${callCount}`);
    });

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    expect(screen.getByTestId("bulk-create-retry-button")).toBeTruthy();
    expect(screen.getByText("Retry Failed")).toBeTruthy();
  });

  it("does not show Retry Failed button when all succeed", async () => {
    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    expect(screen.queryByTestId("bulk-create-retry-button")).toBeNull();
    expect(screen.getByTestId("bulk-create-done-button")).toBeTruthy();
  });

  it("retry skips worktree creation when worktreeId already exists", async () => {
    let callCount = 0;
    mockWorktreeCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("Some error"));
      return Promise.resolve(`wt-${callCount}`);
    });

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    // Now the failed item (#2) has a worktree already created (worktree creation succeeded
    // for item 2 if the error was post-worktree-creation, but in this test worktree creation
    // itself fails). Let's check the retry scenario where worktree was already found.

    // For this test, add the failed issue's worktree to the data store
    worktreeDataHolder.map.set("existing-wt", {
      worktreeId: "existing-wt",
      branch: "feature/issue-2-issue-2",
      path: "/worktrees/feature/issue-2-issue-2",
      isMainWorktree: false,
    });

    const createCallsBefore = mockWorktreeCreate.mock.calls.length;

    await act(async () => {
      screen.getByTestId("bulk-create-retry-button").click();
    });

    await advanceTimersGradually(5000);

    // Worktree.create should NOT be called again for issue 2 since it already exists
    expect(mockWorktreeCreate.mock.calls.length).toBe(createCallsBefore);
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();

    // Clean up
    worktreeDataHolder.map.delete("existing-wt");
  });

  it("auto-retries transient errors with backoff", async () => {
    let callCount = 0;
    mockWorktreeCreate.mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.reject(new Error("index.lock: File exists"));
      }
      return Promise.resolve("wt-1");
    });

    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1)],
    };

    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Advance enough time for backoff retries (up to 30s cap * 2 retries + settle)
    await advanceTimersGradually(65000);

    expect(callCount).toBe(3);
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("classifies rate limit errors as transient", async () => {
    let callCount = 0;
    mockWorktreeCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Rate limit exceeded"));
      }
      return Promise.resolve("wt-1");
    });

    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1)],
    };

    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(35000);

    expect(callCount).toBe(2);
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
  });

  it("does not auto-retry non-transient errors", async () => {
    mockWorktreeCreate.mockRejectedValue(new Error("Branch name is invalid"));

    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1)],
    };

    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(mockWorktreeCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Branch name is invalid")).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
  });

  it("does not re-execute when create button is clicked twice rapidly", async () => {
    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    // Click twice in the same act block — simulates rapid double-click
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    // Each issue should be created exactly once — guard prevents second invocation
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();
  });

  it("second run after Done does not show 0 of N created", async () => {
    const onComplete = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <BulkCreateWorktreeDialog {...defaultProps} onComplete={onComplete} onClose={onClose} />
    );

    // Complete first run
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();

    // Click Done — state preserved during close
    await act(async () => {
      screen.getByTestId("bulk-create-done-button").click();
    });

    // Simulate dialog close/reopen cycle (useLayoutEffect resets on false→true)
    await act(async () => {
      rerender(
        <BulkCreateWorktreeDialog
          {...defaultProps}
          isOpen={false}
          onComplete={onComplete}
          onClose={onClose}
        />
      );
    });
    mockWorktreeCreate.mockClear();
    setupWorktreeCreateMocks();
    await act(async () => {
      rerender(
        <BulkCreateWorktreeDialog {...defaultProps} onComplete={onComplete} onClose={onClose} />
      );
    });

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    // Should reach 3 of 3, not be stuck at 0 of 3 due to stale batchTrackingRef
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();
  });

  it("allows create after cancel while in-flight tasks are pending", async () => {
    const resolvers: Array<(value: string) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const onClose = vi.fn();
    const { rerender } = render(<BulkCreateWorktreeDialog {...defaultProps} onClose={onClose} />);

    // Start the batch
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Cancel before in-flight tasks resolve — guard must be released by handleClose
    await act(async () => {
      const buttons = screen.getAllByRole("button");
      const cancelBtn = buttons.find((b) => b.textContent === "Cancel");
      cancelBtn?.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    // Simulate dialog close/reopen cycle (useLayoutEffect resets on false→true)
    await act(async () => {
      rerender(<BulkCreateWorktreeDialog {...defaultProps} isOpen={false} onClose={onClose} />);
    });

    // Reset mocks for the second run
    mockWorktreeCreate.mockClear();
    setupWorktreeCreateMocks();

    await act(async () => {
      rerender(<BulkCreateWorktreeDialog {...defaultProps} onClose={onClose} />);
    });

    // Create should work again — guard was released by handleClose
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();
  });

  it("recipe-enabled success path shows N of N created, never 0 of N", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ terminalId: "t-1" }, { terminalId: "t-2" }],
      failed: [],
    });
    // Terminals are healthy (no exitCode or exitCode 0)
    mockTerminals = [
      { id: "t-1", exitCode: undefined },
      { id: "t-2", exitCode: undefined },
    ];

    const props = { ...defaultProps, selectedIssues: [makeIssue(1), makeIssue(2)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    // Must show "2 of 2 created", never "0 of 2"
    expect(screen.getByText(/2 of 2 created/)).toBeTruthy();
    expect(screen.queryByText(/0 of/)).toBeNull();
  });

  it("verification detects crashed terminal and shows failure", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ terminalId: "t-crash" }],
      failed: [],
    });
    // Terminal crashed with non-zero exit code
    mockTerminals = [{ id: "t-crash", exitCode: 1 }];

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(screen.getByText(/terminal\(s\) crashed/)).toBeTruthy();
    expect(screen.getByText(/0 of 1 created/)).toBeTruthy();
  });

  it("retry does not re-verify previously succeeded items", async () => {
    mockSelectedRecipeId = "test-recipe";
    let callCount = 0;
    mockWorktreeCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("Some error"));
      return Promise.resolve(`wt-${callCount}`);
    });
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ terminalId: `t-${Date.now()}` }],
      failed: [],
    });
    mockTerminals = [];

    const props = { ...defaultProps, selectedIssues: [makeIssue(1), makeIssue(2)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    // Issue 1 succeeded, issue 2 failed
    expect(screen.getByText(/1 of 2 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();

    // Set up retry — issue 2's worktree exists now
    worktreeDataHolder.map.set("retry-wt", {
      worktreeId: "retry-wt",
      branch: "feature/issue-2-issue-2",
      path: "/worktrees/feature/issue-2-issue-2",
      isMainWorktree: false,
    });

    await act(async () => {
      screen.getByTestId("bulk-create-retry-button").click();
    });
    await advanceTimersGradually(5000);

    // Both should now be succeeded — issue 1 stays succeeded, issue 2 retried successfully
    expect(screen.getByText(/2 of 2 created/)).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();

    worktreeDataHolder.map.delete("retry-wt");
  });

  it("crashed terminal during retry does not demote prior successes", async () => {
    mockSelectedRecipeId = "test-recipe";
    let wtIndex = 0;
    mockWorktreeCreate.mockImplementation(() => Promise.resolve(`wt-${++wtIndex}`));

    // Issue 1 succeeds, issue 2 fails at worktree creation
    let callCount = 0;
    mockWorktreeCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("Lock error"));
      return Promise.resolve(`wt-${callCount}`);
    });
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ terminalId: "t-ok" }],
      failed: [],
    });
    // Issue 1's terminal is healthy during initial run
    mockTerminals = [{ id: "t-ok", exitCode: undefined }];

    const props = { ...defaultProps, selectedIssues: [makeIssue(1), makeIssue(2)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(screen.getByText(/1 of 2 created/)).toBeTruthy();

    // Before retry: issue 1's terminal now crashes (simulating delayed crash)
    mockTerminals = [{ id: "t-ok", exitCode: 1 }];

    // Set up retry for issue 2
    worktreeDataHolder.map.set("retry-wt-2", {
      worktreeId: "retry-wt-2",
      branch: "feature/issue-2-issue-2",
      path: "/worktrees/feature/issue-2-issue-2",
      isMainWorktree: false,
    });
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ terminalId: "t-retry" }],
      failed: [],
    });

    await act(async () => {
      screen.getByTestId("bulk-create-retry-button").click();
    });
    await advanceTimersGradually(5000);

    // Issue 1 must STILL be succeeded — verification only scopes to retry run (issue 2)
    // Issue 2 should now be succeeded as well
    expect(screen.getByText(/2 of 2 created/)).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();

    worktreeDataHolder.map.delete("retry-wt-2");
  });

  it("mixed healthy and crashed terminals across multiple items", async () => {
    mockSelectedRecipeId = "test-recipe";

    let recipeCallIndex = 0;
    mockRunRecipeWithResults.mockImplementation(() => {
      recipeCallIndex++;
      // Each item gets a unique terminal
      return Promise.resolve({
        spawned: [{ terminalId: `t-item-${recipeCallIndex}` }],
        failed: [],
      });
    });

    // Item 1 terminal healthy, item 2 crashes, item 3 healthy
    mockTerminals = [
      { id: "t-item-1", exitCode: undefined },
      { id: "t-item-2", exitCode: 137 },
      { id: "t-item-3", exitCode: 0 },
    ];

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    // 2 succeeded (items 1, 3), 1 failed (item 2 crashed)
    expect(screen.getByText(/2 of 3 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(screen.getByText(/terminal\(s\) crashed/)).toBeTruthy();
  });

  it("large batch with recipe all healthy never shows intermediate 0 count", async () => {
    mockSelectedRecipeId = "test-recipe";
    const issues = Array.from({ length: 6 }, (_, i) => makeIssue(i + 1));

    let recipeCallIndex = 0;
    mockRunRecipeWithResults.mockImplementation(() => {
      recipeCallIndex++;
      return Promise.resolve({
        spawned: [{ terminalId: `t-large-${recipeCallIndex}` }],
        failed: [],
      });
    });

    // All terminals healthy
    mockTerminals = Array.from({ length: 6 }, (_, i) => ({
      id: `t-large-${i + 1}`,
      exitCode: undefined,
    }));

    const props = { ...defaultProps, selectedIssues: issues };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(10000);

    expect(screen.getByText(/6 of 6 created/)).toBeTruthy();
    expect(screen.queryByText(/0 of/)).toBeNull();
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("notification counts match UI counts after recipe verification", async () => {
    const { notify: mockNotify } = await import("@/lib/notify");
    mockSelectedRecipeId = "test-recipe";

    let recipeCallIndex = 0;
    mockRunRecipeWithResults.mockImplementation(() => {
      recipeCallIndex++;
      return Promise.resolve({
        spawned: [{ terminalId: `t-notify-${recipeCallIndex}` }],
        failed: [],
      });
    });

    // Item 1 healthy, item 2 crashes
    mockTerminals = [
      { id: "t-notify-1", exitCode: undefined },
      { id: "t-notify-2", exitCode: 1 },
    ];

    const props = { ...defaultProps, selectedIssues: [makeIssue(1), makeIssue(2)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    // UI shows correct counts
    expect(screen.getByText(/1 of 2 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();

    // Notification was called with matching counts
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "1 created, 1 failed",
      })
    );
  });

  it("recipe verification with multiple crashed terminals reports correct count", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ terminalId: "t-a" }, { terminalId: "t-b" }, { terminalId: "t-c" }],
      failed: [],
    });

    // 2 of 3 terminals crashed
    mockTerminals = [
      { id: "t-a", exitCode: 1 },
      { id: "t-b", exitCode: undefined },
      { id: "t-c", exitCode: 130 },
    ];

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(screen.getByText("2 terminal(s) crashed after spawn")).toBeTruthy();
    expect(screen.getByText(/0 of 1 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
  });

  it("second run with recipe after Done resets tracking cleanly", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ terminalId: "t-run1" }],
      failed: [],
    });
    mockTerminals = [{ id: "t-run1", exitCode: undefined }];

    const onComplete = vi.fn();
    const onClose = vi.fn();
    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1)],
      onComplete,
      onClose,
    };
    const { rerender } = render(<BulkCreateWorktreeDialog {...props} />);

    // First run with recipe
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();

    // Click Done
    await act(async () => {
      screen.getByTestId("bulk-create-done-button").click();
    });

    // Simulate dialog close/reopen cycle (useLayoutEffect resets on false→true)
    await act(async () => {
      rerender(<BulkCreateWorktreeDialog {...props} isOpen={false} />);
    });

    // Second run — crash terminal from first run to prove tracking was reset
    mockTerminals = [
      { id: "t-run1", exitCode: 1 },
      { id: "t-run2", exitCode: undefined },
    ];
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ terminalId: "t-run2" }],
      failed: [],
    });
    mockWorktreeCreate.mockClear();
    setupWorktreeCreateMocks();

    await act(async () => {
      rerender(<BulkCreateWorktreeDialog {...props} isOpen={true} />);
    });

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    // Second run should succeed — old crashed terminal t-run1 is irrelevant
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("stops processing items when dialog is closed during execution", async () => {
    const resolvers: Array<(value: string) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const onClose = vi.fn();
    render(<BulkCreateWorktreeDialog {...defaultProps} onClose={onClose} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Only item 1 has started, resolve it
    await act(async () => {
      resolvers[0]?.("wt-1");
      await vi.advanceTimersByTimeAsync(0);
    });

    // Close the dialog before remaining items finish
    await act(async () => {
      const buttons = screen.getAllByRole("button");
      const cancelBtn = buttons.find((b) => b.textContent === "Cancel");
      cancelBtn?.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onClose).toHaveBeenCalled();
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.queryByTestId("bulk-create-done-button")).toBeNull();
  });

  it("keeps completed items visible after worktreeMap updates during execution", async () => {
    const resolvers: Array<(value: string) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const { rerender } = render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Advance to let the first two items start (concurrency = 2)
    await advanceTimersGradually(400);

    // Resolve the first item
    await act(async () => {
      resolvers[0]?.("wt-1");
      await vi.advanceTimersByTimeAsync(0);
    });

    // Simulate worktreeMap updating with the newly created worktree (issue #1)
    // Replace the Map reference so useMemo's dependency triggers recomputation
    const updatedMap = new Map(worktreeDataHolder.map);
    updatedMap.set("wt-1", {
      worktreeId: "wt-1",
      branch: "feature/issue-1",
      path: "/worktrees/feature/issue-1",
      isMainWorktree: false,
      issueNumber: 1,
    });
    worktreeDataHolder.map = updatedMap;

    // Trigger re-render to simulate Zustand subscription update
    await act(async () => {
      rerender(<BulkCreateWorktreeDialog {...defaultProps} />);
    });

    // Issue #1 must still be visible in the progress list despite worktreeMap update
    expect(screen.getByText("Issue 1")).toBeTruthy();
    expect(screen.getByText("#1")).toBeTruthy();

    // Resolve remaining items and verify final state
    await advanceTimersGradually(400);
    await act(async () => {
      resolvers[1]?.("wt-2");
      resolvers[2]?.("wt-3");
      await vi.advanceTimersByTimeAsync(0);
    });
    await advanceTimersGradually(1000);

    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();
    // All three items should be visible
    expect(screen.getByText("Issue 1")).toBeTruthy();
    expect(screen.getByText("Issue 2")).toBeTruthy();
    expect(screen.getByText("Issue 3")).toBeTruthy();

    // Restore the original map without the test entry
    const cleanMap = new Map(worktreeDataHolder.map);
    cleanMap.delete("wt-1");
    worktreeDataHolder.map = cleanMap;
  });

  it("does not flash empty state when Done is clicked", async () => {
    const onComplete = vi.fn();
    const onClose = vi.fn();
    render(
      <BulkCreateWorktreeDialog {...defaultProps} onComplete={onComplete} onClose={onClose} />
    );

    // Complete a full batch run
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();

    // Click Done — state should NOT reset while dialog is still mounted
    await act(async () => {
      screen.getByTestId("bulk-create-done-button").click();
    });

    // The completion text should still be visible (no RESET before close)
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();
    expect(onComplete).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("BulkCreateWorktreeDialog — PR mode", () => {
  const prProps = {
    isOpen: true,
    onClose: vi.fn(),
    mode: "pr" as const,
    selectedIssues: [] as GitHubIssue[],
    selectedPRs: [makePR(10), makePR(20), makePR(30)],
    onComplete: vi.fn(),
  };

  it("renders PR list with branch names in idle state", () => {
    mockListBranches.mockResolvedValue([
      { name: "origin/feature/pr-10", current: false, remote: true },
      { name: "origin/feature/pr-20", current: false, remote: true },
      { name: "origin/feature/pr-30", current: false, remote: true },
    ]);

    render(<BulkCreateWorktreeDialog {...prProps} />);
    expect(screen.getByText("#10")).toBeTruthy();
    expect(screen.getByText("#20")).toBeTruthy();
    expect(screen.getByText("#30")).toBeTruthy();
    expect(screen.getByText("feature/pr-10")).toBeTruthy();
    expect(screen.getByTestId("bulk-create-confirm-button")).toBeTruthy();
  });

  it("creates worktrees from remote PR branches", async () => {
    mockListBranches.mockResolvedValue([
      { name: "main", current: true, remote: false },
      { name: "origin/feature/pr-10", current: false, remote: true },
      { name: "origin/feature/pr-20", current: false, remote: true },
      { name: "origin/feature/pr-30", current: false, remote: true },
    ]);

    render(<BulkCreateWorktreeDialog {...prProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();

    // Should have called create with fromRemote: true
    const createCalls = mockWorktreeCreate.mock.calls;
    expect(createCalls.length).toBe(3);
    expect(createCalls[0][0].fromRemote).toBe(true);
    expect(createCalls[0][0].baseBranch).toBe("origin/feature/pr-10");
    expect(createCalls[0][0].newBranch).toBe("feature/pr-10");
  });

  it("includes fork PRs in plan", () => {
    const forkPR: GitHubPR = {
      ...makePR(99),
      isFork: true,
    };
    const props = { ...prProps, selectedPRs: [forkPR] };
    render(<BulkCreateWorktreeDialog {...props} />);

    expect(screen.queryByText("Fork PR")).toBeNull();
    expect(screen.getByTestId("bulk-create-confirm-button").hasAttribute("disabled")).toBe(false);
  });

  it("skips merged PRs with reason", () => {
    const mergedPR: GitHubPR = {
      ...makePR(99),
      state: "MERGED",
    };
    const props = { ...prProps, selectedPRs: [mergedPR] };
    render(<BulkCreateWorktreeDialog {...props} />);

    expect(screen.getByText("Merged")).toBeTruthy();
  });

  it("skips PRs without headRefName", () => {
    const noRefPR: GitHubPR = {
      ...makePR(99),
      headRefName: undefined,
    };
    const props = { ...prProps, selectedPRs: [noRefPR] };
    render(<BulkCreateWorktreeDialog {...props} />);

    expect(screen.getByText("No branch info")).toBeTruthy();
  });

  it("does not show assign-to-self toggle in PR mode", () => {
    render(<BulkCreateWorktreeDialog {...prProps} />);
    expect(screen.queryByText("Assign to me")).toBeNull();
  });

  it("falls back to local branch when remote not found", async () => {
    mockListBranches.mockResolvedValue([
      { name: "main", current: true, remote: false },
      { name: "feature/pr-10", current: false, remote: false },
    ]);

    const props = { ...prProps, selectedPRs: [makePR(10)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
    const createCalls = mockWorktreeCreate.mock.calls;
    expect(createCalls[0][0].useExistingBranch).toBe(true);
    expect(createCalls[0][0].fromRemote).toBe(false);
  });

  it("fails when branch cannot be fetched from remote", async () => {
    mockListBranches.mockResolvedValue([{ name: "main", current: true, remote: false }]);
    mockFetchPRBranch.mockRejectedValue(new Error("fatal: couldn't find remote ref pull/10/head"));

    const props = { ...prProps, selectedPRs: [makePR(10)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    expect(screen.getByText(/couldn't find remote ref/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
  });
});
