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

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@/hooks", () => ({
  useOverlayState: vi.fn(),
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

import { ReviewHub } from "../ReviewHub";
import { useUIStore } from "@/store/uiStore";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
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

/**
 * `pullRebase` now gates on a `ConfirmDialog` showing the divergence preview
 * (#8242). The push-error CTA only opens the dialog; clicking its
 * `Pull and rebase` confirm button is what reaches the IPC.
 */

const openPanelDialogMock = vi.hoisted(() =>
  vi.fn<(options: Record<string, unknown>) => Promise<string>>(async () => "diff-panel-1")
);
vi.mock("@/store/panelDialogStore", () => ({
  usePanelDialogStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ panelId: null }),
    { getState: () => ({ openPanelDialog: openPanelDialogMock, closePanelDialog: vi.fn() }) }
  ),
}));

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

      openPanelDialogMock.mockClear();
      act(() => void fireEvent.keyDown(document, { key: "Enter" }));
      await waitFor(() => expect(openPanelDialogMock).toHaveBeenCalled());
      expect(openPanelDialogMock.mock.calls[0]?.[0]).toMatchObject({
        kind: "diff",
        filePath: "src/app.ts",
      });
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
      openPanelDialogMock.mockClear();
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
      act(() => void fireEvent.keyDown(document, { key: " " }));
      act(() => void fireEvent.keyDown(document, { key: "Enter" }));
      expect(stageFileMock).not.toHaveBeenCalled();
      expect(unstageFileMock).not.toHaveBeenCalled();
      expect(openPanelDialogMock).not.toHaveBeenCalled();
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

  describe("readiness rail", () => {
    function setWorktreeDivergence(overrides: Record<string, unknown>) {
      const existing = worktreeStoreData.current.get("main-wt")!;
      worktreeStoreData.current.set("main-wt", { ...existing, ...overrides });
    }

    it("stays hidden until staging status resolves", async () => {
      getStagingStatusMock.mockReturnValue(new Promise(() => {}));
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await act(async () => {});
      expect(screen.queryByTestId("review-readiness-rail")).toBeNull();
    });

    it("reports Ready for the default fixture and surfaces the no-remote info", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByTestId("review-readiness-rail"));
      expect(screen.getByTestId("review-readiness-level").dataset.level).toBe("ready");
      expect(screen.getByTestId("readiness-item-no-remote")).toBeDefined();
    });

    it("flags conflicts as blocked and expands the file list from the CTA", async () => {
      useUIStore.getState().setReviewHubFileListExpanded(WORKTREE_PATH, false);
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [],
          conflicted: ["src/broken.ts"],
          conflictedFiles: [{ path: "src/broken.ts", xy: "UU", label: "both modified" }],
        })
      );
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByTestId("review-readiness-rail"));

      expect(screen.getByTestId("review-readiness-level").dataset.level).toBe("blocked");
      expect(screen.getByTestId("readiness-item-conflicts")).toBeDefined();

      act(() => void fireEvent.click(screen.getByTestId("readiness-cta-conflicts")));
      expect(useUIStore.getState().reviewHubFileListExpanded[WORKTREE_PATH]).toBe(true);
    });

    it("offers pull-and-rebase behind the existing confirm dialog when behind the remote", async () => {
      setWorktreeDivergence({ behindCount: 2, aheadCount: 1 });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByTestId("readiness-item-behind-remote"));

      expect(screen.getByTestId("review-readiness-level").dataset.level).toBe("needs-review");
      act(() => void fireEvent.click(screen.getByTestId("readiness-cta-behind-remote")));

      // D2 stays intact: the CTA only opens the confirm dialog, never the IPC.
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toBeDefined();
      expect(pullRebaseMock).not.toHaveBeenCalled();
    });

    it("surfaces failing PR CI with a click-through to the forge", async () => {
      setWorktreeDivergence({
        linked: {
          providerId: "github",
          pr: {
            ref: { providerId: "github", owner: "t", repo: "t", number: 42, rawData: {} },
            state: "open",
            url: "https://github.com/test/repo/pull/42",
            ciStatus: {
              state: "failure",
              total: 1,
              passed: 0,
              failed: 1,
              pending: 0,
              rawData: null,
            },
          },
        },
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByTestId("readiness-item-ci-failing"));

      act(() => void fireEvent.click(screen.getByTestId("readiness-cta-ci-failing")));
      expect(openExternalMock).toHaveBeenCalledWith("https://github.com/test/repo/pull/42");
    });

    it("hides the rail while switching worktrees so readiness never mixes two worktrees", async () => {
      const { rerender } = render(
        <ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );
      await waitFor(() => screen.getByTestId("review-readiness-rail"));

      // The next worktree's staging status never resolves — the previous
      // worktree's summary must not linger against the new path's selectors.
      getStagingStatusMock.mockReturnValue(new Promise(() => {}));
      rerender(<ReviewHub isOpen={true} worktreePath="/home/user/other" onClose={vi.fn()} />);
      await act(async () => {});
      expect(screen.queryByTestId("review-readiness-rail")).toBeNull();
    });

    it("updates readiness from a worktree port refresh without losing filter state", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));
      expect(screen.queryByTestId("readiness-item-conflicts")).toBeNull();

      const stagedFilter = screen.getAllByPlaceholderText("Filter…")[0]!;
      fireEvent.change(stagedFilter, { target: { value: "index" } });

      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          conflicted: ["src/broken.ts"],
          conflictedFiles: [{ path: "src/broken.ts", xy: "UU", label: "both modified" }],
        })
      );
      await act(async () => {
        capturedUpdateCallback!(makeWorktreeState());
        await Promise.resolve();
      });

      await waitFor(() => screen.getByTestId("readiness-item-conflicts"));
      expect((stagedFilter as HTMLInputElement).value).toBe("index");
    });
  });

  describe("clean-tree push affordance", () => {
    afterEach(() => {
      // The real (unmocked) confirm store is shared suite-wide — resolve any
      // request a failing test left pending so it can't bleed forward.
      useGitPushConfirmStore.getState().resolveConfirmation(false);
    });

    function setWorktreeDivergence(overrides: Record<string, unknown>) {
      const existing = worktreeStoreData.current.get("main-wt")!;
      worktreeStoreData.current.set("main-wt", { ...existing, ...overrides });
    }

    function renderCleanHub(divergence: Record<string, unknown>, hasRemote = true) {
      setWorktreeDivergence(divergence);
      getStagingStatusMock.mockResolvedValue(
        makeStatus({ staged: [], unstaged: [], hasRemote, repoState: "CLEAN" })
      );
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    }

    it("names the unpushed commits and gates Push behind the D2 preview dialog", async () => {
      renderCleanHub({ aheadCount: 2, behindCount: 0 });
      await waitFor(() => screen.getByText("Working tree clean"));

      expect(screen.getByTestId("review-hub-clean-unpushed").textContent).toBe(
        "2 commits not pushed"
      );

      act(() => void fireEvent.click(screen.getByTestId("review-hub-clean-push")));
      // The click only requests the push confirmation — nothing reaches the
      // IPC until the globally-mounted preview dialog resolves it.
      expect(pushMock).not.toHaveBeenCalled();
      expect(useGitPushConfirmStore.getState().pendingConfirm?.cwd).toBe(WORKTREE_PATH);

      await act(async () => {
        useGitPushConfirmStore.getState().resolveConfirmation(true);
      });
      await waitFor(() => expect(pushMock).toHaveBeenCalledWith(WORKTREE_PATH));
    });

    it("does not push when the preview dialog is declined", async () => {
      renderCleanHub({ aheadCount: 1, behindCount: 0 });
      await waitFor(() => screen.getByText("Working tree clean"));

      act(() => void fireEvent.click(screen.getByTestId("review-hub-clean-push")));
      await act(async () => {
        useGitPushConfirmStore.getState().resolveConfirmation(false);
      });
      expect(pushMock).not.toHaveBeenCalled();
    });

    it("names the unpushed commits but offers no Push while divergence is unknown", async () => {
      // behindCount undefined — an unknown divergence state must never read
      // as pushable (mirrors deriveReviewReadiness.pushReady).
      renderCleanHub({ aheadCount: 3, behindCount: undefined });
      await waitFor(() => screen.getByText("Working tree clean"));

      expect(screen.getByTestId("review-hub-clean-unpushed").textContent).toBe(
        "3 commits not pushed"
      );
      expect(screen.queryByTestId("review-hub-clean-push")).toBeNull();
    });

    it("offers no Push while behind the remote", async () => {
      renderCleanHub({ aheadCount: 2, behindCount: 1 });
      await waitFor(() => screen.getByText("Working tree clean"));
      // The unpushed copy proves the divergence fixture reached the component
      // — without it the missing button would pass vacuously.
      expect(screen.getByTestId("review-hub-clean-unpushed").textContent).toBe(
        "2 commits not pushed"
      );
      expect(screen.queryByTestId("review-hub-clean-push")).toBeNull();
    });

    it("keeps the quiet no-changes copy when there is nothing to push", async () => {
      renderCleanHub({ aheadCount: 0, behindCount: 0 });
      await waitFor(() => screen.getByText("Working tree clean"));

      expect(screen.getByText("No changes to commit")).toBeDefined();
      expect(screen.queryByTestId("review-hub-clean-unpushed")).toBeNull();
      expect(screen.queryByTestId("review-hub-clean-push")).toBeNull();
    });

    it("keeps the quiet copy when unpushed commits exist but there is no remote", async () => {
      renderCleanHub({ aheadCount: 2, behindCount: 0 }, false);
      await waitFor(() => screen.getByText("Working tree clean"));

      expect(screen.getByText("No changes to commit")).toBeDefined();
      expect(screen.queryByTestId("review-hub-clean-push")).toBeNull();
    });
  });
});
