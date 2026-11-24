/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { StagingStatus } from "@shared/types";
import type { ConflictMarkerScanEntry } from "@shared/types/ipc/git";
import type { WorktreeState, Project } from "@shared/types";
import { useProjectStore } from "@/store/projectStore";

const REVIEW_PROJECT_ID = "proj-review-1";

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
  openSendToAgentPaletteWithTextMock,
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
  openSendToAgentPaletteWithTextMock: vi.fn<(content: { text: string }) => boolean>(),
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

vi.mock("@/hooks/useSendToAgentPalette", () => ({
  openSendToAgentPaletteWithText: openSendToAgentPaletteWithTextMock,
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
  DropdownMenuItem: ({
    children,
    onSelect,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    destructive?: boolean;
    "aria-label"?: string;
  }) => (
    <div role="menuitem" tabIndex={-1} aria-label={ariaLabel} onClick={() => onSelect?.()}>
      {children}
    </div>
  ),
  DropdownMenuMeta: ({ children }: { children: ReactNode }) => <span>{children}</span>,
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
import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";
import {
  beginStagingStatusRead,
  rememberStagingStatus,
  resetStagingStatusCacheForTests,
} from "../stagingStatusCache";

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
  repoOperationId: null,
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
    name: side === "ours" ? "Use current branch" : "Use incoming changes",
  });
  fireEvent.click(confirmBtn);
}

describe("ReviewHub", () => {
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
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
    onUpdateMock.mockImplementation(() => {
      return mockUnsubscribe;
    });

    compareWorktreesMock.mockResolvedValue({ branch1: "main", branch2: "feature/test", files: [] });

    abortRepositoryOperationMock.mockReset().mockResolvedValue(undefined);
    continueRepositoryOperationMock.mockReset().mockResolvedValue(undefined);
    // Mirrors the handler's contract: one entry per requested path.
    scanConflictMarkersMock
      .mockReset()
      .mockImplementation(async (_cwd: string, paths: string[]) =>
        paths.map((path) => ({ path, hunkCount: 0, hasMarkers: false, firstMarkerLine: null }))
      );
    checkoutOursTheirsMock.mockReset().mockResolvedValue(undefined);
    openInEditorMock.mockReset().mockResolvedValue(undefined);
    // Deliberately unlike the fixture worktree id — a worktree id is not a
    // project id, and only the project id loads the preferred-editor setting.
    const project: Project = {
      id: REVIEW_PROJECT_ID,
      name: "review",
      path: "/repo",
      emoji: "🌳",
      lastOpened: 0,
    };
    useProjectStore.setState({ currentProject: project });
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
        repoOperationId: "merge-a",
        ...overrides,
      });
    const MERGE_A = { operation: "MERGING", operationId: "merge-a" } as const;

    it("renders the conflict panel instead of staging sections when merging", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      screen.getByText(/Resolve Merge Conflicts/i);
      expect(screen.queryByText(/^Staged$/i)).toBeNull();
      expect(screen.queryByLabelText("Commit message")).toBeNull();
    });

    it("shows rebase step progress in the banner", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          repoState: "REBASING",
          rebaseStep: 3,
          rebaseTotalSteps: 8,
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-rebase-progress"));
      expect(screen.queryByTestId("conflict-rebase-sequence")).toBeNull();
    });

    it("renders user-cleared empty state when all conflicts are resolved", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflicted: [],
          conflictedFiles: [],
          staged: [{ path: "src/app.ts", status: "modified", insertions: 1, deletions: 1 }],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const resolvedTitle = screen.getByText("All conflicts resolved");
      const resolvedEmpty = resolvedTitle.closest('[data-testid="empty-state-user-cleared"]');
      expect(resolvedEmpty).not.toBeNull();
      expect(resolvedEmpty?.getAttribute("data-scale")).toBe("sidebar");
    });

    it("stages a file when Mark resolved is clicked", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const openBtn = screen.getByRole("button", {
        name: /Open src\/app\.ts in external editor/i,
      });
      fireEvent.click(openBtn);

      await waitFor(() => {
        expect(openInEditorMock).toHaveBeenCalledWith({
          path: `${WORKTREE_PATH}/src/app.ts`,
          projectId: REVIEW_PROJECT_ID,
        });
      });
    });

    it("forwards the first-marker line to the external editor when the scan finds one", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: 2, hasMarkers: true, firstMarkerLine: 17 },
      ]);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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
          projectId: REVIEW_PROJECT_ID,
        });
      });
    });

    describe("editor target spelling", () => {
      afterEach(() => {
        _resetHostPlatformForTests();
      });

      it("keeps a literal backslash in a POSIX file name instead of opening the nested path", async () => {
        setHostPlatformInfo({ platform: "linux" });
        // Both exist on a POSIX host: a file whose name holds a backslash, and
        // an unrelated `b.txt` inside a folder `a`.
        getStagingStatusMock.mockResolvedValue(
          makeMergingStatus({
            conflicted: ["a\\b.txt"],
            conflictedFiles: [{ path: "a\\b.txt", xy: "UU", label: "both modified" }],
            unstaged: [{ path: "a/b.txt", status: "modified", insertions: 1, deletions: 0 }],
          })
        );
        scanConflictMarkersMock.mockResolvedValue([
          { path: "a\\b.txt", hunkCount: 1, firstMarkerLine: 9 },
        ]);

        render(
          <ReviewHubContent isOpen={true} worktreePath={`${WORKTREE_PATH}/`} onClose={vi.fn()} />
        );

        // The marker line reaches the row with the scan, which the badge shows.
        await screen.findByTestId("conflict-hunk-count-a\\b.txt");
        fireEvent.click(screen.getByRole("button", { name: "Open a\\b.txt in external editor" }));

        await waitFor(() => {
          expect(openInEditorMock).toHaveBeenCalledWith({
            path: `${WORKTREE_PATH}/a\\b.txt`,
            line: 9,
            projectId: REVIEW_PROJECT_ID,
          });
        });
      });

      it("joins a Windows worktree with forward slashes and keeps the marker line", async () => {
        setHostPlatformInfo({ platform: "win32" });
        getStagingStatusMock.mockResolvedValue(makeMergingStatus());
        scanConflictMarkersMock.mockResolvedValue([
          { path: "src/app.ts", hunkCount: 1, firstMarkerLine: 4 },
        ]);

        render(
          <ReviewHubContent
            isOpen={true}
            worktreePath={"C:\\Users\\dev\\project\\"}
            onClose={vi.fn()}
          />
        );

        await screen.findByTestId("conflict-hunk-count-src/app.ts");
        fireEvent.click(
          screen.getByRole("button", { name: /Open src\/app\.ts in external editor/i })
        );

        await waitFor(() => {
          expect(openInEditorMock).toHaveBeenCalledWith({
            path: "C:/Users/dev/project/src/app.ts",
            line: 4,
            projectId: REVIEW_PROJECT_ID,
          });
        });
      });
    });

    it("checks out ours when Take ours is clicked", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const takeOurs = screen.getByRole("menuitem", { name: /for src\/app\.ts \(ours\)/i });
      fireEvent.click(takeOurs);
      await confirmCheckout("ours");

      await waitFor(() => {
        expect(checkoutOursTheirsMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts", {
          resolution: "checkout",
          side: "ours",
        });
      });
    });

    it("checks out theirs when Take theirs is clicked", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const takeTheirs = screen.getByRole("menuitem", { name: /for src\/app\.ts \(theirs\)/i });
      fireEvent.click(takeTheirs);
      await confirmCheckout("theirs");

      await waitFor(() => {
        expect(checkoutOursTheirsMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts", {
          resolution: "checkout",
          side: "theirs",
        });
      });
    });

    it("does not call checkoutOursTheirs until the confirm dialog is accepted (#8242)", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      fireEvent.click(screen.getByRole("menuitem", { name: /for src\/app\.ts \(ours\)/i }));

      // Dialog is open but unconfirmed — the IPC must not have fired.
      await screen.findByRole("alertdialog");
      expect(checkoutOursTheirsMock).not.toHaveBeenCalled();
    });

    describe("a modify/delete conflict offers the deleted side as a deletion", () => {
      it.each([
        {
          case: "merge, incoming deleted",
          repoState: "MERGING" as const,
          entry: { xy: "UD", label: "deleted by them" },
          kind: "deleted by them",
          deleted: { side: "theirs", source: "incoming changes" },
          kept: { side: "ours", source: "current branch" },
        },
        {
          case: "merge, current branch deleted",
          repoState: "MERGING" as const,
          entry: { xy: "DU", label: "deleted by us" },
          kind: "deleted by us",
          deleted: { side: "ours", source: "current branch" },
          kept: { side: "theirs", source: "incoming changes" },
        },
        {
          case: "rebase, incoming commit deleted",
          repoState: "REBASING" as const,
          entry: { xy: "UD", label: "deleted by them" },
          kind: "deleted by incoming commit",
          deleted: { side: "theirs", source: "incoming commit" },
          kept: { side: "ours", source: "destination branch" },
        },
        {
          case: "rebase, destination deleted",
          repoState: "REBASING" as const,
          entry: { xy: "DU", label: "deleted by us" },
          kind: "deleted by destination",
          deleted: { side: "ours", source: "destination branch" },
          kept: { side: "theirs", source: "incoming commit" },
        },
        {
          case: "merge, added on the current branch only",
          repoState: "MERGING" as const,
          entry: { xy: "AU", label: "added by us" },
          kind: "added by us",
          deleted: { side: "theirs", source: "incoming changes" },
          kept: { side: "ours", source: "current branch" },
        },
        {
          case: "merge, added by the incoming changes only",
          repoState: "MERGING" as const,
          entry: { xy: "UA", label: "added by them" },
          kind: "added by them",
          deleted: { side: "ours", source: "current branch" },
          kept: { side: "theirs", source: "incoming changes" },
        },
      ])("$case", async ({ repoState, entry, kind, deleted, kept }) => {
        getStagingStatusMock.mockResolvedValue(
          makeMergingStatus({ repoState, conflictedFiles: [{ path: "src/app.ts", ...entry }] })
        );
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        const list = await screen.findByRole("list", { name: "Conflicted files" });
        expect(list.textContent).toContain(kind);

        const keep = screen.getByRole("menuitem", {
          name: `Use ${kept.source} for src/app.ts (${kept.side})`,
        });
        expect(keep.textContent).toBe(`Use ${kept.source}${kept.side}`);
        const remove = screen.getByRole("menuitem", {
          name: `Delete file to match ${deleted.source} for src/app.ts (${deleted.side})`,
        });
        expect(remove.textContent).toBe(`Delete file to match ${deleted.source}${deleted.side}`);

        fireEvent.click(remove);
        const dialog = await screen.findByRole("alertdialog", { name: "Delete 'app.ts'?" });
        expect(dialog.textContent).toContain(
          `Deletes src/app.ts from the worktree to match the ${deleted.source}. The ${kept.source} version and any manual conflict edits in this file are discarded.`
        );
        expect(checkoutOursTheirsMock).not.toHaveBeenCalled();
        fireEvent.click(within(dialog).getByRole("button", { name: "Delete file" }));

        await waitFor(() => {
          expect(checkoutOursTheirsMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts", {
            resolution: "delete",
            side: deleted.side,
          });
        });
      });

      it("keeps the side that still has the file as a checkout", async () => {
        getStagingStatusMock.mockResolvedValue(
          makeMergingStatus({
            conflictedFiles: [{ path: "src/app.ts", xy: "UD", label: "deleted by them" }],
          })
        );
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        await waitFor(() => screen.getByTestId("conflict-panel"));
        fireEvent.click(screen.getByRole("menuitem", { name: /for src\/app\.ts \(ours\)/i }));
        const dialog = await screen.findByRole("alertdialog", {
          name: "Use current branch for 'app.ts'?",
        });
        expect(dialog.textContent).toContain(
          "Overwrites src/app.ts with the current branch version"
        );
        await confirmCheckout("ours");

        await waitFor(() => {
          expect(checkoutOursTheirsMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts", {
            resolution: "checkout",
            side: "ours",
          });
        });
      });

      it("cancelling a deletion leaves the row and runs nothing", async () => {
        getStagingStatusMock.mockResolvedValue(
          makeMergingStatus({
            conflictedFiles: [{ path: "src/app.ts", xy: "UD", label: "deleted by them" }],
          })
        );
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        await waitFor(() => screen.getByTestId("conflict-panel"));
        fireEvent.click(screen.getByRole("menuitem", { name: /^Delete file to match/ }));
        const dialog = await screen.findByRole("alertdialog", { name: "Delete 'app.ts'?" });
        fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        expect(screen.getByRole("menuitem", { name: /^Delete file to match/ })).toBeTruthy();
        expect(checkoutOursTheirsMock).not.toHaveBeenCalled();
      });

      it("offers one deletion when neither side has the file", async () => {
        getStagingStatusMock.mockResolvedValue(
          makeMergingStatus({
            conflictedFiles: [{ path: "src/app.ts", xy: "DD", label: "both deleted" }],
          })
        );
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        await waitFor(() => screen.getByTestId("conflict-panel"));
        const items = within(screen.getByRole("list", { name: "Conflicted files" })).getAllByRole(
          "menuitem"
        );
        expect(items.map((item) => item.textContent)).toEqual(["Delete file"]);
        expect(items[0]!.getAttribute("aria-label")).toBe("Delete file src/app.ts");

        fireEvent.click(items[0]!);
        const dialog = await screen.findByRole("alertdialog", { name: "Delete 'app.ts'?" });
        expect(dialog.textContent).toContain("since neither side has it");
        fireEvent.click(within(dialog).getByRole("button", { name: "Delete file" }));

        await waitFor(() => {
          expect(checkoutOursTheirsMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts", {
            resolution: "delete",
            side: "both",
          });
        });
      });

      it("names the failed deletion and reads the conflict again", async () => {
        getStagingStatusMock.mockResolvedValue(
          makeMergingStatus({
            conflictedFiles: [{ path: "src/app.ts", xy: "UD", label: "deleted by them" }],
          })
        );
        checkoutOursTheirsMock.mockRejectedValueOnce(
          new Error("The conflict in src/app.ts has changed since it was listed.")
        );
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        await waitFor(() => screen.getByTestId("conflict-panel"));
        fireEvent.click(screen.getByRole("menuitem", { name: /^Delete file to match/ }));
        const dialog = await screen.findByRole("alertdialog");
        // Meanwhile the conflict turned around: the current branch side is now
        // the one without the file.
        getStagingStatusMock.mockResolvedValue(
          makeMergingStatus({
            conflictedFiles: [{ path: "src/app.ts", xy: "DU", label: "deleted by us" }],
          })
        );
        fireEvent.click(within(dialog).getByRole("button", { name: "Delete file" }));

        expect(await screen.findByText("Couldn't delete file")).toBeTruthy();
        expect(
          await screen.findByRole("menuitem", {
            name: "Delete file to match current branch for src/app.ts (ours)",
          })
        ).toBeTruthy();
      });
    });

    it("names a cleanly merged path as staged, then splits it from the resolution once the conflict is resolved", async () => {
      const clean = {
        path: "src/clean.ts",
        status: "modified" as const,
        insertions: 1,
        deletions: 0,
      };
      const resolved = {
        path: "src/app.ts",
        status: "modified" as const,
        insertions: 4,
        deletions: 2,
      };
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({ staged: [clean], resolveUndoPaths: [] })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      // Before: git staged the clean path itself, and nothing has been resolved.
      expect(screen.queryByTestId("conflict-resolved-toggle")).toBeNull();
      const before = screen.getByTestId("conflict-staged-toggle");
      expect(before.textContent).toContain("Staged changes");
      expect(before.textContent).not.toContain("Resolved");
      expect(within(before).getByText("1")).toBeTruthy();
      expect(screen.getByTestId("conflict-staged-list").querySelectorAll("li")).toHaveLength(1);

      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflicted: [],
          conflictedFiles: [],
          staged: [clean, resolved],
          resolveUndoPaths: ["src/app.ts"],
        })
      );
      fireEvent.click(screen.getByRole("button", { name: /Mark src\/app\.ts as resolved/i }));

      // After: the resolution counts alone, and the clean path keeps its own count.
      await waitFor(() => screen.getByTestId("conflict-resolved-toggle"));
      const resolvedToggle = screen.getByTestId("conflict-resolved-toggle");
      const resolvedList = screen.getByTestId("conflict-resolved-list");
      expect(resolvedToggle.textContent).toContain("Resolved");
      expect(within(resolvedToggle).getByText("1")).toBeTruthy();
      expect(resolvedList.textContent).toContain("app.ts");
      expect(resolvedList.textContent).not.toContain("clean.ts");

      const otherToggle = screen.getByTestId("conflict-staged-toggle");
      const otherList = screen.getByTestId("conflict-staged-list");
      expect(otherToggle.textContent).toContain("Other staged changes");
      expect(within(otherToggle).getByText("1")).toBeTruthy();
      expect(otherList.textContent).toContain("clean.ts");
      expect(otherList.textContent).not.toContain("app.ts");
    });

    it("names every staged path as staged when the status carries no resolution record", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflicted: [],
          conflictedFiles: [],
          staged: [
            { path: "src/a.ts", status: "modified", insertions: 1, deletions: 0 },
            { path: "src/b.ts", status: "modified", insertions: 1, deletions: 0 },
          ],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      expect(screen.queryByTestId("conflict-resolved-toggle")).toBeNull();
      const toggle = screen.getByTestId("conflict-staged-toggle");
      expect(toggle.textContent).toContain("Staged changes");
      expect(within(toggle).getByText("2")).toBeTruthy();
    });

    it("ignores a recorded resolution that is no longer staged", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflicted: [],
          conflictedFiles: [],
          staged: [{ path: "src/clean.ts", status: "modified", insertions: 1, deletions: 0 }],
          resolveUndoPaths: ["src/reset.ts"],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      expect(screen.queryByTestId("conflict-resolved-toggle")).toBeNull();
      expect(screen.getByTestId("conflict-staged-list").textContent).not.toContain("reset.ts");
      expect(screen.getByTestId("conflict-staged-toggle").textContent).toContain("Staged changes");
    });

    it("keeps each staged disclosure's open state separate", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflicted: [],
          conflictedFiles: [],
          staged: [
            { path: "src/clean.ts", status: "modified", insertions: 1, deletions: 0 },
            { path: "src/app.ts", status: "modified", insertions: 1, deletions: 0 },
          ],
          resolveUndoPaths: ["src/app.ts"],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const resolvedList = screen.getByTestId("conflict-resolved-list");
      const stagedList = screen.getByTestId("conflict-staged-list");
      expect(resolvedList.id).not.toBe(stagedList.id);
      expect(screen.getByTestId("conflict-resolved-toggle").getAttribute("aria-controls")).toBe(
        resolvedList.id
      );
      expect(screen.getByTestId("conflict-staged-toggle").getAttribute("aria-controls")).toBe(
        stagedList.id
      );

      fireEvent.click(screen.getByTestId("conflict-staged-toggle"));
      await waitFor(() => expect(stagedList.hidden).toBe(false));
      expect(resolvedList.hidden).toBe(true);
    });

    it("keeps the Resolved section collapsed by default and expands on click", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          staged: [{ path: "src/done.ts", status: "modified", insertions: 1, deletions: 0 }],
          resolveUndoPaths: ["src/done.ts"],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const toggle = screen.getByTestId("conflict-resolved-toggle");
      const list = screen.getByTestId("conflict-resolved-list");
      expect(list.hidden).toBe(true);
      // The disclosure always names a real element, collapsed or not.
      expect(toggle.getAttribute("aria-controls")).toBe(list.id);
      // `border-divider/50` generates no CSS, which left a full-strength border.
      const separator = toggle.parentElement!;
      expect(separator.classList.contains("border-t")).toBe(true);
      expect(separator.classList.contains("border-divider")).toBe(true);

      fireEvent.click(toggle);
      await waitFor(() => expect(list.hidden).toBe(false));
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

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByRole("button", { name: /^Abort /i }));
      fireEvent.click(screen.getByRole("button", { name: /^Abort /i }));

      const dialog = await screen.findByRole("alertdialog");
      // 2 staged + replayed = rebaseStep - 1 = 3 of 7
      expect(dialog.textContent).toMatch(/Discards 2 staged changes/);
      expect(dialog.textContent).toMatch(/reverts 3 of 7 replayed commits/);
    });

    it("rolls back optimistic resolution and keeps Continue disabled when mark-resolved fails", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      stageFileMock.mockRejectedValueOnce(new Error("permission denied"));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

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
      expect(
        screen.getByRole("button", { name: /^Continue /i }).getAttribute("aria-disabled")
      ).toBe("true");
      await screen.findByText("Couldn't mark file resolved");
    });

    it("rolls back optimistic resolution when Take ours fails", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      checkoutOursTheirsMock.mockRejectedValueOnce(new Error("checkout failed"));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const takeOurs = screen.getByRole("menuitem", { name: /for src\/app\.ts \(ours\)/i });
      fireEvent.click(takeOurs);
      await confirmCheckout("ours");

      await waitFor(() => {
        // The row reappears after rollback — the Take ours button is still rendered.
        expect(screen.getByRole("menuitem", { name: /for src\/app\.ts \(ours\)/i })).toBeTruthy();
      });
      await screen.findByText("Couldn't take ours");
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

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const takeOurs = screen.getByRole("menuitem", { name: /for src\/app\.ts \(ours\)/i });
      fireEvent.click(takeOurs);
      await confirmCheckout("ours");

      // After the click, the optimistic row disappears for `src/app.ts` —
      // only `src/other.ts` remains conflicted. Continue must still be
      // disabled because the checkout IPC is pending.
      await waitFor(() => {
        const continueBtn = screen.getByRole("button", { name: /^Continue /i });
        expect(continueBtn.getAttribute("aria-disabled")).toBe("true");
      });

      // Cleanup so the pending promise doesn't leak across tests.
      resolveCheckout?.();
    });

    it("renders a hunk-count badge once the scan resolves", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: 3, hasMarkers: true, firstMarkerLine: 12 },
      ]);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      const badge = await screen.findByTestId("conflict-hunk-count-src/app.ts");
      expect(badge.textContent).toBe("3 regions");
    });

    describe("send conflicts to agent", () => {
      const sentText = (): string => openSendToAgentPaletteWithTextMock.mock.calls[0]![0].text;

      beforeEach(() => {
        openSendToAgentPaletteWithTextMock.mockReset().mockReturnValue(true);
      });

      it("hands the palette the live conflicts with the scan's counts, in the rebase's own wording", async () => {
        getStagingStatusMock.mockResolvedValue(
          makeMergingStatus({
            repoState: "REBASING",
            rebaseStep: 2,
            rebaseTotalSteps: 4,
            conflictedFiles: [
              { path: "src/app.ts", xy: "UU", label: "both modified" },
              { path: "src/gone.ts", xy: "DU", label: "deleted by us" },
            ],
            rebaseSequence: {
              backend: "merge",
              entries: [
                { action: "pick", sha: "aaa1111", subject: "first", state: "done" },
                { action: "pick", sha: "bbb2222", subject: "second", state: "current" },
              ],
            },
          })
        );
        scanConflictMarkersMock.mockResolvedValue([
          { path: "src/app.ts", hunkCount: 3, hasMarkers: true, firstMarkerLine: 12 },
          { path: "src/gone.ts", hunkCount: null, hasMarkers: null, firstMarkerLine: null },
        ]);

        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        await screen.findByTestId("conflict-hunk-count-src/app.ts");
        fireEvent.click(screen.getByTestId("conflict-send-to-agent"));

        expect(openSendToAgentPaletteWithTextMock).toHaveBeenCalledTimes(1);
        const text = sentText();
        expect(text).toContain('"conflictRegions": 3');
        expect(text).toContain('"firstMarkerLine": 12');
        expect(text).toContain('"kind": "deleted by destination"');
        expect(text).toContain('"subject": "second"');
        expect(text).toContain("ours is the destination branch");
      });

      it("leaves a file out once it is marked resolved", async () => {
        getStagingStatusMock.mockResolvedValue(
          makeMergingStatus({
            conflictedFiles: [
              { path: "src/app.ts", xy: "UU", label: "both modified" },
              { path: "src/other.ts", xy: "UU", label: "both modified" },
            ],
          })
        );
        scanConflictMarkersMock.mockResolvedValue([
          { path: "src/app.ts", hunkCount: 0, hasMarkers: false, firstMarkerLine: null },
          { path: "src/other.ts", hunkCount: 1, hasMarkers: true, firstMarkerLine: 4 },
        ]);

        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        fireEvent.click(await screen.findByLabelText("Mark src/app.ts as resolved"));
        await waitFor(() =>
          expect(screen.queryByLabelText("Mark src/app.ts as resolved")).toBeNull()
        );
        fireEvent.click(screen.getByTestId("conflict-send-to-agent"));

        const text = sentText();
        expect(text).toContain("src/other.ts");
        expect(text).not.toContain("src/app.ts");
      });

      it("shows a hint and keeps the button when no agent is open", async () => {
        openSendToAgentPaletteWithTextMock.mockReturnValue(false);
        getStagingStatusMock.mockResolvedValue(makeMergingStatus());

        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        fireEvent.click(await screen.findByTestId("conflict-send-to-agent"));

        expect(screen.getByTestId("conflict-send-to-agent-hint").textContent).toContain(
          "Open an agent terminal"
        );
      });

      it("is absent once every conflict is resolved", async () => {
        getStagingStatusMock.mockResolvedValue(
          makeMergingStatus({ conflicted: [], conflictedFiles: [] })
        );

        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        await screen.findByTestId("conflict-panel");

        expect(screen.queryByTestId("conflict-send-to-agent")).toBeNull();
      });
    });

    it("rescans a conflicted file rewritten inside Daintree, with no focus change", async () => {
      let fireTick: (() => void) | undefined;
      onUpdateMock.mockImplementation((type: string, callback: (data: unknown) => void) => {
        if (type === "worktree-tick") {
          fireTick = () => callback({ tick: { worktreeId: "main-wt", path: WORKTREE_PATH } });
        }
        return mockUnsubscribe;
      });
      // Each read is a fresh object, as it is over IPC; the path set never moves.
      getStagingStatusMock.mockImplementation(async () => makeMergingStatus());
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: 3, hasMarkers: true, firstMarkerLine: 12 },
      ]);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      const badge = await screen.findByTestId("conflict-hunk-count-src/app.ts");
      expect(badge.textContent).toBe("3 regions");

      // An agent in a terminal fixes two of the three regions: the watcher's
      // flush reaches the hub as a tick, and the file stays conflicted.
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: 1, hasMarkers: true, firstMarkerLine: 40 },
      ]);
      act(() => fireTick?.());

      await waitFor(() =>
        expect(screen.getByTestId("conflict-hunk-count-src/app.ts").textContent).toBe("1 region")
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Open src\/app\.ts in external editor/i })
      );
      await waitFor(() => {
        expect(openInEditorMock).toHaveBeenCalledWith({
          path: `${WORKTREE_PATH}/src/app.ts`,
          line: 40,
          projectId: REVIEW_PROJECT_ID,
        });
      });
    });

    it.each(["answers", "fails"] as const)(
      "keeps the newer scan when one a status read overtook %s late",
      async (outcome) => {
        let fireTick: (() => void) | undefined;
        onUpdateMock.mockImplementation((type: string, callback: (data: unknown) => void) => {
          if (type === "worktree-tick") {
            fireTick = () => callback({ tick: { worktreeId: "main-wt", path: WORKTREE_PATH } });
          }
          return mockUnsubscribe;
        });
        getStagingStatusMock.mockImplementation(async () => makeMergingStatus());
        let settleFirst:
          | { resolve: (entries: ConflictMarkerScanEntry[]) => void; reject: (err: Error) => void }
          | undefined;
        scanConflictMarkersMock.mockImplementationOnce(
          () =>
            new Promise<ConflictMarkerScanEntry[]>((resolve, reject) => {
              settleFirst = { resolve, reject };
            })
        );

        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        await waitFor(() => expect(scanConflictMarkersMock).toHaveBeenCalledTimes(1));

        scanConflictMarkersMock.mockResolvedValue([
          { path: "src/app.ts", hunkCount: 1, hasMarkers: true, firstMarkerLine: 40 },
        ]);
        act(() => fireTick?.());
        await waitFor(() => expect(scanConflictMarkersMock).toHaveBeenCalledTimes(2));
        await waitFor(() =>
          expect(screen.getByTestId("conflict-hunk-count-src/app.ts").textContent).toBe("1 region")
        );

        // The overtaken scan read the file before the newer one did.
        await act(async () => {
          if (outcome === "answers") {
            settleFirst?.resolve([
              { path: "src/app.ts", hunkCount: 3, hasMarkers: true, firstMarkerLine: 12 },
            ]);
          } else {
            settleFirst?.reject(new Error("EACCES"));
          }
        });
        expect(screen.getByTestId("conflict-hunk-count-src/app.ts").textContent).toBe("1 region");
        fireEvent.click(
          screen.getByRole("button", { name: /Open src\/app\.ts in external editor/i })
        );
        await waitFor(() => {
          expect(openInEditorMock).toHaveBeenCalledWith({
            path: `${WORKTREE_PATH}/src/app.ts`,
            line: 40,
            projectId: REVIEW_PROJECT_ID,
          });
        });
      }
    );

    it("rescans each time the app regains focus", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: 3, hasMarkers: true, firstMarkerLine: 12 },
      ]);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      expect((await screen.findByTestId("conflict-hunk-count-src/app.ts")).textContent).toBe(
        "3 regions"
      );

      for (const [hunkCount, label] of [
        [2, "2 regions"],
        [1, "1 region"],
      ] as const) {
        scanConflictMarkersMock.mockResolvedValue([
          { path: "src/app.ts", hunkCount, hasMarkers: true, firstMarkerLine: 30 },
        ]);
        act(() => {
          window.dispatchEvent(new Event("focus"));
        });
        await waitFor(() =>
          expect(screen.getByTestId("conflict-hunk-count-src/app.ts").textContent).toBe(label)
        );
      }
    });

    it("never shows another worktree's scan on a same-named file after a switch", async () => {
      const OTHER_PATH = "/home/user/other";
      getStagingStatusMock.mockImplementation(async () => makeMergingStatus());
      // A warm cache keeps the panel mounted across the switch.
      rememberStagingStatus(OTHER_PATH, makeMergingStatus(), beginStagingStatusRead());
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: 3, hasMarkers: true, firstMarkerLine: 12 },
      ]);

      const { rerender } = render(
        <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );
      expect((await screen.findByTestId("conflict-hunk-count-src/app.ts")).textContent).toBe(
        "3 regions"
      );
      const panel = screen.getByTestId("conflict-panel");

      // Every scan of the other worktree shares one answer, held back until
      // the switch has been checked.
      let resolveOther: ((entries: ConflictMarkerScanEntry[]) => void) | undefined;
      const otherScan = new Promise<ConflictMarkerScanEntry[]>((resolve) => {
        resolveOther = resolve;
      });
      scanConflictMarkersMock.mockImplementation(() => otherScan);
      rerender(<ReviewHubContent isOpen={true} worktreePath={OTHER_PATH} onClose={vi.fn()} />);
      await waitFor(() =>
        expect(scanConflictMarkersMock).toHaveBeenCalledWith(OTHER_PATH, ["src/app.ts"])
      );

      expect(screen.getByTestId("conflict-panel")).toBe(panel);
      expect(screen.queryByTestId("conflict-hunk-count-src/app.ts")).toBeNull();
      const openButton = () =>
        screen.getByRole("button", { name: /Open src\/app\.ts in external editor/i });
      fireEvent.click(openButton());
      await waitFor(() => {
        expect(openInEditorMock).toHaveBeenCalledWith({
          path: `${OTHER_PATH}/src/app.ts`,
          projectId: REVIEW_PROJECT_ID,
        });
      });

      await act(async () => {
        resolveOther?.([
          { path: "src/app.ts", hunkCount: 1, hasMarkers: true, firstMarkerLine: 5 },
        ]);
      });
      expect(screen.getByTestId("conflict-hunk-count-src/app.ts").textContent).toBe("1 region");
      fireEvent.click(openButton());
      await waitFor(() => {
        expect(openInEditorMock).toHaveBeenCalledWith({
          path: `${OTHER_PATH}/src/app.ts`,
          line: 5,
          projectId: REVIEW_PROJECT_ID,
        });
      });
    });

    // Both worktrees mid-merge on a same-named file, with a warm cache, so the
    // panel stays mounted across the move: anything it was asking about or had
    // assumed for the old worktree would act on the new one.
    describe("after the hub moves to another conflicted worktree", () => {
      const OTHER_PATH = "/home/user/other";

      function renderMergingHub() {
        getStagingStatusMock.mockResolvedValue(makeMergingStatus());
        rememberStagingStatus(OTHER_PATH, makeMergingStatus(), beginStagingStatusRead());
        const view = render(
          <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
        );
        const moveTo = (worktreePath: string) => () =>
          view.rerender(
            <ReviewHubContent isOpen={true} worktreePath={worktreePath} onClose={vi.fn()} />
          );
        return Object.assign(moveTo(OTHER_PATH), { moveBack: moveTo(WORKTREE_PATH) });
      }

      function deferred<T>() {
        let resolve!: (value: T) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      }

      /** Holds the next click-time marker re-read until the test answers it. */
      async function holdNextReread() {
        await waitFor(() =>
          expect(scanConflictMarkersMock).toHaveBeenCalledWith(WORKTREE_PATH, ["src/app.ts"])
        );
        await act(async () => {});
        const reread = deferred<ConflictMarkerScanEntry[]>();
        scanConflictMarkersMock.mockImplementationOnce(() => reread.promise);
        return reread;
      }

      it("closes an abort confirm opened for the previous worktree", async () => {
        const moveToOther = renderMergingHub();
        fireEvent.click(await screen.findByRole("button", { name: /^Abort /i }));
        await screen.findByRole("alertdialog");
        const panel = screen.getByTestId("conflict-panel");

        moveToOther();
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        expect(screen.getByTestId("conflict-panel")).toBe(panel);
        expect(abortRepositoryOperationMock).not.toHaveBeenCalled();
      });

      it("closes a take-a-side confirm opened for the previous worktree", async () => {
        const moveToOther = renderMergingHub();
        await screen.findByTestId("conflict-panel");
        fireEvent.click(screen.getByRole("menuitem", { name: /for src\/app\.ts \(ours\)/i }));
        await screen.findByRole("alertdialog");

        moveToOther();
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        expect(checkoutOursTheirsMock).not.toHaveBeenCalled();
      });

      it("closes a leftover-markers confirm opened for the previous worktree", async () => {
        scanConflictMarkersMock.mockResolvedValue([
          { path: "src/app.ts", hunkCount: 2, hasMarkers: true, firstMarkerLine: 4 },
        ]);
        const moveToOther = renderMergingHub();
        fireEvent.click(
          await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
        );
        await screen.findByRole("alertdialog");

        moveToOther();
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        expect(stageFileMock).not.toHaveBeenCalled();
      });

      it("never asks about leftover markers the previous worktree's re-read found after the move", async () => {
        const moveToOther = renderMergingHub();
        const reread = await holdNextReread();
        fireEvent.click(screen.getByRole("button", { name: /Mark src\/app\.ts as resolved/i }));

        moveToOther();
        await waitFor(() =>
          expect(scanConflictMarkersMock).toHaveBeenCalledWith(OTHER_PATH, ["src/app.ts"])
        );
        await act(async () => {
          reread.resolve([
            { path: "src/app.ts", hunkCount: 2, hasMarkers: true, firstMarkerLine: 4 },
          ]);
        });

        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(stageFileMock).not.toHaveBeenCalled();
      });

      // Back on the worktree it was asked for, the re-read is still a leftover
      // of an earlier visit: the row it confirmed was reset by the move away.
      it("never acts on that re-read once the hub has moved back", async () => {
        const moveToOther = renderMergingHub();
        const reread = await holdNextReread();
        fireEvent.click(screen.getByRole("button", { name: /Mark src\/app\.ts as resolved/i }));

        moveToOther();
        moveToOther.moveBack();
        await act(async () => {
          reread.resolve([
            { path: "src/app.ts", hunkCount: 0, hasMarkers: false, firstMarkerLine: null },
          ]);
        });

        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(stageFileMock).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: /Mark src\/app\.ts as resolved/i })).toBeTruthy();
      });

      it("frees Abort, and keeps the new worktree's abort confirm when the old abort lands", async () => {
        const oldAbort = deferred<void>();
        abortRepositoryOperationMock.mockImplementationOnce(() => oldAbort.promise);
        const moveToOther = renderMergingHub();
        fireEvent.click(await screen.findByRole("button", { name: /^Abort /i }));
        const dialog = await screen.findByRole("alertdialog");
        fireEvent.click(within(dialog).getByRole("button", { name: /Abort merge/i }));
        await waitFor(() =>
          expect(abortRepositoryOperationMock).toHaveBeenCalledWith(WORKTREE_PATH, MERGE_A)
        );

        moveToOther();
        const abortButton = screen.getByRole("button", { name: /^Abort /i }) as HTMLButtonElement;
        expect(abortButton.disabled).toBe(false);
        fireEvent.click(abortButton);
        await screen.findByRole("alertdialog");

        await act(async () => {
          oldAbort.resolve();
        });
        expect(screen.getByRole("alertdialog")).toBeTruthy();
        expect(abortRepositoryOperationMock).toHaveBeenCalledTimes(1);
      });

      it("keeps the old worktree's Take ours failure off the new one's banner (#17584)", async () => {
        const oldCheckout = deferred<void>();
        checkoutOursTheirsMock.mockImplementationOnce(() => oldCheckout.promise);
        const moveToOther = renderMergingHub();
        fireEvent.click(
          await screen.findByRole("menuitem", { name: /for src\/app\.ts \(ours\)/i })
        );
        await confirmCheckout("ours");
        await waitFor(() =>
          expect(checkoutOursTheirsMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts", {
            resolution: "checkout",
            side: "ours",
          })
        );

        moveToOther();
        await act(async () => {
          oldCheckout.reject(new Error("checkout failed"));
        });

        expect(screen.queryByText("Couldn't take ours")).toBeNull();
      });

      it("keeps the old worktree's abort failure off the new one's banner (#17584)", async () => {
        const oldAbort = deferred<void>();
        abortRepositoryOperationMock.mockImplementationOnce(() => oldAbort.promise);
        const moveToOther = renderMergingHub();
        fireEvent.click(await screen.findByRole("button", { name: /^Abort /i }));
        const dialog = await screen.findByRole("alertdialog");
        fireEvent.click(within(dialog).getByRole("button", { name: /Abort merge/i }));
        await waitFor(() =>
          expect(abortRepositoryOperationMock).toHaveBeenCalledWith(WORKTREE_PATH, MERGE_A)
        );

        moveToOther();
        await act(async () => {
          oldAbort.reject(new Error("abort failed"));
        });

        expect(screen.queryByText("Couldn't abort repository operation")).toBeNull();
      });

      it("keeps the new worktree's own resolve when the old worktree's same-named resolve fails", async () => {
        const oldStage = deferred<void>();
        const newStage = deferred<void>();
        stageFileMock
          .mockImplementationOnce(() => oldStage.promise)
          .mockImplementationOnce(() => newStage.promise);
        const moveToOther = renderMergingHub();
        fireEvent.click(
          await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
        );
        await waitFor(() =>
          expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts")
        );

        moveToOther();
        fireEvent.click(
          await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
        );
        await waitFor(() => expect(stageFileMock).toHaveBeenCalledWith(OTHER_PATH, "src/app.ts"));
        expect(screen.queryByRole("button", { name: /Mark src\/app\.ts as resolved/i })).toBeNull();

        await act(async () => {
          oldStage.reject(new Error("index.lock exists"));
        });
        // Neither the old rollback nor its cleanup reaches the new resolve: the
        // row stays resolved and Continue waits on the stage still in flight.
        expect(screen.queryByRole("button", { name: /Mark src\/app\.ts as resolved/i })).toBeNull();
        expect(screen.getByTestId("conflict-continue").getAttribute("aria-disabled")).toBe("true");
        // Nor does the old worktree's failure banner (#17584).
        expect(screen.queryByText("Couldn't mark file resolved")).toBeNull();

        await act(async () => {
          newStage.resolve();
        });
      });

      it("lists, and frees, a same-named conflict the previous worktree had just marked resolved", async () => {
        const oldStage = deferred<void>();
        stageFileMock.mockImplementationOnce(() => oldStage.promise);
        const moveToOther = renderMergingHub();
        fireEvent.click(
          await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
        );
        await waitFor(() =>
          expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts")
        );
        expect(screen.queryByRole("button", { name: /Mark src\/app\.ts as resolved/i })).toBeNull();

        moveToOther();
        expect(
          await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
        ).toBeTruthy();
        const open = screen.getByRole("button", {
          name: /Open src\/app\.ts in external editor/i,
        }) as HTMLButtonElement;
        expect(open.disabled).toBe(false);

        await act(async () => {
          oldStage.resolve();
        });
      });
    });

    it("opens confirm dialog before aborting and calls abort on confirm", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByRole("button", { name: /^Abort /i }));
      fireEvent.click(screen.getByRole("button", { name: /^Abort /i }));

      const dialog = await screen.findByRole("alertdialog");
      expect(abortRepositoryOperationMock).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: /Abort merge/i }));

      await waitFor(() => {
        expect(abortRepositoryOperationMock).toHaveBeenCalledWith(WORKTREE_PATH, MERGE_A);
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

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByRole("button", { name: /^Continue /i }));
      fireEvent.click(screen.getByRole("button", { name: /^Continue /i }));

      await waitFor(() => {
        expect(continueRepositoryOperationMock).toHaveBeenCalledWith(WORKTREE_PATH, MERGE_A);
      });
    });

    describe("acts only on the operation the user chose (#17559)", () => {
      const resolvedMerge = (overrides?: Partial<StagingStatus>) =>
        makeMergingStatus({
          conflicted: [],
          conflictedFiles: [],
          staged: [{ path: "src/app.ts", status: "modified", insertions: 1, deletions: 1 }],
          ...overrides,
        });

      /** The worktree's own event, which is what re-reads the hub's status. */
      async function statusChanged(next: StagingStatus) {
        getStagingStatusMock.mockResolvedValue(next);
        const onWorktreeUpdate: (data: unknown) => void = onUpdateMock.mock.calls.find(
          ([type]) => type === "worktree-update"
        )?.[1];
        await act(async () => {
          onWorktreeUpdate({ worktree: { path: WORKTREE_PATH } });
        });
      }

      /** As the preload delivers Main's refusal: the reason encoded once, ahead of plain prose. */
      const changedMessage = (verb: string) =>
        `The merge in progress was restarted or replaced after you chose it. Nothing was ${verb}; check the worktree's current state and choose again.`;
      const changedError = (verb: string) =>
        new Error(`[GitError|repo-operation-changed||] ${changedMessage(verb)}`);

      it("closes the abort confirm when a read shows another merge in its place", async () => {
        getStagingStatusMock.mockResolvedValue(makeMergingStatus());
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        fireEvent.click(await screen.findByRole("button", { name: /^Abort /i }));
        await screen.findByRole("alertdialog");

        // Same kind, same files: only the identity says it's a different merge.
        await statusChanged(makeMergingStatus({ repoOperationId: "merge-b" }));

        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        expect(abortRepositoryOperationMock).not.toHaveBeenCalled();
      });

      it("keeps the abort confirm open across a read that couldn't identify the merge", async () => {
        getStagingStatusMock.mockResolvedValue(makeMergingStatus());
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        fireEvent.click(await screen.findByRole("button", { name: /^Abort /i }));
        await screen.findByRole("alertdialog");

        await statusChanged(makeMergingStatus({ repoOperationId: null }));
        // The unidentified read has reached the panel behind the confirm.
        await screen.findByText(/Couldn't identify this merge/);

        const dialog = screen.getByRole("alertdialog");
        fireEvent.click(within(dialog).getByRole("button", { name: /Abort merge/i }));
        // Still the merge the confirm was opened for, which Main checks again.
        await waitFor(() =>
          expect(abortRepositoryOperationMock).toHaveBeenCalledWith(WORKTREE_PATH, MERGE_A)
        );
      });

      it("retries a failed continue for the merge it was chosen for, not the one there now", async () => {
        getStagingStatusMock.mockResolvedValue(resolvedMerge());
        continueRepositoryOperationMock.mockRejectedValueOnce(
          new Error("error: could not commit staged changes")
        );
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        fireEvent.click(await screen.findByRole("button", { name: /^Continue /i }));
        const retry = await screen.findByRole("button", { name: "Retry" });

        // Merge B, visibly: a different resolved file, on screen before Retry.
        await statusChanged(
          resolvedMerge({
            repoOperationId: "merge-b",
            staged: [{ path: "src/other.ts", status: "modified", insertions: 1, deletions: 1 }],
          })
        );
        await screen.findByText("other.ts");
        fireEvent.click(retry);

        await waitFor(() => expect(continueRepositoryOperationMock).toHaveBeenCalledTimes(2));
        expect(continueRepositoryOperationMock).toHaveBeenLastCalledWith(WORKTREE_PATH, MERGE_A);

        // A fresh Continue, chosen from what is on screen now, is for B.
        fireEvent.click(screen.getByRole("button", { name: /^Continue /i }));
        await waitFor(() => expect(continueRepositoryOperationMock).toHaveBeenCalledTimes(3));
        expect(continueRepositoryOperationMock).toHaveBeenLastCalledWith(WORKTREE_PATH, {
          operation: "MERGING",
          operationId: "merge-b",
        });
      });

      it("offers no Retry once the merge was replaced, and reads the worktree again", async () => {
        getStagingStatusMock.mockResolvedValue(resolvedMerge());
        continueRepositoryOperationMock.mockRejectedValueOnce(changedError("continued"));
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        const continueBtn = await screen.findByRole("button", { name: /^Continue /i });
        const readsBefore = getStagingStatusMock.mock.calls.length;
        fireEvent.click(continueBtn);

        // Exactly the prose, with no transport prefix left in it.
        await screen.findByText(changedMessage("continued"));
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
        await waitFor(() =>
          expect(getStagingStatusMock.mock.calls.length).toBeGreaterThan(readsBefore)
        );
      });

      it("closes the abort confirm on a replaced merge, says why, and reads the worktree again", async () => {
        getStagingStatusMock.mockResolvedValue(makeMergingStatus());
        abortRepositoryOperationMock.mockRejectedValueOnce(changedError("aborted"));
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        fireEvent.click(await screen.findByRole("button", { name: /^Abort /i }));
        const dialog = await screen.findByRole("alertdialog");
        const readsBefore = getStagingStatusMock.mock.calls.length;
        fireEvent.click(within(dialog).getByRole("button", { name: /Abort merge/i }));

        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        await screen.findByText(changedMessage("aborted"));
        await waitFor(() =>
          expect(getStagingStatusMock.mock.calls.length).toBeGreaterThan(readsBefore)
        );
      });

      it("keeps the abort confirm open over an ordinary abort failure", async () => {
        getStagingStatusMock.mockResolvedValue(makeMergingStatus());
        abortRepositoryOperationMock.mockRejectedValueOnce(new Error("fatal: index.lock exists"));
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
        fireEvent.click(await screen.findByRole("button", { name: /^Abort /i }));
        const dialog = await screen.findByRole("alertdialog");
        fireEvent.click(within(dialog).getByRole("button", { name: /Abort merge/i }));

        await waitFor(() => expect(abortRepositoryOperationMock).toHaveBeenCalledTimes(1));
        // A read that can't identify the merge leaves the confirm open, and the
        // second try still sends the choice it was opened for, not that read.
        await statusChanged(makeMergingStatus({ repoOperationId: null }));
        await screen.findByText(/Couldn't identify this merge/);
        const still = screen.getByRole("alertdialog");
        fireEvent.click(within(still).getByRole("button", { name: /Abort merge/i }));
        await waitFor(() => expect(abortRepositoryOperationMock).toHaveBeenCalledTimes(2));
        expect(abortRepositoryOperationMock).toHaveBeenLastCalledWith(WORKTREE_PATH, MERGE_A);
      });

      it("treats a status with no identity field at all as unidentified", async () => {
        // An older host answers without the field (#17559): it identifies nothing.
        const legacy = resolvedMerge();
        Reflect.deleteProperty(legacy, "repoOperationId");
        getStagingStatusMock.mockResolvedValue(legacy);
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

        await screen.findByText(/Couldn't identify this merge/);
        const abort = screen.getByRole("button", { name: /^Abort /i }) as HTMLButtonElement;
        expect(abort.disabled).toBe(true);
        const continueBtn = screen.getByRole("button", { name: /^Continue /i });
        expect(continueBtn.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(continueBtn);
        await act(async () => {});
        expect(continueRepositoryOperationMock).not.toHaveBeenCalled();
      });

      it("offers neither Abort nor Continue for a merge the read couldn't identify", async () => {
        getStagingStatusMock.mockResolvedValue(resolvedMerge({ repoOperationId: null }));
        render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

        await screen.findByText(/Couldn't identify this merge/);
        const abort = screen.getByRole("button", { name: /^Abort /i }) as HTMLButtonElement;
        expect(abort.disabled).toBe(true);
        const continueBtn = screen.getByRole("button", { name: /^Continue /i });
        expect(continueBtn.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(continueBtn);
        await act(async () => {});
        expect(continueRepositoryOperationMock).not.toHaveBeenCalled();
      });
    });

    it("keeps a Continue failure that lands after a move, and its Retry, off the new worktree (#17584)", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflicted: [],
          conflictedFiles: [],
          staged: [{ path: "src/app.ts", status: "modified", insertions: 1, deletions: 1 }],
        })
      );
      let rejectContinue: (reason: unknown) => void = () => {};
      continueRepositoryOperationMock.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectContinue = reject;
          })
      );
      const { rerender } = render(
        <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );
      fireEvent.click(await screen.findByRole("button", { name: /^Continue /i }));
      await waitFor(() =>
        expect(continueRepositoryOperationMock).toHaveBeenCalledWith(WORKTREE_PATH, MERGE_A)
      );

      rerender(
        <ReviewHubContent isOpen={true} worktreePath="/home/user/other" onClose={vi.fn()} />
      );
      await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledWith("/home/user/other"));
      await act(async () => {
        rejectContinue(new Error("could not continue"));
      });

      expect(screen.queryByText("Couldn't continue repository operation")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Retry$/ })).toBeNull();
      expect(continueRepositoryOperationMock).toHaveBeenCalledTimes(1);
    });

    it("does not continue while conflicts remain, even though Continue stays focusable", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      const continueBtn = await screen.findByRole("button", { name: /^Continue /i });
      expect(continueBtn.hasAttribute("disabled")).toBe(false);
      fireEvent.click(continueBtn);
      await act(async () => {});
      expect(continueRepositoryOperationMock).not.toHaveBeenCalled();
    });

    it("keeps whole-file overwrites out of the row's direct actions", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      const list = await screen.findByRole("list", { name: "Conflicted files" });
      const [row] = within(list).getAllByRole("listitem");
      if (!row) throw new Error("no conflicted row rendered");
      const directNames = within(row)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
      expect(directNames.some((name) => /^Open /.test(name))).toBe(true);
      expect(directNames.some((name) => /\((ours|theirs)\)$/.test(name))).toBe(false);
      // Each overwrite leads with the source it restores; git's ours/theirs is
      // only the trailing qualifier, so the rebase swap never has to be
      // remembered to choose safely.
      const items = within(row).getAllByRole("menuitem");
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.textContent?.trim().startsWith("Use ")).toBe(true);
        expect(item.textContent).not.toMatch(/^\s*(ours|theirs)/i);
      }
    });

    it("names the rebase sides by what they are, not by git's swapped ours/theirs", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus({ repoState: "REBASING" }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await screen.findByTestId("conflict-panel");
      const rebaseOurs = screen
        .getByRole("menuitem", { name: /\(ours\)$/ })
        .getAttribute("aria-label");
      cleanup();

      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await screen.findByTestId("conflict-panel");
      const mergeOurs = screen
        .getByRole("menuitem", { name: /\(ours\)$/ })
        .getAttribute("aria-label");

      expect(rebaseOurs).not.toBe(mergeOurs);
    });

    it("asks before staging a file that still contains conflict markers", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: 2, hasMarkers: true, firstMarkerLine: 4 },
      ]);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      fireEvent.click(
        await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
      );
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog.textContent).toContain("still has 2 conflict regions");
      expect(dialog.textContent).not.toContain("without checking");
      expect(stageFileMock).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Mark resolved" }));
      await waitFor(() => {
        expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts");
      });
    });

    it("asks before staging a file whose opener was deleted but whose closer remains", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      // The background scan reads the file clean; only the click's own re-read
      // sees the closer the edit since left behind.
      const leftover = [{ path: "src/app.ts", hunkCount: 0, hasMarkers: true, firstMarkerLine: 4 }];
      const markButton = await screen.findByRole("button", {
        name: /Mark src\/app\.ts as resolved/i,
      });
      await waitFor(() => expect(scanConflictMarkersMock).toHaveBeenCalled());
      const scansBefore = scanConflictMarkersMock.mock.calls.length;
      scanConflictMarkersMock.mockResolvedValueOnce(leftover);
      fireEvent.click(markButton);
      expect(scanConflictMarkersMock).toHaveBeenCalledTimes(scansBefore + 1);
      expect(scanConflictMarkersMock).toHaveBeenLastCalledWith(WORKTREE_PATH, ["src/app.ts"]);
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog.textContent).toContain("leftover conflict markers, starting on line 4");
      expect(dialog.textContent).not.toContain("without checking");
      expect(stageFileMock).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(stageFileMock).not.toHaveBeenCalled();

      const markAgain = await screen.findByRole("button", {
        name: /Mark src\/app\.ts as resolved/i,
      });
      scanConflictMarkersMock.mockResolvedValueOnce([{ ...leftover[0], firstMarkerLine: 9 }]);
      fireEvent.click(markAgain);
      const retryDialog = await screen.findByRole("alertdialog");
      expect(retryDialog.textContent).toContain("starting on line 9");
      fireEvent.click(within(retryDialog).getByRole("button", { name: "Mark resolved" }));
      await waitFor(() => {
        expect(stageFileMock).toHaveBeenCalledTimes(1);
      });
      expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts");
    });

    it("asks before staging when the re-read counts no regions but gives no marker verdict", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: 0, firstMarkerLine: null },
      ]);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      fireEvent.click(
        await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
      );
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog.textContent).toContain("without checking");
      expect(stageFileMock).not.toHaveBeenCalled();
    });

    it("asks before staging when the marker re-read fails", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      scanConflictMarkersMock.mockRejectedValue(new Error("EACCES"));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      fireEvent.click(
        await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
      );
      await screen.findByRole("alertdialog");
      expect(stageFileMock).not.toHaveBeenCalled();
    });

    it("asks before staging a deleted-side conflict when the marker re-read fails", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflictedFiles: [{ path: "src/app.ts", xy: "DU", label: "deleted by us" }],
        })
      );
      scanConflictMarkersMock.mockRejectedValue(new Error("Reads under the worktree are stalled"));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      fireEvent.click(
        await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
      );
      await screen.findByRole("alertdialog");
      expect(stageFileMock).not.toHaveBeenCalled();
    });

    it("asks before staging when the re-read returns nothing for the file", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      scanConflictMarkersMock.mockResolvedValue([]);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      fireEvent.click(
        await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
      );
      await screen.findByRole("alertdialog");
      expect(stageFileMock).not.toHaveBeenCalled();
    });

    it("stages a deleted-side conflict the scanner had no file to check, without asking", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflictedFiles: [{ path: "src/app.ts", xy: "DU", label: "deleted by us" }],
        })
      );
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: null, hasMarkers: null, firstMarkerLine: null },
      ]);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      fireEvent.click(
        await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
      );
      await waitFor(() => {
        expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts");
      });
    });

    it("asks before staging a deleted-side conflict whose file still holds markers", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflictedFiles: [{ path: "src/app.ts", xy: "UD", label: "deleted by them" }],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      const markButton = await screen.findByRole("button", {
        name: /Mark src\/app\.ts as resolved/i,
      });
      await waitFor(() => expect(scanConflictMarkersMock).toHaveBeenCalled());
      scanConflictMarkersMock.mockResolvedValueOnce([
        { path: "src/app.ts", hunkCount: 0, hasMarkers: true, firstMarkerLine: 3 },
      ]);
      fireEvent.click(markButton);
      expect(scanConflictMarkersMock).toHaveBeenLastCalledWith(WORKTREE_PATH, ["src/app.ts"]);
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog.textContent).toContain("starting on line 3");
      expect(stageFileMock).not.toHaveBeenCalled();
    });

    it("stages a deleted-side conflict the re-read returned nothing for, without asking", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflictedFiles: [{ path: "src/app.ts", xy: "DU", label: "deleted by us" }],
        })
      );
      scanConflictMarkersMock.mockResolvedValue([]);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      fireEvent.click(
        await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
      );
      await waitFor(() => {
        expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts");
      });
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("asks before staging a text conflict the scanner skipped (oversized, unreadable)", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: null, hasMarkers: null, firstMarkerLine: null },
      ]);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      fireEvent.click(
        await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
      );
      await screen.findByRole("alertdialog");
      expect(stageFileMock).not.toHaveBeenCalled();
    });

    it("hands focus to the next file when a confirm dialog resolves the row", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflictedFiles: [
            { path: "src/app.ts", xy: "UU", label: "both modified" },
            { path: "src/other.ts", xy: "UU", label: "both modified" },
          ],
          conflicted: ["src/app.ts", "src/other.ts"],
        })
      );
      checkoutOursTheirsMock.mockImplementationOnce(() => new Promise<void>(() => {}));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      fireEvent.click(await screen.findByRole("menuitem", { name: /for src\/app\.ts \(ours\)/i }));
      await confirmCheckout("ours");

      await waitFor(() => {
        expect(document.activeElement?.getAttribute("aria-label")).toBe(
          "Open src/other.ts in external editor"
        );
      });
    });

    it("stages without asking once the file has no markers left", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus());
      scanConflictMarkersMock.mockResolvedValue([
        { path: "src/app.ts", hunkCount: 0, hasMarkers: false, firstMarkerLine: null },
      ]);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      fireEvent.click(
        await screen.findByRole("button", { name: /Mark src\/app\.ts as resolved/i })
      );
      await waitFor(() => {
        expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/app.ts");
      });
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("hands focus to the next file when the focused row is resolved", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          conflictedFiles: [
            { path: "src/app.ts", xy: "UU", label: "both modified" },
            { path: "src/other.ts", xy: "UU", label: "both modified" },
          ],
          conflicted: ["src/app.ts", "src/other.ts"],
        })
      );
      stageFileMock.mockImplementationOnce(() => new Promise<void>(() => {}));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      const resolveBtn = await screen.findByRole("button", {
        name: /Mark src\/app\.ts as resolved/i,
      });
      resolveBtn.focus();
      fireEvent.click(resolveBtn);

      await waitFor(() => {
        expect(document.activeElement?.getAttribute("aria-label")).toBe(
          "Open src/other.ts in external editor"
        );
      });
    });

    it("marks the current rebase step for assistive technology", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          repoState: "REBASING",
          rebaseStep: 2,
          rebaseTotalSteps: 3,
          rebaseSequence: {
            backend: "merge",
            entries: [
              { action: "pick", sha: "aaa1111", subject: "first", state: "done" },
              { action: "pick", sha: "bbb2222", subject: "second", state: "current" },
              { action: "pick", sha: "ccc3333", subject: "third", state: "pending" },
            ],
          },
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      const rail = await screen.findByTestId("conflict-rebase-sequence");
      const current = within(rail)
        .getAllByRole("listitem")
        .filter((li) => li.getAttribute("aria-current") === "step");
      expect(current).toHaveLength(1);
      expect(current[0]?.textContent).toContain("second");
    });

    it("names deletion sides in rebase terms, and leaves merge labels alone", async () => {
      const deletedByUs = [{ path: "src/app.ts", xy: "DU", label: "deleted by us" }];
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({ repoState: "REBASING", conflictedFiles: deletedByUs })
      );
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      const rebaseList = await screen.findByRole("list", { name: "Conflicted files" });
      expect(rebaseList.textContent).not.toMatch(/\bus\b/);
      expect(rebaseList.textContent).toMatch(/deleted by destination/);
      cleanup();

      getStagingStatusMock.mockResolvedValue(makeMergingStatus({ conflictedFiles: deletedByUs }));
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      const mergeList = await screen.findByRole("list", { name: "Conflicted files" });
      expect(mergeList.textContent).toMatch(/deleted by us/);
    });

    it("renders cherry-pick operation labels", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus({ repoState: "CHERRY_PICKING" }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      screen.getByText(/Resolve Cherry-pick Conflicts/i);
      screen.getByRole("button", { name: /^Abort cherry-pick/i });
      screen.getByRole("button", { name: /^Continue cherry-pick/i });
    });

    it("renders revert operation labels", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus({ repoState: "REVERTING" }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      screen.getByText(/Resolve Revert Conflicts/i);
      screen.getByRole("button", { name: /^Abort revert/i });
      screen.getByRole("button", { name: /^Continue revert/i });
    });

    it("renders a halted git am as a patch apply, with no rebase progress or replay count", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          repoState: "APPLYING_MAILBOX",
          staged: [{ path: "a.ts", status: "modified", insertions: 1, deletions: 0 }],
          // Counters a rebase would render, so the panel's own rebase guard is
          // what keeps them off a mailbox apply.
          rebaseStep: 2,
          rebaseTotalSteps: 3,
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      screen.getByText(/Resolve patch apply conflicts/i);
      screen.getByRole("button", { name: /^Continue patch apply/i });
      expect(screen.queryByTestId("conflict-rebase-progress")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /^Abort patch apply/i }));
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog.textContent).toMatch(/Discards 1 staged change and/);
      expect(dialog.textContent).toMatch(/git am/);
      expect(dialog.textContent).not.toMatch(/replayed commit/);
    });

    it("tells a resolved git am that Continue applies the rest of the series", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({
          repoState: "APPLYING_MAILBOX",
          conflicted: [],
          conflictedFiles: [],
          staged: [{ path: "a.ts", status: "modified", insertions: 1, deletions: 0 }],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      screen.getByText(/Ready to continue patch apply/i);
      screen.getByText("Continue to commit this patch and apply any that remain");
      expect(
        screen.getByRole("button", { name: /^Continue patch apply/i }).getAttribute("aria-disabled")
      ).toBeNull();
    });

    // The status read that shows the staged resolution lands after the row
    // leaves the list; until then the row's own staging is what counts.
    it("does not call a just-resolved git am conflict empty before the status catches up", async () => {
      getStagingStatusMock.mockResolvedValue(makeMergingStatus({ repoState: "APPLYING_MAILBOX" }));

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      fireEvent.click(await screen.findByLabelText("Mark src/app.ts as resolved"));
      await waitFor(() =>
        expect(screen.queryByLabelText("Mark src/app.ts as resolved")).toBeNull()
      );

      screen.getByText(/Ready to continue patch apply/i);
      expect(screen.queryByText("Nothing staged for this patch")).toBeNull();
    });

    // A patch that wouldn't apply at all stops with no conflicts and nothing
    // staged, and `git am --continue` refuses that index.
    it("holds Continue on a git am stop with nothing staged and names the terminal way out", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeMergingStatus({ repoState: "APPLYING_MAILBOX", conflicted: [], conflictedFiles: [] })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByTestId("conflict-panel"));
      screen.getByText("Nothing staged for this patch");
      screen.getByText(/run git am --skip in a terminal/);
      const continueButton = screen.getByRole("button", { name: /^Continue patch apply/i });
      expect(continueButton.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(continueButton);
      expect(continueRepositoryOperationMock).not.toHaveBeenCalled();
    });

    it("renders normal staging UI when repoState is DIRTY with conflicts", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          conflicted: ["src/weird.ts"],
          conflictedFiles: [{ path: "src/weird.ts", xy: "UU", label: "both modified" }],
          repoState: "DIRTY",
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      expect(screen.queryByTestId("conflict-panel")).toBeNull();
    });
  });
});

afterEach(() => {
  resetStagingStatusCacheForTests();
});
