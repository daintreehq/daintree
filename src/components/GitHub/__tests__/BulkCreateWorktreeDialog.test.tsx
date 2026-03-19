/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import type { GitHubIssue } from "@shared/types/github";

const mockDispatch = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => mockDispatch(...args) },
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
  useGitHubConfigStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      config: null,
      initialize: vi.fn(),
    }),
}));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: () => ({ recipes: [] }),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentProject: { id: "test-project" } }),
}));

vi.mock("@/store/worktreeDataStore", () => ({
  useWorktreeDataStore: {
    getState: () => ({ worktrees: new Map() }),
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

vi.mock("@/components/Worktree/hooks/useRecipePicker", () => ({
  useRecipePicker: () => ({
    selectedRecipeId: null,
    setSelectedRecipeId: vi.fn(),
    recipePickerOpen: false,
    setRecipePickerOpen: vi.fn(),
    recipeSelectionTouchedRef: { current: false },
    selectedRecipe: null,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
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

  it("throttles task starts with inter-operation delay", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // First task starts immediately
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    // Advance 300ms — second task starts (intervalCap:1 per 300ms)
    await advanceTimersGradually(400);
    expect(mockDispatch).toHaveBeenCalledTimes(2);

    // Third task can't start yet — concurrency:2 is full (both tasks pending)
    // Resolve task 1 to free a concurrency slot
    await act(async () => {
      resolvers[0]?.({ ok: true, result: { worktreeId: "wt-1" } });
      await vi.advanceTimersByTimeAsync(0);
    });

    // Advance past next interval — third task starts
    await advanceTimersGradually(400);
    expect(mockDispatch).toHaveBeenCalledTimes(3);

    // Resolve remaining and verify completion
    await act(async () => {
      resolvers[1]?.({ ok: true, result: { worktreeId: "wt-2" } });
      resolvers[2]?.({ ok: true, result: { worktreeId: "wt-3" } });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();
  });

  it("shows per-item status during execution", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Items should show in the executing view
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("#3")).toBeTruthy();

    // Advance to start task 2 (task 1 started immediately)
    await advanceTimersGradually(400);

    // Resolve first item successfully — frees a concurrency slot for task 3
    await act(async () => {
      resolvers[0]?.({ ok: true, result: { worktreeId: "wt-1" } });
      await vi.advanceTimersByTimeAsync(0);
    });

    // Check "1 of 3 created" text
    expect(screen.getByText(/1 of 3 created/)).toBeTruthy();

    // Advance to start task 3 (needs concurrency slot + interval)
    await advanceTimersGradually(400);

    // Resolve remaining items
    await act(async () => {
      resolvers[1]?.({ ok: true, result: { worktreeId: "wt-2" } });
      resolvers[2]?.({ ok: true, result: { worktreeId: "wt-3" } });
      await vi.advanceTimersByTimeAsync(0);
    });

    // Should show done state with 3 of 3
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();
    expect(screen.getByTestId("bulk-create-done-button")).toBeTruthy();
  });

  it("displays error messages for failed items", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Advance to start task 2, then resolve task 1 to free concurrency for task 3
    await advanceTimersGradually(400);
    await act(async () => {
      resolvers[0]?.({ ok: true, result: { worktreeId: "wt-1" } });
      await vi.advanceTimersByTimeAsync(0);
    });
    await advanceTimersGradually(400);

    await act(async () => {
      resolvers[1]?.({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "Branch already exists" },
      });
      resolvers[2]?.({ ok: true, result: { worktreeId: "wt-3" } });
      await vi.advanceTimersByTimeAsync(0);
    });

    // Error message should be visible
    expect(screen.getByText("Branch already exists")).toBeTruthy();
    // Shows 2 of 3 created, 1 failed
    expect(screen.getByText(/2 of 3 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
  });

  it("shows Retry Failed button when there are failures", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Advance to start task 2, resolve task 1 to free concurrency for task 3
    await advanceTimersGradually(400);
    await act(async () => {
      resolvers[0]?.({ ok: true, result: { worktreeId: "wt-1" } });
      await vi.advanceTimersByTimeAsync(0);
    });
    await advanceTimersGradually(400);

    await act(async () => {
      resolvers[1]?.({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "Some error" },
      });
      resolvers[2]?.({ ok: true, result: { worktreeId: "wt-3" } });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId("bulk-create-retry-button")).toBeTruthy();
    expect(screen.getByText("Retry Failed")).toBeTruthy();
  });

  it("does not show Retry Failed button when all succeed", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Advance to start task 2, resolve task 1 to free concurrency for task 3
    await advanceTimersGradually(400);
    await act(async () => {
      resolvers[0]?.({ ok: true, result: { worktreeId: "wt-1" } });
      await vi.advanceTimersByTimeAsync(0);
    });
    await advanceTimersGradually(400);

    await act(async () => {
      resolvers[1]?.({ ok: true, result: { worktreeId: "wt-2" } });
      resolvers[2]?.({ ok: true, result: { worktreeId: "wt-3" } });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.queryByTestId("bulk-create-retry-button")).toBeNull();
    expect(screen.getByTestId("bulk-create-done-button")).toBeTruthy();
  });

  it("retries failed items when Retry Failed is clicked", async () => {
    let resolvers: Array<(value: unknown) => void> = [];
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Advance to start task 2, resolve task 1 to free concurrency for task 3
    await advanceTimersGradually(400);
    await act(async () => {
      resolvers[0]?.({ ok: true, result: { worktreeId: "wt-1" } });
      await vi.advanceTimersByTimeAsync(0);
    });
    await advanceTimersGradually(400);

    // Fail item 2, succeed item 3
    await act(async () => {
      resolvers[1]?.({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "Temp error" },
      });
      resolvers[2]?.({ ok: true, result: { worktreeId: "wt-3" } });
      await vi.advanceTimersByTimeAsync(0);
    });

    // Click Retry Failed
    resolvers = [];
    await act(async () => {
      screen.getByTestId("bulk-create-retry-button").click();
    });

    // Should have dispatched again for only item 2
    expect(mockDispatch).toHaveBeenCalledTimes(4); // 3 initial + 1 retry
    // Verify the retry call was for issue #2
    const retryCall = mockDispatch.mock.calls[3]!;
    expect(retryCall[1]).toMatchObject({ issueNumber: 2 });

    // Resolve the retry successfully
    await act(async () => {
      resolvers[0]?.({ ok: true, result: { worktreeId: "wt-2" } });
      await vi.advanceTimersByTimeAsync(0);
    });

    // Now all should succeed, no retry button
    expect(screen.queryByTestId("bulk-create-retry-button")).toBeNull();
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();
  });

  it("auto-retries transient errors with backoff", async () => {
    let callCount = 0;
    mockDispatch.mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        // First two calls for item 1 fail with transient error
        return Promise.resolve({
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: "index.lock: File exists",
          },
        });
      }
      // Third call succeeds
      return Promise.resolve({ ok: true, result: { worktreeId: "wt-1" } });
    });

    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1)],
    };

    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // First attempt fails - advance past 1s backoff
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    // Second attempt fails - advance past 2s backoff
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Third attempt succeeds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(callCount).toBe(3);
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("does not auto-retry non-transient errors", async () => {
    mockDispatch.mockResolvedValue({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Branch name is invalid",
      },
    });

    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1)],
    };

    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
      await vi.advanceTimersByTimeAsync(100);
    });

    // Should only be called once (no retries for VALIDATION_ERROR)
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Branch name is invalid")).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
  });

  it("captures error message from thrown exceptions", async () => {
    mockDispatch.mockRejectedValue(new Error("Network connection lost"));

    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1)],
    };

    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText("Network connection lost")).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
  });

  it("stops processing items when dialog is closed during execution", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );

    const onClose = vi.fn();
    render(<BulkCreateWorktreeDialog {...defaultProps} onClose={onClose} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Only item 1 has started (throttled queue), resolve it
    await act(async () => {
      resolvers[0]?.({ ok: true, result: { worktreeId: "wt-1" } });
      await vi.advanceTimersByTimeAsync(0);
    });

    // Close the dialog (cancel) before throttled items 2 and 3 start
    await act(async () => {
      const buttons = screen.getAllByRole("button");
      const cancelBtn = buttons.find((b) => b.textContent === "Cancel");
      cancelBtn?.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onClose).toHaveBeenCalled();
    // Only 1 dispatch should have fired (items 2 and 3 were cleared from queue)
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    // Advance timers — no more tasks should start
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // Dialog should not show done state (it was closed/reset)
    expect(screen.queryByTestId("bulk-create-done-button")).toBeNull();
  });
});
