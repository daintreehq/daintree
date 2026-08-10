/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { StagingStatus } from "@shared/types";
import type { WorktreeState } from "@shared/types";

const {
  getStagingStatusMock,
  onUpdateMock,
  debounceCancelSpy,
  compareWorktreesMock,
  openExternalMock,
  classifyPushErrorMock,
  abortRepositoryOperationMock,
  continueRepositoryOperationMock,
  scanConflictMarkersMock,
  checkoutOursTheirsMock,
  openInEditorMock,
  stageFileMock,
  unstageFileMock,
  stageFilesMock,
  unstageFilesMock,
  stageAllMock,
  unstageAllMock,
  commitMock,
  pushMock,
  pullRebaseMock,
  forcePushWithLeaseMock,
  listRemoteCommitsMock,
  listCommitsMock,
  actionDispatchMock,
  getDecorationsMock,
  onDecorationsChangedMock,
  worktreeStoreData,
} = vi.hoisted(() => ({
  getStagingStatusMock: vi.fn(),
  onUpdateMock: vi.fn(),
  debounceCancelSpy: vi.fn(),
  compareWorktreesMock: vi.fn(),
  openExternalMock: vi.fn().mockResolvedValue(undefined),
  // Mirrors the real GitHub forge provider: extracts a GH### code from stderr
  // and reports the resolved canonical provider id used to route the
  // settings CTA.
  classifyPushErrorMock: vi.fn(async (_cwd: string, stderr: string) => {
    const match = /\bGH\d{3,}\b/.exec(String(stderr));
    return {
      providerId: "daintree.github.github",
      classification: match ? { code: match[0] } : null,
    };
  }),
  abortRepositoryOperationMock: vi.fn().mockResolvedValue(undefined),
  continueRepositoryOperationMock: vi.fn().mockResolvedValue(undefined),
  scanConflictMarkersMock: vi.fn().mockResolvedValue([]),
  checkoutOursTheirsMock: vi.fn().mockResolvedValue(undefined),
  openInEditorMock: vi.fn().mockResolvedValue(undefined),
  stageFileMock: vi.fn().mockResolvedValue(undefined),
  unstageFileMock: vi.fn().mockResolvedValue(undefined),
  stageFilesMock: vi.fn().mockResolvedValue(undefined),
  unstageFilesMock: vi.fn().mockResolvedValue(undefined),
  stageAllMock: vi.fn().mockResolvedValue(undefined),
  unstageAllMock: vi.fn().mockResolvedValue(undefined),
  commitMock: vi.fn(),
  pushMock: vi.fn(),
  pullRebaseMock: vi.fn(),
  forcePushWithLeaseMock: vi.fn(),
  listRemoteCommitsMock: vi.fn(),
  listCommitsMock: vi.fn().mockResolvedValue({ items: [], hasMore: false, total: 0 }),
  actionDispatchMock: vi.fn().mockResolvedValue({ ok: true }),
  getDecorationsMock: vi.fn().mockResolvedValue({}),
  onDecorationsChangedMock: vi.fn().mockReturnValue(vi.fn()),
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

vi.mock("@/hooks", () => ({
  useTruncationDetection: vi.fn(() => ({ ref: vi.fn(), isTruncated: false })),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: { worktrees: Map<string, WorktreeState> }) => unknown) =>
    selector({ worktrees: worktreeStoreData.current as Map<string, WorktreeState> }),
}));

vi.mock("@/clients/systemClient", () => ({
  systemClient: { openExternal: openExternalMock },
}));

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: { classifyPushError: classifyPushErrorMock },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: actionDispatchMock },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    "aria-disabled": ariaDisabled,
    "aria-label": ariaLabel,
    "data-testid": testId,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-disabled"?: boolean;
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
      aria-disabled={ariaDisabled}
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
    children,
    onConfirm,
    onClose,
    confirmLabel,
    cancelLabel,
  }: {
    isOpen: boolean;
    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
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
        {children && <div>{children}</div>}
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
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <button type="button">{children}</button>,
  DropdownMenuContent: ({
    children,
    align: _align,
    className: _className,
  }: {
    children: ReactNode;
    align?: string;
    className?: string;
  }) => <div role="menu">{children}</div>,
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange: _onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => <div data-value={value}>{children}</div>,
  DropdownMenuRadioItem: ({ children, value: _value }: { children: ReactNode; value: string }) => (
    <div role="menuitemradio">{children}</div>
  ),
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
  }: {
    children: ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <div
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className="cursor-pointer"
    >
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@/components/ui/EmptyState", () => ({
  EmptyState: ({
    variant,
    scale,
    title,
    action,
  }: {
    variant: string;
    scale?: string;
    title: string;
    action?: ReactNode;
  }) => (
    <div data-testid={`empty-state-${variant}`} data-scale={scale}>
      <p>{title}</p>
      {action && <div>{action}</div>}
    </div>
  ),
}));

import { ReviewHubContent } from "../ReviewHubContent";
import { useUIStore } from "@/store/uiStore";
import { usePreferencesStore } from "@/store/preferencesStore";

const WORKTREE_PATH = "/home/user/project";

const makeStatus = (overrides?: Partial<StagingStatus>): StagingStatus => ({
  staged: [{ path: "src/index.ts", status: "modified", insertions: 5, deletions: 2 }],
  unstaged: [{ path: "src/app.ts", status: "modified", insertions: 3, deletions: 1 }],
  conflicted: [],
  conflictedFiles: [],
  isDetachedHead: false,
  currentBranch: "feature/test",
  hasRemote: false,
  pushDestination: null,
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

/**
 * `checkoutOursTheirs` now gates on a per-file `ConfirmDialog` (#8242). The
 * row button only opens the dialog; clicking its `Take ours` / `Take theirs`
 * confirm button is what reaches the IPC.
 */

/**
 * `pullRebase` now gates on a `ConfirmDialog` showing the divergence preview
 * (#8242). The push-error CTA only opens the dialog; clicking its
 * `Pull and rebase` confirm button is what reaches the IPC.
 */

describe("ReviewHub", () => {
  let capturedUpdateCallback: ((state: WorktreeState) => void) | null = null;
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
    capturedUpdateCallback = null;
    debounceCancelSpy.mockReset();

    // The Review Hub's file-list disclosure defaults to collapsed (issue
    // #7886). Existing tests assume rows are visible — expand the disclosure
    // for the canonical worktree path so suite-wide assertions keep working.
    useUIStore.getState().setReviewHubFileListExpanded(WORKTREE_PATH, true);

    // #8025: reset the per-worktree push-confirm opt-out so a previous test
    // that pre-set it can't leak into the next one.
    usePreferencesStore.getState().setSkipPushConfirmForWorktree(WORKTREE_PATH, false);

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
    scanConflictMarkersMock.mockReset().mockResolvedValue([]);
    checkoutOursTheirsMock.mockReset().mockResolvedValue(undefined);
    openInEditorMock.mockReset().mockResolvedValue(undefined);
    stageFileMock.mockReset().mockResolvedValue(undefined);
    unstageFileMock.mockReset().mockResolvedValue(undefined);
    stageFilesMock.mockReset().mockResolvedValue(undefined);
    unstageFilesMock.mockReset().mockResolvedValue(undefined);
    stageAllMock.mockReset().mockResolvedValue(undefined);
    unstageAllMock.mockReset().mockResolvedValue(undefined);
    commitMock.mockReset().mockResolvedValue({ hash: "abc123", summary: "commit" });
    pushMock.mockReset().mockResolvedValue(undefined);
    pullRebaseMock.mockReset().mockResolvedValue(undefined);
    forcePushWithLeaseMock.mockReset().mockResolvedValue(undefined);
    listRemoteCommitsMock.mockReset().mockResolvedValue([]);
    listCommitsMock.mockReset().mockResolvedValue({ items: [], hasMore: false, total: 0 });
    actionDispatchMock.mockReset().mockResolvedValue({ ok: true });
    openExternalMock.mockReset().mockResolvedValue(undefined);
    classifyPushErrorMock.mockReset().mockImplementation(async (_cwd: string, stderr: string) => {
      const match = /\bGH\d{3,}\b/.exec(String(stderr));
      return {
        providerId: "daintree.github.github",
        classification: match ? { code: match[0] } : null,
      };
    });
    getDecorationsMock.mockReset().mockResolvedValue({});
    onDecorationsChangedMock.mockReset().mockReturnValue(vi.fn());

    Object.defineProperty(window, "electron", {
      value: {
        git: {
          getStagingStatus: getStagingStatusMock,
          stageFile: stageFileMock,
          unstageFile: unstageFileMock,
          stageFiles: stageFilesMock,
          unstageFiles: unstageFilesMock,
          stageAll: stageAllMock,
          unstageAll: unstageAllMock,
          commit: commitMock,
          push: pushMock,
          pullRebase: pullRebaseMock,
          forcePushWithLease: forcePushWithLeaseMock,
          listRemoteCommits: listRemoteCommitsMock,
          listCommits: listCommitsMock,
          compareWorktrees: compareWorktreesMock,
          abortRepositoryOperation: abortRepositoryOperationMock,
          continueRepositoryOperation: continueRepositoryOperationMock,
          scanConflictMarkers: scanConflictMarkersMock,
          checkoutOursTheirs: checkoutOursTheirsMock,
          onPushProgress: vi.fn().mockReturnValue(vi.fn()),
        },
        system: { openInEditor: openInEditorMock },
        worktreePort: { onEvent: onUpdateMock },
        plugin: {
          // Default to no decorations; per-describe blocks can override via
          // `getDecorationsMock.mockResolvedValueOnce(...)` once a worktree
          // PR is set (the scope is empty when no PR is linked, so the
          // hook skips the IPC anyway).
          getDecorations: getDecorationsMock,
          onDecorationsChanged: onDecorationsChangedMock,
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches status once on open", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(getStagingStatusMock).toHaveBeenCalledTimes(1);
      expect(getStagingStatusMock).toHaveBeenCalledWith(WORKTREE_PATH);
    });
  });

  it("renders staged and unstaged files after initial load", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => {
      screen.getByText("index.ts");
      screen.getByText("app.ts");
    });
  });

  it("subscribes to worktree updates on open", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => expect(onUpdateMock).toHaveBeenCalledTimes(1));
    expect(capturedUpdateCallback).not.toBeNull();
  });

  it("triggers background refresh when matching worktree emits update", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState("/home/user/other-project"));
      await Promise.resolve();
    });

    expect(getStagingStatusMock).toHaveBeenCalledTimes(1);
  });

  it("preserves commit message during a background resync", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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
      <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
    );
    await waitFor(() => expect(onUpdateMock).toHaveBeenCalled());

    rerender(<ReviewHubContent isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it("cancels debounce before explicit stage actions", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("app.ts"));

    // Click the "Stage src/app.ts" button (unstaged file) — aria-label starts with "Stage"
    const stageBtn = screen.getByRole("button", { name: /^Stage src\/app\.ts/i });
    fireEvent.click(stageBtn);

    await waitFor(() => expect(debounceCancelSpy).toHaveBeenCalled());
  });

  it("manual refresh button still works independently", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(1));

    const refreshButton = screen.getByRole("button", { name: /refresh/i });
    act(() => fireEvent.click(refreshButton));

    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(2));
  });

  it("resets commit message on close then reopen", async () => {
    const { rerender } = render(
      <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
    );
    await waitFor(() => screen.getByPlaceholderText("Commit message…"));

    const textarea = screen.getByPlaceholderText("Commit message…");
    fireEvent.change(textarea, { target: { value: "draft message" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("draft message");

    rerender(<ReviewHubContent isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    rerender(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => {
      const ta = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;
      expect(ta.value).toBe("");
    });
  });

  it("background refresh error keeps existing file list visible", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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

  describe("file row chrome (issue #7783)", () => {
    it("separates stage and inspect click targets — toggling stage does not open the diff", async () => {
      // Render via ReviewHub so the row is wired into the real component.
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("app.ts"));

      // The stage toggle is `aria-label="Stage src/app.ts"`. Clicking it must
      // call the stage IPC and must NOT advance to the diff view.
      const stageBtn = screen.getByRole("button", { name: /^Stage src\/app\.ts/i });
      fireEvent.click(stageBtn);

      await waitFor(() => expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts"));

      // The inspect button has aria-label "View diff: src/app.ts". It must be
      // a separate, independently-clickable element.
      const inspectBtn = screen.getByRole("button", { name: /^View diff: src\/app\.ts/i });
      expect(inspectBtn).not.toBe(stageBtn);
      expect(inspectBtn.contains(stageBtn)).toBe(false);
      expect(stageBtn.contains(inspectBtn)).toBe(false);
    });

    it("renders +N/-M churn from staging entries", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [{ path: "src/big.ts", status: "modified", insertions: 42, deletions: 7 }],
          unstaged: [],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("big.ts"));

      const churn = screen.getByTestId("file-stage-row-churn");
      expect(churn.textContent).toContain("+42");
      expect(churn.textContent).toContain("-7");
    });

    it("omits the deletions span when the value is zero", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [{ path: "new.ts", status: "added", insertions: 10, deletions: 0 }],
          unstaged: [],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("new.ts"));

      const churn = screen.getByTestId("file-stage-row-churn");
      expect(churn.textContent).toContain("+10");
      expect(churn.textContent).not.toContain("-0");
    });

    it("hides churn entirely when both insertions and deletions are null", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [],
          unstaged: [
            { path: "untracked.ts", status: "untracked", insertions: null, deletions: null },
          ],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("untracked.ts"));

      expect(screen.queryByTestId("file-stage-row-churn")).toBeNull();
    });

    it("dims the filename text on generated/lockfile rows but keeps the stage toggle full-opacity", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [],
          unstaged: [
            { path: "package-lock.json", status: "modified", insertions: 1, deletions: 1 },
          ],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("package-lock.json"));

      const baseSpan = screen.getByTestId("file-stage-row-base");
      // Dimming applied to the base name span.
      expect(baseSpan.className).toMatch(/text-daintree-text\/40/);

      // Stage toggle stays at full opacity — no /40 dimming applied to it.
      const stageBtn = screen.getByRole("button", { name: /^Stage package-lock\.json/i });
      expect(stageBtn.className).not.toMatch(/text-daintree-text\/40/);
    });

    it("does not dim hand-written source files", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [],
          unstaged: [
            { path: "src/component.tsx", status: "modified", insertions: 3, deletions: 2 },
          ],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("component.tsx"));

      const baseSpan = screen.getByTestId("file-stage-row-base");
      expect(baseSpan.className).not.toMatch(/text-daintree-text\/40/);
    });
  });

  describe("base-branch diff mode", () => {
    it("defaults to working-tree mode showing staged and unstaged sections", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      expect(
        screen.getByRole("button", { name: /working tree/i }).getAttribute("aria-pressed")
      ).toBe("true");
      expect(screen.getByRole("button", { name: /vs main/i }).getAttribute("aria-pressed")).toBe(
        "false"
      );
    });

    it("does not call compareWorktrees on initial open", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      expect(compareWorktreesMock).not.toHaveBeenCalled();
    });

    it("calls compareWorktrees with useMergeBase when switching to base-branch mode", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("button", { name: /vs main/i });
      act(() => fireEvent.click(toggle));

      await waitFor(() => {
        screen.getByText(/no changes vs main/i);
      });
    });

    it("shows error message when compareWorktrees fails", async () => {
      compareWorktreesMock.mockRejectedValue(new Error("branch not found"));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("button", { name: /vs main/i });
      act(() => fireEvent.click(toggle));

      await waitFor(() => {
        screen.getByText("branch not found");
      });
    });

    it("does not show commit panel in base-branch mode", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const toggle = screen.getByRole("button", { name: /vs main/i });
      act(() => fireEvent.click(toggle));

      await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalled());

      expect(screen.queryByPlaceholderText("Commit message…")).toBeNull();
    });

    it("resets to working-tree mode when closed and reopened", async () => {
      const { rerender } = render(
        <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );
      await waitFor(() => screen.getByText("index.ts"));

      // Switch to base-branch mode
      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));
      await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalled());

      // Close and reopen
      rerender(<ReviewHubContent isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      rerender(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /working tree/i }).getAttribute("aria-pressed")
        ).toBe("true");
      });
    });

    it("disables vs-branch button when current branch matches main branch", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ currentBranch: "main" }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("button", { name: /vs main/i });
      expect(toggle.hasAttribute("disabled")).toBe(true);
    });

    it("does not call compareWorktrees when current branch matches main branch", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ currentBranch: "main" }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("button", { name: /vs main/i });
      fireEvent.click(toggle);

      expect(compareWorktreesMock).not.toHaveBeenCalled();
    });

    it("does not refetch base-branch diff on repeated toggle to base-branch mode", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={onClose} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));
      await act(async () => {});

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

      expect(document.activeElement).toBe(textarea);
    });

    it("Escape reads latest state through useEffectEvent", async () => {
      const onClose = vi.fn();
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={onClose} />);
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
});
