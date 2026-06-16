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

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@/hooks", () => ({
  useOverlayState: vi.fn(),
  useTruncationDetection: vi.fn(() => ({ ref: vi.fn(), isTruncated: false })),
}));

interface CapturedNavProps {
  filePath: string;
  currentFileIndex?: number;
  totalFileCount?: number;
  onNavigateFile?: (delta: -1 | 1) => void;
}

const { fileDiffModalOpenHistory, fileDiffModalLastFilePath } = vi.hoisted(() => ({
  fileDiffModalOpenHistory: { value: [] as boolean[] },
  fileDiffModalLastFilePath: { value: null as string | null },
}));
const fileDiffModalNavCapture = vi.hoisted((): { value: CapturedNavProps | null } => ({
  value: null,
}));
const baseBranchModalNavCapture = vi.hoisted((): { value: CapturedNavProps | null } => ({
  value: null,
}));
vi.mock("../../FileDiffModal", () => ({
  FileDiffModal: ({
    isOpen,
    filePath,
    currentFileIndex,
    totalFileCount,
    onNavigateFile,
  }: { isOpen: boolean } & CapturedNavProps) => {
    fileDiffModalOpenHistory.value.push(isOpen);
    if (isOpen) {
      fileDiffModalLastFilePath.value = filePath;
      fileDiffModalNavCapture.value = {
        filePath,
        currentFileIndex,
        totalFileCount,
        onNavigateFile,
      };
    }
    return null;
  },
}));
vi.mock("../BaseBranchDiffModal", () => ({
  BaseBranchDiffModal: ({
    isOpen,
    filePath,
    currentFileIndex,
    totalFileCount,
    onNavigateFile,
  }: { isOpen: boolean } & CapturedNavProps) => {
    if (isOpen) {
      baseBranchModalNavCapture.value = {
        filePath,
        currentFileIndex,
        totalFileCount,
        onNavigateFile,
      };
    }
    return null;
  },
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

import { ReviewHub } from "../ReviewHub";
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
async function confirmCheckout(side: "ours" | "theirs"): Promise<void> {
  const dialog = await screen.findByRole("alertdialog");
  const confirmBtn = within(dialog).getByRole("button", {
    name: side === "ours" ? "Take ours" : "Take theirs",
  });
  fireEvent.click(confirmBtn);
}

/**
 * `pullRebase` now gates on a `ConfirmDialog` showing the divergence preview
 * (#8242). The push-error CTA only opens the dialog; clicking its
 * `Pull and rebase` confirm button is what reaches the IPC.
 */
async function confirmPullRebase(): Promise<void> {
  const dialog = await screen.findByRole("alertdialog");
  const confirmBtn = within(dialog).getByRole("button", { name: "Pull and rebase" });
  fireEvent.click(confirmBtn);
}

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

  describe("file row chrome (issue #7783)", () => {
    it("separates stage and inspect click targets — toggling stage does not open the diff", async () => {
      // Render via ReviewHub so the row is wired into the real component.
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("component.tsx"));

      const baseSpan = screen.getByTestId("file-stage-row-base");
      expect(baseSpan.className).not.toMatch(/text-daintree-text\/40/);
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

  describe("diff modal file stepping", () => {
    const steppingStatus = () =>
      makeStatus({
        staged: [
          { path: "src/a.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/b.ts", status: "modified", insertions: 1, deletions: 0 },
        ],
        unstaged: [
          { path: "src/x.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/y.ts", status: "modified", insertions: 1, deletions: 0 },
        ],
      });

    beforeEach(() => {
      fileDiffModalNavCapture.value = null;
      baseBranchModalNavCapture.value = null;
    });

    it("passes the flat staged-then-unstaged index and steps across the section boundary", async () => {
      getStagingStatusMock.mockResolvedValue(steppingStatus());
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByTestId("file-stage-row-src/b.ts"));

      fireEvent.click(screen.getByTestId("file-stage-row-src/b.ts"));

      // First open mounts the lazy modal chunk — wait for the capture.
      await waitFor(() => {
        expect(fileDiffModalNavCapture.value).toMatchObject({
          filePath: "src/b.ts",
          currentFileIndex: 1,
          totalFileCount: 4,
        });
      });

      act(() => fileDiffModalNavCapture.value?.onNavigateFile?.(1));

      expect(fileDiffModalNavCapture.value).toMatchObject({
        filePath: "src/x.ts",
        currentFileIndex: 2,
        totalFileCount: 4,
      });

      act(() => fileDiffModalNavCapture.value?.onNavigateFile?.(-1));
      act(() => fileDiffModalNavCapture.value?.onNavigateFile?.(-1));

      expect(fileDiffModalNavCapture.value).toMatchObject({
        filePath: "src/a.ts",
        currentFileIndex: 0,
      });
    });

    it("clamps stepping at both list boundaries", async () => {
      getStagingStatusMock.mockResolvedValue(steppingStatus());
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByTestId("file-stage-row-src/a.ts"));

      fireEvent.click(screen.getByTestId("file-stage-row-src/a.ts"));
      act(() => fileDiffModalNavCapture.value?.onNavigateFile?.(-1));
      expect(fileDiffModalNavCapture.value).toMatchObject({
        filePath: "src/a.ts",
        currentFileIndex: 0,
      });

      fireEvent.click(screen.getByTestId("file-stage-row-src/y.ts"));
      act(() => fileDiffModalNavCapture.value?.onNavigateFile?.(1));
      expect(fileDiffModalNavCapture.value).toMatchObject({
        filePath: "src/y.ts",
        currentFileIndex: 3,
      });
    });

    it("clamps a stale index when the list shrinks while the modal is open", async () => {
      getStagingStatusMock.mockResolvedValue(steppingStatus());
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByTestId("file-stage-row-src/y.ts"));

      fireEvent.click(screen.getByTestId("file-stage-row-src/y.ts"));
      expect(fileDiffModalNavCapture.value).toMatchObject({
        filePath: "src/y.ts",
        currentFileIndex: 3,
      });

      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [{ path: "src/a.ts", status: "modified", insertions: 1, deletions: 0 }],
          unstaged: [{ path: "src/x.ts", status: "modified", insertions: 1, deletions: 0 }],
        })
      );
      act(() => capturedUpdateCallback?.(makeWorktreeState()));
      await waitFor(() => {
        expect(screen.queryByTestId("file-stage-row-src/y.ts")).toBeNull();
      });

      act(() => fileDiffModalNavCapture.value?.onNavigateFile?.(-1));

      expect(fileDiffModalNavCapture.value).toMatchObject({
        filePath: "src/a.ts",
        currentFileIndex: 0,
        totalFileCount: 2,
      });
    });

    it("steps through base-branch files in rendered order and clamps at the end", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [
          { status: "A", path: "src/new-file.ts" },
          { status: "M", path: "src/component.tsx" },
        ],
      });

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: /vs main/i }));
      });
      await waitFor(() => screen.getByText("component.tsx"));

      fireEvent.click(screen.getByText("component.tsx"));

      // First open mounts the lazy modal chunk — wait for the capture.
      await waitFor(() => {
        expect(baseBranchModalNavCapture.value).toMatchObject({
          filePath: "src/component.tsx",
          currentFileIndex: 0,
          totalFileCount: 2,
        });
      });

      act(() => baseBranchModalNavCapture.value?.onNavigateFile?.(1));
      expect(baseBranchModalNavCapture.value).toMatchObject({
        filePath: "src/new-file.ts",
        currentFileIndex: 1,
      });

      act(() => baseBranchModalNavCapture.value?.onNavigateFile?.(1));
      expect(baseBranchModalNavCapture.value).toMatchObject({
        filePath: "src/new-file.ts",
        currentFileIndex: 1,
      });
    });
  });

  describe("focus retention", () => {
    it("commit textarea retains focus during background resync", async () => {
      const onClose = vi.fn();
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={onClose} />);
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

  describe("focus restore on close (#9217)", () => {
    function renderWithOpener(isOpen: boolean) {
      return (
        <>
          <button type="button" data-testid="opener">
            open
          </button>
          <ReviewHub isOpen={isOpen} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
        </>
      );
    }

    it("returns focus to the element that opened the hub", async () => {
      const { rerender } = render(renderWithOpener(false));
      const opener = screen.getByTestId("opener") as HTMLButtonElement;
      act(() => opener.focus());
      expect(document.activeElement).toBe(opener);

      // Open captures the opener as the previously-focused element.
      rerender(renderWithOpener(true));
      await waitFor(() => screen.getByText("index.ts"));

      // Close restores focus to the opener.
      act(() => {
        rerender(renderWithOpener(false));
      });
      expect(document.activeElement).toBe(opener);
    });

    it("does not throw when the opener was removed before close", async () => {
      const { rerender } = render(renderWithOpener(false));
      const opener = screen.getByTestId("opener") as HTMLButtonElement;
      act(() => opener.focus());

      rerender(renderWithOpener(true));
      await waitFor(() => screen.getByText("index.ts"));

      // Drop the opener from the tree, then close — restore must guard on
      // document.contains and skip the detached node without throwing.
      act(() => {
        rerender(<ReviewHub isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      });
      expect(document.contains(opener)).toBe(false);
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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

    it("shows CI status when prCiStatus is set", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
        prCiStatus: "failure",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("failing");
        screen.getByLabelText(/ci failing/i);
      });
    });

    it("omits CI status when prCiStatus is undefined", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("#42"));
      expect(screen.queryByText("passing")).toBeNull();
      expect(screen.queryByText("failing")).toBeNull();
      expect(screen.queryByText("pending")).toBeNull();
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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: /vs main/i }));
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

    it("does not concatenate a GitHub-shaped ?file= query onto the PR URL", async () => {
      // Regression for the original bug: the badge used to open
      // `${worktreePR.prUrl}/files?file=${encodeURIComponent(file.path)}`,
      // which github.com doesn't honor.
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

      const calledWith = openExternalMock.mock.calls[0]?.[0] as string | undefined;
      expect(calledWith).toBeDefined();
      // No legacy `?file=` query
      expect(calledWith).not.toMatch(/\?file=/);
      // No `/files?file=` shape at all — the provider's URL is the source
      // of truth and may or may not contain `/files`.
      expect(calledWith).not.toMatch(/\/files\?/);
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

    it("renders the decoration.badge as the visible text", async () => {
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
      // Visible text equals the provider's badge value, not a re-parsed count
      expect(badge.textContent).toBe("3");
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

    it("renders the rebase sequence rail when rebaseSequence is populated", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          repoState: "REBASING",
          rebaseStep: 2,
          rebaseTotalSteps: 4,
          rebaseSequence: {
            backend: "merge",
            entries: [
              { action: "pick", sha: "aaa1111", subject: "first", state: "done" },
              { action: "pick", sha: "bbb2222", subject: "second", state: "current" },
              { action: "fixup", sha: "ccc3333", subject: "third", state: "pending" },
              { action: "pick", sha: "ddd4444", subject: "fourth", state: "pending" },
            ],
          },
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      const rail = await screen.findByTestId("conflict-rebase-sequence");
      expect(within(rail).getAllByTestId(/^rebase-entry-/)).toHaveLength(4);
      expect(within(rail).getByTestId("rebase-entry-current").textContent).toContain("bbb2222");
      expect(within(rail).getByTestId("rebase-entry-current").textContent).toContain("second");
    });

    it("does not render the rebase sequence rail when rebaseSequence is null (apply backend)", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          repoState: "REBASING",
          rebaseStep: 1,
          rebaseTotalSteps: 3,
          rebaseSequence: null,
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-rebase-progress"));
      expect(screen.queryByTestId("conflict-rebase-sequence")).toBeNull();
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

    it("renders user-cleared empty state when all conflicts are resolved", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflicted: [],
          conflictedFiles: [],
          staged: [{ path: "src/app.ts", status: "modified", insertions: 1, deletions: 1 }],
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const resolvedTitle = screen.getByText("All conflicts resolved");
      const resolvedEmpty = resolvedTitle.closest('[data-testid="empty-state-user-cleared"]');
      expect(resolvedEmpty).not.toBeNull();
      expect(resolvedEmpty?.getAttribute("data-scale")).toBe("sidebar");
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

    it("forwards the first-marker line to the external editor when the scan finds one", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: 2, firstMarkerLine: 17 },
      ]);

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      await waitFor(() =>
        expect(scanConflictMarkersMock).toHaveBeenCalledWith(WORKTREE_PATH, ["src/app.ts"])
      );

      const openBtn = await screen.findByRole("button", {
        name: /Open src\/app\.ts in external editor/i,
      });
      fireEvent.click(openBtn);

      await waitFor(() => {
        expect(openInEditorMock).toHaveBeenCalledWith({
          path: `${WORKTREE_PATH}/src/app.ts`,
          line: 17,
        });
      });
    });

    it("checks out ours when Take ours is clicked", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const takeOurs = screen.getByRole("button", { name: /Take ours for src\/app\.ts/i });
      fireEvent.click(takeOurs);
      await confirmCheckout("ours");

      await waitFor(() => {
        expect(checkoutOursTheirsMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts", "ours");
      });
    });

    it("checks out theirs when Take theirs is clicked", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const takeTheirs = screen.getByRole("button", { name: /Take theirs for src\/app\.ts/i });
      fireEvent.click(takeTheirs);
      await confirmCheckout("theirs");

      await waitFor(() => {
        expect(checkoutOursTheirsMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts", "theirs");
      });
    });

    it("does not call checkoutOursTheirs until the confirm dialog is accepted (#8242)", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      fireEvent.click(screen.getByRole("button", { name: /Take ours for src\/app\.ts/i }));

      // Dialog is open but unconfirmed — the IPC must not have fired.
      await screen.findByRole("alertdialog");
      expect(checkoutOursTheirsMock).not.toHaveBeenCalled();
    });

    it("renders the Abort action inside the operation chrome, not the footer", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      // The Abort control is now sized `xs` (text-[10px]); Continue is the
      // only `sm` primary in the footer region. Verify both exist and that
      // there is exactly one Continue and exactly one Abort.
      expect(screen.getAllByRole("button", { name: /^Continue /i })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: /^Abort /i })).toHaveLength(1);
    });

    it("keeps the Resolved section collapsed by default and expands on click", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          staged: [{ path: "src/done.ts", status: "modified", insertions: 1, deletions: 0 }],
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      expect(screen.queryByTestId("conflict-resolved-list")).toBeNull();

      fireEvent.click(screen.getByTestId("conflict-resolved-toggle"));
      await waitFor(() => screen.getByTestId("conflict-resolved-list"));
      screen.getByText("done.ts");
    });

    it("builds dynamic abort copy with staged count and rebase progress", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          repoState: "REBASING",
          rebaseStep: 4,
          rebaseTotalSteps: 7,
          staged: [
            { path: "a.ts", status: "modified", insertions: 1, deletions: 0 },
            { path: "b.ts", status: "modified", insertions: 1, deletions: 0 },
          ],
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByRole("button", { name: /^Abort /i }));
      fireEvent.click(screen.getByRole("button", { name: /^Abort /i }));

      const dialog = await screen.findByRole("alertdialog");
      // 2 staged + replayed = rebaseStep - 1 = 3 of 7
      expect(dialog.textContent).toMatch(/Discards 2 staged resolutions/);
      expect(dialog.textContent).toMatch(/reverts 3 of 7 replayed commits/);
    });

    it("rolls back optimistic resolution and keeps Continue disabled when mark-resolved fails", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      stageFileMock.mockRejectedValueOnce(new Error("permission denied"));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const resolveBtn = screen.getByRole("button", {
        name: /Mark src\/app\.ts as resolved/i,
      });
      fireEvent.click(resolveBtn);

      // After the rejection the row must reappear (rollback) and Continue must
      // remain disabled — the unresolved conflict is still present.
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Mark src\/app\.ts as resolved/i })).toBeTruthy();
      });
      expect(screen.getByRole("button", { name: /^Continue /i }).hasAttribute("disabled")).toBe(
        true
      );
    });

    it("rolls back optimistic resolution when Take ours fails", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      checkoutOursTheirsMock.mockRejectedValueOnce(new Error("checkout failed"));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const takeOurs = screen.getByRole("button", { name: /Take ours for src\/app\.ts/i });
      fireEvent.click(takeOurs);
      await confirmCheckout("ours");

      await waitFor(() => {
        // The row reappears after rollback — the Take ours button is still rendered.
        expect(screen.getByRole("button", { name: /Take ours for src\/app\.ts/i })).toBeTruthy();
      });
    });

    it("disables Continue while a checkout IPC call is still in flight", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflictedFiles: [
            { path: "src/app.ts", xy: "UU", label: "both modified" },
            { path: "src/other.ts", xy: "UU", label: "both modified" },
          ],
          conflicted: ["src/app.ts", "src/other.ts"],
        })
      );
      // Pending promise — the IPC call never resolves during the test.
      let resolveCheckout: (() => void) | undefined;
      checkoutOursTheirsMock.mockImplementationOnce(
        () => new Promise<void>((resolve) => (resolveCheckout = () => resolve()))
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const takeOurs = screen.getByRole("button", { name: /Take ours for src\/app\.ts/i });
      fireEvent.click(takeOurs);
      await confirmCheckout("ours");

      // After the click, the optimistic row disappears for `src/app.ts` —
      // only `src/other.ts` remains conflicted. Continue must still be
      // disabled because the checkout IPC is pending.
      await waitFor(() => {
        const continueBtn = screen.getByRole("button", { name: /^Continue /i });
        expect(continueBtn.hasAttribute("disabled")).toBe(true);
      });

      // Cleanup so the pending promise doesn't leak across tests.
      resolveCheckout?.();
    });

    it("renders a hunk-count badge once the scan resolves", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: 3, firstMarkerLine: 12 },
      ]);

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const badge = await screen.findByTestId("conflict-hunk-count-src/app.ts");
      expect(badge.textContent).toBe("3");
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

  describe("commit panel", () => {
    it("renders both Commit and Commit & Push buttons when hasRemote is true", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      expect(screen.getByRole("button", { name: /^Commit$/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /Commit & Push \(1\)/i })).toBeDefined();
    });

    it("renders single Commit button when hasRemote is false", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      expect(screen.queryByRole("button", { name: /Commit & Push/i })).toBeNull();
      expect(screen.getByRole("button", { name: /Commit \(1\)/i })).toBeDefined();
    });

    it("uses aria-disabled instead of native disabled on commit button when blocked", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ staged: [], hasRemote: false }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const btn = screen.getByRole("button", { name: /Commit \(0\)/i });
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.hasAttribute("disabled")).toBe(false);
    });

    it("uses aria-disabled on both buttons when blocked and hasRemote is true", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ staged: [], hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const commitBtn = screen.getByRole("button", { name: /^Commit$/i });
      const pushBtn = screen.getByRole("button", { name: /Commit & Push \(0\)/i });
      expect(commitBtn.getAttribute("aria-disabled")).toBe("true");
      expect(pushBtn.getAttribute("aria-disabled")).toBe("true");
    });

    it("shows tooltip content when blocked and hasRemote is false", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ staged: [], hasRemote: false }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      // The TooltipContent is mocked but the blocker list renders as ReactNode
      // Since our Tooltip mock renders children, the tooltip content reveals via DOM
      expect(screen.getByText("Cannot commit")).toBeDefined();
    });

    it("shows tooltip content when blocked and hasRemote is true", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ staged: [], hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      expect(screen.getAllByText("Cannot commit").length).toBeGreaterThan(0);
    });

    it("reentrancy guard prevents double-commit via rapid clicks", async () => {
      commitMock.mockResolvedValue({ hash: "abc", summary: "ok" });

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…");
      fireEvent.change(textarea, { target: { value: "feat: test double click" } });

      const btn = screen.getByRole("button", { name: /Commit \(1\)/i });
      fireEvent.click(btn);
      fireEvent.click(btn);

      await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    });

    it("Cmd+Enter fires primary commit when not blocked", async () => {
      commitMock.mockResolvedValue({ hash: "abc", summary: "ok" });

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…");
      fireEvent.change(textarea, { target: { value: "feat: keyboard shortcut" } });
      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

      await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    });

    it("Cmd+Shift+Enter fires commit (alternate) when hasRemote", async () => {
      commitMock.mockResolvedValue({ hash: "abc", summary: "ok" });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…");
      fireEvent.change(textarea, { target: { value: "feat: shift shortcut" } });
      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, shiftKey: true });

      await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
      expect(pushMock).not.toHaveBeenCalled();
    });
  });

  describe("push error banner", () => {
    async function triggerCommitAndPush() {
      // #8025: every remote push now opens a confirm dialog. These tests
      // target push-error handling, not the confirm UI, so pre-set the
      // per-worktree opt-out to bypass the dialog and exercise the push
      // path directly.
      usePreferencesStore.getState().setSkipPushConfirmForWorktree(WORKTREE_PATH, true);

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

    it("shows auth-failed banner with Open forge settings CTA routed to the resolved provider", async () => {
      const rawError = "fatal: Authentication failed for 'https://github.com/foo/bar.git/'";
      pushMock.mockRejectedValue(
        Object.assign(new Error(rawError), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("auth-failed");
      expect(banner.textContent).toMatch(/Push failed/i);
      expect(banner.textContent).toMatch(/credentials or SSH key/i);
      expect(banner.textContent).not.toContain(rawError);
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      expect(screen.queryByTestId("review-hub-push-error-toggle")).toBeNull();

      // The settings CTA is stamped once the forge provider resolves (async).
      const cta = await screen.findByTestId("review-hub-push-error-cta");
      expect(cta.textContent).toMatch(/Open forge settings/i);
      expect(classifyPushErrorMock).toHaveBeenCalledWith(
        WORKTREE_PATH,
        expect.stringContaining("Authentication failed")
      );
      fireEvent.click(cta);

      expect(actionDispatchMock).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "code-forge", subtab: "daintree.github.github" },
        { source: "user" }
      );
    });

    it("omits the settings CTA when push-error classification fails (no provider resolved)", async () => {
      classifyPushErrorMock.mockRejectedValue(new Error("no forge provider"));
      pushMock.mockRejectedValue(
        Object.assign(new Error("fatal: Authentication failed for 'https://example.com/'"), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("auth-failed");
      // Message still shows, but there is no provider-agnostic settings route.
      await waitFor(() => expect(classifyPushErrorMock).toHaveBeenCalled());
      expect(screen.queryByTestId("review-hub-push-error-cta")).toBeNull();
    });

    it("does not show a stale code when a retry surfaces a different error", async () => {
      // First failure is network-unavailable (has a Retry CTA) and the stderr
      // carries a GH code so the default regex mock surfaces it.
      pushMock.mockRejectedValueOnce(
        Object.assign(new Error("Could not resolve host: github.com — GH999"), {
          name: "GitOperationError",
          gitReason: "network-unavailable",
        })
      );

      await triggerCommitAndPush();
      await screen.findByTestId("review-hub-push-error");
      expect((await screen.findByTestId("review-hub-push-error-code")).textContent).toBe("GH999");

      // Retry surfaces a code-less auth failure; hold the classification
      // pending so we can observe the in-flight window.
      let releaseSecond: (v: { providerId: string; classification: null }) => void = () => {};
      classifyPushErrorMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = resolve;
          })
      );
      pushMock.mockRejectedValueOnce(
        Object.assign(new Error("fatal: Authentication failed for 'https://example.com/'"), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-cta"));
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(screen.getByTestId("review-hub-push-error").getAttribute("data-reason")).toBe(
          "auth-failed"
        )
      );
      // While the second classification is pending, the stale GH999 must be gone.
      expect(screen.queryByTestId("review-hub-push-error-code")).toBeNull();

      await act(async () => {
        releaseSecond({ providerId: "daintree.github.github", classification: null });
        await Promise.resolve();
      });
      expect(screen.queryByTestId("review-hub-push-error-code")).toBeNull();
    });

    it("shows push-rejected-outdated banner with Pull-and-rebase primary CTA only when leaseSha is missing", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected] main -> main (non-fast-forward)"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("push-rejected-outdated");
      expect(banner.textContent).toMatch(/Pull and rebase, or force push to overwrite/i);
      // Primary CTA renders even without leaseSha — it just doesn't get the
      // force-push secondary CTA (would silently degrade to plain --force).
      const primary = screen.getByTestId("review-hub-push-error-cta");
      expect(primary.textContent).toMatch(/Pull and rebase/i);
      expect(screen.queryByTestId("review-hub-push-error-secondary-cta")).toBeNull();
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      expect(screen.queryByTestId("review-hub-push-error-toggle")).toBeNull();
    });

    it("shows both Pull-and-rebase primary and Force-push secondary CTAs when leaseSha is present", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected] feature/x -> feature/x (non-fast-forward)"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
          leaseSha: "abc1234567890abc1234567890abc1234567890a",
          branchName: "feature/x",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("push-rejected-outdated");
      const primary = screen.getByTestId("review-hub-push-error-cta");
      expect(primary.textContent).toMatch(/Pull and rebase/i);
      const secondary = screen.getByTestId("review-hub-push-error-secondary-cta");
      expect(secondary.textContent).toMatch(/Force push/i);
    });

    it("Pull-and-rebase CTA invokes pullRebase, refreshes status, and clears the banner on success", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected]"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
          leaseSha: "abc123",
          branchName: "feature/x",
        })
      );

      await triggerCommitAndPush();
      await screen.findByTestId("review-hub-push-error");

      pullRebaseMock.mockResolvedValueOnce(undefined);

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-cta"));
        await Promise.resolve();
      });
      await act(async () => {
        await confirmPullRebase();
        await Promise.resolve();
      });

      await waitFor(() => expect(pullRebaseMock).toHaveBeenCalledWith(WORKTREE_PATH));
      await waitFor(() => expect(screen.queryByTestId("review-hub-push-error")).toBeNull());
      // refresh() called: once on initial load + once after commit (in
      // handleCommitAndPush) + once after pull-rebase success.
      expect(getStagingStatusMock).toHaveBeenCalledTimes(3);
    });

    it("does not call pullRebase until the confirm dialog is accepted (#8242)", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected]"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
          leaseSha: "abc123",
          branchName: "feature/x",
        })
      );

      await triggerCommitAndPush();
      await screen.findByTestId("review-hub-push-error");

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-cta"));
        await Promise.resolve();
      });

      // Dialog is open but unconfirmed — the rebase IPC must not have fired.
      await screen.findByRole("alertdialog");
      expect(pullRebaseMock).not.toHaveBeenCalled();
    });

    it("Pull-and-rebase failure surfaces conflict-unresolved through the banner", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected]"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
          leaseSha: "abc123",
          branchName: "feature/x",
        })
      );

      await triggerCommitAndPush();
      await screen.findByTestId("review-hub-push-error");

      pullRebaseMock.mockRejectedValueOnce(
        Object.assign(new Error("CONFLICT (content): Merge conflict in foo.ts"), {
          name: "GitOperationError",
          gitReason: "conflict-unresolved",
        })
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-cta"));
        await Promise.resolve();
      });
      await act(async () => {
        await confirmPullRebase();
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(screen.getByTestId("review-hub-push-error").getAttribute("data-reason")).toBe(
          "conflict-unresolved"
        )
      );
    });

    it("Force-push CTA opens the confirmation dialog with loaded remote commits and confirm calls forcePushWithLease", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected]"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
          leaseSha: "deadbeef",
          branchName: "feature/x",
        })
      );
      listRemoteCommitsMock.mockResolvedValueOnce([
        { hash: "abcd1234567", date: "2026-01-01", message: "first remote commit", author: "Bob" },
        { hash: "efgh1234567", date: "2026-01-02", message: "second remote commit", author: "Bob" },
      ]);

      await triggerCommitAndPush();
      await screen.findByTestId("review-hub-push-error");

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-secondary-cta"));
        await Promise.resolve();
      });

      // Dialog opens; commit list loads.
      await waitFor(() =>
        expect(listRemoteCommitsMock).toHaveBeenCalledWith(WORKTREE_PATH, "feature/x", 20)
      );
      await waitFor(() => screen.getByText("first remote commit"));

      const dialog = screen.getByRole("alertdialog");
      const confirmBtn = within(dialog).getByRole("button", { name: /Force push/i });

      await act(async () => {
        fireEvent.click(confirmBtn);
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(forcePushWithLeaseMock).toHaveBeenCalledWith(WORKTREE_PATH, "feature/x", "deadbeef")
      );
      await waitFor(() => expect(screen.queryByTestId("review-hub-push-error")).toBeNull());
    });

    it("Force-push CTA is suppressed when leaseSha is absent", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected]"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
          // no leaseSha
          branchName: "feature/x",
        })
      );

      await triggerCommitAndPush();
      await screen.findByTestId("review-hub-push-error");

      expect(screen.queryByTestId("review-hub-push-error-secondary-cta")).toBeNull();
    });

    it("shows push-rejected-policy banner with collapsed raw stderr and GH code", async () => {
      const rawError = "GH006: Protected branch update failed for refs/heads/main.";
      pushMock.mockRejectedValue(
        Object.assign(new Error(rawError), {
          name: "GitOperationError",
          gitReason: "push-rejected-policy",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("push-rejected-policy");
      expect(banner.textContent).toMatch(/protected branch/i);
      expect(screen.queryByTestId("review-hub-push-error-cta")).toBeNull();
      // The code is resolved async via the forge provider classification.
      expect((await screen.findByTestId("review-hub-push-error-code")).textContent).toBe("GH006");
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();

      const toggle = screen.getByTestId("review-hub-push-error-toggle");
      expect(toggle.textContent).toMatch(/Show details/i);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(toggle);
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(rawError);
      expect(toggle.textContent).toMatch(/Hide details/i);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    });

    it("shows hook-rejected banner with collapsed raw stderr", async () => {
      const rawError = "[remote rejected] main -> main (pre-receive hook declined)";
      pushMock.mockRejectedValue(
        Object.assign(new Error(rawError), {
          name: "GitOperationError",
          gitReason: "hook-rejected",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("hook-rejected");
      expect(banner.textContent).toMatch(/server-side hook rejected/i);
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      fireEvent.click(screen.getByTestId("review-hub-push-error-toggle"));
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(rawError);
    });

    it("shows network-unavailable banner with Retry button that re-pushes without re-committing", async () => {
      const rawError = "Could not resolve host: github.com";
      pushMock.mockRejectedValueOnce(
        Object.assign(new Error(rawError), {
          name: "GitOperationError",
          gitReason: "network-unavailable",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("network-unavailable");
      expect(banner.textContent).toMatch(/internet connection/i);
      expect(banner.textContent).not.toContain(rawError);
      expect(screen.queryByTestId("review-hub-push-error-toggle")).toBeNull();
      expect(commitMock).toHaveBeenCalledTimes(1);
      expect(pushMock).toHaveBeenCalledTimes(1);

      pushMock.mockResolvedValueOnce(undefined);

      const retryBtn = screen.getByTestId("review-hub-push-error-cta");
      expect(retryBtn.textContent?.trim()).toBe("Retry");
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
      // "Push failed" appears exactly once — the title prepends it, so the
      // unknown message must not repeat it.
      expect(banner.textContent?.match(/Push failed/gi) ?? []).toHaveLength(1);
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      fireEvent.click(screen.getByTestId("review-hub-push-error-toggle"));
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(
        "Could not resolve host: github.com"
      );
    });

    it("updates the banner when a retry fails with a different reason", async () => {
      pushMock.mockRejectedValueOnce(
        Object.assign(new Error("Could not resolve host: github.com"), {
          name: "GitOperationError",
          gitReason: "network-unavailable",
        })
      );

      await triggerCommitAndPush();

      await screen.findByTestId("review-hub-push-error");

      pushMock.mockRejectedValueOnce(
        Object.assign(new Error("[remote rejected] main -> main (pre-receive hook declined)"), {
          name: "GitOperationError",
          gitReason: "hook-rejected",
        })
      );

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
      pushMock.mockRejectedValue(
        Object.assign(new Error("Authentication failed"), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );

      // #8025: bypass the per-push confirm dialog for this push-error test.
      usePreferencesStore.getState().setSkipPushConfirmForWorktree(WORKTREE_PATH, true);

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

      // #8025: bypass the per-push confirm dialog for this push-error test.
      usePreferencesStore.getState().setSkipPushConfirmForWorktree(WORKTREE_PATH, true);

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

    it("falls back to generic copy + collapsed raw stderr for an unclassified failure", async () => {
      const rawError = "unexpected: something weird happened";
      pushMock.mockRejectedValue(new Error(rawError));

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("unknown");
      expect(banner.textContent).toMatch(/Push failed/i);
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      expect(screen.queryByTestId("review-hub-push-error-cta")).toBeNull();
      fireEvent.click(screen.getByTestId("review-hub-push-error-toggle"));
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(rawError);
    });

    it("shows a rate-limit message when push throws AppError(RATE_LIMITED)", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("Rate limit exceeded"), {
          name: "AppError",
          code: "RATE_LIMITED",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("unknown");
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      fireEvent.click(screen.getByTestId("review-hub-push-error-toggle"));
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toMatch(
        /Too many push attempts/i
      );
    });

    it("does not render the banner on successful push", async () => {
      pushMock.mockResolvedValue(undefined);

      await triggerCommitAndPush();

      await waitFor(() => expect(pushMock).toHaveBeenCalled());
      expect(screen.queryByTestId("review-hub-push-error")).toBeNull();
    });

    it("shows the 'Push failed' title across reasons", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("Authentication failed"), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.textContent).toMatch(/Push failed/i);
    });

    it("extracts and displays a GH code when present in the raw message", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("GH013: Repository rule violations found."), {
          name: "GitOperationError",
          gitReason: "push-rejected-policy",
        })
      );

      await triggerCommitAndPush();

      await screen.findByTestId("review-hub-push-error");
      expect((await screen.findByTestId("review-hub-push-error-code")).textContent).toBe("GH013");
      // Code stays visible without expanding the toggle.
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
    });

    it("does not render a GH code element when none is present", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("[remote rejected] main -> main (pre-receive hook declined)"), {
          name: "GitOperationError",
          gitReason: "hook-rejected",
        })
      );

      await triggerCommitAndPush();

      await screen.findByTestId("review-hub-push-error");
      expect(screen.queryByTestId("review-hub-push-error-code")).toBeNull();
    });

    it("hides raw output entirely for hide-policy reasons (no toggle)", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("fatal: Authentication failed for 'https://github.com/'"), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );

      await triggerCommitAndPush();

      await screen.findByTestId("review-hub-push-error");
      expect(screen.queryByTestId("review-hub-push-error-toggle")).toBeNull();
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
    });

    it("resets the details toggle when a retry surfaces a new push error", async () => {
      // First failure: network-unavailable has a Retry CTA but no toggle.
      pushMock.mockRejectedValueOnce(
        Object.assign(new Error("Could not resolve host: github.com"), {
          name: "GitOperationError",
          gitReason: "network-unavailable",
        })
      );

      await triggerCommitAndPush();

      await screen.findByTestId("review-hub-push-error");
      expect(screen.queryByTestId("review-hub-push-error-toggle")).toBeNull();

      // Retry rejects with a collapse-policy reason; the new banner must start collapsed
      // (i.e. the toggle state from any prior banner doesn't leak in).
      const retryError = "[remote rejected] main -> main (pre-receive hook declined)";
      pushMock.mockRejectedValueOnce(
        Object.assign(new Error(retryError), {
          name: "GitOperationError",
          gitReason: "hook-rejected",
        })
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-cta"));
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(screen.getByTestId("review-hub-push-error").getAttribute("data-reason")).toBe(
          "hook-rejected"
        )
      );
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      const toggle = screen.getByTestId("review-hub-push-error-toggle");
      expect(toggle.textContent).toMatch(/Show details/i);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(toggle);
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(retryError);
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
      repoState: "DIRTY",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });

    it("renders filter input in both section headers", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      const filters = screen.getAllByPlaceholderText("Filter…");
      expect(filters).toHaveLength(2);
    });

    it("renders view-options dropdown triggers in both section headers", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      const viewOptionBtns = screen.getAllByLabelText("View options");
      expect(viewOptionBtns).toHaveLength(2);
    });

    it("shows count chip with total file count", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("a.ts"));
      // Exact full-text match: catches misordered/duplicate/missing segments.
      const stagedChip = screen.getByTestId("staged-section-count-chip");
      expect(stagedChip.textContent).toBe("2 files·+15-3");
      const changesChip = screen.getByTestId("changes-section-count-chip");
      expect(changesChip.textContent).toBe("1 file·+3-4");
    });

    it("renders only +N when deletions are zero in the chip", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [{ path: "new.ts", status: "added", insertions: 10, deletions: 0 }],
          unstaged: [],
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("new.ts"));
      const stagedChip = screen.getByTestId("staged-section-count-chip");
      expect(stagedChip.textContent).toBe("1 file·+10");
    });

    it("omits churn suffix when all insertions/deletions are null", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      const stagedChip = screen.getByTestId("staged-section-count-chip");
      expect(stagedChip.textContent).toBe("3 files");
      const changesChip = screen.getByTestId("changes-section-count-chip");
      expect(changesChip.textContent).toBe("3 files");
    });

    it("renders base-branch files in sorted path order", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [
          { status: "M", path: "z-last.ts" },
          { status: "A", path: "a-first.ts" },
          { status: "M", path: "m-middle.ts" },
        ],
      });

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));

      await waitFor(() => screen.getByText("a-first.ts"));

      // Query the rendered filename spans in DOM order.
      const baseSpans = screen.getAllByTestId("base-branch-file-row-base");
      expect(baseSpans.map((el) => el.textContent)).toEqual([
        "a-first.ts",
        "m-middle.ts",
        "z-last.ts",
      ]);
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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));

      await waitFor(() =>
        expect(screen.getAllByTestId("base-branch-file-row-base")).toHaveLength(3)
      );

      const rows = screen.getAllByTestId("base-branch-file-row-dir");
      const bases = screen.getAllByTestId("base-branch-file-row-base");
      // Expected order: a/a.ts, a/z.ts, z/a.ts
      expect(rows.map((el) => el.textContent)).toEqual(["a/", "a/", "z/"]);
      expect(bases.map((el) => el.textContent)).toEqual(["a.ts", "z.ts", "a.ts"]);
    });

    it("splits base-branch row into dir and base spans for nested paths", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [{ status: "M", path: "src/components/button.tsx" }],
      });

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));

      await waitFor(() => screen.getByText("button.tsx"));

      const dirSpans = screen.getAllByTestId("base-branch-file-row-dir");
      expect(dirSpans).toHaveLength(1);
      expect(dirSpans[0]!.textContent).toBe("src/components/");

      const baseSpans = screen.getAllByTestId("base-branch-file-row-base");
      expect(baseSpans.map((el) => el.textContent)).toEqual(["button.tsx"]);
    });

    it("omits the dir span for root-level base-branch files", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [{ status: "M", path: "rootfile.md" }],
      });

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));

      await waitFor(() =>
        expect(screen.getAllByTestId("base-branch-file-row-base")).toHaveLength(1)
      );

      // Root-level path has no dir prefix.
      expect(screen.queryByTestId("base-branch-file-row-dir")).toBeNull();
      const baseSpans = screen.getAllByTestId("base-branch-file-row-base");
      expect(baseSpans[0]!.textContent).toBe("rootfile.md");
    });

    it("renders Stage all (N) button with correct count", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      screen.getByText("Stage all (3)");
      screen.getByText("Unstage all (3)");
    });

    it("filters files when typing in filter input", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

    it("shows Stage shown (N) when filter is active", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      fireEvent.change(filters[1]!, { target: { value: "legacy" } });

      await waitFor(() => screen.getByText("Stage shown (1)"));
    });

    it("shows filtered-empty state when no files match filter", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      fireEvent.change(filters[0]!, { target: { value: "zzz_nonexistent" } });

      await waitFor(() => screen.getByTestId("empty-state-filtered-empty"));
      screen.getByText('No staged files matching "zzz_nonexistent"');
    });

    it("shows Clear filter link in filtered-empty state", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      fireEvent.change(filters[1]!, { target: { value: "zzz" } });

      await waitFor(() => screen.getByText("Clear filter"));
    });

    it("hides generated files when showGenerated is toggled off", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        // package-lock.json should be visible by default
        screen.getByText("package-lock.json");
      });

      // Simulate toggling showGenerated off in Staged section
      // Since DropdownMenu is mocked, we directly call the onCheckedChange via
      // finding the checkbox item and clicking it
      const checkboxes = screen.getAllByRole("menuitemcheckbox");
      // First checkbox is for Staged section "Show generated files"
      fireEvent.click(checkboxes[0]!);

      await waitFor(() => {
        expect(screen.queryByText("package-lock.json")).toBeNull();
      });
    });

    it("uses stageAll IPC when no filter is active", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const stageAllBtn = screen.getByTestId("review-hub-stage-section-button");
      fireEvent.click(stageAllBtn);

      await waitFor(() => {
        expect(window.electron.git.stageAll).toHaveBeenCalledWith(WORKTREE_PATH);
      });
    });

    it("uses batched stageFiles when filter is active", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const unstageAllBtn = screen.getByTestId("review-hub-unstage-section-button");
      fireEvent.click(unstageAllBtn);

      await waitFor(() => {
        expect(window.electron.git.unstageAll).toHaveBeenCalledWith(WORKTREE_PATH);
      });
    });

    it("shows bulk button hidden when no files in section", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [{ path: "src/a.ts", status: "modified", insertions: null, deletions: null }],
          unstaged: [],
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      const allStagedTitle = await screen.findByText("All changes staged");
      const allStagedEmpty = allStagedTitle.closest('[data-testid="empty-state-user-cleared"]');
      expect(allStagedEmpty).not.toBeNull();
      expect(allStagedEmpty?.getAttribute("data-scale")).toBe("sidebar");
      // Stage all button (for Changes section) should be hidden when there are no unstaged files
      expect(screen.queryByTestId("review-hub-stage-section-button")).toBeNull();
      // Unstage all button (for Staged section) should be visible with 1 file
      screen.getByTestId("review-hub-unstage-section-button");
    });

    it("filter input uses ref for typing (no re-render on each keystroke)", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      // Just typing should not crash or cause focus loss — the debounce ref handles it
      fireEvent.change(filters[0]!, { target: { value: "src" } });

      // The input value is set via ref, not state, so it shouldn't cause thrashing
      // Verify the input has the value
      expect((filters[0]! as HTMLInputElement).value).toBe("src");
    });

    it("shows Nothing staged user-cleared empty state when section is empty but filter is not active", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [],
          unstaged: [{ path: "src/b.ts", status: "modified", insertions: null, deletions: null }],
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

  describe("commit message subject counter", () => {
    it("shows subject line length counter", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…");
      fireEvent.change(textarea, {
        target: { value: "fix: resolve bug" },
      });

      expect(screen.getByText("16/72")).toBeTruthy();
    });

    it("counter reflects subject length past the 72-char limit", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…");
      const longSubject = "x".repeat(85);
      fireEvent.change(textarea, { target: { value: longSubject } });

      expect(screen.getByText("85/72")).toBeTruthy();
    });
  });

  describe("commit history arrow-key cycling", () => {
    function renderOpen() {
      return render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    }

    function focusTextareaAt(textarea: HTMLTextAreaElement, start: number, end = start) {
      textarea.focus();
      textarea.setSelectionRange(start, end);
    }

    it("fetches and cycles through recent commits on ArrowUp from caret 0", async () => {
      listCommitsMock.mockResolvedValue({
        items: [
          {
            hash: "abc1234",
            shortHash: "abc1234",
            message: "feat: most recent commit",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-10",
          },
          {
            hash: "def5678",
            shortHash: "def5678",
            message: "fix: older commit",
            body: "Detailed body text.",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-09",
          },
        ],
        hasMore: false,
        total: 2,
      });

      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const getTextarea = () =>
        screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      // Position cursor at 0 (empty textarea)
      focusTextareaAt(getTextarea(), 0);

      fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
      expect(listCommitsMock).toHaveBeenCalledWith({
        cwd: WORKTREE_PATH,
        limit: 8,
      });

      // After fetch, the textarea should show the most recent commit message
      await waitFor(() => expect(getTextarea().value).toBe("feat: most recent commit"), {
        timeout: 3000,
      });

      // ArrowUp again → next older commit (with body)
      focusTextareaAt(getTextarea(), 0);
      fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
      await waitFor(
        () => expect(getTextarea().value).toBe("fix: older commit\n\nDetailed body text."),
        {
          timeout: 3000,
        }
      );

      // ArrowUp again → no more commits, stays at last
      focusTextareaAt(getTextarea(), 0);
      fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
      await waitFor(
        () => expect(getTextarea().value).toBe("fix: older commit\n\nDetailed body text."),
        {
          timeout: 3000,
        }
      );
    });

    it("keeps cycling history after the first recalled message even when the caret moved", async () => {
      listCommitsMock.mockResolvedValue({
        items: [
          {
            hash: "abc1234",
            shortHash: "abc1234",
            message: "feat: most recent commit",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-10",
          },
          {
            hash: "def5678",
            shortHash: "def5678",
            message: "fix: older commit",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-09",
          },
        ],
        hasMore: false,
        total: 2,
      });

      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const getTextarea = () =>
        screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      focusTextareaAt(getTextarea(), 0);
      fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
      await waitFor(() => expect(getTextarea().value).toBe("feat: most recent commit"), {
        timeout: 3000,
      });

      const textarea = getTextarea();
      focusTextareaAt(textarea, textarea.value.length);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() => expect(getTextarea().value).toBe("fix: older commit"), {
        timeout: 3000,
      });
    });

    it("ArrowDown unwinds through history and restores original draft", async () => {
      listCommitsMock.mockResolvedValue({
        items: [
          {
            hash: "abc1234",
            shortHash: "abc1234",
            message: "feat: most recent commit",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-10",
          },
        ],
        hasMore: false,
        total: 1,
      });

      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      // Type a draft first
      fireEvent.change(textarea, { target: { value: "my draft message" } });
      focusTextareaAt(textarea, 0);

      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() => expect(textarea.value).toBe("feat: most recent commit"), {
        timeout: 3000,
      });

      // ArrowDown → back to draft
      focusTextareaAt(textarea, 0);
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      await waitFor(() => expect(textarea.value).toBe("my draft message"), { timeout: 3000 });
    });

    it("does not intercept ArrowUp when caret is not at position 0", async () => {
      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: "some text" } });
      // Caret in middle of text
      focusTextareaAt(textarea, 4);

      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(listCommitsMock).not.toHaveBeenCalled();
    });

    it("resets history index when user types manually after cycling", async () => {
      listCommitsMock.mockResolvedValue({
        items: [
          {
            hash: "abc1234",
            shortHash: "abc1234",
            message: "feat: first commit",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-10",
          },
          {
            hash: "def5678",
            shortHash: "def5678",
            message: "feat: second commit",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-09",
          },
        ],
        hasMore: false,
        total: 2,
      });

      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      focusTextareaAt(textarea, 0);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() => expect(textarea.value).toBe("feat: first commit"), { timeout: 3000 });

      // Type manually — should reset history index and start fresh on next ArrowUp
      fireEvent.change(textarea, { target: { value: "typed after cycling" } });

      focusTextareaAt(textarea, 0);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      // Should show most recent again (cycling from start), not the second-oldest
      await waitFor(() => expect(textarea.value).toBe("feat: first commit"), { timeout: 3000 });

      focusTextareaAt(textarea, 0);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() => expect(textarea.value).toBe("feat: second commit"), { timeout: 3000 });
    });

    it("ArrowUp does nothing when there is no commit history", async () => {
      listCommitsMock.mockResolvedValue({ items: [], hasMore: false, total: 0 });

      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      focusTextareaAt(textarea, 0);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await act(async () => {
        await Promise.resolve();
      });

      expect(textarea.value).toBe("");
    });

    it("ArrowDown does nothing when not in history mode", async () => {
      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: "no history here" } });
      focusTextareaAt(textarea, 0);

      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      // Should remain unchanged
      expect(textarea.value).toBe("no history here");
    });

    it("does not intercept ArrowUp with modifier keys", async () => {
      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      focusTextareaAt(textarea, 0);

      fireEvent.keyDown(textarea, { key: "ArrowUp", altKey: true });
      expect(listCommitsMock).not.toHaveBeenCalled();
    });
  });

  describe("per-file Viewed checkbox", () => {
    it("renders an unchecked Viewed checkbox next to each file row", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const viewedCheckboxes = screen.getAllByRole("checkbox", { name: /Mark .* as viewed/ });
      // One per file (1 staged + 1 unstaged from makeStatus).
      expect(viewedCheckboxes).toHaveLength(2);
      for (const cb of viewedCheckboxes) {
        expect((cb as HTMLInputElement).checked).toBe(false);
      }
    });

    it("toggles a file's Viewed state when its checkbox is clicked", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const indexCheckbox = screen.getByRole("checkbox", {
        name: "Mark src/index.ts as viewed",
      }) as HTMLInputElement;
      expect(indexCheckbox.checked).toBe(false);

      fireEvent.click(indexCheckbox);

      // After being checked, the aria-label flips so we now look for the inverse.
      const stillThere = screen.getByRole("checkbox", {
        name: "Mark src/index.ts as not viewed",
      }) as HTMLInputElement;
      expect(stillThere.checked).toBe(true);
    });

    it("does not open the diff modal when the Viewed checkbox is clicked", async () => {
      fileDiffModalOpenHistory.value = [];
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const indexCheckbox = screen.getByRole("checkbox", {
        name: "Mark src/index.ts as viewed",
      });
      fileDiffModalOpenHistory.value = [];

      fireEvent.click(indexCheckbox);

      // FileDiffModal is rendered with isOpen=true only when selectedFile is set.
      // After the checkbox click, none of its renders should have isOpen=true.
      expect(fileDiffModalOpenHistory.value.some((o) => o === true)).toBe(false);
    });

    it("tracks Viewed state independently for staged and unstaged copies of the same path", async () => {
      // Partial-staging scenario: the same file is both staged and unstaged
      // (e.g. user staged some hunks, left others unstaged).
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [{ path: "src/dual.ts", status: "modified", insertions: 1, deletions: 0 }],
          unstaged: [{ path: "src/dual.ts", status: "modified", insertions: 2, deletions: 0 }],
        })
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getAllByText("dual.ts"));

      const checkboxes = screen.getAllByRole("checkbox", {
        name: "Mark src/dual.ts as viewed",
      }) as HTMLInputElement[];
      // One in the staged section, one in the unstaged section.
      expect(checkboxes).toHaveLength(2);
      const firstCheckbox = checkboxes[0]!;

      fireEvent.click(firstCheckbox);

      // Only the clicked row flips to "viewed"; the sibling row stays unchecked.
      const checkedAfter = screen.getAllByRole("checkbox", {
        name: /Mark src\/dual\.ts as (not viewed|viewed)/,
      }) as HTMLInputElement[];
      const viewedCount = checkedAfter.filter((cb) => cb.checked).length;
      expect(viewedCount).toBe(1);
    });

    it("resets Viewed state when the modal closes and reopens", async () => {
      const { rerender } = render(
        <ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );

      await waitFor(() => screen.getByText("index.ts"));

      fireEvent.click(screen.getByRole("checkbox", { name: "Mark src/index.ts as viewed" }));

      rerender(<ReviewHub isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      rerender(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const reopened = screen.getByRole("checkbox", {
        name: "Mark src/index.ts as viewed",
      }) as HTMLInputElement;
      expect(reopened.checked).toBe(false);
    });
  });

  describe("multi-select", () => {
    const makeMultiFileStatus = (): StagingStatus =>
      makeStatus({
        staged: [
          { path: "src/a.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/b.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/c.ts", status: "modified", insertions: 1, deletions: 0 },
        ],
        unstaged: [
          { path: "src/x.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/y.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/z.ts", status: "modified", insertions: 1, deletions: 0 },
        ],
      });

    const renderHub = async () => {
      getStagingStatusMock.mockResolvedValue(makeMultiFileStatus());
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByTestId("file-stage-row-src/x.ts"));
    };

    it("renders the default Stage all / Unstage all labels with no selection", async () => {
      await renderHub();
      expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
        /Stage all/i
      );
      expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
        /Unstage all/i
      );
    });

    it("cmd-click selects an unstaged row and swaps button label to 'Stage selection (1)'", async () => {
      await renderHub();
      const row = screen.getByTestId("file-stage-row-src/x.ts");
      fireEvent.click(row, { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(1\)/i
        );
      });
      expect(row.getAttribute("aria-selected")).toBe("true");
    });

    it("ctrl-click also selects (Windows/Linux modifier)", async () => {
      await renderHub();
      const row = screen.getByTestId("file-stage-row-src/x.ts");
      fireEvent.click(row, { ctrlKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(1\)/i
        );
      });
    });

    it("cmd-click again on a selected row deselects it", async () => {
      await renderHub();
      const row = screen.getByTestId("file-stage-row-src/x.ts");

      fireEvent.click(row, { metaKey: true });
      await waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));

      fireEvent.click(row, { metaKey: true });
      await waitFor(() => {
        expect(row.getAttribute("aria-selected")).toBe("false");
      });
      expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
        /Stage all/i
      );
    });

    it("shift-click extends the selection across a range", async () => {
      await renderHub();
      const x = screen.getByTestId("file-stage-row-src/x.ts");
      const z = screen.getByTestId("file-stage-row-src/z.ts");

      fireEvent.click(x, { metaKey: true });
      fireEvent.click(z, { shiftKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(3\)/i
        );
      });
      expect(screen.getByTestId("file-stage-row-src/y.ts").getAttribute("aria-selected")).toBe(
        "true"
      );
    });

    it("plain click clears an active selection (and does not toggle selection)", async () => {
      await renderHub();
      const x = screen.getByTestId("file-stage-row-src/x.ts");
      const y = screen.getByTestId("file-stage-row-src/y.ts");

      fireEvent.click(x, { metaKey: true });
      fireEvent.click(y, { metaKey: true });
      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(2\)/i
        );
      });

      fireEvent.click(screen.getByTestId("file-stage-row-src/z.ts"));

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage all/i
        );
      });
      expect(x.getAttribute("aria-selected")).toBe("false");
      expect(y.getAttribute("aria-selected")).toBe("false");
    });

    it("clicking in the other section clears the existing selection (per-section scope)", async () => {
      await renderHub();
      fireEvent.click(screen.getByTestId("file-stage-row-src/x.ts"), { metaKey: true });
      fireEvent.click(screen.getByTestId("file-stage-row-src/y.ts"), { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(2\)/i
        );
      });

      // Cmd-click in the staged section
      fireEvent.click(screen.getByTestId("file-stage-row-src/a.ts"), { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage all/i
        );
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(1\)/i
        );
      });
    });

    it("'Stage selection (N)' invokes stageFiles once with all selected paths", async () => {
      await renderHub();
      fireEvent.click(screen.getByTestId("file-stage-row-src/x.ts"), { metaKey: true });
      fireEvent.click(screen.getByTestId("file-stage-row-src/z.ts"), { shiftKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(3\)/i
        );
      });

      fireEvent.click(screen.getByTestId("review-hub-stage-section-button"));

      await waitFor(() => expect(stageFilesMock).toHaveBeenCalledTimes(1));
      expect(stageFilesMock).toHaveBeenCalledWith(WORKTREE_PATH, [
        "src/x.ts",
        "src/y.ts",
        "src/z.ts",
      ]);
      expect(stageFileMock).not.toHaveBeenCalled();
      expect(stageAllMock).not.toHaveBeenCalled();
    });

    it("'Unstage selection (N)' invokes unstageFiles once with all selected paths", async () => {
      await renderHub();
      fireEvent.click(screen.getByTestId("file-stage-row-src/a.ts"), { metaKey: true });
      fireEvent.click(screen.getByTestId("file-stage-row-src/b.ts"), { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(2\)/i
        );
      });

      fireEvent.click(screen.getByTestId("review-hub-unstage-section-button"));

      await waitFor(() => expect(unstageFilesMock).toHaveBeenCalledTimes(1));
      expect(unstageFilesMock).toHaveBeenCalledWith(WORKTREE_PATH, ["src/a.ts", "src/b.ts"]);
      expect(unstageFileMock).not.toHaveBeenCalled();
      expect(unstageAllMock).not.toHaveBeenCalled();
    });

    it("clears the selection after a successful batch stage", async () => {
      await renderHub();
      fireEvent.click(screen.getByTestId("file-stage-row-src/x.ts"), { metaKey: true });
      fireEvent.click(screen.getByTestId("file-stage-row-src/y.ts"), { metaKey: true });

      // Status will reflect the stage on refresh:
      getStagingStatusMock.mockResolvedValueOnce(
        makeStatus({
          staged: [
            { path: "src/x.ts", status: "modified", insertions: 1, deletions: 0 },
            { path: "src/y.ts", status: "modified", insertions: 1, deletions: 0 },
          ],
          unstaged: [{ path: "src/z.ts", status: "modified", insertions: 1, deletions: 0 }],
        })
      );

      fireEvent.click(screen.getByTestId("review-hub-stage-section-button"));

      await waitFor(() => expect(stageFilesMock).toHaveBeenCalled());
      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage all/i
        );
      });
    });

    it("guards against rapid double-clicks — only one IPC call is issued", async () => {
      // Hold the resolution of stageFiles so a second click can land before it completes.
      let resolveStageFiles!: () => void;
      stageFilesMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveStageFiles = resolve;
          })
      );

      await renderHub();
      fireEvent.click(screen.getByTestId("file-stage-row-src/x.ts"), { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(1\)/i
        );
      });

      const btn = screen.getByTestId("review-hub-stage-section-button");
      fireEvent.click(btn);
      fireEvent.click(btn);

      // Resolve the pending call so the test cleans up.
      resolveStageFiles();
      await waitFor(() => expect(stageFilesMock).toHaveBeenCalledTimes(1));
    });

    it("Escape clears an active selection before closing the modal", async () => {
      const onClose = vi.fn();
      getStagingStatusMock.mockResolvedValue(makeMultiFileStatus());
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={onClose} />);
      await waitFor(() => screen.getByTestId("file-stage-row-src/x.ts"));

      fireEvent.click(screen.getByTestId("file-stage-row-src/x.ts"), { metaKey: true });
      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(1\)/i
        );
      });

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage all/i
        );
      });
      expect(onClose).not.toHaveBeenCalled();

      // Second Escape with no selection closes the modal.
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("removes a staged-then-no-longer-present path from the selection after refresh", async () => {
      await renderHub();
      fireEvent.click(screen.getByTestId("file-stage-row-src/a.ts"), { metaKey: true });
      fireEvent.click(screen.getByTestId("file-stage-row-src/b.ts"), { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(2\)/i
        );
      });

      // Background refresh removes src/a.ts from the staged section.
      const updated = makeStatus({
        staged: [{ path: "src/b.ts", status: "modified", insertions: 1, deletions: 0 }],
        unstaged: [
          { path: "src/x.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/y.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/z.ts", status: "modified", insertions: 1, deletions: 0 },
        ],
      });
      getStagingStatusMock.mockResolvedValue(updated);

      await act(async () => {
        capturedUpdateCallback!(makeWorktreeState());
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.queryByTestId("file-stage-row-src/a.ts")).toBeNull();
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(1\)/i
        );
      });
    });

    it("reseats the anchor onto a surviving path when the original anchor is evicted by a refresh", async () => {
      await renderHub();
      // Anchor on src/a.ts, extend to b.ts — selection = {a, b}, anchor = a.
      fireEvent.click(screen.getByTestId("file-stage-row-src/a.ts"), { metaKey: true });
      fireEvent.click(screen.getByTestId("file-stage-row-src/b.ts"), { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(2\)/i
        );
      });

      // Background refresh drops src/a.ts (the anchor); b.ts and c.ts remain.
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [
            { path: "src/b.ts", status: "modified", insertions: 1, deletions: 0 },
            { path: "src/c.ts", status: "modified", insertions: 1, deletions: 0 },
          ],
          unstaged: [
            { path: "src/x.ts", status: "modified", insertions: 1, deletions: 0 },
            { path: "src/y.ts", status: "modified", insertions: 1, deletions: 0 },
            { path: "src/z.ts", status: "modified", insertions: 1, deletions: 0 },
          ],
        })
      );

      await act(async () => {
        capturedUpdateCallback!(makeWorktreeState());
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.queryByTestId("file-stage-row-src/a.ts")).toBeNull();
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(1\)/i
        );
      });

      // Shift-click from b (the surviving anchor) to c — selection should extend.
      fireEvent.click(screen.getByTestId("file-stage-row-src/c.ts"), { shiftKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(2\)/i
        );
      });
      expect(screen.getByTestId("file-stage-row-src/b.ts").getAttribute("aria-selected")).toBe(
        "true"
      );
      expect(screen.getByTestId("file-stage-row-src/c.ts").getAttribute("aria-selected")).toBe(
        "true"
      );
    });

    it("stage toggle button on a row does not start a selection", async () => {
      await renderHub();
      const row = screen.getByTestId("file-stage-row-src/x.ts");
      const toggle = within(row).getByRole("button", { name: /Stage src\/x\.ts/i });

      fireEvent.click(toggle);

      // No selection started; the per-row toggle still fires single-file stage.
      await waitFor(() => expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/x.ts"));
      expect(row.getAttribute("aria-selected")).toBe("false");
      expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
        /Stage all/i
      );
    });
  });

  describe("autoStageOnOpen (issue #7886)", () => {
    it("stages all unstaged files exactly once on open when no files are staged", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [],
          unstaged: [{ path: "src/a.ts", status: "modified", insertions: 1, deletions: 0 }],
        })
      );
      render(
        <ReviewHub
          isOpen={true}
          worktreePath={WORKTREE_PATH}
          onClose={vi.fn()}
          autoStageOnOpen={true}
        />
      );
      await waitFor(() => expect(stageAllMock).toHaveBeenCalledWith(WORKTREE_PATH));
      expect(stageAllMock).toHaveBeenCalledTimes(1);

      // A background-refresh tick (worktree update) must not re-trigger stageAll
      // — the one-shot guard owns that decision.
      await act(async () => {
        capturedUpdateCallback!(makeWorktreeState());
        await Promise.resolve();
      });
      expect(stageAllMock).toHaveBeenCalledTimes(1);
    });

    it("does not stage when files are already staged", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [{ path: "src/a.ts", status: "modified", insertions: 1, deletions: 0 }],
          unstaged: [{ path: "src/b.ts", status: "modified", insertions: 1, deletions: 0 }],
        })
      );
      render(
        <ReviewHub
          isOpen={true}
          worktreePath={WORKTREE_PATH}
          onClose={vi.fn()}
          autoStageOnOpen={true}
        />
      );
      await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalled());
      // Give effects a chance to settle.
      await act(async () => {
        await Promise.resolve();
      });
      expect(stageAllMock).not.toHaveBeenCalled();
    });

    it("does not stage when autoStageOnOpen is omitted", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [],
          unstaged: [{ path: "src/a.ts", status: "modified", insertions: 1, deletions: 0 }],
        })
      );
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalled());
      await act(async () => {
        await Promise.resolve();
      });
      expect(stageAllMock).not.toHaveBeenCalled();
    });
  });

  describe("initialCommitMessage (issue #7886)", () => {
    it("seeds the commit textarea on open with the provided message", async () => {
      render(
        <ReviewHub
          isOpen={true}
          worktreePath={WORKTREE_PATH}
          onClose={vi.fn()}
          initialCommitMessage="fix(scope): from AI note"
        />
      );
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));
      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;
      expect(textarea.value).toBe("fix(scope): from AI note");
    });

    it("does not overwrite user edits when the prop changes while open", async () => {
      const { rerender } = render(
        <ReviewHub
          isOpen={true}
          worktreePath={WORKTREE_PATH}
          onClose={vi.fn()}
          initialCommitMessage="from AI"
        />
      );
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));
      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "human override" } });
      rerender(
        <ReviewHub
          isOpen={true}
          worktreePath={WORKTREE_PATH}
          onClose={vi.fn()}
          initialCommitMessage="new AI note"
        />
      );
      expect(textarea.value).toBe("human override");
    });
  });

  describe("loading skeleton states (#8908)", () => {
    it("suppresses the skeleton during the sub-400ms Doherty window, then shows a shape-matched skeleton", async () => {
      // Never resolves → `loading` stays true and `status` stays null, so the
      // working-tree loading branch renders for the duration of the test.
      getStagingStatusMock.mockReturnValue(new Promise<StagingStatus>(() => {}));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      // Before the Doherty threshold elapses, nothing renders (no flash).
      expect(screen.queryByRole("status", { name: /loading review changes/i })).toBeNull();

      // After the 400ms gate, the shape-matched skeleton appears.
      await waitFor(() =>
        expect(screen.getByRole("status", { name: /loading review changes/i })).toBeTruthy()
      );
    });

    it("shows a shape-matched skeleton while the base-branch diff loads", async () => {
      // Initial working-tree status resolves; the base-branch comparison hangs.
      compareWorktreesMock.mockReturnValue(
        new Promise<{ branch1: string; branch2: string; files: never[] }>(() => {})
      );

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));

      await waitFor(() =>
        expect(screen.getByRole("status", { name: /loading changes vs main/i })).toBeTruthy()
      );
    });

    it("does not deadlock the base-branch skeleton after closing mid-load and reopening", async () => {
      // compareWorktrees never resolves, so closing while it's in flight would
      // strand baseBranchLoading=true unless the close branch resets it.
      compareWorktreesMock.mockReturnValue(
        new Promise<{ branch1: string; branch2: string; files: never[] }>(() => {})
      );

      const { rerender } = render(
        <ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );
      await waitFor(() => screen.getByText("index.ts"));

      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));
      await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalledTimes(1));

      // Close mid-load, then reopen.
      rerender(<ReviewHub isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      rerender(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      // Switching to base-branch again must trigger a fresh fetch, proving
      // baseBranchLoading was cleared on close (no stuck skeleton).
      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));
      await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalledTimes(2));
    });
  });

  describe("keyboard navigation (issue #9215)", () => {
    // jsdom doesn't implement scrollIntoView; the focus effect calls it.
    beforeEach(() => {
      HTMLElement.prototype.scrollIntoView = vi.fn();
    });

    const renderHub = async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));
      return screen.getByRole("listbox", { name: "Changed files" });
    };

    it("ArrowDown focuses the first row, then traverses across sections", async () => {
      const listbox = await renderHub();
      expect(listbox.getAttribute("aria-activedescendant")).toBeNull();

      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
      expect(listbox.getAttribute("aria-activedescendant")).toBe("review-hub-row-0");
      expect(screen.getByTestId("file-stage-row-src/index.ts").getAttribute("data-focused")).toBe(
        "true"
      );

      // Row 1 is the first unstaged file — ArrowDown crosses the section boundary.
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
      expect(listbox.getAttribute("aria-activedescendant")).toBe("review-hub-row-1");

      // Already at the last row — ArrowDown stops, no wrap.
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
      expect(listbox.getAttribute("aria-activedescendant")).toBe("review-hub-row-1");
    });

    it("ArrowUp from no focus jumps to the last row", async () => {
      const listbox = await renderHub();
      act(() => void fireEvent.keyDown(document, { key: "ArrowUp" }));
      expect(listbox.getAttribute("aria-activedescendant")).toBe("review-hub-row-1");
    });

    it("Space unstages the focused staged row and keeps focus", async () => {
      const listbox = await renderHub();
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));

      act(() => void fireEvent.keyDown(document, { key: " " }));
      await waitFor(() =>
        expect(unstageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/index.ts")
      );
      expect(stageFileMock).not.toHaveBeenCalled();
      // Focus is not cleared by toggling.
      expect(listbox.getAttribute("aria-activedescendant")).toBe("review-hub-row-0");
    });

    it("Space stages the focused unstaged row", async () => {
      const listbox = await renderHub();
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
      expect(listbox.getAttribute("aria-activedescendant")).toBe("review-hub-row-1");

      act(() => void fireEvent.keyDown(document, { key: " " }));
      await waitFor(() => expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts"));
      expect(unstageFileMock).not.toHaveBeenCalled();
    });

    it("Enter opens the diff for the focused row", async () => {
      await renderHub();
      // Focus row 1 (the unstaged file) so a wrong-file bug would be caught.
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));

      fileDiffModalOpenHistory.value.length = 0;
      fileDiffModalLastFilePath.value = null;
      act(() => void fireEvent.keyDown(document, { key: "Enter" }));
      await waitFor(() => expect(fileDiffModalOpenHistory.value.at(-1)).toBe(true));
      expect(fileDiffModalLastFilePath.value).toBe("src/app.ts");
    });

    it("'v' toggles the Viewed marker for the focused row", async () => {
      await renderHub();
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));

      expect(screen.getByLabelText("Mark src/index.ts as viewed")).toBeTruthy();
      act(() => void fireEvent.keyDown(document, { key: "v" }));
      await waitFor(() =>
        expect(screen.getByLabelText("Mark src/index.ts as not viewed")).toBeTruthy()
      );
    });

    it("ignores navigation keys while a filter input is focused", async () => {
      const listbox = await renderHub();
      const filterInput = screen.getAllByPlaceholderText("Filter…")[0]!;
      filterInput.focus();

      act(() => void fireEvent.keyDown(filterInput, { key: "ArrowDown" }));
      expect(listbox.getAttribute("aria-activedescendant")).toBeNull();
    });

    it("does nothing when the file list is collapsed", async () => {
      // The disclosure defaults to collapsed; rows (and the listbox) aren't
      // rendered, so keys must not mutate the index or fire git side effects.
      useUIStore.getState().setReviewHubFileListExpanded(WORKTREE_PATH, false);
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(1));
      await act(async () => {});

      expect(screen.queryByRole("listbox", { name: "Changed files" })).toBeNull();
      fileDiffModalOpenHistory.value.length = 0;
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
      act(() => void fireEvent.keyDown(document, { key: " " }));
      act(() => void fireEvent.keyDown(document, { key: "Enter" }));
      expect(stageFileMock).not.toHaveBeenCalled();
      expect(unstageFileMock).not.toHaveBeenCalled();
      expect(fileDiffModalOpenHistory.value.some((o) => o === true)).toBe(false);
    });

    it("does not hijack Space when a toolbar button has focus", async () => {
      await renderHub();
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));

      // With a row keyboard-focused, Space on the Refresh button must NOT
      // unstage the row — the button owns its own activation.
      const refreshButton = screen.getByRole("button", { name: /refresh/i });
      act(() => void fireEvent.keyDown(refreshButton, { key: " " }));
      expect(unstageFileMock).not.toHaveBeenCalled();
    });

    it("clears keyboard focus when the hub closes", async () => {
      const { rerender } = render(
        <ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );
      await waitFor(() => screen.getByText("index.ts"));

      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
      expect(
        screen.getByRole("listbox", { name: "Changed files" }).getAttribute("aria-activedescendant")
      ).toBe("review-hub-row-0");

      rerender(<ReviewHub isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      rerender(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      expect(
        screen.getByRole("listbox", { name: "Changed files" }).getAttribute("aria-activedescendant")
      ).toBeNull();
    });
  });
});
