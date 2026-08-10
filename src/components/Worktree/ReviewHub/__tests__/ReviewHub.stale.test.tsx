/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import type { StagingStatus, WorktreeState } from "@shared/types";

const {
  getStagingStatusMock,
  onUpdateMock,
  debounceCancelSpy,
  compareWorktreesMock,
  abortRepositoryOperationMock,
  continueRepositoryOperationMock,
  openInEditorMock,
  stageFileMock,
  commitMock,
  pushMock,
  actionDispatchMock,
  worktreeStoreData,
} = vi.hoisted(() => ({
  getStagingStatusMock: vi.fn(),
  onUpdateMock: vi.fn(),
  debounceCancelSpy: vi.fn(),
  compareWorktreesMock: vi.fn(),
  abortRepositoryOperationMock: vi.fn().mockResolvedValue(undefined),
  continueRepositoryOperationMock: vi.fn().mockResolvedValue(undefined),
  openInEditorMock: vi.fn().mockResolvedValue(undefined),
  stageFileMock: vi.fn().mockResolvedValue(undefined),
  commitMock: vi.fn(),
  pushMock: vi.fn(),
  actionDispatchMock: vi.fn().mockResolvedValue({ ok: true }),
  worktreeStoreData: {
    current: new Map<string, Partial<WorktreeState>>(),
  },
}));

vi.mock("@/utils/debounce", () => ({
  debounce: (fn: (...args: unknown[]) => void) => {
    const immediate = (...args: unknown[]) => fn(...args);
    immediate.cancel = debounceCancelSpy;
    immediate.flush = vi.fn();
    return immediate;
  },
}));

vi.mock("@/hooks", () => ({
  useTruncationDetection: vi.fn(() => ({ ref: vi.fn(), isTruncated: false })),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: { worktrees: Map<string, WorktreeState> }) => unknown) =>
    selector({ worktrees: worktreeStoreData.current as Map<string, WorktreeState> }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: actionDispatchMock },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    "aria-label": ariaLabel,
    "data-testid": testId,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    className?: string;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ReviewHubContent } from "../ReviewHubContent";
import { useUIStore } from "@/store/uiStore";

const WORKTREE_PATH = "/home/user/project";

const makeStatus = (overrides?: Partial<StagingStatus>): StagingStatus => ({
  staged: [{ path: "src/index.ts", status: "modified", insertions: 5, deletions: 2 }],
  unstaged: [{ path: "src/app.ts", status: "modified", insertions: 3, deletions: 1 }],
  conflicted: [],
  conflictedFiles: [],
  isDetachedHead: false,
  currentBranch: "feature/test",
  hasRemote: false,
  pushDestination: { remote: "origin", branch: "feature/test" },
  pullSource: { remote: "origin", branch: "feature/test" },
  repoState: "DIRTY",
  rebaseStep: null,
  rebaseTotalSteps: null,
  rebaseSequence: null,
  ...overrides,
});

const makeWorktreeState = (path = WORKTREE_PATH): WorktreeState =>
  ({
    id: path,
    path,
    worktreeId: path,
    name: "test",
    isCurrent: true,
    worktreeChanges: null,
    lastActivityTimestamp: null,
  }) as unknown as WorktreeState;

function findScrollContainer(): HTMLElement {
  return screen.getByTestId("review-hub-scroll-container");
}

describe("ReviewHub stale visual", () => {
  let capturedUpdateCallback: ((state: WorktreeState) => void) | null = null;
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
    capturedUpdateCallback = null;
    debounceCancelSpy.mockReset();

    // Default disclosure to expanded for tests (defaults to collapsed in
    // production per issue #7886).
    useUIStore.getState().setReviewHubFileListExpanded(WORKTREE_PATH, true);

    worktreeStoreData.current = new Map([
      [
        "main-wt",
        {
          id: "main-wt",
          path: "/home/user/project",
          name: "main",
          branch: "main",
          isMainWorktree: true,
          isCurrent: false,
          worktreeId: "main-wt",
          worktreeChanges: null,
          lastActivityTimestamp: null,
        },
      ],
    ]);

    getStagingStatusMock.mockResolvedValue(makeStatus());
    onUpdateMock.mockImplementation((_type: string, callback: (data: unknown) => void) => {
      // The component subscribes to the per-view worktree port; tests keep
      // driving it with a plain WorktreeState by wrapping it in the port
      // event envelope here.
      capturedUpdateCallback = (state: WorktreeState) => callback({ worktree: state });
      return mockUnsubscribe;
    });

    compareWorktreesMock.mockResolvedValue({ branch1: "main", branch2: "feature/test", files: [] });

    abortRepositoryOperationMock.mockReset().mockResolvedValue(undefined);
    continueRepositoryOperationMock.mockReset().mockResolvedValue(undefined);
    openInEditorMock.mockReset().mockResolvedValue(undefined);
    stageFileMock.mockReset().mockResolvedValue(undefined);
    commitMock.mockReset().mockResolvedValue({ hash: "abc123", summary: "commit" });
    pushMock.mockReset().mockResolvedValue(undefined);
    actionDispatchMock.mockReset().mockResolvedValue({ ok: true });

    Object.defineProperty(window, "electron", {
      value: {
        git: {
          getStagingStatus: getStagingStatusMock,
          stageFile: stageFileMock,
          unstageFile: vi.fn().mockResolvedValue(undefined),
          stageAll: vi.fn().mockResolvedValue(undefined),
          unstageAll: vi.fn().mockResolvedValue(undefined),
          commit: commitMock,
          push: pushMock,
          compareWorktrees: compareWorktreesMock,
          abortRepositoryOperation: abortRepositoryOperationMock,
          continueRepositoryOperation: continueRepositoryOperationMock,
        },
        system: { openInEditor: openInEditorMock },
        worktreePort: { onEvent: onUpdateMock },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not apply surface-stale or aria-busy when no background refresh is in flight", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("index.ts"));

    const scroll = findScrollContainer();
    expect(scroll.classList.contains("surface-stale")).toBe(false);
    expect(scroll.getAttribute("aria-busy")).toBeNull();
  });

  it("applies surface-stale and aria-busy=true while a background refresh is in flight", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("index.ts"));

    let resolveRefresh!: (value: StagingStatus) => void;
    getStagingStatusMock.mockReturnValue(
      new Promise<StagingStatus>((resolve) => {
        resolveRefresh = resolve;
      })
    );

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });

    const scroll = findScrollContainer();
    expect(scroll.classList.contains("surface-stale")).toBe(true);
    expect(scroll.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      resolveRefresh(makeStatus());
      await Promise.resolve();
    });
  });

  it("clears surface-stale and aria-busy when the background refresh rejects", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("index.ts"));

    let rejectRefresh!: (reason: unknown) => void;
    getStagingStatusMock.mockReturnValue(
      new Promise<StagingStatus>((_, reject) => {
        rejectRefresh = reject;
      })
    );

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });

    expect(findScrollContainer().classList.contains("surface-stale")).toBe(true);

    await act(async () => {
      rejectRefresh(new Error("git fail"));
      await Promise.resolve();
    });

    await waitFor(() => {
      const scroll = findScrollContainer();
      expect(scroll.classList.contains("surface-stale")).toBe(false);
      expect(scroll.getAttribute("aria-busy")).toBeNull();
    });

    screen.getByText("index.ts");
  });

  it("clears surface-stale and aria-busy after the background refresh resolves", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("index.ts"));

    let resolveRefresh!: (value: StagingStatus) => void;
    getStagingStatusMock.mockReturnValue(
      new Promise<StagingStatus>((resolve) => {
        resolveRefresh = resolve;
      })
    );

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });

    expect(findScrollContainer().classList.contains("surface-stale")).toBe(true);

    await act(async () => {
      resolveRefresh(makeStatus());
      await Promise.resolve();
    });

    await waitFor(() => {
      const scroll = findScrollContainer();
      expect(scroll.classList.contains("surface-stale")).toBe(false);
      expect(scroll.getAttribute("aria-busy")).toBeNull();
    });
  });
});
