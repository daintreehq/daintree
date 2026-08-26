/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, within } from "@testing-library/react";
import React from "react";
import type { Issue, PR } from "@shared/types/forge";
import {
  setCache,
  getCache,
  buildCacheKey,
  _resetForTests as resetForgeResourceCache,
} from "@/lib/forgeResourceCache";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const mockWorktreeCreate = vi.fn();
const mockGetAvailableBranch = vi.fn();
const mockGetDefaultPath = vi.fn();
const mockListBranches = vi.fn();
const mockFetchPRBranch = vi.fn();
const mockAssignIssue = vi.fn();
const mockLogError = vi.fn();
const mockAgentSettingsGet = vi.fn();
const mockSystemGetTmpDir = vi.fn();
const mockGetAgentConfig = vi.fn();
const mockGenerateAgentCommand = vi.fn();

vi.mock("@/clients", () => ({
  worktreeClient: {
    create: (...args: unknown[]) => mockWorktreeCreate(...args),
    getAvailableBranch: (...args: unknown[]) => mockGetAvailableBranch(...args),
    getDefaultPath: (...args: unknown[]) => mockGetDefaultPath(...args),
    listBranches: (...args: unknown[]) => mockListBranches(...args),
    fetchPRBranch: (...args: unknown[]) => mockFetchPRBranch(...args),
  },
  forgeClient: {
    assignIssue: (...args: unknown[]) => mockAssignIssue(...args),
    getCurrentUser: () => mockGetCurrentUser(),
  },
  agentSettingsClient: {
    get: (...args: unknown[]) => mockAgentSettingsGet(...args),
  },
  systemClient: {
    getTmpDir: (...args: unknown[]) => mockSystemGetTmpDir(...args),
  },
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (...args: unknown[]) => mockGetAgentConfig(...args),
}));

vi.mock("@shared/types", async (importActual) => {
  const actual = await importActual<typeof import("@shared/types")>();
  return {
    ...actual,
    generateAgentCommand: (...args: unknown[]) => mockGenerateAgentCommand(...args),
  };
});

const mockRunRecipeWithResults = vi.fn();
const mockGenerateRecipeFromActiveTerminals = vi.fn();
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: Object.assign(() => ({ recipes: [] }), {
    getState: () => ({
      runRecipeWithResults: mockRunRecipeWithResults,
      getRecipeById: () => null,
      generateRecipeFromActiveTerminals: (...args: unknown[]) =>
        mockGenerateRecipeFromActiveTerminals(...args),
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

vi.mock("@/utils/logger", () => ({
  logError: (...args: unknown[]) => mockLogError(...args),
}));

const prefsHolder: { assignWorktreeToSelf: boolean } = { assignWorktreeToSelf: false };
const mockSetAssignWorktreeToSelf = vi.fn();
const viewerHolder: { user: { login: string; avatarUrl?: string } | null } = { user: null };
const mockGetCurrentUser = vi.fn(async () => viewerHolder.user);

vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      assignWorktreeToSelf: prefsHolder.assignWorktreeToSelf,
      setAssignWorktreeToSelf: mockSetAssignWorktreeToSelf,
      lastSelectedWorktreeRecipeIdByProject: {},
      setLastSelectedWorktreeRecipeIdByProject: vi.fn(),
    }),
}));

const projectHolder: { currentProject: { id: string; path?: string } | null } = {
  currentProject: { id: "test-project", path: "/test/root" },
};

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentProject: projectHolder.currentProject }),
}));

const worktreeDataHolder: { map: Map<string, unknown> } = {
  map: new Map([
    [
      "main-wt",
      { worktreeId: "main-wt", branch: "main", path: "/test/root", isMainWorktree: true },
    ],
  ]),
};

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
const mockBulkCreateDialog: { onComplete: (() => void) | undefined } = {
  onComplete: undefined,
};
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      activeWorktreeId: "source-wt",
      setPendingWorktree: mockSetPendingWorktree,
      selectWorktree: mockSelectWorktree,
      bulkCreateDialog: mockBulkCreateDialog,
    }),
  },
}));

let mockTerminals: Array<{ id: string; exitCode?: number }> = [];
const mockAddPanel = vi.fn();
const mockBeginSpawnBatch = vi.fn(() => Symbol("test-spawn-batch"));
const mockFlushSpawnBatch = vi.fn();
const mockSetFocused = vi.fn();
const mockExitMaximize = vi.fn();
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      panelsById: Object.fromEntries(mockTerminals.map((t) => [t.id, t])),
      panelIds: mockTerminals.map((t) => t.id),
      addPanel: (...args: unknown[]) => mockAddPanel(...args),
      beginSpawnBatch: () => mockBeginSpawnBatch(),
      flushSpawnBatch: (token: unknown) => mockFlushSpawnBatch(token),
      setFocused: (id: string) => mockSetFocused(id),
      exitMaximize: () => mockExitMaximize(),
    }),
  },
}));

let mockSelectedRecipeId: string | null = null;
vi.mock("@/components/Worktree/hooks/useRecipePicker", () => ({
  CLONE_LAYOUT_ID: "__clone_layout__",
  resolveEligibleDefaultRecipeId: (
    recipes: unknown[],
    persistedDefaultRecipeId: string | undefined
  ) => {
    // Mirror the real implementation: return the persisted ID only if it exists in recipes and is not shadowed
    return recipes.some((r: any) => r.id === persistedDefaultRecipeId && !r.shadowedBy)
      ? persistedDefaultRecipeId
      : undefined;
  },
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

// Bridge the dialog's onClose prop down to the mocked CloseButton via React
// context, so tests can drive handleClose by clicking the header X just like
// the real AppDialog wires it.
const DialogCloseContext = React.createContext<(() => void) | null>(null);

vi.mock("@/components/ui/AppDialog", () => {
  // `dismissible` is modelled rather than dropped: the real AppDialog routes
  // Escape/backdrop through it, and blocking those mid-run is a guarantee this
  // dialog is expected to keep (#11517).
  const Dialog = ({
    children,
    isOpen,
    onClose,
    dismissible = true,
  }: {
    children: React.ReactNode;
    isOpen: boolean;
    onClose?: () => void;
    dismissible?: boolean;
  }) =>
    isOpen ? (
      <DialogCloseContext.Provider value={dismissible ? (onClose ?? null) : null}>
        <div
          data-testid="bulk-create-worktree-dialog"
          data-dismissible={String(dismissible)}
          onClick={(e) => {
            // Backdrop only — a bubbled click from a footer button is not a
            // dismissal.
            if (dismissible && e.target === e.currentTarget) onClose?.();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && dismissible) onClose?.();
          }}
        >
          {children}
        </div>
      </DialogCloseContext.Provider>
    ) : null;
  Dialog.Header = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.Title = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const CloseButton = () => {
    const onClose = React.useContext(DialogCloseContext);
    return <button aria-label="Close dialog" onClick={() => onClose?.()} />;
  };
  Dialog.CloseButton = CloseButton;
  Dialog.Body = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  // `hint` is modelled rather than dropped: the batch summary is the footer's
  // only rendering of what the selection resolves to.
  Dialog.Footer = ({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) => (
    <div>
      {hint ? <div data-testid="bulk-create-footer-hint">{hint}</div> : null}
      {children}
    </div>
  );
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

import { BulkCreateWorktreeDialog } from "../components/BulkCreateWorktreeDialog";

async function advanceTimersGradually(totalMs: number, stepMs = 100) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
    });
  }
}

const makeIssue = (n: number, title?: string): Issue => ({
  number: n,
  title: title ?? `Issue ${n}`,
  body: "",
  url: `https://github.com/test/repo/issues/${n}`,
  state: "open",
  rawState: "OPEN",
  author: { login: "user", avatarUrl: "", rawData: null },
  assignees: [],
  labels: [],
  commentCount: 0,
  createdAt: 0,
  updatedAt: 0,
  rawData: null,
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

const makePR = (n: number, title?: string, headRef?: string): PR => ({
  number: n,
  title: title ?? `PR ${n}`,
  body: "",
  url: `https://github.com/test/repo/pull/${n}`,
  state: "open",
  rawState: "OPEN",
  isDraft: false,
  merged: false,
  author: { login: "user", avatarUrl: "", rawData: null },
  baseRef: "main",
  headRef: headRef ?? `feature/pr-${n}`,
  createdAt: 0,
  updatedAt: 0,
  rawData: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  setupWorktreeCreateMocks();
  mockTerminals = [];
  mockSelectedRecipeId = null;
  mockBulkCreateDialog.onComplete = undefined;
  mockAddPanel.mockResolvedValue("clone-terminal-id");
  mockAgentSettingsGet.mockResolvedValue({ agents: {} });
  mockSystemGetTmpDir.mockResolvedValue("/tmp");
  mockGetAgentConfig.mockReturnValue({ command: "claude" });
  mockGenerateAgentCommand.mockReturnValue("claude --fresh");
  mockGenerateRecipeFromActiveTerminals.mockReturnValue([]);
  prefsHolder.assignWorktreeToSelf = false;
  viewerHolder.user = null;
  projectHolder.currentProject = { id: "test-project", path: "/test/root" };
  // Rebuilt, not cleared: a test that seeds an extra worktree and then fails
  // its assertion would otherwise leak that row into every later plan.
  worktreeDataHolder.map = new Map([
    [
      "main-wt",
      { worktreeId: "main-wt", branch: "main", path: "/test/root", isMainWorktree: true },
    ],
  ]);
  // clearAllMocks leaves queued `mockImplementationOnce` entries in place, so a
  // deferred-identity test that never consumes its queue would poison the next.
  mockGetCurrentUser.mockReset();
  mockGetCurrentUser.mockImplementation(async () => viewerHolder.user);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetForgeResourceCache();
});

describe("BulkCreateWorktreeDialog", () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    mode: "issue" as const,
    selectedIssues: [makeIssue(1), makeIssue(2), makeIssue(3)],
    selectedPRs: [] as PR[],
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

    // All three concurrency slots fill immediately (concurrency = 3) — the
    // backend leaky-bucket rate limiter drives the real cadence.
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);

    // Resolve all
    await act(async () => {
      resolvers[0]?.("wt-1");
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

    // Should show "Creating worktree..." labels for the items that started
    // immediately under concurrency = 3.
    expect(screen.getAllByText("Creating worktree\u2026").length).toBeGreaterThanOrEqual(1);

    // Resolve all
    await act(async () => {
      resolvers[0]?.("wt-1");
      await vi.advanceTimersByTimeAsync(0);
    });
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
    expect(screen.getByText("Retry failed")).toBeTruthy();
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

  it("keeps retrying a transient worktree creation past the old 3-attempt cap", async () => {
    // Five consecutive transient failures — beyond the old MAX_AUTO_RETRIES cap
    // of 3 total attempts — then success. Proves the count ceiling is gone for
    // worktree creation, not just assignment (see #10128).
    let callCount = 0;
    mockWorktreeCreate.mockImplementation(() => {
      callCount++;
      if (callCount <= 5) {
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

    // Each worktree backoff is capped at 30s; drain enough virtual time (still
    // under the 5-minute ceiling) for all five retries to elapse.
    await advanceTimersGradually(240000, 5000);

    expect(callCount).toBe(6);
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
    const spawnBatches = mockRunRecipeWithResults.mock.calls.map(
      (call) => (call[4] as { spawnBatch?: { id: string; size: number } })?.spawnBatch
    );
    expect(spawnBatches.every(Boolean)).toBe(true);
    expect(new Set(spawnBatches.map((batch) => batch?.id)).size).toBe(1);
    expect(spawnBatches.every((batch) => batch?.size === spawnBatches.length)).toBe(true);
  });

  it("done-phase counts match UI after recipe verification with mixed outcomes", async () => {
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

    expect(screen.getByText(/1 of 2 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    // Done-phase body conveys the result; no toast should fire.
    expect(mockNotify).not.toHaveBeenCalled();
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
    // Use 4 items so that with concurrency=3 at least one item stays queued,
    // letting us verify the queue-clearing + stale-handler cancel semantics.
    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)],
    };
    render(<BulkCreateWorktreeDialog {...props} onClose={onClose} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Items 1-3 start immediately under concurrency = 3; item 4 is still
    // queued. Cancel before any resolve so the queue is cleared and item 4
    // never starts.
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);

    // Close the dialog before remaining items finish
    await act(async () => {
      const buttons = screen.getAllByRole("button");
      const cancelBtn = buttons.find((b) => b.textContent === "Cancel");
      cancelBtn?.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onClose).toHaveBeenCalled();

    // Resolving the in-flight items after cancel must not trigger item 4 —
    // runIdRef has been bumped so the stale handlers exit early.
    await act(async () => {
      resolvers[0]?.("wt-1");
      resolvers[1]?.("wt-2");
      resolvers[2]?.("wt-3");
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("bulk-create-done-button")).toBeNull();
  });

  it("does not run the recipe for an item whose worktree lands after cancel", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ terminalId: "t-1" }],
      failed: [],
    });
    const resolvers: Array<(value: string) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "octocat" };

    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)],
    };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    const startedCreates = mockWorktreeCreate.mock.calls.length;
    expect(startedCreates).toBeGreaterThan(0);

    await act(async () => {
      const cancelBtn = screen
        .getAllByRole("button")
        .find((b) => b.textContent === "Cancel") as HTMLButtonElement;
      cancelBtn.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    // The creates were already past the point of no return — let them land.
    await act(async () => {
      resolvers.forEach((resolve, i) => resolve(`wt-${i + 1}`));
      await vi.advanceTimersByTimeAsync(5000);
    });

    // Each landed worktree stops at the Step 1 -> Step 2 boundary rather than
    // spawning agents and skipping the assignment the dialog otherwise promises.
    expect(mockRunRecipeWithResults).not.toHaveBeenCalled();
    expect(mockAssignIssue).not.toHaveBeenCalled();
    // Queued items never start, so no additional worktrees appear.
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(startedCreates);
  });

  it("reports the worktrees a cancel left behind", async () => {
    const { notify: mockNotify } = await import("@/lib/notify");
    const resolvers: Array<(value: string) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)],
    };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Land one worktree so the snapshot has both a created and an in-flight count.
    await act(async () => {
      resolvers[0]?.("wt-1");
      await vi.advanceTimersByTimeAsync(0);
    });

    const stillCreating = resolvers.length - 1;

    await act(async () => {
      const cancelBtn = screen
        .getAllByRole("button")
        .find((b) => b.textContent === "Cancel") as HTMLButtonElement;
      cancelBtn.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        message: expect.stringContaining(
          `1 of ${props.selectedIssues.length} worktrees created`
        ) as unknown as string,
      })
    );
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(`${stillCreating} already underway`) as unknown as string,
      })
    );

    await act(async () => {
      resolvers.slice(1).forEach((resolve, i) => resolve(`wt-${i + 2}`));
      await vi.advanceTimersByTimeAsync(1000);
    });
  });

  it("stays silent when a cancel lands before any worktree is underway", async () => {
    const { notify: mockNotify } = await import("@/lib/notify");
    vi.mocked(mockNotify).mockClear();

    // Stall the batch in its pre-query phase: the queue callbacks are running,
    // so PQueue.pending is non-zero, but no worktree has been requested yet.
    let releasePrequery: (value: string) => void = () => {};
    mockGetAvailableBranch.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releasePrequery = resolve;
        })
    );

    const props = { ...defaultProps, selectedIssues: [makeIssue(1), makeIssue(2)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
      await vi.advanceTimersByTimeAsync(0);
    });

    // Confirm the run really is executing, or the guard under test never runs.
    expect((screen.getByTestId("bulk-create-confirm-button") as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(mockWorktreeCreate).not.toHaveBeenCalled();

    await act(async () => {
      const cancelBtn = screen
        .getAllByRole("button")
        .find((b) => b.textContent === "Cancel") as HTMLButtonElement;
      cancelBtn.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    // Nothing escaped, so the close is its own confirmation — no toast.
    expect(mockNotify).not.toHaveBeenCalled();

    await act(async () => {
      releasePrequery("feature/issue-1");
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockWorktreeCreate).not.toHaveBeenCalled();
  });

  it("stops the batch when the dialog unmounts without going through Cancel", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({ spawned: [{ terminalId: "t-1" }], failed: [] });
    const resolvers: Array<(value: string) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    // Four items against concurrency 3 leaves one in the backlog, so the
    // unmount has to both stop the running items and drop the queued one.
    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)],
    };
    const { unmount } = render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    const startedCreates = mockWorktreeCreate.mock.calls.length;
    expect(startedCreates).toBeGreaterThan(0);
    expect(startedCreates).toBeLessThan(props.selectedIssues.length);

    // The parent drops the dialog (SidebarContent renders it only while open),
    // bypassing handleClose entirely.
    await act(async () => {
      unmount();
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      resolvers.forEach((resolve, i) => resolve(`wt-${i + 1}`));
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mockRunRecipeWithResults).not.toHaveBeenCalled();
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(startedCreates);
  });

  it("does not focus a clone-layout panel spawned into a cancelled run", async () => {
    mockSelectedRecipeId = "__clone_layout__";
    mockGenerateRecipeFromActiveTerminals.mockReturnValue([
      { type: "terminal", title: "Shell", location: "grid" },
    ]);
    // Hold the spawn open so Cancel lands while panels are still committing.
    let releasePanel: (value: string) => void = () => {};
    mockAddPanel.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releasePanel = resolve;
        })
    );

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockAddPanel).toHaveBeenCalled();

    await act(async () => {
      const cancelBtn = screen
        .getAllByRole("button")
        .find((b) => b.textContent === "Cancel") as HTMLButtonElement;
      cancelBtn.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      releasePanel("clone-terminal-id");
      await vi.advanceTimersByTimeAsync(1000);
    });

    // The panel can't be recalled, but the run's AbortSignal must stop it from
    // yanking focus into the worktree the user just cancelled.
    expect(mockSetFocused).not.toHaveBeenCalled();
  });

  it("does not assign or select for a recipe that resolves after cancel", async () => {
    mockSelectedRecipeId = "test-recipe";
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "octocat" };
    // The worktree is already made and the recipe is mid-flight when Cancel lands.
    let releaseRecipe: (value: {
      spawned: Array<{ terminalId: string }>;
      failed: [];
    }) => void = () => {};
    mockRunRecipeWithResults.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRecipe = resolve;
        })
    );

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockRunRecipeWithResults).toHaveBeenCalledTimes(1);

    await act(async () => {
      const cancelBtn = screen
        .getAllByRole("button")
        .find((b) => b.textContent === "Cancel") as HTMLButtonElement;
      cancelBtn.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      releaseRecipe({ spawned: [{ terminalId: "t-1" }], failed: [] });
      await vi.advanceTimersByTimeAsync(5000);
    });

    // The recipe's own terminals are out of reach — this pins the end state
    // instead: an item cancelled mid-recipe is never assigned and never becomes
    // the selected worktree.
    expect(mockAssignIssue).not.toHaveBeenCalled();
    expect(mockSelectWorktree).not.toHaveBeenCalled();
  });

  it("fails the batch instead of stranding it when the project path is missing", async () => {
    projectHolder.currentProject = { id: "test-project" };

    const props = { ...defaultProps, selectedIssues: [makeIssue(1), makeIssue(2)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
      await vi.advanceTimersByTimeAsync(0);
    });

    // Reaching a terminal phase is the fix: "Creating worktrees…" with a hidden
    // X and blocked Escape used to persist forever.
    expect(screen.getByTestId("bulk-create-done-button")).toBeTruthy();
    expect(screen.getByTestId("bulk-create-retry-button")).toBeTruthy();
    // Every item must carry the failure, not just the one that tripped it.
    expect(screen.getByText(/0 of 2 created/)).toBeTruthy();
    expect(screen.getByText(/2 failed/)).toBeTruthy();
    expect(mockWorktreeCreate).not.toHaveBeenCalled();

    // Dismissal is unblocked again, so the user isn't trapped.
    const onCloseSpy = vi.fn();
    cleanup();
    render(<BulkCreateWorktreeDialog {...props} onClose={onCloseSpy} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      screen
        .getByTestId("bulk-create-worktree-dialog")
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onCloseSpy).toHaveBeenCalled();
  });

  it("keeps the primary action in place while executing", async () => {
    const resolvers: Array<(value: string) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    // The header X is unlabelled and correctly disappears mid-run; only the
    // footer's ordering is what Cancel's hit area depends on.
    const footerLabels = () =>
      screen
        .getAllByRole("button")
        .map((b) => b.textContent)
        .filter(Boolean);
    const footerOrderBefore = footerLabels();

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Cancel must not inherit the CTA's slot once the run commits.
    const confirmButton = screen.getByTestId("bulk-create-confirm-button") as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    expect(footerLabels()).toEqual(footerOrderBefore);

    // A stray second click on the now-disabled CTA starts nothing.
    await act(async () => {
      confirmButton.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0]?.("wt-1");
      await vi.advanceTimersByTimeAsync(1000);
    });
  });

  it("blocks Escape and backdrop dismissal while executing", async () => {
    const resolvers: Array<(value: string) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const onClose = vi.fn();
    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} onClose={onClose} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    const dialog = screen.getByTestId("bulk-create-worktree-dialog");
    expect(dialog.dataset.dismissible).toBe("false");

    await act(async () => {
      dialog.click();
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onClose).not.toHaveBeenCalled();

    // The footer Cancel remains the deliberate way out.
    await act(async () => {
      const cancelBtn = screen
        .getAllByRole("button")
        .find((b) => b.textContent === "Cancel") as HTMLButtonElement;
      cancelBtn.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onClose).toHaveBeenCalled();

    await act(async () => {
      resolvers[0]?.("wt-1");
      await vi.advanceTimersByTimeAsync(1000);
    });
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

    // Advance to let all three items start (concurrency = 3)
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

  it("runs pre-queries once per batch before any worktree creates", async () => {
    const createResolvers: Array<(value: string) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          createResolvers.push(resolve);
        })
    );

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // With 3 issues, pre-query runs getAvailableBranch + getDefaultPath once each
    // per item BEFORE any worktree.create call. After the button click and
    // microtask flush, all pre-queries have completed and all three concurrency
    // slots have filled — but no further pre-query IPC should fire.
    expect(mockGetAvailableBranch).toHaveBeenCalledTimes(3);
    expect(mockGetDefaultPath).toHaveBeenCalledTimes(3);

    // The queue has started worktree.create for all 3 items (concurrency=3)
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);

    // Resolve all creates and advance
    await act(async () => {
      createResolvers[0]?.("wt-1");
      createResolvers[1]?.("wt-2");
      createResolvers[2]?.("wt-3");
      await vi.advanceTimersByTimeAsync(0);
    });
    await advanceTimersGradually(1000);

    // Pre-query call counts must not have grown — confirming the per-item
    // queue bodies read from the precomputed map, not fresh IPC calls.
    expect(mockGetAvailableBranch).toHaveBeenCalledTimes(3);
    expect(mockGetDefaultPath).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();
  });

  it("suffixes colliding branch names during pre-query", async () => {
    // findAvailableBranchName is a pure snapshot read — if two items
    // independently resolve to the same branch name (e.g., backend returned
    // identical result before any creates happened), the client-side
    // `assignedBranches` set must add `-2`, `-3`, ... to prevent a real
    // collision at create time. Force the scenario by returning a constant
    // branch name from the mock for both items.
    mockGetAvailableBranch.mockResolvedValue("feature/shared-branch");
    mockGetDefaultPath.mockImplementation((_root: string, branch: string) =>
      Promise.resolve(`/worktrees/${branch}`)
    );

    const props = { ...defaultProps, selectedIssues: [makeIssue(1), makeIssue(2)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(screen.getByText(/2 of 2 created/)).toBeTruthy();

    const createCalls = mockWorktreeCreate.mock.calls;
    expect(createCalls.length).toBe(2);
    const createdBranches = createCalls.map((c) => c[0].newBranch).sort();
    // First item keeps the base name; second gets a client-side `-2` suffix.
    expect(createdBranches).toEqual(["feature/shared-branch", "feature/shared-branch-2"]);
    // getDefaultPath was called with the post-suffix branch name for item 2.
    const pathCalls = mockGetDefaultPath.mock.calls.map((c) => c[1]);
    expect(pathCalls).toContain("feature/shared-branch-2");
  });

  it("does not dispatch stale ITEM_FAILED when cancelled during pre-query", async () => {
    // Defer getAvailableBranch so we can cancel while the pre-query is
    // pending. After cancel, the deferred rejection must not pollute the
    // reducer with a stale ITEM_FAILED row.
    let rejectPrequery: ((err: Error) => void) | null = null;
    mockGetAvailableBranch.mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectPrequery = reject;
        })
    );

    const onClose = vi.fn();
    render(<BulkCreateWorktreeDialog {...defaultProps} onClose={onClose} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Cancel while pre-query is still pending.
    await act(async () => {
      const buttons = screen.getAllByRole("button");
      const cancelBtn = buttons.find((b) => b.textContent === "Cancel");
      cancelBtn?.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    // Reject the pending pre-query after the cancel has bumped runIdRef.
    await act(async () => {
      rejectPrequery?.(new Error("IPC failure after cancel"));
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(onClose).toHaveBeenCalled();
    // No stale dispatches — the done button never appears, no error rows
    // bleed into the closed dialog, and no worktree.create was triggered.
    expect(screen.queryByTestId("bulk-create-done-button")).toBeNull();
    expect(mockWorktreeCreate).not.toHaveBeenCalled();
  });

  it("dispatches ITEM_FAILED and skips item when pre-query rejects", async () => {
    let availableBranchCalls = 0;
    mockGetAvailableBranch.mockImplementation((_root: string, branch: string) => {
      availableBranchCalls++;
      if (availableBranchCalls === 2) {
        return Promise.reject(new Error("Branch name is invalid"));
      }
      return Promise.resolve(branch);
    });

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(screen.getByText("Branch name is invalid")).toBeTruthy();
    expect(screen.getByText(/2 of 3 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    // The failed item never reached worktree.create.
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(2);
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

  it("invokes stored bulkCreateDialog.onComplete when Done is clicked", async () => {
    const storedOnComplete = vi.fn();
    mockBulkCreateDialog.onComplete = storedOnComplete;
    // Simulate the real closeBulkCreateDialog behavior: prop onComplete/onClose
    // zero out the stored callback. This catches the ordering bug where the
    // stored callback would be read after being cleared.
    const propOnComplete = vi.fn(() => {
      mockBulkCreateDialog.onComplete = undefined;
    });
    const propOnClose = vi.fn(() => {
      mockBulkCreateDialog.onComplete = undefined;
    });

    render(
      <BulkCreateWorktreeDialog
        {...defaultProps}
        onComplete={propOnComplete}
        onClose={propOnClose}
      />
    );

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();

    await act(async () => {
      screen.getByTestId("bulk-create-done-button").click();
    });

    expect(storedOnComplete).toHaveBeenCalledTimes(1);
  });

  it("does not invoke stored bulkCreateDialog.onComplete when dialog is cancelled", async () => {
    // Cancel/Escape/backdrop pre-completion must preserve bulk selection so
    // the user can reopen the dropdown and finish picking. Selection only
    // clears once worktrees are actually created.
    const storedOnComplete = vi.fn();
    mockBulkCreateDialog.onComplete = storedOnComplete;
    const propOnClose = vi.fn(() => {
      mockBulkCreateDialog.onComplete = undefined;
    });

    render(<BulkCreateWorktreeDialog {...defaultProps} onClose={propOnClose} />);

    await act(async () => {
      screen.getByText("Cancel").click();
    });

    expect(storedOnComplete).not.toHaveBeenCalled();
    expect(propOnClose).toHaveBeenCalledTimes(1);
  });

  it("invokes stored bulkCreateDialog.onComplete when dialog is dismissed after completion", async () => {
    // After the batch is done, dismissing via header X / Escape / backdrop
    // must run the same selection cleanup as the Done button — otherwise
    // the bulk-action bar stays visible with the now-stale selection.
    const storedOnComplete = vi.fn();
    mockBulkCreateDialog.onComplete = storedOnComplete;
    const propOnClose = vi.fn(() => {
      mockBulkCreateDialog.onComplete = undefined;
    });

    render(<BulkCreateWorktreeDialog {...defaultProps} onClose={propOnClose} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();

    // Dismiss via header close button (routes through handleClose, not handleDone)
    await act(async () => {
      screen.getByLabelText("Close dialog").click();
    });

    expect(storedOnComplete).toHaveBeenCalledTimes(1);
    expect(propOnClose).toHaveBeenCalledTimes(1);
  });

  it("clone layout generates command for agent panels and preserves plain terminal commands", async () => {
    mockSelectedRecipeId = "__clone_layout__";
    mockGenerateRecipeFromActiveTerminals.mockReturnValue([
      {
        type: "claude",
        title: "Agent",
        exitBehavior: "stay",
        command: "claude --resume stale-session",
        agentModelId: "claude-opus-4-7",
        agentLaunchFlags: ["--resume", "old"],
      },
      {
        type: "terminal",
        title: "Shell",
        exitBehavior: "close",
        command: "npm test",
      },
      {
        type: "dev-preview",
        title: "Preview",
        exitBehavior: "close",
        devCommand: "npm run dev",
      },
    ]);
    mockAgentSettingsGet.mockResolvedValue({ agents: { claude: { flags: [] } } });
    mockSystemGetTmpDir.mockResolvedValue("/tmp");
    mockGetAgentConfig.mockReturnValue({ command: "claude" });
    mockGenerateAgentCommand.mockReturnValue("claude --fresh-generated");

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();

    // Agent command is regenerated from current settings, not the stale one
    // captured at recipe-generation time.
    expect(mockGenerateAgentCommand).toHaveBeenCalledWith(
      "claude",
      { flags: [] },
      "claude",
      expect.objectContaining({
        clipboardDirectory: "/tmp/daintree-clipboard",
        modelId: "claude-opus-4-7",
      })
    );

    // Agent-running terminals are now kind: "terminal" with launchAgentId set.
    const agentCall = mockAddPanel.mock.calls.find((c) => c[0].launchAgentId === "claude");
    expect(agentCall).toBeDefined();
    expect(agentCall?.[0].kind).toBe("terminal");
    expect(agentCall?.[0].command).toBe("claude --fresh-generated");
    expect(agentCall?.[0].launchAgentId).toBe("claude");
    expect(agentCall?.[0].command).not.toContain("stale-session");
    // Per-panel agent overrides survive the clone-layout projection.
    expect(agentCall?.[0].agentModelId).toBe("claude-opus-4-7");
    expect(agentCall?.[0].agentLaunchFlags).toEqual(["--resume", "old"]);

    // Plain terminal command is passed through verbatim (it's a user-authored
    // shell command, not a path-scoped agent invocation).
    const terminalCall = mockAddPanel.mock.calls.find(
      (c) => c[0].kind === "terminal" && !c[0].launchAgentId
    );
    expect(terminalCall).toBeDefined();
    expect(terminalCall?.[0].command).toBe("npm test");

    // Dev-preview carries devCommand, not command.
    const devPreviewCall = mockAddPanel.mock.calls.find((c) => c[0].kind === "dev-preview");
    expect(devPreviewCall).toBeDefined();
    expect(devPreviewCall?.[0].devCommand).toBe("npm run dev");
  });

  it("clone layout degrades gracefully when agent settings IPC fails", async () => {
    mockSelectedRecipeId = "__clone_layout__";
    mockGenerateRecipeFromActiveTerminals.mockReturnValue([
      { type: "claude", title: "Agent", exitBehavior: "stay" },
    ]);
    mockAgentSettingsGet.mockRejectedValue(new Error("IPC timeout"));
    mockGetAgentConfig.mockReturnValue({ command: "claude" });
    mockGenerateAgentCommand.mockReturnValue("claude --default");

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    // Worktree still created — failed IPC is non-fatal.
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();

    // Agent command was still generated (with an empty settings entry).
    expect(mockGenerateAgentCommand).toHaveBeenCalledWith(
      "claude",
      {},
      "claude",
      expect.objectContaining({ clipboardDirectory: undefined })
    );
    const agentCall = mockAddPanel.mock.calls.find((c) => c[0].launchAgentId === "claude");
    expect(agentCall?.[0].command).toBe("claude --default");
  });

  it("clone layout skips agent-settings prefetch when no agent panels present", async () => {
    mockSelectedRecipeId = "__clone_layout__";
    mockGenerateRecipeFromActiveTerminals.mockReturnValue([
      { type: "terminal", title: "Shell", exitBehavior: "close", command: "ls" },
    ]);

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
    // No agent panels → prefetch is skipped entirely.
    expect(mockAgentSettingsGet).not.toHaveBeenCalled();
    expect(mockGenerateAgentCommand).not.toHaveBeenCalled();

    const terminalCall = mockAddPanel.mock.calls.find((c) => c[0].kind === "terminal");
    expect(terminalCall?.[0].command).toBe("ls");
  });

  it("clone layout continues spawning and surfaces failure when addPanel throws mid-loop", async () => {
    mockSelectedRecipeId = "__clone_layout__";
    mockGenerateRecipeFromActiveTerminals.mockReturnValue([
      { type: "terminal", title: "A", exitBehavior: "close", command: "cmd-a" },
      { type: "terminal", title: "B", exitBehavior: "close", command: "cmd-b" },
      { type: "terminal", title: "C", exitBehavior: "close", command: "cmd-c" },
    ]);
    mockAddPanel
      .mockResolvedValueOnce("panel-a")
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce("panel-c");

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    // Loop continued past the throw — all three terminals attempted.
    expect(mockAddPanel).toHaveBeenCalledTimes(3);

    // Item is surfaced as failed, not silently succeeded.
    expect(screen.queryByText(/1 of 1 created/)).toBeNull();
    expect(screen.getByText(/0 of 1 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(screen.getByTestId("bulk-create-retry-button")).toBeTruthy();
  });

  it("clone layout treats addPanel returning null as a per-terminal failure", async () => {
    mockSelectedRecipeId = "__clone_layout__";
    mockGenerateRecipeFromActiveTerminals.mockReturnValue([
      { type: "terminal", title: "A", exitBehavior: "close", command: "cmd-a" },
      { type: "terminal", title: "B", exitBehavior: "close", command: "cmd-b" },
    ]);
    mockAddPanel.mockResolvedValueOnce("panel-a").mockResolvedValueOnce(null);

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(mockAddPanel).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/1 of 1 created/)).toBeNull();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(screen.getByTestId("bulk-create-retry-button")).toBeTruthy();
  });

  it("clone layout retry re-enters clone branch after partial failure", async () => {
    mockSelectedRecipeId = "__clone_layout__";
    mockGenerateRecipeFromActiveTerminals.mockReturnValue([
      { type: "terminal", title: "A", exitBehavior: "close", command: "cmd-a" },
      { type: "terminal", title: "B", exitBehavior: "close", command: "cmd-b" },
    ]);
    // First run: second terminal throws. Retry run: both succeed.
    mockAddPanel
      .mockResolvedValueOnce("panel-a1")
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce("panel-a2")
      .mockResolvedValueOnce("panel-b2");

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(mockAddPanel).toHaveBeenCalledTimes(2);

    // Retry: cloneComplete must have stayed false, so the branch re-enters.
    await act(async () => {
      screen.getByTestId("bulk-create-retry-button").click();
    });
    await advanceTimersGradually(5000);

    expect(mockAddPanel).toHaveBeenCalledTimes(4);
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
    expect(screen.queryByText(/1 failed/)).toBeNull();
  });

  it("clone layout retry re-enters clone branch after verification failure", async () => {
    mockSelectedRecipeId = "__clone_layout__";
    mockGenerateRecipeFromActiveTerminals.mockReturnValue([
      { type: "terminal", title: "A", exitBehavior: "close", command: "cmd-a" },
    ]);
    // First run spawns successfully but terminal crashes post-batch.
    mockAddPanel.mockResolvedValueOnce("panel-crash");
    mockTerminals = [{ id: "panel-crash", exitCode: 1 }];

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    // Verification caught the crash and marked the item failed.
    expect(screen.getByText(/terminal\(s\) crashed/)).toBeTruthy();
    expect(screen.getByTestId("bulk-create-retry-button")).toBeTruthy();
    expect(mockAddPanel).toHaveBeenCalledTimes(1);

    // Retry: healthy terminal this time. cloneComplete must have been reset so
    // the clone branch re-runs; otherwise the retry silently marks succeeded
    // with zero spawn attempts.
    mockAddPanel.mockResolvedValueOnce("panel-healthy");
    mockTerminals = [{ id: "panel-healthy", exitCode: undefined }];

    await act(async () => {
      screen.getByTestId("bulk-create-retry-button").click();
    });
    await advanceTimersGradually(5000);

    expect(mockAddPanel).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
  });
});

describe("BulkCreateWorktreeDialog — issue assignment retry", () => {
  const assignProps = {
    isOpen: true,
    onClose: vi.fn(),
    mode: "issue" as const,
    selectedIssues: [makeIssue(1)],
    selectedPRs: [] as PR[],
    onComplete: vi.fn(),
  };

  it("retries transient assignment failure with backoff then succeeds", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };

    let assignCallCount = 0;
    mockAssignIssue.mockImplementation(() => {
      assignCallCount++;
      if (assignCallCount === 1) {
        return Promise.reject(new Error("GitHub is temporarily unavailable. Please retry."));
      }
      return Promise.resolve();
    });

    render(<BulkCreateWorktreeDialog {...assignProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(35000);

    expect(assignCallCount).toBe(2);
    expect(mockAssignIssue).toHaveBeenCalledWith("/test/root", 1, "me");
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("succeeds when assignment recovers after two transient failures", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };

    let assignCallCount = 0;
    mockAssignIssue.mockImplementation(() => {
      assignCallCount++;
      if (assignCallCount <= 2) {
        return Promise.reject(new Error("GitHub is temporarily unavailable. Please retry."));
      }
      return Promise.resolve();
    });

    render(<BulkCreateWorktreeDialog {...assignProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(70000);

    // Two transient failures inside the wall-clock window must keep retrying;
    // the third attempt recovers and short-circuits out of the loop.
    expect(assignCallCount).toBe(3);
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("keeps retrying transient assignment failures past the old 3-attempt cap", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };

    // Six consecutive transient failures — more than the old MAX_AUTO_RETRIES
    // cap of 3 total attempts — then recovery. Proves the count-based ceiling is
    // gone and a secondary rate limit that lasts a few minutes is ridden out.
    let assignCallCount = 0;
    mockAssignIssue.mockImplementation(() => {
      assignCallCount++;
      if (assignCallCount <= 6) {
        return Promise.reject(new Error("You have exceeded a secondary rate limit."));
      }
      return Promise.resolve();
    });

    render(<BulkCreateWorktreeDialog {...assignProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Each backoff is capped at 60s; drain enough virtual time (still well under
    // the 5-minute ceiling) for all six retries to elapse.
    await advanceTimersGradually(420000, 5000);

    expect(assignCallCount).toBe(7);
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("surfaces non-transient assignment failures as item failures", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };

    mockAssignIssue.mockRejectedValue(new Error("Forbidden"));

    render(<BulkCreateWorktreeDialog {...assignProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    // Permanent failure must not retry, and must mark the item failed instead
    // of falling through to ITEM_SUCCEEDED (see #8975).
    expect(mockAssignIssue).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/0 of 1 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(screen.getByText(/Assignment failed/)).toBeTruthy();
  });

  it("surfaces a silent-drop assignment (token lacks push access) as a failure", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };

    // POST /assignees returns 201 with an empty assignees[] when the token
    // lacks push access. assignIssue() in the main process detects this and
    // throws the message below; isTransientError() must not match it, so the
    // call is treated as permanent.
    mockAssignIssue.mockRejectedValue(
      new Error('Assignment succeeded but user "me" not found in response')
    );

    render(<BulkCreateWorktreeDialog {...assignProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    expect(mockAssignIssue).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/0 of 1 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(screen.getByText(/Assignment failed/)).toBeTruthy();
  });

  it("gives up on a transient assignment failure only after the wall-clock ceiling", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };

    mockAssignIssue.mockRejectedValue(
      new Error("GitHub is temporarily unavailable. Please retry.")
    );

    render(<BulkCreateWorktreeDialog {...assignProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // A persistent transient failure must keep retrying past the old 3-attempt
    // cap and surface as a failure only once the 5-minute per-item ceiling
    // (MAX_TRANSIENT_RETRY_MS) elapses. Drain well past it (each backoff is
    // capped at 60s, so several attempts accrue before the deadline).
    await advanceTimersGradually(360000, 5000);

    expect(mockAssignIssue.mock.calls.length).toBeGreaterThan(3);
    expect(screen.getByText(/0 of 1 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(screen.getByText(/Assignment failed/)).toBeTruthy();
  });

  it("stops assignment retries when the run is cancelled mid-backoff", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };

    mockAssignIssue.mockRejectedValue(
      new Error("GitHub is temporarily unavailable. Please retry.")
    );

    render(<BulkCreateWorktreeDialog {...assignProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Let the worktree finish and the first assignIssue call fail; the loop
    // is now suspended on `await cancellableDelay(assignBackoff, …)`.
    await advanceTimersGradually(100);
    expect(mockAssignIssue).toHaveBeenCalledTimes(1);

    // Cancel before backoff expires.
    await act(async () => {
      const buttons = screen.getAllByRole("button");
      const cancelBtn = buttons.find((b) => b.textContent === "Cancel");
      cancelBtn?.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    // Drain remaining backoff window — the stale-run guard must short-circuit
    // the loop before another IPC call goes out.
    await advanceTimersGradually(35000);

    expect(mockAssignIssue).toHaveBeenCalledTimes(1);
  });

  it("accounts mixed assignment outcomes correctly in a 3-item batch", async () => {
    // The original bug surfaced in bulk accounting — every prior test in this
    // describe block uses a single-item batch. This test guards the regression
    // that prompted #8975: 2 of 3 must NOT be reported as 3 of 3.
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };

    mockAssignIssue.mockImplementation((_root: string, issueNumber: number, _username: string) => {
      if (issueNumber === 2) return Promise.reject(new Error("Forbidden"));
      return Promise.resolve();
    });

    const props = {
      ...assignProps,
      selectedIssues: [makeIssue(1), makeIssue(2), makeIssue(3)],
    };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    expect(screen.getByText(/2 of 3 created/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(screen.getByText(/Assignment failed/)).toBeTruthy();
  });

  it("does not re-run the recipe when retrying an assignment-only failure", async () => {
    // Pre-fix, handleRetryFailed cleared all terminal tracking, causing the
    // recipe to re-spawn every terminal on retry of an assignment failure.
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ terminalId: "t-1" }],
      failed: [],
    });
    mockTerminals = [{ id: "t-1", exitCode: undefined }];

    let assignCallCount = 0;
    mockAssignIssue.mockImplementation(() => {
      assignCallCount++;
      if (assignCallCount === 1) return Promise.reject(new Error("Forbidden"));
      return Promise.resolve();
    });

    render(<BulkCreateWorktreeDialog {...assignProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(mockRunRecipeWithResults).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Assignment failed/)).toBeTruthy();

    // Click "Retry failed" — recipe must NOT re-spawn terminals.
    await act(async () => {
      const buttons = screen.getAllByRole("button");
      const retryBtn = buttons.find((b) => b.textContent?.includes("Retry"));
      retryBtn?.click();
    });
    await advanceTimersGradually(5000);

    expect(mockRunRecipeWithResults).toHaveBeenCalledTimes(1);
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(1);
    expect(assignCallCount).toBe(2);
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
  });

  it("assignment failure is not overwritten by post-batch verification", async () => {
    // Both branches converge on ITEM_FAILED. The post-batch verification loop
    // must skip items already in failedItems, or it overwrites
    // failedStep:"assignment" with failedStep:"verification".
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ terminalId: "t-crash" }],
      failed: [],
    });
    // Terminal will be observed as crashed during verification.
    mockTerminals = [{ id: "t-crash", exitCode: 1 }];

    mockAssignIssue.mockRejectedValue(new Error("Forbidden"));

    render(<BulkCreateWorktreeDialog {...assignProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(screen.getByText(/Assignment failed/)).toBeTruthy();
    expect(screen.queryByText(/Missing terminals/)).toBeNull();
  });

  it("patches the cached issue-list slot so the dropdown reflects the self-assign", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me", avatarUrl: "https://example.com/me.png" };
    mockAssignIssue.mockResolvedValue(undefined);

    // Seed two cached slots (different sort orders) under the same
    // `${rootPath}:issue:` prefix — mutateCacheEntries must patch every slot.
    // Each holds the issue being assigned plus a sibling that stays untouched.
    const keyA = buildCacheKey("/test/root", "issue", "open", "created_at:desc");
    const keyB = buildCacheKey("/test/root", "issue", "open", "updated_at:desc");
    // A slot for a different project must NOT be touched.
    const keyOther = buildCacheKey("/other/root", "issue", "open", "created_at:desc");
    for (const k of [keyA, keyB, keyOther]) {
      setCache(k, {
        items: [makeIssue(1), makeIssue(2)],
        nextCursor: null,
        hasMore: false,
        timestamp: Date.now(),
      });
    }

    render(<BulkCreateWorktreeDialog {...assignProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(mockAssignIssue).toHaveBeenCalledWith("/test/root", 1, "me");

    for (const k of [keyA, keyB]) {
      const patched = getCache(k);
      const issue1 = patched?.items.find((i) => i.number === 1) as Issue;
      expect(issue1.assignees).toContainEqual({
        login: "me",
        avatarUrl: "https://example.com/me.png",
        rawData: null,
      });
      // The sibling issue (not assigned) keeps its empty assignees list.
      const issue2 = patched?.items.find((i) => i.number === 2) as Issue;
      expect(issue2.assignees).toEqual([]);
    }
    // A different project's slot is untouched by the prefix-scoped patch.
    const otherIssue1 = getCache(keyOther)?.items.find((i) => i.number === 1) as Issue;
    expect(otherIssue1.assignees).toEqual([]);
    // The cache patch succeeded, so no cache-error log was emitted.
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("contains a cache-patch throw without failing the assignment", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };
    mockAssignIssue.mockResolvedValue(undefined);

    // A malformed entry (items not an array) makes the in-transform map() throw,
    // exercising the try/catch guard: the assignment already succeeded server
    // side, so the item must still count as created and the error is only logged.
    const key = buildCacheKey("/test/root", "issue", "open", "created_at:desc");
    setCache(key, {
      items: null as unknown as Issue[],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    render(<BulkCreateWorktreeDialog {...assignProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(mockAssignIssue).toHaveBeenCalledWith("/test/root", 1, "me");
    expect(screen.getByText(/1 of 1 created/)).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      "Failed to patch issue cache after bulk self-assign",
      expect.any(Error)
    );
  });

  it("does not duplicate the assignee when the cached issue already lists the user", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };
    mockAssignIssue.mockResolvedValue(undefined);

    const key = buildCacheKey("/test/root", "issue", "open", "created_at:desc");
    const seeded = makeIssue(1);
    seeded.assignees = [{ login: "me", avatarUrl: undefined, rawData: null }];
    setCache(key, {
      items: [seeded],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    render(<BulkCreateWorktreeDialog {...assignProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    const issue1 = getCache(key)?.items.find((i) => i.number === 1) as Issue;
    expect(issue1.assignees).toHaveLength(1);
    expect(issue1.assignees.filter((a) => a.login === "me")).toHaveLength(1);
  });
});

describe("BulkCreateWorktreeDialog — form layout and batch summary", () => {
  const issueProps = {
    isOpen: true,
    onClose: vi.fn(),
    mode: "issue" as const,
    selectedIssues: [makeIssue(1), makeIssue(2), makeIssue(3)],
    selectedPRs: [] as PR[],
    onComplete: vi.fn(),
  };

  function hintText(): string {
    return screen.getByTestId("bulk-create-footer-hint").textContent ?? "";
  }

  /** The rail `<label>` carrying this text, as opposed to any other node with it. */
  function railLabel(text: string): HTMLLabelElement {
    const match = screen
      .getAllByText(text)
      .find((node): node is HTMLLabelElement => node.tagName === "LABEL");
    if (!match) throw new Error(`no <label> with text "${text}"`);
    return match;
  }

  it("names the assignment checkbox from the rail label, not an aria-label", () => {
    viewerHolder.user = { login: "octocat" };
    render(<BulkCreateWorktreeDialog {...issueProps} />);

    const checkbox = screen.getByRole("checkbox");
    // The association has to run label -> control. An aria-label would win over
    // the rail's <label for>, leaving the visible text out of the accessible
    // name (WCAG 2.5.3).
    expect(checkbox.getAttribute("aria-label")).toBeNull();
    expect(checkbox.id).toBeTruthy();
    expect(railLabel("Assign to me").htmlFor).toBe(checkbox.id);
  });

  it("names the recipe trigger from the rail label", () => {
    render(<BulkCreateWorktreeDialog {...issueProps} />);

    const trigger = screen.getByRole("combobox");
    expect(trigger.getAttribute("aria-label")).toBeNull();
    expect(trigger.id).toBeTruthy();
    expect(railLabel("Starting layout").htmlFor).toBe(trigger.id);
  });

  it("keeps the assignment row mounted while identity resolves", async () => {
    let resolveViewer!: (user: { login: string } | null) => void;
    mockGetCurrentUser.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveViewer = resolve as (user: { login: string } | null) => void;
        })
    );

    render(<BulkCreateWorktreeDialog {...issueProps} />);

    const before = screen.getByRole("checkbox") as HTMLInputElement;
    // Still looking is not the same as found nothing: naming a failure here
    // would be wrong, and disabling would be too.
    expect(before.disabled).toBe(false);
    expect(screen.queryByText("Account unavailable")).toBeNull();

    await act(async () => {
      resolveViewer({ login: "octocat" });
    });

    // Same node, not a re-inserted row: identity arriving must populate the
    // row rather than add one and push everything below it down.
    const after = screen.getByRole("checkbox") as HTMLInputElement;
    expect(after).toBe(before);
    expect(after.disabled).toBe(false);
    expect(screen.getByText("@octocat")).toBeTruthy();
  });

  it("goes dead only once the lookup comes back with no account", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = null;
    render(<BulkCreateWorktreeDialog {...issueProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    // The run loop skips assignment without a login, so a checked box would
    // promise work that never happens.
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(false);
    expect(screen.getByText("Account unavailable")).toBeTruthy();
  });

  it("treats a failed identity lookup the same as no account", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    mockGetCurrentUser.mockImplementationOnce(() => Promise.reject(new Error("network down")));
    render(<BulkCreateWorktreeDialog {...issueProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(false);
    expect(screen.getByText("Account unavailable")).toBeTruthy();
  });

  it("reflects the preference once an account is available", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "octocat" };
    render(<BulkCreateWorktreeDialog {...issueProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(mockSetAssignWorktreeToSelf).toHaveBeenCalledWith(false);
  });

  it("renders the batch preview as one list item per planned worktree", () => {
    worktreeDataHolder.map.set("existing-2", {
      worktreeId: "existing-2",
      branch: "feature/issue-2",
      path: "/worktrees/issue-2",
      issueNumber: 2,
    });
    render(<BulkCreateWorktreeDialog {...issueProps} />);

    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows).toHaveLength(issueProps.selectedIssues.length);
    expect(screen.getByText("Has worktree")).toBeTruthy();
  });

  it("keeps the summary, the list and the create button telling the same story", () => {
    const props = {
      ...issueProps,
      selectedIssues: [makeIssue(1), { ...makeIssue(2), state: "closed" as const }, makeIssue(3)],
    };
    render(<BulkCreateWorktreeDialog {...props} />);

    const hint = hintText();
    const selected = Number(/^(\d+)/.exec(hint)?.[1]);
    const skipped = Number(/(\d+) skipped/.exec(hint)?.[1] ?? 0);
    const creating = Number(
      /Create (\d+)/.exec(screen.getByTestId("bulk-create-confirm-button").textContent ?? "")?.[1]
    );

    expect(selected).toBe(within(screen.getByRole("list")).getAllByRole("listitem").length);
    expect(skipped).toBeGreaterThan(0);
    expect(selected - skipped).toBe(creating);
  });

  it("counts PR skips the same way", () => {
    const props = {
      ...issueProps,
      mode: "pr" as const,
      selectedIssues: [] as Issue[],
      selectedPRs: [makePR(10), { ...makePR(20), merged: true }, makePR(30)],
    };
    render(<BulkCreateWorktreeDialog {...props} />);

    const hint = hintText();
    const selected = Number(/^(\d+)/.exec(hint)?.[1]);
    const skipped = Number(/(\d+) skipped/.exec(hint)?.[1] ?? 0);
    const creating = Number(
      /Create (\d+)/.exec(screen.getByTestId("bulk-create-confirm-button").textContent ?? "")?.[1]
    );

    expect(selected).toBe(within(screen.getByRole("list")).getAllByRole("listitem").length);
    expect(selected - skipped).toBe(creating);
  });

  it("blocks creation when the whole selection is skipped", async () => {
    const props = {
      ...issueProps,
      selectedIssues: [
        { ...makeIssue(1), state: "closed" as const },
        { ...makeIssue(2), state: "closed" as const },
      ],
    };
    render(<BulkCreateWorktreeDialog {...props} />);

    const hint = hintText();
    expect(Number(/^(\d+)/.exec(hint)?.[1])).toBe(Number(/(\d+) skipped/.exec(hint)?.[1]));

    const confirm = screen.getByTestId("bulk-create-confirm-button") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    await act(async () => {
      confirm.click();
    });
    expect(mockWorktreeCreate).not.toHaveBeenCalled();
  });

  it("omits the skipped clause when the whole selection is creatable", () => {
    render(<BulkCreateWorktreeDialog {...issueProps} />);
    expect(hintText()).toBe("3 issues selected");
  });

  it("uses the singular noun for a selection of one", () => {
    const props = { ...issueProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);
    expect(hintText()).toBe("1 issue selected");
  });

  it("names pull requests in PR mode", () => {
    const props = {
      ...issueProps,
      mode: "pr" as const,
      selectedIssues: [] as Issue[],
      selectedPRs: [makePR(10), makePR(20)],
    };
    render(<BulkCreateWorktreeDialog {...props} />);
    expect(hintText()).toBe("2 pull requests selected");
  });

  it("asks for a selection when there is nothing to plan", () => {
    const props = { ...issueProps, selectedIssues: [] as Issue[] };
    render(<BulkCreateWorktreeDialog {...props} />);
    expect(hintText()).toBe("Select an issue to continue");
  });

  it("drops the summary once the run starts, leaving the progress line authoritative", async () => {
    const props = { ...issueProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);
    expect(screen.getByTestId("bulk-create-footer-hint")).toBeTruthy();

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    expect(screen.queryByTestId("bulk-create-footer-hint")).toBeNull();
  });
});

describe("BulkCreateWorktreeDialog — PR mode", () => {
  const prProps = {
    isOpen: true,
    onClose: vi.fn(),
    mode: "pr" as const,
    selectedIssues: [] as Issue[],
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
    expect(createCalls[0]![0].fromRemote).toBe(true);
    expect(createCalls[0]![0].baseBranch).toBe("origin/feature/pr-10");
    expect(createCalls[0]![0].newBranch).toBe("feature/pr-10");
  });

  it("invokes stored bulkCreateDialog.onComplete when Done is clicked in PR mode", async () => {
    mockListBranches.mockResolvedValue([
      { name: "origin/feature/pr-10", current: false, remote: true },
      { name: "origin/feature/pr-20", current: false, remote: true },
      { name: "origin/feature/pr-30", current: false, remote: true },
    ]);
    const storedOnComplete = vi.fn();
    mockBulkCreateDialog.onComplete = storedOnComplete;

    render(<BulkCreateWorktreeDialog {...prProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(screen.getByText(/3 of 3 created/)).toBeTruthy();

    await act(async () => {
      screen.getByTestId("bulk-create-done-button").click();
    });

    expect(storedOnComplete).toHaveBeenCalledTimes(1);
  });

  it("includes fork PRs in plan", () => {
    const forkPR: PR = {
      ...makePR(99),
      rawData: { isFork: true },
    };
    const props = { ...prProps, selectedPRs: [forkPR] };
    render(<BulkCreateWorktreeDialog {...props} />);

    expect(screen.queryByText("Fork PR")).toBeNull();
    expect(screen.getByTestId("bulk-create-confirm-button").hasAttribute("disabled")).toBe(false);
  });

  it("skips merged PRs with reason", () => {
    const mergedPR: PR = {
      ...makePR(99),
      state: "merged",
      merged: true,
    };
    const props = { ...prProps, selectedPRs: [mergedPR] };
    render(<BulkCreateWorktreeDialog {...props} />);

    expect(screen.getByText("Merged")).toBeTruthy();
  });

  it("skips PRs without headRef", () => {
    const noRefPR: PR = {
      ...makePR(99),
      headRef: undefined as unknown as string,
    };
    const props = { ...prProps, selectedPRs: [noRefPR] };
    render(<BulkCreateWorktreeDialog {...props} />);

    expect(screen.getByText("No branch info")).toBeTruthy();
  });

  it("does not show assign-to-self toggle in PR mode", () => {
    render(<BulkCreateWorktreeDialog {...prProps} />);
    // Both halves: no control, and no orphaned rail label pointing at nothing.
    expect(screen.queryByRole("checkbox")).toBeNull();
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
    expect(createCalls[0]![0].useExistingBranch).toBe(true);
    expect(createCalls[0]![0].fromRemote).toBe(false);
  });

  it("calls listBranches once per batch, not once per PR", async () => {
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
    // Single shared snapshot hoisted before the queue, not one per item.
    expect(mockListBranches).toHaveBeenCalledTimes(1);
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);
  });

  it("fails all PRs when shared listBranches snapshot rejects", async () => {
    mockListBranches.mockRejectedValueOnce(new Error("git ls-remote failed"));

    render(<BulkCreateWorktreeDialog {...prProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(screen.getByText(/0 of 3 created/)).toBeTruthy();
    expect(screen.getByText(/3 failed/)).toBeTruthy();
    expect(screen.getAllByText(/git ls-remote failed/).length).toBeGreaterThanOrEqual(1);
    expect(mockWorktreeCreate).not.toHaveBeenCalled();
    expect(mockFetchPRBranch).not.toHaveBeenCalled();
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
