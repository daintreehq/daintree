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
  getChecksMock,
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
  getChecksMock: vi.fn().mockResolvedValue({ checks: [] }),
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
  forgeClient: { classifyPushError: classifyPushErrorMock, getChecks: getChecksMock },
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
import { resetStagingStatusCacheForTests } from "../stagingStatusCache";

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
  let capturedTickCallback: ((path: string) => void) | null = null;
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
    capturedUpdateCallback = null;
    capturedTickCallback = null;
    debounceCancelSpy.mockReset();

    // Clear the file-list disclosure map rather than force-expanding it: the
    // disclosure now defaults to expanded, so an unset entry is what production
    // renders, and clearing also stops a test that collapses it from leaking
    // into the next one.
    useUIStore.setState({ reviewHubFileListExpanded: {} });

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
    onUpdateMock.mockImplementation((type: string, callback: (data: unknown) => void) => {
      // The component subscribes to the per-view worktree port; tests keep
      // driving it with a plain WorktreeState by wrapping it in the port
      // event envelope here.
      if (type === "worktree-update") {
        capturedUpdateCallback = (state: WorktreeState) => callback({ worktree: state });
      } else if (type === "worktree-tick") {
        capturedTickCallback = (path: string) => callback({ tick: { worktreeId: path, path } });
      }
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

  it("triggers background refresh on a stamp-only tick for the matching worktree only", async () => {
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      capturedTickCallback!("/home/user/other-project");
      await Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(getStagingStatusMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      capturedTickCallback!(WORKTREE_PATH);
      await Promise.resolve();
    });
    // The refresh is debounced 800 ms, close to waitFor's default window.
    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(2), {
      timeout: 3000,
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
    await waitFor(() => screen.getByLabelText("Commit message"));

    const textarea = screen.getByLabelText("Commit message");
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

  it("resets commit message on close then reopen", async () => {
    const { rerender } = render(
      <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
    );
    await waitFor(() => screen.getByLabelText("Commit message"));

    const textarea = screen.getByLabelText("Commit message");
    fireEvent.change(textarea, { target: { value: "draft message" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("draft message");

    rerender(<ReviewHubContent isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    rerender(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => {
      const ta = screen.getByLabelText("Commit message") as HTMLTextAreaElement;
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
      // The base name steps down the ink hierarchy rather than to primary.
      expect(baseSpan.className).toMatch(/text-text-secondary/);
      expect(baseSpan.className).not.toMatch(/text-text-primary/);

      // Stage toggle stays at full strength — no dimming applied to it.
      const stageBtn = screen.getByRole("button", { name: /^Stage package-lock\.json/i });
      expect(stageBtn.className).not.toMatch(/opacity-60/);
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
      expect(baseSpan.className).toMatch(/text-text-primary/);
    });
  });

  describe("base-branch diff mode", () => {
    it("does not call compareWorktrees on initial open", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      expect(compareWorktreesMock).not.toHaveBeenCalled();
    });

    it("calls compareWorktrees with useMergeBase when switching to base-branch mode", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("radio", { name: /vs main/i });
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

      const toggle = screen.getByRole("radio", { name: /vs main/i });
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

      const toggle = screen.getByRole("radio", { name: /vs main/i });
      act(() => fireEvent.click(toggle));

      await waitFor(() => {
        screen.getByText(/no changes vs main/i);
      });
    });

    it("shows error message when compareWorktrees fails", async () => {
      compareWorktreesMock.mockRejectedValue(new Error("branch not found"));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("radio", { name: /vs main/i });
      act(() => fireEvent.click(toggle));

      await waitFor(() => {
        screen.getByText("branch not found");
      });
    });

    it("does not show commit panel in base-branch mode", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByLabelText("Commit message"));

      const toggle = screen.getByRole("radio", { name: /vs main/i });
      act(() => fireEvent.click(toggle));

      await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalled());

      expect(screen.queryByLabelText("Commit message")).toBeNull();
    });

    it("leaves the file-list keys alone while the base-branch comparison is showing", async () => {
      HTMLElement.prototype.scrollIntoView = vi.fn();
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => {
        fireEvent.click(screen.getByRole("radio", { name: /vs main/i }));
      });
      await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalled());

      for (const key of ["End", "ArrowDown", " "]) {
        let notConsumed = false;
        act(() => {
          notConsumed = fireEvent.keyDown(document, { key });
        });
        expect(notConsumed).toBe(true);
      }
      await act(async () => {});
      expect(stageFileMock).not.toHaveBeenCalled();
      expect(unstageFileMock).not.toHaveBeenCalled();
    });

    it("resets to working-tree mode when closed and reopened", async () => {
      const { rerender } = render(
        <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );
      await waitFor(() => screen.getByText("index.ts"));

      // Switch to base-branch mode
      act(() => fireEvent.click(screen.getByRole("radio", { name: /vs main/i })));
      await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalled());

      // Close and reopen
      rerender(<ReviewHubContent isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      rerender(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(
          screen.getByRole("radio", { name: /working tree/i }).getAttribute("aria-checked")
        ).toBe("true");
      });
    });

    it("disables the vs-branch segment when current branch matches main branch", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ currentBranch: "main" }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      const toggle = screen.getByRole("radio", { name: /vs main/i });
      expect(toggle.hasAttribute("disabled")).toBe(true);
    });

    it("does not refetch base-branch diff on repeated toggle to base-branch mode", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      // First toggle
      act(() => fireEvent.click(screen.getByRole("radio", { name: /vs main/i })));
      await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalledTimes(1));

      // Toggle back to working-tree
      act(() => fireEvent.click(screen.getByRole("radio", { name: /working tree/i })));

      // Toggle again to base-branch — should NOT re-fetch since files are cached
      act(() => fireEvent.click(screen.getByRole("radio", { name: /vs main/i })));

      // Still only 1 call
      expect(compareWorktreesMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("focus retention", () => {
    it("commit textarea retains focus during background resync", async () => {
      const onClose = vi.fn();
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={onClose} />);
      await waitFor(() => screen.getByLabelText("Commit message"));
      await act(async () => {});

      const textarea = screen.getByLabelText("Commit message") as HTMLTextAreaElement;
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

  describe("section toolbar", () => {
    const multiFileStatus = (): StagingStatus => ({
      staged: [
        { path: "src/index.ts", status: "modified", insertions: null, deletions: null },
        { path: "src/utils.ts", status: "added", insertions: null, deletions: null },
        { path: "package-lock.json", status: "modified", insertions: null, deletions: null },
      ],
      unstaged: [
        { path: "src/app.ts", status: "modified", insertions: null, deletions: null },
        { path: "src/legacy.ts", status: "deleted", insertions: null, deletions: null },
        { path: "docs/readme.md", status: "untracked", insertions: null, deletions: null },
      ],
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
    });

    it("renders view-options dropdown triggers in both section headers", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      const viewOptionBtns = screen.getAllByLabelText("View options");
      expect(viewOptionBtns).toHaveLength(2);
    });

    it("shows count chip with total file count", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      // Verify the section headers show "Staged" and "Changes" labels with counts
      screen.getByText("Staged");
      screen.getByText("Changes");
      // Pluralized count appears in the chip ("3 files" — both sections have 3 entries).
      expect(screen.getAllByText("3 files").length).toBe(2);
      // Both sections have 3 files each, and the bulk buttons also show counts
      screen.getByText("Stage all (3)");
      screen.getByText("Unstage all (3)");
    });

    it("includes aggregate +X -Y churn in section header chips when available", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [
            { path: "src/a.ts", status: "modified", insertions: 5, deletions: 2 },
            { path: "src/b.ts", status: "modified", insertions: 10, deletions: 1 },
          ],
          unstaged: [{ path: "src/c.ts", status: "modified", insertions: 3, deletions: 4 }],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("a.ts"));
      // Exact full-text match: catches misordered/duplicate/missing segments.
      const stagedChip = screen.getByTestId("staged-section-count-chip");
      expect(stagedChip.textContent).toBe("2 files");
      expect(screen.getByTestId("staged-section-churn").textContent).toBe("+15-3");
      const changesChip = screen.getByTestId("changes-section-count-chip");
      expect(changesChip.textContent).toBe("1 file");
      expect(screen.getByTestId("unstaged-section-churn").textContent).toBe("+3-4");
    });

    it("renders only +N when deletions are zero in the chip", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [{ path: "new.ts", status: "added", insertions: 10, deletions: 0 }],
          unstaged: [],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("new.ts"));
      const stagedChip = screen.getByTestId("staged-section-count-chip");
      expect(stagedChip.textContent).toBe("1 file");
      expect(screen.getByTestId("staged-section-churn").textContent).toBe("+10");
    });

    it("sorts base-branch files by directory prefix then filename", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [
          { status: "M", path: "z/a.ts" },
          { status: "A", path: "a/z.ts" },
          { status: "M", path: "a/a.ts" },
        ],
      });

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => fireEvent.click(screen.getByRole("radio", { name: /vs main/i })));

      await waitFor(() =>
        expect(screen.getAllByTestId("base-branch-file-row-base")).toHaveLength(3)
      );

      const rows = screen.getAllByTestId("base-branch-file-row-dir");
      const bases = screen.getAllByTestId("base-branch-file-row-base");
      // Expected order: a/a.ts, a/z.ts, z/a.ts
      expect(rows.map((el) => el.textContent)).toEqual(["a/", "a/", "z/"]);
      expect(bases.map((el) => el.textContent)).toEqual(["a.ts", "z.ts", "a.ts"]);
    });

    it("omits the dir span for root-level base-branch files", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [{ status: "M", path: "rootfile.md" }],
      });

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => fireEvent.click(screen.getByRole("radio", { name: /vs main/i })));

      await waitFor(() =>
        expect(screen.getAllByTestId("base-branch-file-row-base")).toHaveLength(1)
      );

      // Root-level path has no dir prefix.
      expect(screen.queryByTestId("base-branch-file-row-dir")).toBeNull();
      const baseSpans = screen.getAllByTestId("base-branch-file-row-base");
      expect(baseSpans[0]!.textContent).toBe("rootfile.md");
    });

    it("filters files when typing in filter input", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      // Type in the Changes filter to find only legacy.ts
      fireEvent.change(filters[1]!, { target: { value: "legacy" } });

      await waitFor(() => {
        expect(screen.queryByText("app.ts")).toBeNull();
        expect(screen.queryByText("readme.md")).toBeNull();
        screen.getByText("legacy.ts");
      });
    });

    it("shows filtered-empty state when no files match filter", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      fireEvent.change(filters[0]!, { target: { value: "zzz_nonexistent" } });

      await waitFor(() => screen.getByTestId("empty-state-filtered-empty"));
      screen.getByText('No staged files matching "zzz_nonexistent"');
    });

    it("shows Clear filter link in filtered-empty state", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      fireEvent.change(filters[1]!, { target: { value: "zzz" } });

      await waitFor(() => screen.getByText("Clear filter"));
    });

    it("uses batched stageFiles when filter is active", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      fireEvent.change(filters[1]!, { target: { value: "legacy" } });

      await waitFor(() => screen.getByText("Stage shown (1)"));

      const stageBtn = screen.getByTestId("review-hub-stage-section-button");
      fireEvent.click(stageBtn);

      await waitFor(() => {
        expect(stageFilesMock).toHaveBeenCalledWith(WORKTREE_PATH, ["src/legacy.ts"]);
        expect(window.electron.git.stageAll).not.toHaveBeenCalled();
      });
    });

    it("uses unstageAll IPC when no filter is active", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const unstageAllBtn = screen.getByTestId("review-hub-unstage-section-button");
      fireEvent.click(unstageAllBtn);

      await waitFor(() => {
        expect(window.electron.git.unstageAll).toHaveBeenCalledWith(WORKTREE_PATH);
      });
    });

    /**
     * A fixture whose Changes section contains a generated file, so hiding
     * generated output actually narrows that section.
     */
    const generatedInChangesStatus = (): StagingStatus =>
      makeStatus({
        staged: [{ path: "src/index.ts", status: "modified", insertions: null, deletions: null }],
        unstaged: [
          { path: "src/app.ts", status: "modified", insertions: null, deletions: null },
          { path: "dist/bundle.js", status: "modified", insertions: null, deletions: null },
        ],
      });

    /**
     * The invariant behind #11984's worst defect: the word in the bulk label and
     * the IPC the same button dispatches are two readings of one decision, and
     * they must never disagree. Previously the label branched on the filter
     * query alone while the handler also branched on generated visibility, so
     * hiding generated files produced "Stage all (N)" over a stage-shown call.
     *
     * Asserted as an equivalence rather than a fixed pair, so it keeps holding
     * when new ways to narrow a section are added.
     */
    it("bulk label's scope word agrees with the IPC the button dispatches", async () => {
      const narrowings: { name: string; narrow: () => void }[] = [
        {
          name: "no narrowing at all",
          narrow: () => {},
        },
        {
          name: "an active filter query",
          narrow: () => {
            const filters = screen.getAllByPlaceholderText("Filter…");
            fireEvent.change(filters[1]!, { target: { value: "app" } });
          },
        },
        {
          name: "generated files hidden",
          narrow: () => {
            // [0] is Staged's toggle, [1] is Changes'.
            const checkboxes = screen.getAllByRole("menuitemcheckbox");
            fireEvent.click(checkboxes[1]!);
          },
        },
      ];

      for (const { name, narrow } of narrowings) {
        stageFilesMock.mockClear();
        stageAllMock.mockClear();
        getStagingStatusMock.mockResolvedValue(generatedInChangesStatus());

        const { unmount } = render(
          <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
        );
        await waitFor(() => screen.getByText("app.ts"));

        narrow();

        const button = await screen.findByTestId("review-hub-stage-section-button");
        const claimsWholeSection = /\ball\b/.test(button.textContent ?? "");
        fireEvent.click(button);

        await waitFor(() => {
          expect(stageAllMock.mock.calls.length + stageFilesMock.mock.calls.length).toBe(1);
        });

        // The equivalence. `stageAll` acts on the section; `stageFiles` acts on
        // an explicit path list. Saying "all" and calling the second is the bug.
        expect(
          stageAllMock.mock.calls.length === 1,
          `with ${name}, label was "${button.textContent ?? ""}"`
        ).toBe(claimsWholeSection);

        unmount();
      }
    });

    it("keeps reporting the section's full population when rows are hidden", async () => {
      const status = generatedInChangesStatus();
      getStagingStatusMock.mockResolvedValue(status);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("app.ts"));

      const total = status.unstaged.length;
      const chip = screen.getByTestId("changes-section-count-chip");
      expect(chip.textContent).toContain(`${total} files`);
      // Nothing hidden yet, so nothing to disclose.
      expect(screen.queryByTestId("unstaged-section-shown-chip")).toBeNull();

      const checkboxes = screen.getAllByRole("menuitemcheckbox");
      fireEvent.click(checkboxes[1]!);

      await waitFor(() => {
        expect(screen.queryByText("bundle.js")).toBeNull();
      });

      // The headline count must NOT have followed the visible rows down.
      expect(screen.getByTestId("changes-section-count-chip").textContent).toContain(
        `${total} files`
      );
      const shown = screen.getByTestId("unstaged-section-shown-chip");
      expect(shown.textContent).toBe(`${total - 1} shown`);
    });

    it("offers a recovery that can actually reveal the matches when a query only matches hidden generated files", async () => {
      getStagingStatusMock.mockResolvedValue(generatedInChangesStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("app.ts"));

      const checkboxes = screen.getAllByRole("menuitemcheckbox");
      fireEvent.click(checkboxes[1]!);

      const filters = screen.getAllByPlaceholderText("Filter…");
      fireEvent.change(filters[1]!, { target: { value: "dist" } });

      // "dist/bundle.js" matches the query and exists; it is hidden as
      // generated. Blaming the filter here names the wrong cause and offers a
      // recovery that cannot bring it back.
      const reveal = await screen.findByRole("button", { name: "Show generated files" });
      expect(reveal).toBeTruthy();
      expect(screen.queryByText("Clear filter")).toBeNull();

      fireEvent.click(reveal);
      await waitFor(() => screen.getByText("bundle.js"));
    });

    it("shows bulk button hidden when no files in section", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [{ path: "src/a.ts", status: "modified", insertions: null, deletions: null }],
          unstaged: [],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      const allStagedTitle = await screen.findByText("All changes staged");
      const allStagedEmpty = allStagedTitle.closest('[data-testid="empty-state-user-cleared"]');
      expect(allStagedEmpty).not.toBeNull();
      expect(allStagedEmpty?.getAttribute("data-scale")).toBe("sidebar");
      // Stage all button (for Changes section) should be hidden when there are no unstaged files
      expect(screen.queryByTestId("review-hub-stage-section-button")).toBeNull();
      // Unstage all button (for Staged section) should be visible with 1 file
      screen.getByTestId("review-hub-unstage-section-button");
    });

    it("shows Nothing staged user-cleared empty state when section is empty but filter is not active", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [],
          unstaged: [{ path: "src/b.ts", status: "modified", insertions: null, deletions: null }],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("Nothing staged");
        screen.getByText("b.ts");
      });
      const nothingStagedTitle = screen.getByText("Nothing staged");
      const nothingStagedEmpty = nothingStagedTitle.closest(
        '[data-testid="empty-state-user-cleared"]'
      );
      expect(nothingStagedEmpty).not.toBeNull();
      expect(nothingStagedEmpty?.getAttribute("data-scale")).toBe("sidebar");
    });

    it("renders files sorted by path ascending by default", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [
            { path: "ccc.ts", status: "added", insertions: null, deletions: null },
            { path: "aaa.ts", status: "modified", insertions: null, deletions: null },
            { path: "bbb.ts", status: "deleted", insertions: null, deletions: null },
          ],
          unstaged: [],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("aaa.ts"));

      // Path asc sort: aaa.ts DOM position < bbb.ts < ccc.ts
      const rows = screen.getAllByText(/\.ts$/).filter((el) => el.tagName === "SPAN");
      const texts = rows.map((el) => el.textContent);
      const aaaIdx = texts.indexOf("aaa.ts");
      const bbbIdx = texts.indexOf("bbb.ts");
      const cccIdx = texts.indexOf("ccc.ts");
      expect(aaaIdx).toBeLessThan(bbbIdx);
      expect(bbbIdx).toBeLessThan(cccIdx);
    });

    it("detects lock files as generated", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [
            { path: "package-lock.json", status: "modified", insertions: null, deletions: null },
            { path: "yarn.lock", status: "modified", insertions: null, deletions: null },
            { path: "src/app.ts", status: "modified", insertions: null, deletions: null },
          ],
          unstaged: [],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("package-lock.json");
        screen.getByText("yarn.lock");
        screen.getByText("app.ts");
      });

      // Toggle showGenerated off in Staged section
      const checkboxes = screen.getAllByRole("menuitemcheckbox");
      fireEvent.click(checkboxes[0]!);

      await waitFor(() => {
        expect(screen.queryByText("package-lock.json")).toBeNull();
        expect(screen.queryByText("yarn.lock")).toBeNull();
        screen.getByText("app.ts");
      });
    });
  });

  describe("PR state indicator", () => {
    function setWorktreePR(prData: {
      prNumber: number;
      prUrl: string;
      prState: "open" | "merged" | "closed";
      prCiStatus?: "success" | "failure" | "pending";
    }) {
      const existing = worktreeStoreData.current.get("main-wt")!;
      const mappedState =
        prData.prState === "closed"
          ? ("closed" as const)
          : prData.prState === "merged"
            ? ("merged" as const)
            : ("open" as const);
      const ciState =
        prData.prCiStatus === "success"
          ? ("success" as const)
          : prData.prCiStatus === "failure"
            ? ("failure" as const)
            : prData.prCiStatus === "pending"
              ? ("pending" as const)
              : undefined;
      worktreeStoreData.current.set("main-wt", {
        ...existing,
        ...prData,
        linked: {
          providerId: "github",
          pr: {
            ref: {
              providerId: "github",
              owner: "test",
              repo: "test",
              number: prData.prNumber,
              rawData: {},
            },
            state: mappedState,
            url: prData.prUrl,
            ...(ciState
              ? {
                  ciStatus: {
                    state: ciState,
                    total: 0,
                    passed: 0,
                    failed: 0,
                    pending: 0,
                    rawData: null,
                  },
                }
              : {}),
          },
        },
      });
    }

    it("shows PR badge with number and state when worktree has a PR", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByRole("button", { name: /view pull request #42/i });
        screen.getByText("#42");
        screen.getByText("open");
      });
    });

    it("opens PR in browser when external-link button is clicked", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByRole("button", { name: /view pull request #42/i }));

      // Clicking the pill text does not open the PR
      fireEvent.click(screen.getByText("#42"));
      expect(openExternalMock).not.toHaveBeenCalled();

      // Clicking the external-link button opens the PR via the generic
      // system opener (no GitHub-specific IPC).
      fireEvent.click(screen.getByRole("button", { name: /view pull request #42/i }));
      expect(openExternalMock).toHaveBeenCalledWith("https://github.com/test/repo/pull/42");
    });

    it("shows 'No PR' when branch has remote but no PR", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("#99");
        screen.getByText("merged");
      });
    });

    it("shows CI status when prCiStatus is set", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
        prCiStatus: "failure",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("failing");
        screen.getByLabelText(/ci failing/i);
      });
    });

    it("renders an in-flight run as a dot with its label on a text channel", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
        prCiStatus: "pending",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      const { container } = render(
        <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );

      const label = await waitFor(() => screen.getByText("pending"));
      // The mark is a painted disc carrying the forced-colors rescue hook…
      const dot = container.querySelector(".status-mark");
      expect(dot).toBeTruthy();
      expect(dot?.className).toContain("bg-status-warning");
      // …and the words beside it stay on a neutral text token: status colours
      // only promise the 3:1 non-text floor, so the colour rides on the mark.
      expect(label.className).toContain("text-text-secondary");
      expect(label.className).not.toMatch(/\bbg-status-/);
    });

    it("omits CI status when prCiStatus is undefined", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("#42"));
      expect(screen.queryByText("passing")).toBeNull();
      expect(screen.queryByText("failing")).toBeNull();
      expect(screen.queryByText("pending")).toBeNull();
    });

    // #12417: the per-check read is reachable from the GUI, not only over MCP.
    // The hub owns one thing here — handing its own worktree path down to the
    // chip — so that is what this layer proves; the disclosure's own states are
    // covered in `PrChecksPopover.test.tsx`.
    it("reads the checks for the hub's own worktree when the chip is opened", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
        prCiStatus: "failure",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("#42"));
      expect(getChecksMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("#42"));
      await waitFor(() => expect(getChecksMock).toHaveBeenCalledWith(WORKTREE_PATH, 42));
      // Opening the disclosure is not a hand-off to the browser.
      expect(openExternalMock).not.toHaveBeenCalled();
    });

    // The hub's Escape listener is on the document in the capture phase and
    // stops propagation, so without the disclosure claiming Escape first it
    // would close the whole hub instead of the thing the user is looking at.
    it("gives Escape to the open checks disclosure, then back to the hub", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
        prCiStatus: "failure",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));
      getChecksMock.mockResolvedValue({
        checks: [{ name: "build", status: "completed", conclusion: "failure" }],
      });
      const onClose = vi.fn();

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={onClose} />);
      await waitFor(() => screen.getByText("#42"));

      fireEvent.click(screen.getByText("#42"));
      const list = await screen.findByTestId("pr-checks-list");
      expect(list.textContent).toContain("build");

      // First Escape dismisses the disclosure and leaves the hub standing.
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("pr-checks-list")).toBeNull());
      expect(onClose).not.toHaveBeenCalled();

      // Second one reaches the hub as normal.
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("drops a previous PR's checks when the chip switches PRs", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));
      getChecksMock.mockResolvedValue({
        checks: [{ name: "pr-42-check", status: "completed", conclusion: "failure" }],
      });

      const { rerender } = render(
        <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );
      await waitFor(() => screen.getByText("#42"));
      fireEvent.click(screen.getByText("#42"));
      await screen.findByText("pr-42-check");

      // The linked PR changes underneath an open disclosure. Its snapshot must
      // not survive to be read — or sent to an agent — under the new number.
      setWorktreePR({
        prNumber: 77,
        prUrl: "https://github.com/test/repo/pull/77",
        prState: "open",
      });
      rerender(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("#77"));
      expect(screen.queryByText("pr-42-check")).toBeNull();
    });
  });

  // Issue #9953: the review-thread badge on a base-branch file row must
  // open a provider-authored deep-link (decoration.url), not a hardcoded
  // GitHub-shaped `${prUrl}/files?file=...` URL the renderer used to
  // concatenate. The aria-label must be the provider-authored tooltip,
  // not a count re-derived via `Number.parseInt(decoration.badge)`.
  describe("review-thread badge deep-link (#9953)", () => {
    const deepLinkA =
      "https://github.com/test/repo/pull/42/files#diff-deadbeefcafebabe0000000000000000000000000000000000000000000000";

    function setWorktreePRWithLink() {
      const existing = worktreeStoreData.current.get("main-wt")!;
      worktreeStoreData.current.set("main-wt", {
        ...existing,
        linked: {
          providerId: "github",
          pr: {
            ref: {
              providerId: "github",
              owner: "test",
              repo: "test",
              number: 42,
              rawData: {},
            },
            state: "open",
            url: "https://github.com/test/repo/pull/42",
          },
        },
      });
    }

    beforeEach(() => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [
          { status: "M", path: "src/component.tsx", insertions: 3, deletions: 1 },
          { status: "A", path: "src/new-file.ts", insertions: 7, deletions: 0 },
        ],
      });
    });

    async function switchToBaseBranchWithPR() {
      setWorktreePRWithLink();
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => {
        fireEvent.click(screen.getByRole("radio", { name: /vs main/i }));
      });
      await waitFor(() => screen.getByText("component.tsx"));
    }

    it("opens the provider-authored deep-link when the badge is clicked", async () => {
      getDecorationsMock.mockResolvedValueOnce({
        "src/component.tsx": {
          badge: "3",
          tooltip: "3 unresolved review comments",
          color: "text-status-warning",
          url: deepLinkA,
        },
      });

      await switchToBaseBranchWithPR();

      const badge = await screen.findByRole("button", {
        name: /3 unresolved review comments/i,
      });
      fireEvent.click(badge);

      expect(openExternalMock).toHaveBeenCalledWith(deepLinkA);
    });

    it("uses decoration.tooltip verbatim as the aria-label (no Number.parseInt re-derivation)", async () => {
      getDecorationsMock.mockResolvedValueOnce({
        "src/component.tsx": {
          badge: "3",
          // Provider-authored semantic text, including the
          // "(partial count)" annotation. The host must NOT re-derive
          // a count-based label like "3 unresolved review comments on
          // src/component.tsx".
          tooltip: "3 unresolved review comments (partial count)",
          color: "text-status-warning",
          url: deepLinkA,
        },
      });

      await switchToBaseBranchWithPR();

      // The exact provider text is the accessible label.
      expect(
        await screen.findByRole("button", {
          name: "3 unresolved review comments (partial count)",
        })
      ).toBeDefined();
      // The count re-derivation label must NOT appear.
      expect(
        screen.queryByRole("button", {
          name: /3 unresolved review comments on src\/component\.tsx/i,
        })
      ).toBeNull();
    });

    it("renders the badge but disables click when decoration.url is absent", async () => {
      // The provider shipped the badge + tooltip + color but the deep-link
      // capability is missing (e.g. a future non-GitHub provider that
      // hasn't implemented `buildPRFileUrl` yet). The badge stays visible
      // as an indicator; the click target is disabled so a tooltip-only
      // row doesn't 404.
      getDecorationsMock.mockResolvedValueOnce({
        "src/component.tsx": {
          badge: "3",
          tooltip: "3 unresolved review comments",
          color: "text-status-warning",
        },
      });

      await switchToBaseBranchWithPR();

      const badge = await screen.findByRole("button", {
        name: /3 unresolved review comments/i,
      });
      expect(badge.hasAttribute("disabled")).toBe(true);

      fireEvent.click(badge);
      // Click must NOT route through the legacy prUrl-shape fallback
      // (the old code did `${prUrl}/files?file=...` host-side).
      expect(openExternalMock).not.toHaveBeenCalled();
    });

    it("falls back to a host-side label when the provider omits tooltip", async () => {
      // The host keeps a narrow fallback label for any provider that
      // forgets `tooltip` — the badge is still informative, just less
      // semantic. This documents the carve-out so a future PR that
      // removes the fallback knows the contract.
      getDecorationsMock.mockResolvedValueOnce({
        "src/component.tsx": {
          badge: "3",
          color: "text-status-warning",
          url: deepLinkA,
        },
      });

      await switchToBaseBranchWithPR();

      // `findByRole` polls until the badge appears (the decoration
      // resolves through an async IPC round-trip, so a single
      // `getByRole` after `switchToBaseBranchWithPR` can race the
      // state update under load).
      const badge = await screen.findByRole("button", {
        name: /Unresolved review comments on/i,
      });
      expect(badge.textContent).toBe("3");
      // Click still routes through the deep-link.
      fireEvent.click(badge);
      expect(openExternalMock).toHaveBeenCalledWith(deepLinkA);
    });
  });
});

afterEach(() => {
  resetStagingStatusCacheForTests();
});
