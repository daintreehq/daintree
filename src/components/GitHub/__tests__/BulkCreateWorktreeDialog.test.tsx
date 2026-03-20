/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import type { GitHubIssue } from "@shared/types/github";

const mockWorktreeCreate = vi.fn();
const mockGetAvailableBranch = vi.fn();
const mockGetDefaultPath = vi.fn();
const mockAssignIssue = vi.fn();

vi.mock("@/clients", () => ({
  worktreeClient: {
    create: (...args: unknown[]) => mockWorktreeCreate(...args),
    getAvailableBranch: (...args: unknown[]) => mockGetAvailableBranch(...args),
    getDefaultPath: (...args: unknown[]) => mockGetDefaultPath(...args),
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

const mockWorktreeDataMap = new Map();
mockWorktreeDataMap.set("main-wt", {
  worktreeId: "main-wt",
  branch: "main",
  path: "/test/root",
  isMainWorktree: true,
});

vi.mock("@/store/worktreeDataStore", () => ({
  useWorktreeDataStore: {
    getState: () => ({ worktrees: mockWorktreeDataMap }),
  },
}));

const mockSetPendingWorktree = vi.fn();
const mockSelectWorktree = vi.fn();
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      setPendingWorktree: mockSetPendingWorktree,
      selectWorktree: mockSelectWorktree,
    }),
  },
}));

let mockTerminals: Array<{ id: string; exitCode?: number }> = [];
vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: {
    getState: () => ({
      terminals: mockTerminals,
    }),
  },
}));

let mockSelectedRecipeId: string | null = null;
vi.mock("@/components/Worktree/hooks/useRecipePicker", () => ({
  useRecipePicker: () => ({
    selectedRecipeId: mockSelectedRecipeId,
    setSelectedRecipeId: vi.fn(),
    recipePickerOpen: false,
    setRecipePickerOpen: vi.fn(),
    recipeSelectionTouchedRef: { current: false },
    selectedRecipe: mockSelectedRecipeId ? { name: "Test Recipe", terminals: [{}] } : null,
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
}

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
    selectedIssues: [makeIssue(1), makeIssue(2), makeIssue(3)],
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
    mockWorktreeDataMap.set("existing-wt", {
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
    mockWorktreeDataMap.delete("existing-wt");
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
    render(
      <BulkCreateWorktreeDialog {...defaultProps} onComplete={onComplete} onClose={onClose} />
    );

    // Complete first run
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();

    // Click Done to reset the dialog
    await act(async () => {
      screen.getByTestId("bulk-create-done-button").click();
    });

    // Second run: create again (component stays mounted, isOpen still true via mock)
    // Reset mock call count for clarity
    mockWorktreeCreate.mockClear();
    setupWorktreeCreateMocks();

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

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

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

    // Reset mocks for the second run
    mockWorktreeCreate.mockClear();
    setupWorktreeCreateMocks();

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
    mockWorktreeDataMap.set("retry-wt", {
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

    mockWorktreeDataMap.delete("retry-wt");
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
});
