/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { whenPluginUiReady } from "@daintreehq/plugin-ui";
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

/**
 * The shape `worktreeClient.create` resolves to. The branch travels WITH the
 * result because the host owns collision handling and may land on a different
 * one than was asked for; the renderer has no race-free way to read it back.
 */
const createdWorktree = (worktreeId: string, branch = "feature/x") => ({
  worktreeId,
  branch,
  setupState: "pending" as const,
});
const mockGetAvailableBranch = vi.fn();
const mockGetDefaultPath = vi.fn();
const mockListBranches = vi.fn();
const mockGetRecentBranches = vi.fn();
const mockFetchPRBranch = vi.fn();
const mockAssignIssue = vi.fn();
const mockLogError = vi.fn();
const mockAgentSettingsGet = vi.fn();
const mockSystemGetTmpDir = vi.fn();
const mockGetAgentConfig = vi.fn();
const mockGenerateAgentCommand = vi.fn();

vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  worktreeClient: {
    create: (...args: unknown[]) => mockWorktreeCreate(...args),
    getAvailableBranch: (...args: unknown[]) => mockGetAvailableBranch(...args),
    getDefaultPath: (...args: unknown[]) => mockGetDefaultPath(...args),
    listBranches: (...args: unknown[]) => mockListBranches(...args),
    getRecentBranches: (...args: unknown[]) => mockGetRecentBranches(...args),
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

vi.mock("@/config/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/agents")>()),
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

let mockTerminals: Array<{
  id: string;
  exitCode?: number;
  worktreeId?: string;
  location?: string;
  spawnStatus?: string;
  isRestarting?: boolean;
}> = [];
const mockAddPanel = vi.fn();
const mockTrashPanel = vi.fn();
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
      trashPanel: (id: string) => mockTrashPanel(id),
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
    recipes: Array<{ id: string; shadowedBy?: unknown }>,
    persistedDefaultRecipeId: string | undefined
  ) => {
    // Mirror the real implementation: return the persisted ID only if it exists in recipes and is not shadowed
    return recipes.some((r) => r.id === persistedDefaultRecipeId && !r.shadowedBy)
      ? persistedDefaultRecipeId
      : undefined;
  },
  useRecipePicker: () => ({
    selectedRecipeId: mockSelectedRecipeId,
    setSelectedRecipeId: vi.fn(),
    recipePickerOpen: false,
    setRecipePickerOpen: vi.fn(),
    recipeSelectionTouchedRef: { current: false },
    markRecipeSelectionTouched: vi.fn(),
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
import {
  _resetBulkCreateRunsForTests,
  cancelBulkCreateRun,
  retryFailedBulkCreateRun,
  toBulkWorktreeRunSnapshot,
  useBulkCreateRunStore,
  type BulkCreateRun,
} from "../components/bulkCreateRunner";
import { bulkRunItemStep, summarizeBulkRun } from "@/lib/bulkWorktreeRuns";
import { notify } from "@/lib/notify";

/** The run Create started most recently. */
function latestRun(): BulkCreateRun {
  const { runs } = useBulkCreateRunStore.getState();
  const ids = Object.keys(runs);
  const run = runs[ids[ids.length - 1] ?? ""];
  if (!run) throw new Error("Create has not started a run");
  return run;
}

function itemOf(issueNumber: number) {
  return latestRun().progress.items.get(issueNumber);
}

/** The run as the toolbar chip and the inbox read it. */
function runSummary() {
  return summarizeBulkRun(toBulkWorktreeRunSnapshot(latestRun()));
}

/** Each item's step in the words the chip's popover shows, by issue/PR number. */
function itemSteps(): Record<number, string> {
  const snapshot = toBulkWorktreeRunSnapshot(latestRun());
  return Object.fromEntries(
    snapshot.items.map((item) => [
      item.number,
      bulkRunItemStep(item, snapshot.mode, snapshot.phase),
    ])
  );
}

/** The dialog closes on Create; cancel comes from the toolbar chip, which calls the runner. */
async function cancelRun() {
  await act(async () => {
    expect(cancelBulkCreateRun(latestRun().id)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Retry failed, as the toolbar chip sends it. */
async function retryFailed() {
  await act(async () => {
    expect(retryFailedBulkCreateRun(latestRun().id)).not.toBeNull();
  });
}

async function clickCreate() {
  await act(async () => {
    screen.getByTestId("bulk-create-confirm-button").click();
  });
}

function skipBadges(reason: string): number {
  return screen.queryAllByText(reason).filter((node) => node.dataset.slot === "badge").length;
}

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
    return Promise.resolve(createdWorktree(`wt-${callIndex}`));
  });
  mockListBranches.mockResolvedValue([
    { name: "main", current: true, remote: false },
    { name: "origin/main", current: false, remote: true },
  ]);
  mockGetRecentBranches.mockResolvedValue([]);
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

beforeAll(() => whenPluginUiReady(), 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Runs outlive the dialog by design, so each test starts with none.
  _resetBulkCreateRunsForTests();
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

  it("names the worktree count on the confirm button with tabular figures", () => {
    const { rerender } = render(<BulkCreateWorktreeDialog {...defaultProps} />);
    const confirm = screen.getByTestId("bulk-create-confirm-button");
    expect(confirm.textContent).toContain("Create 3 worktrees");
    expect(confirm.className).toContain("tabular-nums");

    rerender(<BulkCreateWorktreeDialog {...defaultProps} selectedIssues={[makeIssue(1)]} />);
    expect(screen.getByTestId("bulk-create-confirm-button").textContent).toContain(
      "Create 1 worktree"
    );
    expect(screen.getByTestId("bulk-create-confirm-button").textContent).not.toContain("worktrees");
  });

  it("groups digits in a large batch's summary and confirm button", () => {
    const many = Array.from({ length: 1204 }, (_, i) =>
      i < 1200 ? { ...makeIssue(i + 1), state: "closed" as const } : makeIssue(i + 1)
    );
    render(<BulkCreateWorktreeDialog {...defaultProps} selectedIssues={many} />);
    expect(screen.getByTestId("bulk-create-footer-hint").textContent).toBe(
      "1,204 issues \u00b7 1,200 skipped \u00b7 runs in the background"
    );
    const clearable = Array.from({ length: 1204 }, (_, i) => makeIssue(i + 1));
    cleanup();
    render(<BulkCreateWorktreeDialog {...defaultProps} selectedIssues={clearable} />);
    expect(screen.getByTestId("bulk-create-confirm-button").textContent).toContain(
      "Create 1,204 worktrees"
    );
  });

  it("creates worktrees using direct client calls", async () => {
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
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
      resolvers[0]?.(createdWorktree("wt-1"));
      resolvers[1]?.(createdWorktree("wt-2"));
      resolvers[2]?.(createdWorktree("wt-3"));
      await vi.advanceTimersByTimeAsync(0);
    });

    // Advance past verification settle delay
    await advanceTimersGradually(1000);

    expect(latestRun().progress.phase).toBe("done");
    expect(runSummary().detail).toBe("3 of 3 created");
    expect(runSummary().facts.ready).toBe(3);
  });

  it("shows per-item sub-step status during execution", async () => {
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
          resolvers.push(resolve);
        })
    );

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Every item started immediately under concurrency = 3, so each is on
    // its worktree step.
    expect(Object.values(itemSteps())).toEqual([
      "Creating worktree\u2026",
      "Creating worktree\u2026",
      "Creating worktree\u2026",
    ]);

    // Resolve all
    await act(async () => {
      resolvers[0]?.(createdWorktree("wt-1"));
      await vi.advanceTimersByTimeAsync(0);
    });
    // The one that landed moves on; the others are still creating.
    expect(itemOf(1)?.stage).toBe("succeeded");
    expect([itemOf(2)?.stage, itemOf(3)?.stage]).toEqual([
      "worktree-creating",
      "worktree-creating",
    ]);
    await act(async () => {
      resolvers[1]?.(createdWorktree("wt-2"));
      resolvers[2]?.(createdWorktree("wt-3"));
      await vi.advanceTimersByTimeAsync(0);
    });
    await advanceTimersGradually(1000);

    expect(runSummary().detail).toBe("3 of 3 created");
    expect(latestRun().progress.phase).toBe("done");
  });

  it("displays error messages for failed items", async () => {
    let callCount = 0;
    mockWorktreeCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("Branch already exists"));
      return Promise.resolve(createdWorktree(`wt-${callCount}`));
    });

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Let all tasks run (with backoff delays for transient check)
    await advanceTimersGradually(5000);

    expect(itemOf(2)).toMatchObject({
      stage: "failed",
      error: "Branch already exists",
      failedStep: "worktree",
    });
    expect(itemSteps()[2]).toBe("Couldn't create worktree");
    expect(runSummary().detail).toBe("2 of 3 created · 1 not created");
    expect(runSummary().facts.failed).toBe(1);
  });

  it("files one quiet inbox entry and leaves nothing to retry when every item succeeds", async () => {
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
          resolvers.push(resolve);
        })
    );
    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Nothing is filed while the run is still going.
    await act(async () => {
      resolvers[0]?.(createdWorktree("wt-1"));
      resolvers[1]?.(createdWorktree("wt-2"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latestRun().progress.phase).toBe("executing");
    expect(notify).not.toHaveBeenCalled();

    await act(async () => {
      resolvers[2]?.(createdWorktree("wt-3"));
      await vi.advanceTimersByTimeAsync(1000);
    });

    const { id } = latestRun();
    expect(retryFailedBulkCreateRun(id)).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        priority: "low",
        title: "3 worktrees created",
        supersedeKey: `bulk-worktree-run:${id}`,
      })
    );
  });

  it("retry skips worktree creation when worktreeId already exists", async () => {
    let callCount = 0;
    mockWorktreeCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("Some error"));
      return Promise.resolve(createdWorktree(`wt-${callCount}`));
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

    await retryFailed();

    await advanceTimersGradually(5000);

    // Worktree.create should NOT be called again for issue 2 since it already exists
    expect(mockWorktreeCreate.mock.calls.length).toBe(createCallsBefore);
    expect(itemOf(2)).toMatchObject({ stage: "succeeded", worktreeId: "existing-wt" });
    expect(runSummary().detail).toBe("3 of 3 created");

    // Clean up
    worktreeDataHolder.map.delete("existing-wt");
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
      return Promise.resolve(createdWorktree("wt-1"));
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
    // The sixth attempt at the worktree step is the one that landed.
    expect(itemOf(1)).toMatchObject({ stage: "succeeded", attempt: 6, worktreeId: "wt-1" });
    expect(runSummary().facts.failed).toBe(0);
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
    expect(itemOf(1)).toMatchObject({
      stage: "failed",
      error: "Branch name is invalid",
      attempt: 1,
      failedStep: "worktree",
    });
    expect(runSummary().facts.failed).toBe(1);
  });

  it("does not re-execute when create button is clicked twice rapidly", async () => {
    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    // Click twice in the same act block — simulates rapid double-click
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    // One run, and each issue created exactly once — guard prevents second invocation
    expect(Object.keys(useBulkCreateRunStore.getState().runs)).toHaveLength(1);
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);
    expect(runSummary().detail).toBe("3 of 3 created");
  });

  it("starts a separate run with fresh tracking when Create is pressed again after reopening", async () => {
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
    const first = latestRun();
    expect(first.progress.phase).toBe("done");

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

    // A run of its own, reaching 3 of 3 rather than reusing the first one's tracking.
    const second = latestRun();
    expect(second.id).not.toBe(first.id);
    expect(Object.keys(useBulkCreateRunStore.getState().runs)).toHaveLength(2);
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);
    expect(runSummary().detail).toBe("3 of 3 created");
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("skips a cancelled run's items as being created until the cancel settles", async () => {
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const onClose = vi.fn();
    const { rerender } = render(<BulkCreateWorktreeDialog {...defaultProps} onClose={onClose} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await cancelRun();
    expect(latestRun().progress.phase).toBe("cancelling");

    // Reopening while the cancel drains: the creates already sent can still
    // land, so picking the same issues again would race them for the branch.
    await act(async () => {
      rerender(<BulkCreateWorktreeDialog {...defaultProps} isOpen={false} onClose={onClose} />);
    });
    await act(async () => {
      rerender(<BulkCreateWorktreeDialog {...defaultProps} onClose={onClose} />);
    });
    expect(skipBadges("Being created")).toBe(3);
    const confirm = () => screen.getByTestId("bulk-create-confirm-button");
    expect(confirm().getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      resolvers.forEach((resolve, i) => resolve(createdWorktree(`wt-${i + 1}`)));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(latestRun().progress.phase).toBe("cancelled");

    // Settled: the same issues are free to go again.
    expect(skipBadges("Being created")).toBe(0);
    expect(confirm().getAttribute("aria-disabled")).toBeNull();

    mockWorktreeCreate.mockClear();
    setupWorktreeCreateMocks();

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    expect(Object.keys(useBulkCreateRunStore.getState().runs)).toHaveLength(2);
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);
    expect(runSummary().detail).toBe("3 of 3 created");
  });

  it("retry does not re-verify previously succeeded items", async () => {
    mockSelectedRecipeId = "test-recipe";
    let callCount = 0;
    mockWorktreeCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("Some error"));
      return Promise.resolve(createdWorktree(`wt-${callCount}`));
    });
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ index: 0, terminalId: `t-${Date.now()}` }],
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
    expect([itemOf(1)?.stage, itemOf(2)?.stage]).toEqual(["succeeded", "failed"]);
    expect(runSummary().facts).toMatchObject({ created: 1, failed: 1 });

    // Set up retry — issue 2's worktree exists now
    worktreeDataHolder.map.set("retry-wt", {
      worktreeId: "retry-wt",
      branch: "feature/issue-2-issue-2",
      path: "/worktrees/feature/issue-2-issue-2",
      isMainWorktree: false,
    });

    await retryFailed();
    await advanceTimersGradually(5000);

    // Both should now be succeeded — issue 1 stays succeeded, issue 2 retried successfully
    expect([itemOf(1)?.stage, itemOf(2)?.stage]).toEqual(["succeeded", "succeeded"]);
    expect(runSummary().facts).toMatchObject({ created: 2, ready: 2, failed: 0 });

    worktreeDataHolder.map.delete("retry-wt");
  });

  it("crashed terminal during retry does not demote prior successes", async () => {
    mockSelectedRecipeId = "test-recipe";
    let wtIndex = 0;
    mockWorktreeCreate.mockImplementation(() =>
      Promise.resolve(createdWorktree(`wt-${++wtIndex}`))
    );

    // Issue 1 succeeds, issue 2 fails at worktree creation
    let callCount = 0;
    mockWorktreeCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("Lock error"));
      return Promise.resolve(createdWorktree(`wt-${callCount}`));
    });
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ index: 0, terminalId: "t-ok" }],
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

    expect([itemOf(1)?.stage, itemOf(2)?.stage]).toEqual(["succeeded", "failed"]);

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
      spawned: [{ index: 0, terminalId: "t-retry" }],
      failed: [],
    });

    await retryFailed();
    await advanceTimersGradually(5000);

    // Issue 1 must STILL be succeeded — verification only scopes to retry run (issue 2)
    // Issue 2 should now be succeeded as well
    expect([itemOf(1)?.stage, itemOf(2)?.stage]).toEqual(["succeeded", "succeeded"]);
    expect(runSummary().facts).toMatchObject({ ready: 2, failed: 0 });

    worktreeDataHolder.map.delete("retry-wt-2");
  });

  it("mixed healthy and crashed terminals across multiple items", async () => {
    mockSelectedRecipeId = "test-recipe";

    let recipeCallIndex = 0;
    mockRunRecipeWithResults.mockImplementation(() => {
      recipeCallIndex++;
      // Each item gets a unique terminal
      return Promise.resolve({
        spawned: [{ index: 0, terminalId: `t-item-${recipeCallIndex}` }],
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

    // 2 succeeded (items 1, 3), 1 failed (item 2 crashed). All three
    // worktrees exist, so all three count as created; the crash is a setup
    // failure reported beside that count.
    expect(runSummary().facts).toMatchObject({ created: 3, ready: 2, failed: 1 });
    expect(itemOf(2)).toMatchObject({ stage: "failed", failedStep: "verification" });
    expect(itemOf(2)?.error).toMatch(/terminal\(s\) crashed/);
    expect(itemSteps()[2]).toBe("Terminals exited");
  });

  it("large batch with recipe all healthy never shows intermediate 0 count", async () => {
    mockSelectedRecipeId = "test-recipe";
    const issues = Array.from({ length: 6 }, (_, i) => makeIssue(i + 1));

    let recipeCallIndex = 0;
    mockRunRecipeWithResults.mockImplementation(() => {
      recipeCallIndex++;
      return Promise.resolve({
        spawned: [{ index: 0, terminalId: `t-large-${recipeCallIndex}` }],
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

    expect(runSummary().facts).toMatchObject({ created: 6, ready: 6, failed: 0 });
    const spawnBatches = mockRunRecipeWithResults.mock.calls.map(
      (call) => (call[4] as { spawnBatch?: { id: string; size: number } })?.spawnBatch
    );
    expect(spawnBatches.every(Boolean)).toBe(true);
    expect(new Set(spawnBatches.map((batch) => batch?.id)).size).toBe(1);
    expect(spawnBatches.every((batch) => batch?.size === spawnBatches.length)).toBe(true);
  });

  it("files one quiet inbox entry naming the failure after recipe verification with mixed outcomes", async () => {
    mockSelectedRecipeId = "test-recipe";

    let recipeCallIndex = 0;
    mockRunRecipeWithResults.mockImplementation(() => {
      recipeCallIndex++;
      return Promise.resolve({
        spawned: [{ index: 0, terminalId: `t-notify-${recipeCallIndex}` }],
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

    // Both worktrees exist; one item's terminal then crashed.
    expect(runSummary().facts).toMatchObject({ created: 2, ready: 1, failed: 1 });
    expect(itemOf(2)).toMatchObject({ stage: "failed", failedStep: "verification" });
    // No toast: a single low-priority inbox entry records which item failed and why.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        priority: "low",
        title: "Worktree creation: 1 failed",
        message: expect.stringContaining(`#2 terminals exited: ${itemOf(2)?.error}`),
        supersedeKey: `bulk-worktree-run:${latestRun().id}`,
      })
    );
  });

  it("recipe verification with multiple crashed terminals reports correct count", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [
        { index: 0, terminalId: "t-a" },
        { index: 1, terminalId: "t-b" },
        { index: 2, terminalId: "t-c" },
      ],
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

    expect(itemOf(1)).toMatchObject({
      stage: "failed",
      failedStep: "verification",
      error: "2 terminal(s) crashed after spawn",
    });
    // The worktree is on disk, so it counts as created; it just isn't ready.
    expect(runSummary().facts).toMatchObject({ created: 1, ready: 0, failed: 1 });
  });

  it("second run with recipe after reopening resets tracking cleanly", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ index: 0, terminalId: "t-run1" }],
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
    expect(itemOf(1)?.stage).toBe("succeeded");

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
      spawned: [{ index: 0, terminalId: "t-run2" }],
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
    expect(Object.keys(useBulkCreateRunStore.getState().runs)).toHaveLength(2);
    expect(itemOf(1)).toMatchObject({ stage: "succeeded", worktreeId: "wt-1" });
    expect(runSummary().facts.failed).toBe(0);
  });

  it("stops queued items on an explicit cancel and reports the ones already underway", async () => {
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
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

    await cancelRun();

    // The creates already sent can't be called back, so the run waits for
    // them; the queued item won't start.
    expect(latestRun().progress.phase).toBe("cancelling");
    expect(itemSteps()[4]).toBe("Won't start");

    await act(async () => {
      resolvers[0]?.(createdWorktree("wt-1"));
      resolvers[1]?.(createdWorktree("wt-2"));
      resolvers[2]?.(createdWorktree("wt-3"));
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);
    expect(latestRun().progress.phase).toBe("cancelled");
    // The three that landed are reported as created; the queued one never started.
    expect(itemSteps()).toEqual({
      1: "Cancelled before setup finished",
      2: "Cancelled before setup finished",
      3: "Cancelled before setup finished",
      4: "Cancelled",
    });
    // The summary counts the worktrees that exist, and nothing is left in progress.
    expect(runSummary().detail).toBe("3 of 4 created (3 not fully set up) \u00b7 1 not created");
    expect(runSummary().facts.inProgress).toBe(0);
    const run = latestRun();
    expect(run.progress.items.get(4)?.worktreeId).toBeUndefined();
    expect([1, 2, 3].map((n) => run.progress.items.get(n)?.worktreeId)).toEqual([
      "wt-1",
      "wt-2",
      "wt-3",
    ]);
  });

  it("does not run the recipe for an item whose worktree lands after cancel", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ index: 0, terminalId: "t-1" }],
      failed: [],
    });
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
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

    await cancelRun();

    // The creates were already past the point of no return — let them land.
    await act(async () => {
      resolvers.forEach((resolve, i) => resolve(createdWorktree(`wt-${i + 1}`)));
      await vi.advanceTimersByTimeAsync(5000);
    });

    // Each landed worktree stops at the Step 1 -> Step 2 boundary rather than
    // spawning agents and skipping the assignment the dialog otherwise promises.
    expect(mockRunRecipeWithResults).not.toHaveBeenCalled();
    expect(mockAssignIssue).not.toHaveBeenCalled();
    // Queued items never start, so no additional worktrees appear.
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(startedCreates);
  });

  it("reports the worktrees a cancel left behind once the work underway settles", async () => {
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4), makeIssue(5)],
    };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Land one worktree, which lets a fourth item start; the fifth stays queued.
    await act(async () => {
      resolvers[0]?.(createdWorktree("wt-1"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(resolvers).toHaveLength(4);

    await cancelRun();

    // Nothing is reported until the creates already underway settle.
    expect(notify).not.toHaveBeenCalled();

    // Two of the three still underway land; the run waits for the third.
    await act(async () => {
      resolvers[1]?.(createdWorktree("wt-2"));
      resolvers[2]?.(createdWorktree("wt-3"));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(notify).not.toHaveBeenCalled();
    await act(async () => {
      resolvers[3]?.(createdWorktree("wt-4"));
      await vi.advanceTimersByTimeAsync(1000);
    });

    // One quiet inbox entry: #1 finished before the cancel, #2-#4 landed
    // without setup, and the queued #5 never started.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "low",
        title: "Worktree creation cancelled",
        message: "4 of 5 created (3 not fully set up) \u00b7 1 not created.",
        supersedeKey: `bulk-worktree-run:${latestRun().id}`,
      })
    );
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(4);
  });

  it("files only a quiet inbox entry when a cancel lands before any worktree is underway", async () => {
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
    expect(latestRun().progress.phase).toBe("executing");
    expect(mockWorktreeCreate).not.toHaveBeenCalled();

    await cancelRun();

    // Nothing is filed while the pre-query the cancel interrupted is still out.
    expect(notify).not.toHaveBeenCalled();

    await act(async () => {
      releasePrequery("feature/issue-1");
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockWorktreeCreate).not.toHaveBeenCalled();
    expect(latestRun().progress.phase).toBe("cancelled");
    // Nothing escaped, so there is no toast: only the low-priority inbox record.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "low",
        title: "Worktree creation cancelled",
        message: "0 of 2 created \u00b7 2 not created.",
      })
    );
  });

  it("keeps the batch going after the dialog closes, and a reopened dialog skips its items", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ index: 0, terminalId: "t-1" }],
      failed: [],
    });
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
          resolvers.push(resolve);
        })
    );

    // Four items against concurrency 3 leaves one in the backlog, so the
    // close lands with work both running and queued.
    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)],
    };
    const { unmount } = render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(3);

    // The parent drops the dialog (ProjectDialogHost renders it only while open).
    await act(async () => {
      unmount();
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      resolvers.slice(0, 3).forEach((resolve, i) => resolve(createdWorktree(`wt-${i + 1}`)));
      await vi.advanceTimersByTimeAsync(0);
    });
    // The queued item still starts once a slot frees.
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(4);

    // Reopening mid-run: every item belongs to the live run, so none can be
    // picked again until it ends, and the form says why.
    render(<BulkCreateWorktreeDialog {...props} />);
    expect(latestRun().progress.phase).toBe("executing");
    expect(runSummary().facts.created).toBe(3);
    expect(skipBadges("Being created")).toBe(4);
    expect(screen.getByTestId("bulk-create-footer-hint").textContent).toBe(
      "4 issues selected \u00b7 4 skipped"
    );
    expect(screen.getByTestId("bulk-create-confirm-button").getAttribute("aria-disabled")).toBe(
      "true"
    );

    await act(async () => {
      resolvers[3]?.(createdWorktree("wt-4"));
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mockRunRecipeWithResults).toHaveBeenCalledTimes(4);
    expect(Object.keys(useBulkCreateRunStore.getState().runs)).toHaveLength(1);
    expect(latestRun().progress.phase).toBe("done");
    expect(runSummary().detail).toBe("4 of 4 created");
    // An ended run holds nothing back.
    expect(skipBadges("Being created")).toBe(0);
  });

  it("only skips items a live run in the same project and mode is creating", async () => {
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const { unmount } = render(<BulkCreateWorktreeDialog {...defaultProps} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    unmount();
    expect(latestRun().progress.phase).toBe("executing");

    // The same numbers as pull requests are different items.
    const prView = render(
      <BulkCreateWorktreeDialog
        {...defaultProps}
        mode="pr"
        selectedIssues={[]}
        selectedPRs={[makePR(1), makePR(2), makePR(3)]}
      />
    );
    expect(skipBadges("Being created")).toBe(0);
    prView.unmount();

    // Another project's issues #1-#3 are other issues altogether.
    projectHolder.currentProject = { id: "other-project", path: "/other/root" };
    render(<BulkCreateWorktreeDialog {...defaultProps} />);
    expect(skipBadges("Being created")).toBe(0);
    expect(screen.getByTestId("bulk-create-confirm-button").textContent).toContain(
      "Create 3 worktrees"
    );

    await act(async () => {
      resolvers.forEach((resolve, i) => resolve(createdWorktree(`wt-${i + 1}`)));
      await vi.advanceTimersByTimeAsync(1000);
    });
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

    await cancelRun();

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
      spawned: Array<{ index: number; terminalId: string }>;
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

    await cancelRun();

    await act(async () => {
      releaseRecipe({ spawned: [{ index: 0, terminalId: "t-1" }], failed: [] });
      await vi.advanceTimersByTimeAsync(5000);
    });

    // The recipe's own terminals are out of reach — this pins the end state
    // instead: an item cancelled mid-recipe is never assigned and never becomes
    // the selected worktree.
    expect(latestRun().progress.phase).toBe("cancelled");
    expect(mockAssignIssue).not.toHaveBeenCalled();
    expect(mockSelectWorktree).not.toHaveBeenCalled();
    expect(mockSetPendingWorktree).not.toHaveBeenCalled();
  });

  it("fails the batch instead of stranding it when the project path is missing", async () => {
    projectHolder.currentProject = { id: "test-project" };

    const props = { ...defaultProps, selectedIssues: [makeIssue(1), makeIssue(2)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
      await vi.advanceTimersByTimeAsync(0);
    });

    // Reaching a terminal phase is the fix: a run stuck "executing" would
    // hold its items as being created and keep the toolbar chip live forever.
    expect(latestRun().progress.phase).toBe("done");
    // Every item must carry the failure, not just the one that tripped it.
    expect([itemOf(1)?.failedStep, itemOf(2)?.failedStep]).toEqual(["worktree", "worktree"]);
    expect(runSummary().facts).toMatchObject({ created: 0, failed: 2 });
    expect(mockWorktreeCreate).not.toHaveBeenCalled();
    // Both failures land in one inbox entry, with the shared reason said once.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        priority: "low",
        title: "Worktree creation failed",
        message: expect.stringContaining(`${itemOf(1)?.error} (#1, #2)`),
      })
    );
  });

  it("hands the batch to one background run on Create and closes without waiting for it", async () => {
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const onClose = vi.fn();
    const onComplete = vi.fn();
    const props = {
      ...defaultProps,
      selectedIssues: [makeIssue(1), makeIssue(2)],
      onClose,
      onComplete,
    };
    render(<BulkCreateWorktreeDialog {...props} />);
    expect(Object.keys(useBulkCreateRunStore.getState().runs)).toHaveLength(0);

    await clickCreate();

    // Committed and handed off before any worktree has landed.
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(2);
    expect(Object.keys(useBulkCreateRunStore.getState().runs)).toHaveLength(1);
    const run = latestRun();
    expect(run).toMatchObject({ projectId: "test-project", mode: "issue" });
    expect(run.progress.phase).toBe("executing");
    expect([...run.progress.items.keys()]).toEqual([1, 2]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers.forEach((resolve, i) => resolve(createdWorktree(`wt-${i + 1}`)));
      await vi.advanceTimersByTimeAsync(1000);
    });

    // The run finishes on its own; it asks nothing more of the dialog.
    expect(latestRun().progress.phase).toBe("done");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves the worktree selection where it was when the run ends", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ index: 0, terminalId: "t-1" }],
      failed: [],
    });
    mockTerminals = [{ id: "t-1", exitCode: undefined }];

    const { unmount } = render(<BulkCreateWorktreeDialog {...defaultProps} />);
    await clickCreate();
    unmount();
    await advanceTimersGradually(5000);

    expect(runSummary().facts).toMatchObject({ created: 3, ready: 3 });
    // A batch that ends while the user works elsewhere must not move them;
    // each worktree is reached from the toolbar's run detail instead.
    expect(mockSelectWorktree).not.toHaveBeenCalled();
    expect(mockSetPendingWorktree).not.toHaveBeenCalled();
  });

  it("keeps completed items visible after worktreeMap updates during execution", async () => {
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
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
      resolvers[0]?.(createdWorktree("wt-1"));
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

    // Issue #1 must still be visible in the batch preview despite worktreeMap update
    expect(screen.getByText("Issue 1")).toBeTruthy();
    expect(screen.getByText("#1")).toBeTruthy();

    // Resolve remaining items and verify final state
    await advanceTimersGradually(400);
    await act(async () => {
      resolvers[1]?.(createdWorktree("wt-2"));
      resolvers[2]?.(createdWorktree("wt-3"));
      await vi.advanceTimersByTimeAsync(0);
    });
    await advanceTimersGradually(1000);

    expect(runSummary().detail).toBe("3 of 3 created");
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
    const createResolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
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
      createResolvers[0]?.(createdWorktree("wt-1"));
      createResolvers[1]?.(createdWorktree("wt-2"));
      createResolvers[2]?.(createdWorktree("wt-3"));
      await vi.advanceTimersByTimeAsync(0);
    });
    await advanceTimersGradually(1000);

    // Pre-query call counts must not have grown — confirming the per-item
    // queue bodies read from the precomputed map, not fresh IPC calls.
    expect(mockGetAvailableBranch).toHaveBeenCalledTimes(3);
    expect(mockGetDefaultPath).toHaveBeenCalledTimes(3);
    expect(runSummary().detail).toBe("3 of 3 created");
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

    expect(runSummary().facts).toMatchObject({ created: 2, ready: 2 });

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

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    // Cancel while pre-query is still pending.
    await cancelRun();

    // Reject the pending pre-query after the cancel has bumped runIdRef.
    await act(async () => {
      rejectPrequery?.(new Error("IPC failure after cancel"));
      await vi.advanceTimersByTimeAsync(100);
    });

    // No stale dispatches — no item carries the rejection, and no
    // worktree.create was triggered. The run ends cancelled, not failed.
    expect(latestRun().progress.phase).toBe("cancelled");
    expect([...latestRun().progress.items.values()].map((item) => item.error)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(Object.values(itemSteps())).toEqual(["Cancelled", "Cancelled", "Cancelled"]);
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

    expect(itemOf(2)).toMatchObject({
      stage: "failed",
      error: "Branch name is invalid",
      failedStep: "worktree",
    });
    expect(itemOf(2)?.worktreeId).toBeUndefined();
    expect(runSummary().facts).toMatchObject({ created: 2, failed: 1 });
    // The failed item never reached worktree.create.
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(2);
  });

  it("invokes stored bulkCreateDialog.onComplete when Create is pressed", async () => {
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

    await clickCreate();

    expect(storedOnComplete).toHaveBeenCalledTimes(1);
    expect(propOnComplete).toHaveBeenCalledTimes(1);
    expect(propOnClose).toHaveBeenCalledTimes(1);
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

  it("clears the selection once, at Create, rather than when the run ends", async () => {
    // The batch is committed at Create, so its selection is spent then: a
    // selection held until the run ends would leave the bulk-action bar
    // offering the same issues again while they are being created.
    const storedOnComplete = vi.fn();
    mockBulkCreateDialog.onComplete = storedOnComplete;
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
          resolvers.push(resolve);
        })
    );

    render(<BulkCreateWorktreeDialog {...defaultProps} />);

    await clickCreate();
    expect(latestRun().progress.phase).toBe("executing");
    expect(storedOnComplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers.forEach((resolve, i) => resolve(createdWorktree(`wt-${i + 1}`)));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(latestRun().progress.phase).toBe("done");

    // Dismissing afterwards is a plain close, not a second cleanup.
    await act(async () => {
      screen.getByLabelText("Close dialog").click();
    });

    expect(storedOnComplete).toHaveBeenCalledTimes(1);
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

    expect(itemOf(1)?.stage).toBe("succeeded");

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
    expect(itemOf(1)?.stage).toBe("succeeded");

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

    expect(itemOf(1)?.stage).toBe("succeeded");
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

    // Item is surfaced as failed, not silently succeeded. Its worktree is on
    // disk, so it counts as created, but not as ready.
    expect(itemOf(1)).toMatchObject({ stage: "failed", failedStep: "terminals" });
    expect(itemSteps()[1]).toBe("Terminals didn't start");
    expect(runSummary().facts).toMatchObject({ created: 1, ready: 0, failed: 1 });
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
    expect(itemOf(1)).toMatchObject({ stage: "failed", failedStep: "terminals" });
    expect(runSummary().facts).toMatchObject({ ready: 0, failed: 1 });
  });

  it("clone layout retry relaunches only the entries that failed", async () => {
    mockSelectedRecipeId = "__clone_layout__";
    mockGenerateRecipeFromActiveTerminals.mockReturnValue([
      { type: "terminal", title: "A", exitBehavior: "close", command: "cmd-a" },
      { type: "terminal", title: "B", exitBehavior: "close", command: "cmd-b" },
    ]);
    // First run: second terminal throws. Retry run: B succeeds.
    mockAddPanel
      .mockResolvedValueOnce("panel-a1")
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce("panel-b2");

    const props = { ...defaultProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(itemOf(1)).toMatchObject({ stage: "failed", failedStep: "terminals" });
    expect(mockAddPanel).toHaveBeenCalledTimes(2);

    // Retry relaunches only B; A is already running.
    await retryFailed();
    await advanceTimersGradually(5000);

    expect(mockAddPanel).toHaveBeenCalledTimes(3);
    expect(mockAddPanel.mock.calls[2]?.[0]).toMatchObject({ command: "cmd-b" });
    expect(itemOf(1)?.stage).toBe("succeeded");
    expect(runSummary().facts.failed).toBe(0);
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
    expect(itemOf(1)).toMatchObject({
      stage: "failed",
      failedStep: "verification",
      error: expect.stringMatching(/terminal\(s\) crashed/),
    });
    expect(mockAddPanel).toHaveBeenCalledTimes(1);

    // Retry: healthy terminal this time. cloneComplete must have been reset so
    // the clone branch re-runs; otherwise the retry silently marks succeeded
    // with zero spawn attempts.
    mockAddPanel.mockResolvedValueOnce("panel-healthy");
    mockTerminals = [{ id: "panel-healthy", exitCode: undefined }];

    await retryFailed();
    await advanceTimersGradually(5000);

    expect(mockAddPanel).toHaveBeenCalledTimes(2);
    expect(itemOf(1)?.stage).toBe("succeeded");
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
    expect(itemOf(1)?.stage).toBe("succeeded");
    expect(runSummary().facts.failed).toBe(0);
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
    // of falling through to ITEM_SUCCEEDED (see #8975). The worktree itself is
    // on disk, so it counts as created; the item is just not ready.
    expect(mockAssignIssue).toHaveBeenCalledTimes(1);
    expect(itemOf(1)).toMatchObject({ stage: "failed", failedStep: "assignment", attempt: 1 });
    expect(itemSteps()[1]).toBe("Couldn't assign issue");
    expect(runSummary().facts).toMatchObject({ created: 1, ready: 0, failed: 1 });
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
    expect(itemOf(1)).toMatchObject({ stage: "failed", failedStep: "assignment", attempt: 1 });
    expect(itemSteps()[1]).toBe("Couldn't assign issue");
    expect(runSummary().facts).toMatchObject({ created: 1, ready: 0, failed: 1 });
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
    expect(itemOf(1)).toMatchObject({
      stage: "failed",
      failedStep: "assignment",
      attempt: mockAssignIssue.mock.calls.length,
    });
    expect(itemSteps()[1]).toBe("Couldn't assign issue");
    expect(runSummary().facts).toMatchObject({ created: 1, ready: 0, failed: 1 });
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
    await cancelRun();

    // Drain remaining backoff window — the stale-run guard must short-circuit
    // the loop before another IPC call goes out.
    await advanceTimersGradually(35000);

    expect(mockAssignIssue).toHaveBeenCalledTimes(1);
  });

  it("still assigns when the dialog closes before its identity lookup answers", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    // The dialog's lookup never answers; the run's own one does.
    mockGetCurrentUser.mockImplementationOnce(() => new Promise(() => {}));
    mockGetCurrentUser.mockImplementation(async () => ({ login: "octocat" }));

    const { unmount } = render(<BulkCreateWorktreeDialog {...assignProps} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
      unmount();
    });
    await advanceTimersGradually(1000);

    expect(mockAssignIssue).toHaveBeenCalledWith("/test/root", 1, "octocat");
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

    // All three worktrees exist, but only two items are fully set up: the
    // batch must read 2 ready of 3, never 3 of 3.
    expect(runSummary().facts).toMatchObject({ total: 3, created: 3, ready: 2, failed: 1 });
    expect(itemOf(2)).toMatchObject({ stage: "failed", failedStep: "assignment" });
    expect(runSummary().title).toBe("1 of 3 failed");
  });

  it("does not re-run the recipe when retrying an assignment-only failure", async () => {
    // Pre-fix, handleRetryFailed cleared all terminal tracking, causing the
    // recipe to re-spawn every terminal on retry of an assignment failure.
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ index: 0, terminalId: "t-1" }],
      failed: [],
    });
    mockTerminals = [{ id: "t-1", worktreeId: "wt-1", exitCode: undefined }];

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
    expect(itemOf(1)).toMatchObject({ stage: "failed", failedStep: "assignment" });

    // Retry failed — recipe must NOT re-spawn terminals.
    await retryFailed();
    await advanceTimersGradually(5000);

    expect(mockRunRecipeWithResults).toHaveBeenCalledTimes(1);
    expect(mockTrashPanel).not.toHaveBeenCalled();
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(1);
    expect(assignCallCount).toBe(2);
    expect(itemOf(1)?.stage).toBe("succeeded");
  });

  it("assignment failure is not overwritten by post-batch verification", async () => {
    // Both branches converge on ITEM_FAILED. The post-batch verification loop
    // must skip items already in failedItems, or it overwrites
    // failedStep:"assignment" with failedStep:"verification".
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "me" };
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValue({
      spawned: [{ index: 0, terminalId: "t-crash" }],
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

    expect(itemOf(1)).toMatchObject({ stage: "failed", failedStep: "assignment" });
    expect(itemSteps()[1]).toBe("Couldn't assign issue");
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
    expect(itemOf(1)?.stage).toBe("succeeded");
    expect(runSummary().facts.failed).toBe(0);
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
    // The host Checkbox, as New Worktree draws the same setting, not a
    // hand-rolled switch.
    expect(checkbox.getAttribute("data-slot")).toBe("checkbox");
  });

  it("names the recipe trigger from the rail label", () => {
    render(<BulkCreateWorktreeDialog {...issueProps} />);

    const trigger = screen.getByRole("combobox", { name: "Recipe" });
    expect(trigger.getAttribute("aria-label")).toBeNull();
    expect(trigger.id).toBeTruthy();
    expect(railLabel("Recipe").htmlFor).toBe(trigger.id);
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

    const before = screen.getByRole("checkbox") as HTMLButtonElement;
    // Still looking is not the same as found nothing: naming a failure here
    // would be wrong, and disabling would be too.
    expect(before.disabled).toBe(false);
    expect(screen.queryByText("Account unavailable")).toBeNull();

    await act(async () => {
      resolveViewer({ login: "octocat" });
    });

    // Same node, not a re-inserted row: identity arriving must populate the
    // row rather than add one and push everything below it down.
    const after = screen.getByRole("checkbox") as HTMLButtonElement;
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
    const checkbox = screen.getByRole("checkbox") as HTMLButtonElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Account unavailable")).toBeTruthy();
  });

  it("treats a failed identity lookup the same as no account", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    mockGetCurrentUser.mockImplementationOnce(() => Promise.reject(new Error("network down")));
    render(<BulkCreateWorktreeDialog {...issueProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    const checkbox = screen.getByRole("checkbox") as HTMLButtonElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Account unavailable")).toBeTruthy();
  });

  it("reflects the preference once an account is available", async () => {
    prefsHolder.assignWorktreeToSelf = true;
    viewerHolder.user = { login: "octocat" };
    render(<BulkCreateWorktreeDialog {...issueProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    const checkbox = screen.getByRole("checkbox") as HTMLButtonElement;
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");

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
    const skip = screen.getByText("Has worktree");
    expect(skip.getAttribute("data-slot")).toBe("badge");
    expect(skip.getAttribute("data-tone")).toBe("warning");
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

    const confirm = screen.getByTestId("bulk-create-confirm-button");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      confirm.click();
    });
    expect(mockWorktreeCreate).not.toHaveBeenCalled();
  });

  // The title and the button already count the batch, so a creatable one
  // trades "selected" for where the work goes once the dialog closes.
  it("omits the skipped clause when the whole selection is creatable", () => {
    render(<BulkCreateWorktreeDialog {...issueProps} />);
    expect(hintText()).toBe("3 issues \u00b7 runs in the background");
  });

  it("uses the singular noun for a selection of one", () => {
    const props = { ...issueProps, selectedIssues: [makeIssue(1)] };
    render(<BulkCreateWorktreeDialog {...props} />);
    expect(hintText()).toBe("1 issue \u00b7 runs in the background");
  });

  it("names pull requests in PR mode", () => {
    const props = {
      ...issueProps,
      mode: "pr" as const,
      selectedIssues: [] as Issue[],
      selectedPRs: [makePR(10), makePR(20)],
    };
    render(<BulkCreateWorktreeDialog {...props} />);
    expect(hintText()).toBe("2 pull requests \u00b7 runs in the background");
  });

  it("asks for a selection when there is nothing to plan", () => {
    const props = { ...issueProps, selectedIssues: [] as Issue[] };
    render(<BulkCreateWorktreeDialog {...props} />);
    expect(hintText()).toBe("Select an issue to continue");
  });

  it("promises a background run only when Create will start one", () => {
    const partly = {
      ...issueProps,
      selectedIssues: [makeIssue(1), { ...makeIssue(2), state: "closed" as const }],
    };
    const { unmount } = render(<BulkCreateWorktreeDialog {...partly} />);
    expect(hintText()).toBe("2 issues \u00b7 1 skipped \u00b7 runs in the background");
    unmount();

    const none = {
      ...issueProps,
      selectedIssues: [
        { ...makeIssue(1), state: "closed" as const },
        { ...makeIssue(2), state: "closed" as const },
      ],
    };
    render(<BulkCreateWorktreeDialog {...none} />);
    expect(hintText()).toBe("2 issues selected \u00b7 2 skipped");
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
      { name: "origin/feature/pr-10", current: false, remote: "origin" },
      { name: "origin/feature/pr-20", current: false, remote: "origin" },
      { name: "origin/feature/pr-30", current: false, remote: "origin" },
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
      { name: "origin/feature/pr-10", current: false, remote: "origin" },
      { name: "origin/feature/pr-20", current: false, remote: "origin" },
      { name: "origin/feature/pr-30", current: false, remote: "origin" },
    ]);

    render(<BulkCreateWorktreeDialog {...prProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });

    await advanceTimersGradually(5000);

    expect(runSummary().detail).toBe("3 of 3 created");

    // Should have called create with fromRemote: true
    const createCalls = mockWorktreeCreate.mock.calls;
    expect(createCalls.length).toBe(3);
    expect(createCalls[0]![0].fromRemote).toBe(true);
    expect(createCalls[0]![0].baseBranch).toBe("origin/feature/pr-10");
    expect(createCalls[0]![0].newBranch).toBe("feature/pr-10");
  });

  it("includes fork PRs in plan", () => {
    const forkPR: PR = {
      ...makePR(99),
      rawData: { isFork: true },
    };
    const props = { ...prProps, selectedPRs: [forkPR] };
    render(<BulkCreateWorktreeDialog {...props} />);

    expect(screen.queryByText("Fork PR")).toBeNull();
    expect(
      screen.getByTestId("bulk-create-confirm-button").getAttribute("aria-disabled")
    ).toBeNull();
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

    expect(itemOf(10)?.stage).toBe("succeeded");
    const createCalls = mockWorktreeCreate.mock.calls;
    expect(createCalls[0]![0].useExistingBranch).toBe(true);
    expect(createCalls[0]![0].fromRemote).toBe(false);
  });

  it("calls listBranches once per batch, not once per PR", async () => {
    mockListBranches.mockResolvedValue([
      { name: "main", current: true, remote: false },
      { name: "origin/feature/pr-10", current: false, remote: "origin" },
      { name: "origin/feature/pr-20", current: false, remote: "origin" },
      { name: "origin/feature/pr-30", current: false, remote: "origin" },
    ]);

    render(<BulkCreateWorktreeDialog {...prProps} />);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(runSummary().detail).toBe("3 of 3 created");
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

    expect(runSummary().facts).toMatchObject({ created: 0, failed: 3 });
    // One reason behind every failure, which the chip says once.
    expect(runSummary().sharedFailure).toMatch(/git ls-remote failed/);
    expect([10, 20, 30].map((n) => itemOf(n)?.failedStep)).toEqual([
      "worktree",
      "worktree",
      "worktree",
    ]);
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

    expect(itemOf(10)).toMatchObject({
      stage: "failed",
      failedStep: "worktree",
      error: expect.stringMatching(/couldn't find remote ref/),
    });
    expect(runSummary().facts.failed).toBe(1);
  });
});

describe("BulkCreateWorktreeDialog — base branch", () => {
  const issueProps = {
    isOpen: true,
    onClose: vi.fn(),
    mode: "issue" as const,
    selectedIssues: [makeIssue(1), makeIssue(2)],
    selectedPRs: [] as PR[],
    onComplete: vi.fn(),
  };

  async function createAndSettle() {
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(2000);
  }

  it("keeps the main worktree's branch even when the list marks another current", async () => {
    // A project opened from a linked worktree: the list's `current` is that
    // worktree's checkout, not the main worktree's.
    mockListBranches.mockResolvedValue([
      { name: "main", current: false, remote: false },
      { name: "feature/x", current: true, remote: false },
    ]);

    render(<BulkCreateWorktreeDialog {...issueProps} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockListBranches).toHaveBeenCalledWith("/test/root");
    expect(screen.getByRole("combobox", { name: "Base" }).textContent).toContain("main");

    await createAndSettle();

    const calls = mockWorktreeCreate.mock.calls;
    expect(calls.length).toBe(2);
    for (const [options] of calls) {
      expect(options.baseBranch).toBe("main");
      expect(options.fromRemote).toBe(false);
    }
  });

  it("takes the list's default when the main worktree has no branch, holding Create until then", async () => {
    worktreeDataHolder.map = new Map([
      ["main-wt", { worktreeId: "main-wt", path: "/test/root", isMainWorktree: true }],
    ]);
    let resolveList: (list: unknown[]) => void = () => {};
    mockListBranches.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      })
    );

    render(<BulkCreateWorktreeDialog {...issueProps} />);

    const confirm = screen.getByTestId("bulk-create-confirm-button");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      confirm.click();
    });
    expect(mockWorktreeCreate).not.toHaveBeenCalled();

    await act(async () => {
      resolveList([
        { name: "feature/y", current: false, remote: false },
        { name: "develop", current: true, remote: false },
      ]);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(confirm.getAttribute("aria-disabled")).toBeNull();
    await createAndSettle();

    const calls = mockWorktreeCreate.mock.calls;
    expect(calls.length).toBe(2);
    for (const [options] of calls) {
      expect(options.baseBranch).toBe("develop");
    }
  });

  it("falls back to the main worktree's branch when the branch list fails to load", async () => {
    mockListBranches.mockRejectedValue(new Error("git exploded"));

    render(<BulkCreateWorktreeDialog {...issueProps} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Couldn't load branches. Using main.")).toBeTruthy();

    await createAndSettle();

    const calls = mockWorktreeCreate.mock.calls;
    expect(calls.length).toBe(2);
    for (const [options] of calls) {
      expect(options.baseBranch).toBe("main");
      expect(options.fromRemote).toBe(false);
    }
  });

  it("uses the main worktree's branch when Create runs before the list loads", async () => {
    mockListBranches.mockReturnValue(new Promise(() => {}));

    render(<BulkCreateWorktreeDialog {...issueProps} />);
    await createAndSettle();

    const calls = mockWorktreeCreate.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0]![0].baseBranch).toBe("main");
    expect(calls[0]![0].fromRemote).toBe(false);
  });

  it("creates every issue from a picked remote branch", async () => {
    mockListBranches.mockResolvedValue([
      { name: "main", current: true, remote: false },
      { name: "origin/release", current: false, remote: "origin" },
    ]);

    render(<BulkCreateWorktreeDialog {...issueProps} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Base" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /origin\/release/ }));
    });

    await createAndSettle();

    const calls = mockWorktreeCreate.mock.calls;
    expect(calls.length).toBe(2);
    for (const [options] of calls) {
      expect(options.baseBranch).toBe("origin/release");
      expect(options.fromRemote).toBe(true);
    }
  });

  it("retries on the base Create was pressed with, even if the list lands later", async () => {
    let resolveList: (list: unknown[]) => void = () => {};
    mockListBranches.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      })
    );
    mockWorktreeCreate
      .mockRejectedValueOnce(new Error("fatal: invalid reference"))
      .mockRejectedValueOnce(new Error("fatal: invalid reference"));

    render(<BulkCreateWorktreeDialog {...issueProps} />);
    await createAndSettle();
    expect(runSummary().facts.failed).toBe(2);

    await act(async () => {
      resolveList([
        { name: "main", current: false, remote: false },
        { name: "develop", current: true, remote: false },
      ]);
      await vi.advanceTimersByTimeAsync(0);
    });

    await retryFailed();
    await advanceTimersGradually(2000);

    const calls = mockWorktreeCreate.mock.calls;
    expect(calls.length).toBe(4);
    for (const [options] of calls) {
      expect(options.baseBranch).toBe("main");
    }
  });

  it("offers no base picker in PR mode", () => {
    render(
      <BulkCreateWorktreeDialog
        {...issueProps}
        mode="pr"
        selectedIssues={[]}
        selectedPRs={[makePR(10)]}
      />
    );

    expect(screen.queryByText("Base")).toBeNull();
    expect(mockListBranches).not.toHaveBeenCalled();
  });
});

describe("BulkCreateWorktreeDialog — retry keeps healthy terminals", () => {
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    mode: "issue" as const,
    selectedIssues: [makeIssue(1)],
    selectedPRs: [] as PR[],
    onComplete: vi.fn(),
  };

  // clearAllMocks keeps queued once-values, and a case that never relaunches
  // leaves one behind for the next test to consume.
  beforeEach(() => {
    mockRunRecipeWithResults.mockReset();
  });

  const recipeIndicesForCall = (call: number) =>
    (mockRunRecipeWithResults.mock.calls[call]?.[4] as { terminalIndices?: number[] } | undefined)
      ?.terminalIndices;

  it("relaunches only the recipe entries that failed to launch", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults
      .mockResolvedValueOnce({
        spawned: [{ index: 0, terminalId: "t-0" }],
        failed: [{ index: 1, error: "spawn failed" }],
      })
      .mockResolvedValueOnce({
        spawned: [{ index: 1, terminalId: "t-1-retry" }],
        failed: [],
      });
    mockTerminals = [
      { id: "t-0", worktreeId: "wt-1", exitCode: undefined },
      { id: "t-1-retry", worktreeId: "wt-1", exitCode: undefined },
    ];

    render(<BulkCreateWorktreeDialog {...props} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(itemOf(1)).toMatchObject({ stage: "failed", failedStep: "terminals" });
    expect(itemSteps()[1]).toBe("Terminals didn't start");
    expect(recipeIndicesForCall(0)).toBeUndefined();

    // The worktree exists, so nothing about it needs looking up again.
    mockGetAvailableBranch.mockClear().mockRejectedValue(new Error("lookup timed out"));
    mockGetDefaultPath.mockClear().mockRejectedValue(new Error("lookup timed out"));
    await retryFailed();
    await advanceTimersGradually(5000);

    expect(mockGetAvailableBranch).not.toHaveBeenCalled();
    expect(mockGetDefaultPath).not.toHaveBeenCalled();
    expect(mockRunRecipeWithResults).toHaveBeenCalledTimes(2);
    expect(recipeIndicesForCall(1)).toEqual([1]);
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(1);
    expect(itemOf(1)?.stage).toBe("succeeded");
  });

  it("keeps verifying the terminals an earlier attempt launched", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults
      .mockResolvedValueOnce({
        spawned: [{ index: 0, terminalId: "t-0" }],
        failed: [{ index: 1, error: "spawn failed" }],
      })
      .mockImplementationOnce(async () => {
        // t-0 dies while the retry is relaunching entry 1.
        mockTerminals = [
          { id: "t-0", worktreeId: "wt-1", exitCode: 1 },
          { id: "t-1", worktreeId: "wt-1", exitCode: undefined },
        ];
        return { spawned: [{ index: 1, terminalId: "t-1" }], failed: [] };
      })
      .mockResolvedValueOnce({ spawned: [{ index: 0, terminalId: "t-0b" }], failed: [] });
    mockTerminals = [{ id: "t-0", worktreeId: "wt-1", exitCode: undefined }];

    render(<BulkCreateWorktreeDialog {...props} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    await retryFailed();
    await advanceTimersGradually(5000);

    expect(recipeIndicesForCall(1)).toEqual([1]);
    expect(itemOf(1)).toMatchObject({
      stage: "failed",
      failedStep: "verification",
      error: expect.stringMatching(/1 terminal\(s\) crashed/),
    });

    mockTerminals = [
      { id: "t-0", worktreeId: "wt-1", exitCode: 1 },
      { id: "t-0b", worktreeId: "wt-1", exitCode: undefined },
      { id: "t-1", worktreeId: "wt-1", exitCode: undefined },
    ];
    await retryFailed();
    await advanceTimersGradually(5000);

    expect(recipeIndicesForCall(2)).toEqual([0]);
    expect(mockTrashPanel).toHaveBeenCalledWith("t-0");
    expect(mockTrashPanel).not.toHaveBeenCalledWith("t-1");
    expect(itemOf(1)?.stage).toBe("succeeded");
  });

  it("relaunches an entry that died after another entry failed to launch", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults
      .mockResolvedValueOnce({
        spawned: [{ index: 0, terminalId: "t-0" }],
        failed: [{ index: 1, error: "spawn failed" }],
      })
      .mockResolvedValueOnce({
        spawned: [
          { index: 0, terminalId: "t-0b" },
          { index: 1, terminalId: "t-1" },
        ],
        failed: [],
      });
    mockTerminals = [{ id: "t-0", worktreeId: "wt-1", exitCode: undefined }];

    render(<BulkCreateWorktreeDialog {...props} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    mockTerminals = [
      { id: "t-0", worktreeId: "wt-1", exitCode: 1 },
      { id: "t-0b", worktreeId: "wt-1", exitCode: undefined },
      { id: "t-1", worktreeId: "wt-1", exitCode: undefined },
    ];
    await retryFailed();
    await advanceTimersGradually(5000);

    expect(recipeIndicesForCall(1)).toEqual([0, 1]);
    expect(mockTrashPanel).toHaveBeenCalledWith("t-0");
    expect(itemOf(1)?.stage).toBe("succeeded");
  });

  it("relaunches only the recipe entries whose terminals crashed after launch", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults
      .mockResolvedValueOnce({
        spawned: [
          { index: 0, terminalId: "t-0" },
          { index: 1, terminalId: "t-1" },
        ],
        failed: [],
      })
      .mockResolvedValueOnce({
        spawned: [{ index: 1, terminalId: "t-1-retry" }],
        failed: [],
      });
    mockTerminals = [
      { id: "t-0", worktreeId: "wt-1", exitCode: undefined },
      { id: "t-1", worktreeId: "wt-1", exitCode: 1 },
    ];

    render(<BulkCreateWorktreeDialog {...props} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);

    expect(itemOf(1)).toMatchObject({
      stage: "failed",
      failedStep: "verification",
      error: expect.stringMatching(/1 terminal\(s\) crashed/),
    });

    mockTerminals = [
      { id: "t-0", worktreeId: "wt-1", exitCode: undefined },
      { id: "t-1", worktreeId: "wt-1", exitCode: 1 },
      { id: "t-1-retry", worktreeId: "wt-1", exitCode: undefined },
    ];
    await retryFailed();
    await advanceTimersGradually(5000);

    expect(mockRunRecipeWithResults).toHaveBeenCalledTimes(2);
    expect(recipeIndicesForCall(1)).toEqual([1]);
    // The dead panel goes to the trash instead of sitting beside its
    // replacement, and the superseded crash no longer counts against the item.
    expect(mockTrashPanel).toHaveBeenCalledTimes(1);
    expect(mockTrashPanel).toHaveBeenCalledWith("t-1");
    expect(itemOf(1)?.stage).toBe("succeeded");
    expect(itemOf(1)?.error).toBeUndefined();
  });

  it("leaves a crashed terminal the user has since restarted alone", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults.mockResolvedValueOnce({
      spawned: [
        { index: 0, terminalId: "t-0" },
        { index: 1, terminalId: "t-1" },
      ],
      failed: [],
    });
    mockTerminals = [
      { id: "t-0", worktreeId: "wt-1", exitCode: undefined },
      { id: "t-1", worktreeId: "wt-1", exitCode: 1 },
    ];

    render(<BulkCreateWorktreeDialog {...props} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(itemOf(1)).toMatchObject({
      stage: "failed",
      failedStep: "verification",
      error: expect.stringMatching(/1 terminal\(s\) crashed/),
    });

    mockTerminals = [
      { id: "t-0", worktreeId: "wt-1", exitCode: undefined },
      { id: "t-1", worktreeId: "wt-1", exitCode: undefined },
    ];
    await retryFailed();
    await advanceTimersGradually(5000);

    expect(mockRunRecipeWithResults).toHaveBeenCalledTimes(1);
    expect(mockTrashPanel).not.toHaveBeenCalled();
    expect(itemOf(1)?.stage).toBe("succeeded");
  });

  it.each([
    {
      name: "a terminal whose spawn failed is replaced",
      atRetry: { exitCode: undefined, spawnStatus: "failed" },
      trashed: true,
      relaunched: true,
    },
    {
      name: "a terminal moved to another worktree is relaunched but not trashed",
      atRetry: { exitCode: 1, worktreeId: "other-wt" },
      trashed: false,
      relaunched: true,
    },
    {
      name: "a terminal already in the trash is relaunched without trashing it again",
      atRetry: { exitCode: 1, location: "trash" },
      trashed: false,
      relaunched: true,
    },
    {
      name: "a terminal mid-restart is neither trashed nor duplicated",
      atRetry: { exitCode: 1, isRestarting: true },
      trashed: false,
      relaunched: false,
    },
  ])("on retry, $name", async ({ atRetry, trashed, relaunched }) => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults
      .mockResolvedValueOnce({
        spawned: [
          { index: 0, terminalId: "t-0" },
          { index: 1, terminalId: "t-1" },
        ],
        failed: [],
      })
      .mockResolvedValueOnce({ spawned: [{ index: 1, terminalId: "t-1b" }], failed: [] });
    mockTerminals = [
      { id: "t-0", worktreeId: "wt-1", exitCode: undefined },
      { id: "t-1", worktreeId: "wt-1", exitCode: 1 },
    ];

    render(<BulkCreateWorktreeDialog {...props} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(itemOf(1)).toMatchObject({
      stage: "failed",
      failedStep: "verification",
      error: expect.stringMatching(/1 terminal\(s\) crashed/),
    });

    mockTerminals = [
      { id: "t-0", worktreeId: "wt-1", exitCode: undefined },
      { id: "t-1", worktreeId: "wt-1", ...atRetry },
      { id: "t-1b", worktreeId: "wt-1", exitCode: undefined },
    ];
    await retryFailed();
    await advanceTimersGradually(5000);

    if (trashed) expect(mockTrashPanel).toHaveBeenCalledWith("t-1");
    else expect(mockTrashPanel).not.toHaveBeenCalled();
    if (relaunched) {
      expect(recipeIndicesForCall(1)).toEqual([1]);
      expect(itemOf(1)?.stage).toBe("succeeded");
    } else {
      expect(mockRunRecipeWithResults).toHaveBeenCalledTimes(1);
    }
  });

  it("relaunches only the failed entry when a transient launch failure backs off", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockRunRecipeWithResults
      .mockResolvedValueOnce({
        spawned: [{ index: 0, terminalId: "t-0" }],
        failed: [{ index: 1, error: "Spawn queue full" }],
      })
      .mockResolvedValueOnce({
        spawned: [{ index: 1, terminalId: "t-1" }],
        failed: [],
      });
    mockTerminals = [
      { id: "t-0", worktreeId: "wt-1", exitCode: undefined },
      { id: "t-1", worktreeId: "wt-1", exitCode: undefined },
    ];

    render(<BulkCreateWorktreeDialog {...props} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(10000, 250);

    expect(mockRunRecipeWithResults).toHaveBeenCalledTimes(2);
    expect(recipeIndicesForCall(1)).toEqual([1]);
    expect(itemOf(1)?.stage).toBe("succeeded");
  });

  it("relaunches only the crashed entry of the layout cloned at Create", async () => {
    mockSelectedRecipeId = "__clone_layout__";
    mockGenerateRecipeFromActiveTerminals.mockReturnValue([
      { type: "terminal", title: "A", exitBehavior: "close", command: "cmd-a" },
      { type: "terminal", title: "B", exitBehavior: "close", command: "cmd-b" },
    ]);
    mockAddPanel.mockResolvedValueOnce("panel-a").mockResolvedValueOnce("panel-b");
    mockTerminals = [
      { id: "panel-a", worktreeId: "wt-1", exitCode: undefined },
      { id: "panel-b", worktreeId: "wt-1", exitCode: 1 },
    ];

    render(<BulkCreateWorktreeDialog {...props} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(itemOf(1)).toMatchObject({
      stage: "failed",
      failedStep: "verification",
      error: expect.stringMatching(/1 terminal\(s\) crashed/),
    });

    // The finished run selected the new worktree; its layout must not leak in.
    mockGenerateRecipeFromActiveTerminals.mockReturnValue([
      { type: "terminal", title: "Other", exitBehavior: "close", command: "cmd-other" },
    ]);
    mockAddPanel.mockResolvedValueOnce("panel-b2");
    mockTerminals = [
      { id: "panel-a", worktreeId: "wt-1", exitCode: undefined },
      { id: "panel-b", worktreeId: "wt-1", exitCode: 1 },
      { id: "panel-b2", worktreeId: "wt-1", exitCode: undefined },
    ];
    await retryFailed();
    await advanceTimersGradually(5000);

    expect(mockGenerateRecipeFromActiveTerminals).toHaveBeenCalledTimes(1);
    expect(mockAddPanel).toHaveBeenCalledTimes(3);
    expect(mockAddPanel.mock.calls[2]?.[0]).toMatchObject({ command: "cmd-b" });
    expect(mockTrashPanel).toHaveBeenCalledWith("panel-b");
    expect(mockTrashPanel).not.toHaveBeenCalledWith("panel-a");
    expect(itemOf(1)?.stage).toBe("succeeded");
  });

  it("keeps a cloned entry's original index across repeated retries", async () => {
    mockSelectedRecipeId = "__clone_layout__";
    mockGenerateRecipeFromActiveTerminals.mockReturnValue([
      { type: "terminal", title: "A", exitBehavior: "close", command: "cmd-a" },
      { type: "terminal", title: "B", exitBehavior: "close", command: "cmd-b" },
    ]);
    mockAddPanel
      .mockResolvedValueOnce("panel-a")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("panel-b2")
      .mockResolvedValueOnce("panel-b3");

    render(<BulkCreateWorktreeDialog {...props} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(itemOf(1)).toMatchObject({ stage: "failed", failedStep: "terminals" });
    expect(itemSteps()[1]).toBe("Terminals didn't start");

    // B's first replacement crashes; the next retry must relaunch B again.
    mockTerminals = [
      { id: "panel-a", worktreeId: "wt-1", exitCode: undefined },
      { id: "panel-b2", worktreeId: "wt-1", exitCode: 1 },
    ];
    await retryFailed();
    await advanceTimersGradually(5000);
    expect(itemOf(1)).toMatchObject({
      stage: "failed",
      failedStep: "verification",
      error: expect.stringMatching(/1 terminal\(s\) crashed/),
    });

    mockTerminals = [
      { id: "panel-a", worktreeId: "wt-1", exitCode: undefined },
      { id: "panel-b2", worktreeId: "wt-1", exitCode: 1 },
      { id: "panel-b3", worktreeId: "wt-1", exitCode: undefined },
    ];
    await retryFailed();
    await advanceTimersGradually(5000);

    expect(mockAddPanel.mock.calls.map((c) => c[0].command)).toEqual([
      "cmd-a",
      "cmd-b",
      "cmd-b",
      "cmd-b",
    ]);
    expect(mockTrashPanel).toHaveBeenCalledWith("panel-b2");
    expect(mockTrashPanel).not.toHaveBeenCalledWith("panel-a");
    expect(itemOf(1)?.stage).toBe("succeeded");
  });

  it("fails only the PR still needing a worktree when the retry can't list branches", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockListBranches.mockResolvedValue([
      { name: "origin/feature/pr-1", current: false, remote: "origin" },
      { name: "origin/feature/pr-2", current: false, remote: "origin" },
    ]);
    mockWorktreeCreate.mockImplementation((opts: { newBranch: string }) =>
      opts.newBranch === "feature/pr-2"
        ? Promise.reject(new Error("Some error"))
        : Promise.resolve(createdWorktree("wt-1", "feature/pr-1"))
    );
    mockRunRecipeWithResults
      .mockResolvedValueOnce({ spawned: [], failed: [{ index: 0, error: "spawn failed" }] })
      .mockResolvedValueOnce({ spawned: [{ index: 0, terminalId: "t-0" }], failed: [] });
    mockTerminals = [{ id: "t-0", worktreeId: "wt-1", exitCode: undefined }];
    const prProps = {
      ...props,
      mode: "pr" as const,
      selectedIssues: [],
      selectedPRs: [makePR(1), makePR(2)],
    };

    render(<BulkCreateWorktreeDialog {...prProps} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    // PR #1's worktree landed and only its terminals failed; PR #2 has no
    // worktree. Created counts worktrees on disk, so that is 1, with 0 ready.
    expect(runSummary().facts).toMatchObject({ created: 1, ready: 0, failed: 2 });
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(2);

    const listCallsBefore = mockListBranches.mock.calls.length;
    mockListBranches.mockRejectedValue(new Error("git exploded"));
    await retryFailed();
    await advanceTimersGradually(5000);

    expect(mockListBranches.mock.calls.length).toBe(listCallsBefore + 1);
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(2);
    expect(recipeIndicesForCall(1)).toEqual([0]);
    expect(itemOf(1)?.stage).toBe("succeeded");
    expect(itemOf(2)).toMatchObject({
      stage: "failed",
      failedStep: "worktree",
      error: "git exploded",
    });
    expect(runSummary().facts).toMatchObject({ created: 1, ready: 1, failed: 1 });
  });

  it("retries a PR's terminals without listing branches for a worktree it already has", async () => {
    mockSelectedRecipeId = "test-recipe";
    mockListBranches.mockResolvedValue([
      { name: "origin/feature/pr-1", current: false, remote: "origin" },
    ]);
    mockRunRecipeWithResults
      .mockResolvedValueOnce({ spawned: [], failed: [{ index: 0, error: "spawn failed" }] })
      .mockResolvedValueOnce({ spawned: [{ index: 0, terminalId: "t-0" }], failed: [] });
    mockTerminals = [{ id: "t-0", worktreeId: "wt-1", exitCode: undefined }];
    const prProps = { ...props, mode: "pr" as const, selectedIssues: [], selectedPRs: [makePR(1)] };

    render(<BulkCreateWorktreeDialog {...prProps} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(itemOf(1)).toMatchObject({ stage: "failed", failedStep: "terminals" });
    expect(itemSteps()[1]).toBe("Terminals didn't start");

    const listCallsBefore = mockListBranches.mock.calls.length;
    mockListBranches.mockRejectedValue(new Error("git exploded"));
    await retryFailed();
    await advanceTimersGradually(5000);

    expect(mockListBranches.mock.calls.length).toBe(listCallsBefore);
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(1);
    expect(recipeIndicesForCall(1)).toEqual([0]);
    expect(itemOf(1)?.stage).toBe("succeeded");
  });

  it("keeps a live run's items out of the plan while their worktrees land", async () => {
    const resolvers: Array<(value: ReturnType<typeof createdWorktree>) => void> = [];
    mockWorktreeCreate.mockImplementation(
      () =>
        new Promise<ReturnType<typeof createdWorktree>>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const twoProps = { ...props, selectedIssues: [makeIssue(1), makeIssue(2)] };
    const { rerender } = render(<BulkCreateWorktreeDialog {...twoProps} />);
    const creatable = () =>
      Number(
        /Create (\d+)/.exec(screen.getByTestId("bulk-create-confirm-button").textContent ?? "")?.[1]
      );
    expect(creatable()).toBe(2);

    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    // Still mounted here only because the test's onClose doesn't unmount it:
    // everything picked now belongs to the run.
    expect(creatable()).toBe(0);
    expect(skipBadges("Being created")).toBe(2);

    await act(async () => {
      resolvers[0]?.(createdWorktree("wt-1", "feature/issue-1-issue-1"));
      await vi.advanceTimersByTimeAsync(0);
    });
    const landed = new Map(worktreeDataHolder.map);
    landed.set("wt-1", {
      worktreeId: "wt-1",
      branch: "feature/issue-1-issue-1",
      path: "/worktrees/feature/issue-1-issue-1",
      isMainWorktree: false,
      issueNumber: 1,
    });
    worktreeDataHolder.map = landed;
    await act(async () => {
      rerender(<BulkCreateWorktreeDialog {...twoProps} />);
    });

    // #1 now reads as having its worktree, #2 is still the run's: neither is
    // offered again in between.
    expect(skipBadges("Has worktree")).toBe(1);
    expect(skipBadges("Being created")).toBe(1);
    expect(creatable()).toBe(0);

    await act(async () => {
      resolvers[1]?.(createdWorktree("wt-2", "feature/issue-2-issue-2"));
      await vi.advanceTimersByTimeAsync(0);
    });
    await advanceTimersGradually(1000);
    expect(runSummary().detail).toBe("2 of 2 created");
  });

  it("retries a failed item on its planned branch after its worktree is tagged with the issue", async () => {
    // create() rejected, but the host landed the worktree anyway and the store
    // now tags it with the issue. A live plan would mark the item skipped with
    // an empty branch and create a second, nameless worktree on retry.
    mockWorktreeCreate.mockRejectedValueOnce(new Error("Some error"));

    const { rerender } = render(<BulkCreateWorktreeDialog {...props} />);
    await act(async () => {
      screen.getByTestId("bulk-create-confirm-button").click();
    });
    await advanceTimersGradually(5000);
    expect(itemOf(1)).toMatchObject({ stage: "failed", failedStep: "worktree" });
    expect(itemOf(1)?.worktreeId).toBeUndefined();

    const landed = new Map(worktreeDataHolder.map);
    landed.set("late-wt", {
      worktreeId: "late-wt",
      branch: "feature/issue-1-issue-1",
      path: "/worktrees/feature/issue-1-issue-1",
      isMainWorktree: false,
      issueNumber: 1,
    });
    worktreeDataHolder.map = landed;
    await act(async () => {
      rerender(<BulkCreateWorktreeDialog {...props} />);
    });

    await retryFailed();
    await advanceTimersGradually(5000);

    expect(mockWorktreeCreate).toHaveBeenCalledTimes(1);
    expect(mockGetAvailableBranch).not.toHaveBeenCalledWith("/test/root", "");
    expect(itemOf(1)?.stage).toBe("succeeded");
  });
});
