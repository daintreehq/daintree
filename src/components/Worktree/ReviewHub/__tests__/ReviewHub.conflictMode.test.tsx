/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
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

describe("ReviewHub", () => {
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
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
    onUpdateMock.mockImplementation(() => {
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
});
