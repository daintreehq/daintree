/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { StagingStatus } from "@shared/types";
import type { WorktreeState } from "@shared/types";

const {
  getStagingStatusMock,
  onUpdateMock,
  debounceCancelSpy,
  compareWorktreesMock,
  openPRMock,
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
  openPRMock: vi.fn().mockResolvedValue(undefined),
  abortRepositoryOperationMock: vi.fn().mockResolvedValue(undefined),
  continueRepositoryOperationMock: vi.fn().mockResolvedValue(undefined),
  openInEditorMock: vi.fn().mockResolvedValue(undefined),
  stageFileMock: vi.fn().mockResolvedValue(undefined),
  commitMock: vi.fn(),
  pushMock: vi.fn(),
  actionDispatchMock: vi.fn().mockResolvedValue({ ok: true }),
  worktreeStoreData: {
    current: new Map<string, Partial<WorktreeState>>([
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
    ]),
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

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@/hooks", () => ({
  useOverlayState: vi.fn(),
  useTruncationDetection: vi.fn(() => ({ ref: vi.fn(), isTruncated: false })),
}));

vi.mock("../../FileDiffModal", () => ({ FileDiffModal: () => null }));
vi.mock("../BaseBranchDiffModal", () => ({ BaseBranchDiffModal: () => null }));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: { worktrees: Map<string, WorktreeState> }) => unknown) =>
    selector({ worktrees: worktreeStoreData.current as Map<string, WorktreeState> }),
}));

vi.mock("@/clients/githubClient", () => ({
  githubClient: { openPR: openPRMock },
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
  ConfirmDialog: ({
    isOpen,
    title,
    description,
    onConfirm,
    onClose,
    confirmLabel,
    cancelLabel,
  }: {
    isOpen: boolean;
    title: ReactNode;
    description?: ReactNode;
    onConfirm: () => void;
    onClose?: () => void;
    confirmLabel: string;
    cancelLabel?: string;
    variant: "default" | "destructive" | "info";
  }) => {
    if (!isOpen) return null;
    return (
      <div role="alertdialog" aria-label={typeof title === "string" ? title : "confirm"}>
        <div>{title}</div>
        {description && <div>{description}</div>}
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
        {onClose && (
          <button type="button" onClick={onClose}>
            {cancelLabel ?? "Cancel"}
          </button>
        )}
      </div>
    );
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ReviewHub } from "../ReviewHub";

const WORKTREE_PATH = "/home/user/project";

const makeStatus = (overrides?: Partial<StagingStatus>): StagingStatus => ({
  staged: [{ path: "src/index.ts", status: "modified", insertions: 5, deletions: 2 }],
  unstaged: [{ path: "src/app.ts", status: "modified", insertions: 3, deletions: 1 }],
  conflicted: [],
  conflictedFiles: [],
  isDetachedHead: false,
  currentBranch: "feature/test",
  hasRemote: false,
  repoState: "DIRTY",
  rebaseStep: null,
  rebaseTotalSteps: null,
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

describe("ReviewHub", () => {
  let capturedUpdateCallback: ((state: WorktreeState) => void) | null = null;
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
    capturedUpdateCallback = null;
    debounceCancelSpy.mockReset();

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
    onUpdateMock.mockImplementation((callback: (state: WorktreeState) => void) => {
      capturedUpdateCallback = callback;
      return mockUnsubscribe;
    });

    compareWorktreesMock.mockResolvedValue({ branch1: "main", branch2: "feature/test", files: [] });

    abortRepositoryOperationMock.mockReset().mockResolvedValue(undefined);
    continueRepositoryOperationMock.mockReset().mockResolvedValue(undefined);
    openInEditorMock.mockReset().mockResolvedValue(undefined);
    stageFileMock.mockReset().mockResolvedValue(undefined);
    commitMock.mockReset().mockResolvedValue({ hash: "abc123", summary: "commit" });
    pushMock.mockReset().mockResolvedValue({ success: true });
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
        worktree: { onUpdate: onUpdateMock },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches status once on open", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(getStagingStatusMock).toHaveBeenCalledTimes(1);
      expect(getStagingStatusMock).toHaveBeenCalledWith(WORKTREE_PATH);
    });
  });

  it("renders staged and unstaged files after initial load", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => {
      screen.getByText("index.ts");
      screen.getByText("app.ts");
    });
  });

  it("subscribes to worktree updates on open", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => expect(onUpdateMock).toHaveBeenCalledTimes(1));
    expect(capturedUpdateCallback).not.toBeNull();
  });

  it("triggers background refresh when matching worktree emits update", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(1));

    const updatedStatus = makeStatus({
      staged: [{ path: "new.ts", status: "added", insertions: 10, deletions: 0 }],
      unstaged: [],
    });
    getStagingStatusMock.mockResolvedValue(updatedStatus);

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getStagingStatusMock).toHaveBeenCalledTimes(2);
      screen.getByText("new.ts");
    });
  });

  it("ignores worktree update events for a different path", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState("/home/user/other-project"));
      await Promise.resolve();
    });

    expect(getStagingStatusMock).toHaveBeenCalledTimes(1);
  });

  it("preserves commit message during a background resync", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByPlaceholderText("Commit message…"));

    const textarea = screen.getByPlaceholderText("Commit message…");
    fireEvent.change(textarea, { target: { value: "My commit message" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("My commit message");

    getStagingStatusMock.mockResolvedValue(makeStatus());
    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });
    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(2));

    expect((textarea as HTMLTextAreaElement).value).toBe("My commit message");
  });

  it("keeps existing file rows visible during background refresh (no blank flash)", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("index.ts"));

    let resolveRefresh!: (value: StagingStatus) => void;
    getStagingStatusMock.mockReturnValue(
      new Promise<StagingStatus>((resolve) => {
        resolveRefresh = resolve;
      })
    );

    act(() => {
      capturedUpdateCallback!(makeWorktreeState());
    });

    screen.getByText("index.ts");

    await act(async () => {
      resolveRefresh(makeStatus());
      await Promise.resolve();
    });
  });

  it("unsubscribes when closed", async () => {
    const { rerender } = render(
      <ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
    );
    await waitFor(() => expect(onUpdateMock).toHaveBeenCalled());

    rerender(<ReviewHub isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it("cancels debounce before explicit stage actions", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("app.ts"));

    // Click the "Stage src/app.ts" button (unstaged file) — aria-label starts with "Stage"
    const stageBtn = screen.getByRole("button", { name: /^Stage src\/app\.ts/i });
    fireEvent.click(stageBtn);

    await waitFor(() => expect(debounceCancelSpy).toHaveBeenCalled());
  });

  it("manual refresh button still works independently", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(1));

    const refreshButton = screen.getByRole("button", { name: /refresh/i });
    act(() => fireEvent.click(refreshButton));

    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(2));
  });

  it("resets commit message on close then reopen", async () => {
    const { rerender } = render(
      <ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
    );
    await waitFor(() => screen.getByPlaceholderText("Commit message…"));

    const textarea = screen.getByPlaceholderText("Commit message…");
    fireEvent.change(textarea, { target: { value: "draft message" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("draft message");

    rerender(<ReviewHub isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    rerender(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => {
      const ta = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;
      expect(ta.value).toBe("");
    });
  });

  it("background refresh error keeps existing file list visible", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("index.ts"));

    getStagingStatusMock.mockRejectedValue(new Error("network error"));

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    screen.getByText("index.ts");
  });

  it("removes old rows after background refresh replaces status", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("index.ts"));

    const statusWithNewFiles = makeStatus({
      staged: [{ path: "new-feature.ts", status: "added", insertions: 10, deletions: 0 }],
      unstaged: [],
    });
    getStagingStatusMock.mockResolvedValue(statusWithNewFiles);

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });

    await waitFor(() => screen.getByText("new-feature.ts"));
    expect(screen.queryByText("index.ts")).toBeNull();
    expect(screen.queryByText("app.ts")).toBeNull();
  });

  it("background refresh clears a prior loadError on success", async () => {
    getStagingStatusMock.mockRejectedValue(new Error("git error"));
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("git error"));

    getStagingStatusMock.mockResolvedValue(makeStatus());

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByText("git error")).toBeNull();
      screen.getByText("index.ts");
    });
  });

  it("foreground and background requests use independent IDs, neither suppresses the other", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("index.ts"));

    // Trigger a background refresh (fires immediately due to mocked debounce)
    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });

    // Then trigger an explicit manual refresh
    const refreshButton = screen.getByRole("button", { name: /refresh/i });
    act(() => fireEvent.click(refreshButton));

    await waitFor(() => {
      // Both should have fired — total calls: 1 initial + 1 bg + 1 manual = 3
      expect(getStagingStatusMock).toHaveBeenCalledTimes(3);
      screen.getByText("index.ts");
    });
  });

  describe("base-branch diff mode", () => {
    it("defaults to working-tree mode showing staged and unstaged sections", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      expect(
        screen.getByRole("button", { name: /working tree/i }).getAttribute("aria-pressed")
      ).toBe("true");
      expect(screen.getByRole("button", { name: /vs main/i }).getAttribute("aria-pressed")).toBe(
        "false"
      );
    });

    it("does not call compareWorktrees on initial open", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      expect(compareWorktreesMock).not.toHaveBeenCalled();
    });

    it("calls compareWorktrees with useMergeBase when switching to base-branch mode", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("button", { name: /vs main/i });
      act(() => fireEvent.click(toggle));

      await waitFor(() => {
        expect(compareWorktreesMock).toHaveBeenCalledWith(
          WORKTREE_PATH,
          "main",
          "feature/test",
          undefined,
          true
        );
      });
    });

    it("shows changed file list in base-branch mode", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [
          { status: "M", path: "src/component.tsx" },
          { status: "A", path: "src/new-file.ts" },
        ],
      });

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("button", { name: /vs main/i });
      act(() => fireEvent.click(toggle));

      await waitFor(() => {
        screen.getByText("component.tsx");
        screen.getByText("new-file.ts");
      });
    });

    it("shows empty state when no files changed vs base branch", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [],
      });

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("button", { name: /vs main/i });
      act(() => fireEvent.click(toggle));

      await waitFor(() => {
        screen.getByText(/no changes vs main/i);
      });
    });

    it("shows error message when compareWorktrees fails", async () => {
      compareWorktreesMock.mockRejectedValue(new Error("branch not found"));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("button", { name: /vs main/i });
      act(() => fireEvent.click(toggle));

      await waitFor(() => {
        screen.getByText("branch not found");
      });
    });

    it("does not show commit panel in base-branch mode", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const toggle = screen.getByRole("button", { name: /vs main/i });
      act(() => fireEvent.click(toggle));

      await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalled());

      expect(screen.queryByPlaceholderText("Commit message…")).toBeNull();
    });

    it("resets to working-tree mode when closed and reopened", async () => {
      const { rerender } = render(
        <ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );
      await waitFor(() => screen.getByText("index.ts"));

      // Switch to base-branch mode
      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));
      await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalled());

      // Close and reopen
      rerender(<ReviewHub isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      rerender(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /working tree/i }).getAttribute("aria-pressed")
        ).toBe("true");
      });
    });

    it("disables vs-branch button when current branch matches main branch", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ currentBranch: "main" }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("button", { name: /vs main/i });
      expect(toggle.hasAttribute("disabled")).toBe(true);
    });

    it("does not call compareWorktrees when current branch matches main branch", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ currentBranch: "main" }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("button", { name: /vs main/i });
      fireEvent.click(toggle);

      expect(compareWorktreesMock).not.toHaveBeenCalled();
    });

    it("does not refetch base-branch diff on repeated toggle to base-branch mode", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      // First toggle
      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));
      await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalledTimes(1));

      // Toggle back to working-tree
      act(() => fireEvent.click(screen.getByRole("button", { name: /working tree/i })));

      // Toggle again to base-branch — should NOT re-fetch since files are cached
      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));

      // Still only 1 call
      expect(compareWorktreesMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("focus retention", () => {
    it("commit textarea retains focus during background resync", async () => {
      const onClose = vi.fn();
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={onClose} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      // Wait for the initial 50ms close-button autofocus to settle
      await new Promise((r) => setTimeout(r, 100));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;
      act(() => textarea.focus());
      expect(document.activeElement).toBe(textarea);

      // Trigger a background resync which re-renders the component
      getStagingStatusMock.mockResolvedValue(makeStatus());
      await act(async () => {
        capturedUpdateCallback!(makeWorktreeState());
        await Promise.resolve();
      });
      await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(2));

      // Wait past the 50ms window — the focus effect should NOT re-run
      await new Promise((r) => setTimeout(r, 100));

      expect(document.activeElement).toBe(textarea);
    });

    it("Escape reads latest state through useEffectEvent", async () => {
      const onClose = vi.fn();
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={onClose} />);
      await waitFor(() => screen.getByText("index.ts"));

      // Click the file row button to open its diff (sets selectedFile)
      const fileRow = screen.getByText("index.ts").closest("button")!;
      fireEvent.click(fileRow);

      // First Escape should clear selectedFile, not close modal
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });

      expect(onClose).not.toHaveBeenCalled();

      // Second Escape should close the modal
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("PR state indicator", () => {
    function setWorktreePR(prData: {
      prNumber: number;
      prUrl: string;
      prState: "open" | "merged" | "closed";
    }) {
      const existing = worktreeStoreData.current.get("main-wt")!;
      worktreeStoreData.current.set("main-wt", { ...existing, ...prData });
    }

    it("shows PR badge with number and state when worktree has a PR", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByRole("button", { name: /open pull request #42/i });
        screen.getByText("#42");
        screen.getByText("open");
      });
    });

    it("opens PR in browser when PR badge is clicked", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByRole("button", { name: /open pull request #42/i }));
      fireEvent.click(screen.getByRole("button", { name: /open pull request #42/i }));

      expect(openPRMock).toHaveBeenCalledWith("https://github.com/test/repo/pull/42");
    });

    it("shows 'No PR' when branch has remote but no PR", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("No PR");
      });
    });

    it("does not show PR indicator when branch has no remote, even with PR data", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: false }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      expect(screen.queryByText("No PR")).toBeNull();
      expect(screen.queryByText("#42")).toBeNull();
    });

    it("shows closed state for closed PRs", async () => {
      setWorktreePR({
        prNumber: 77,
        prUrl: "https://github.com/test/repo/pull/77",
        prState: "closed",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("#77");
        screen.getByText("closed");
      });
    });

    it("shows merged state for merged PRs", async () => {
      setWorktreePR({
        prNumber: 99,
        prUrl: "https://github.com/test/repo/pull/99",
        prState: "merged",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("#99");
        screen.getByText("merged");
      });
    });
  });

  describe("conflict mode", () => {
    const makeMergingStatus = (overrides?: Partial<StagingStatus>): StagingStatus =>
      makeStatus({
        staged: [],
        unstaged: [],
        conflicted: ["src/app.ts"],
        conflictedFiles: [{ path: "src/app.ts", xy: "UU", label: "both modified" }],
        repoState: "MERGING",
        ...overrides,
      });

    it("renders the conflict panel instead of staging sections when merging", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      screen.getByText(/Resolve Merge Conflicts/i);
      expect(screen.queryByText(/^Staged$/i)).toBeNull();
      expect(screen.queryByPlaceholderText("Commit message…")).toBeNull();
    });

    it("shows rebase step progress in the banner", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          repoState: "REBASING",
          rebaseStep: 3,
          rebaseTotalSteps: 8,
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-rebase-progress"));
      expect(screen.getByTestId("conflict-rebase-progress").textContent).toMatch(/Step 3 of 8/);
    });

    it("disables Continue when conflicted files remain", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByRole("button", { name: /^Continue /i }));
      expect(screen.getByRole("button", { name: /^Continue /i }).hasAttribute("disabled")).toBe(
        true
      );
    });

    it("enables Continue when all conflicts are resolved", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflicted: [],
          conflictedFiles: [],
          staged: [{ path: "src/app.ts", status: "modified", insertions: 1, deletions: 1 }],
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByRole("button", { name: /^Continue /i }));
      expect(screen.getByRole("button", { name: /^Continue /i }).hasAttribute("disabled")).toBe(
        false
      );
    });

    it("stages a file when Mark resolved is clicked", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const resolveBtn = screen.getByRole("button", {
        name: /Mark src\/app\.ts as resolved/i,
      });
      fireEvent.click(resolveBtn);

      await waitFor(() => {
        expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts");
      });
    });

    it("opens the file in the external editor with the absolute path", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const openBtn = screen.getByRole("button", {
        name: /Open src\/app\.ts in external editor/i,
      });
      fireEvent.click(openBtn);

      await waitFor(() => {
        expect(openInEditorMock).toHaveBeenCalledWith({
          path: `${WORKTREE_PATH}/src/app.ts`,
        });
      });
    });

    it("opens confirm dialog before aborting and calls abort on confirm", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByRole("button", { name: /^Abort /i }));
      fireEvent.click(screen.getByRole("button", { name: /^Abort /i }));

      const dialog = await screen.findByRole("alertdialog");
      expect(abortRepositoryOperationMock).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: /Abort merge/i }));

      await waitFor(() => {
        expect(abortRepositoryOperationMock).toHaveBeenCalledWith(WORKTREE_PATH);
      });
    });

    it("invokes continue when Continue is clicked", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflicted: [],
          conflictedFiles: [],
          staged: [{ path: "src/app.ts", status: "modified", insertions: 1, deletions: 1 }],
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByRole("button", { name: /^Continue /i }));
      fireEvent.click(screen.getByRole("button", { name: /^Continue /i }));

      await waitFor(() => {
        expect(continueRepositoryOperationMock).toHaveBeenCalledWith(WORKTREE_PATH);
      });
    });

    it("renders cherry-pick operation labels", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus({ repoState: "CHERRY_PICKING" }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      screen.getByText(/Resolve Cherry-pick Conflicts/i);
      screen.getByRole("button", { name: /^Abort cherry-pick/i });
      screen.getByRole("button", { name: /^Continue cherry-pick/i });
    });

    it("renders revert operation labels", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus({ repoState: "REVERTING" }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      screen.getByText(/Resolve Revert Conflicts/i);
      screen.getByRole("button", { name: /^Abort revert/i });
      screen.getByRole("button", { name: /^Continue revert/i });
    });

    it("renders normal staging UI when repoState is DIRTY with conflicts", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          conflicted: ["src/weird.ts"],
          conflictedFiles: [{ path: "src/weird.ts", xy: "UU", label: "both modified" }],
          repoState: "DIRTY",
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      expect(screen.queryByTestId("conflict-panel")).toBeNull();
    });
  });

  describe("push error banner", () => {
    async function triggerCommitAndPush() {
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…");
      fireEvent.change(textarea, { target: { value: "feat: do the thing" } });

      const commitPushBtn = screen.getByRole("button", { name: /Commit & Push/i });
      await act(async () => {
        fireEvent.click(commitPushBtn);
        await Promise.resolve();
      });
    }

    it("shows auth-failed banner with Open GitHub settings CTA and dispatches settings tab", async () => {
      const rawError = "fatal: Authentication failed for 'https://github.com/foo/bar.git/'";
      pushMock.mockResolvedValue({
        success: false,
        gitReason: "auth-failed",
        error: rawError,
      });

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("auth-failed");
      expect(banner.textContent).toMatch(/Authentication failed/i);
      expect(banner.textContent).toMatch(/Committed locally/i);
      expect(banner.textContent).not.toContain(rawError);
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();

      const cta = screen.getByTestId("review-hub-push-error-cta");
      expect(cta.textContent).toMatch(/Open GitHub settings/i);
      fireEvent.click(cta);

      expect(actionDispatchMock).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "github" },
        { source: "user" }
      );
    });

    it("shows push-rejected-outdated banner without a CTA", async () => {
      pushMock.mockResolvedValue({
        success: false,
        gitReason: "push-rejected-outdated",
        error: "! [rejected] main -> main (non-fast-forward)",
      });

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("push-rejected-outdated");
      expect(banner.textContent).toMatch(/remote has new commits/i);
      expect(screen.queryByTestId("review-hub-push-error-cta")).toBeNull();
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
    });

    it("shows push-rejected-policy banner with raw stderr and no CTA", async () => {
      const rawError = "GH006: Protected branch update failed for refs/heads/main.";
      pushMock.mockResolvedValue({
        success: false,
        gitReason: "push-rejected-policy",
        error: rawError,
      });

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("push-rejected-policy");
      expect(banner.textContent).toMatch(/protected branch or repository rule/i);
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(rawError);
      expect(screen.queryByTestId("review-hub-push-error-cta")).toBeNull();
    });

    it("shows hook-rejected banner with raw stderr", async () => {
      const rawError = "[remote rejected] main -> main (pre-receive hook declined)";
      pushMock.mockResolvedValue({
        success: false,
        gitReason: "hook-rejected",
        error: rawError,
      });

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("hook-rejected");
      expect(banner.textContent).toMatch(/server-side hook rejected/i);
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(rawError);
    });

    it("shows network-unavailable banner with Retry push button that re-pushes without re-committing", async () => {
      const rawError = "Could not resolve host: github.com";
      pushMock.mockResolvedValueOnce({
        success: false,
        gitReason: "network-unavailable",
        error: rawError,
      });

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("network-unavailable");
      expect(banner.textContent).toMatch(/Could not reach the remote/i);
      expect(banner.textContent).not.toContain(rawError);
      expect(commitMock).toHaveBeenCalledTimes(1);
      expect(pushMock).toHaveBeenCalledTimes(1);

      pushMock.mockResolvedValueOnce({ success: true });

      const retryBtn = screen.getByTestId("review-hub-push-error-cta");
      expect(retryBtn.textContent).toMatch(/Retry push/i);
      await act(async () => {
        fireEvent.click(retryBtn);
        await Promise.resolve();
      });

      await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(2));
      expect(commitMock).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByTestId("review-hub-push-error")).toBeNull());
    });

    it("renders the banner with the unknown reason when push rejects (throws)", async () => {
      pushMock.mockRejectedValueOnce(new Error("Could not resolve host: github.com"));

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("unknown");
      expect(banner.textContent).toMatch(/Push failed\. See details below\./i);
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(
        "Could not resolve host: github.com"
      );
    });

    it("updates the banner when a retry fails with a different reason", async () => {
      pushMock.mockResolvedValueOnce({
        success: false,
        gitReason: "network-unavailable",
        error: "Could not resolve host: github.com",
      });

      await triggerCommitAndPush();

      await screen.findByTestId("review-hub-push-error");

      pushMock.mockResolvedValueOnce({
        success: false,
        gitReason: "hook-rejected",
        error: "[remote rejected] main -> main (pre-receive hook declined)",
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-cta"));
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(screen.getByTestId("review-hub-push-error").getAttribute("data-reason")).toBe(
          "hook-rejected"
        )
      );
      expect(screen.queryByTestId("review-hub-push-error-cta")).toBeNull();
    });

    it("clears the push banner when the modal is closed and reopened", async () => {
      pushMock.mockResolvedValue({
        success: false,
        gitReason: "auth-failed",
        error: "Authentication failed",
      });

      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));
      const { rerender } = render(
        <ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      fireEvent.change(screen.getByPlaceholderText("Commit message…"), {
        target: { value: "feat: thing" },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Commit & Push/i }));
        await Promise.resolve();
      });
      await screen.findByTestId("review-hub-push-error");

      rerender(<ReviewHub isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      rerender(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => expect(screen.queryByTestId("review-hub-push-error")).toBeNull());
    });

    it("does not call push when commit itself fails", async () => {
      commitMock.mockRejectedValueOnce(new Error("nothing to commit"));
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      fireEvent.change(screen.getByPlaceholderText("Commit message…"), {
        target: { value: "feat: thing" },
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Commit & Push/i }));
        await Promise.resolve();
      });

      expect(pushMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("review-hub-push-error")).toBeNull();
      await waitFor(() => screen.getByText("nothing to commit"));
    });

    it("falls back to generic copy + raw stderr for an unclassified failure", async () => {
      const rawError = "unexpected: something weird happened";
      pushMock.mockResolvedValue({
        success: false,
        error: rawError,
      });

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("unknown");
      expect(banner.textContent).toMatch(/Push failed\. See details below\./i);
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(rawError);
      expect(screen.queryByTestId("review-hub-push-error-cta")).toBeNull();
    });

    it("does not render the banner on successful push", async () => {
      pushMock.mockResolvedValue({ success: true });

      await triggerCommitAndPush();

      await waitFor(() => expect(pushMock).toHaveBeenCalled());
      expect(screen.queryByTestId("review-hub-push-error")).toBeNull();
    });
  });
});
